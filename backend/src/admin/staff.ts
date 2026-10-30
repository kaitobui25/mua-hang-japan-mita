import { pathToFileURL } from 'node:url';
import { db } from '../db/pool.js';
import { hashPassword } from './security.js';
import { secretPrompt } from './owner.js';

const validUsername = (value: string) => /^[a-z][a-z0-9_-]{2,31}$/.test(value) && value !== 'owner';

/** Manual, trusted-machine provisioning; never expose staff creation publicly. */
export async function provisionStaff(username: string, password: string, reset = false) {
  if (!validUsername(username)) throw new Error('Tên nhân viên cần 3–32 ký tự thường, số, _ hoặc -; khác owner.');
  const hash = await hashPassword(password);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(70400201)');
    if (reset) {
      const result = await client.query(
        "UPDATE admin_accounts SET password_hash=$2,enabled=true,updated_at=now() WHERE username=$1 AND role='staff' RETURNING id",
        [username, hash]);
      if (!result.rowCount) throw new Error('Không tìm thấy nhân viên.');
      await client.query('DELETE FROM admin_sessions WHERE account_id=$1', [result.rows[0].id]);
      await client.query('DELETE FROM admin_staff_login_limit WHERE username=$1', [username]);
      await client.query("INSERT INTO admin_audit_events(actor_id,action,object_id) VALUES(1,'staff.password_reset',$1)", [username]);
    } else {
      const created = await client.query(
        "INSERT INTO admin_accounts(id,username,role,password_hash) SELECT COALESCE(MAX(id),1)+1,$1,'staff',$2 FROM admin_accounts RETURNING id",
        [username, hash]);
      if (!created.rowCount) throw new Error('Không tạo được nhân viên.');
      await client.query("INSERT INTO admin_audit_events(actor_id,action,object_id) VALUES(1,'staff.created',$1)", [username]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function disableStaff(username: string) {
  if (!validUsername(username)) throw new Error('Tên nhân viên không hợp lệ.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      "UPDATE admin_accounts SET enabled=false,updated_at=now() WHERE username=$1 AND role='staff' RETURNING id",
      [username]);
    if (!result.rowCount) throw new Error('Không tìm thấy nhân viên.');
    await client.query('DELETE FROM admin_sessions WHERE account_id=$1', [result.rows[0].id]);
    await client.query("INSERT INTO admin_audit_events(actor_id,action,object_id) VALUES(1,'staff.disabled',$1)", [username]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2], username = process.argv[3];
    if (process.argv.length !== 4 || !username || !['add', 'reset', 'disable'].includes(command)) {
      throw new Error('Dùng npm run admin:staff:add -- <username>, admin:staff:reset hoặc admin:staff:disable.');
    }
    if (command === 'disable') {
      if (await secretPrompt('Nhập DISABLE STAFF để xác nhận: ') !== 'DISABLE STAFF') throw new Error('Đã hủy.');
      await disableStaff(username);
    } else {
      const password = await secretPrompt('Mật khẩu nhân viên (12–128 ký tự): ');
      if (password !== await secretPrompt('Nhập lại mật khẩu: ')) throw new Error('Mật khẩu không khớp.');
      await provisionStaff(username, password, command === 'reset');
    }
    console.log('Đã cập nhật tài khoản nhân viên.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Thao tác thất bại.');
    process.exitCode = 1;
  } finally { await db.end(); }
}
