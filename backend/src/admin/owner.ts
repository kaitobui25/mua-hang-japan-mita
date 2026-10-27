import { emitKeypressEvents } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { db } from '../db/pool.js';
import { hashPassword } from './security.js';

export async function provisionOwner(password: string, reset = false) {
  const hash = await hashPassword(password);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (reset) {
      const changed = await client.query('UPDATE admin_accounts SET password_hash=$1,updated_at=now() WHERE id=1 RETURNING id', [hash]);
      if (!changed.rowCount) throw new Error('Chưa có owner. Chạy admin:setup trước.');
      await client.query('DELETE FROM admin_sessions');
      await client.query('UPDATE admin_login_limit SET attempts=0,window_started_at=now() WHERE id=1');
      await client.query("INSERT INTO admin_audit_events(actor_id,action,object_id) VALUES(1,'owner.password_reset','1')");
    } else {
      const created = await client.query('INSERT INTO admin_accounts(id,password_hash) VALUES(1,$1) ON CONFLICT DO NOTHING RETURNING id', [hash]);
      if (!created.rowCount) throw new Error('Owner đã tồn tại. Không tạo hoặc ghi đè tài khoản.');
      await client.query("INSERT INTO admin_audit_events(actor_id,action,object_id) VALUES(1,'owner.created','1')");
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function secretPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Cần terminal tương tác để nhập kín; không pipe mật khẩu.');
  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') { finish(); reject(new Error('Đã hủy.')); }
      else if (key.name === 'return') { finish(); resolve(value); }
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (text && !key.ctrl && !/[\x00-\x1f\x7f]/.test(text) && value.length + text.length <= 128) value += text;
    };
    process.stdin.on('keypress', onKey);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (process.argv.length !== 3 || !['setup', 'reset'].includes(command)) throw new Error('Dùng npm run admin:setup hoặc npm run admin:reset; không truyền mật khẩu.');
    if (command === 'reset' && await secretPrompt('Nhập RESET OWNER để xác nhận thu hồi mọi phiên: ') !== 'RESET OWNER') throw new Error('Đã hủy reset.');
    const password = await secretPrompt('Mật khẩu owner (12–128 ký tự, không hiển thị): ');
    if (password !== await secretPrompt('Nhập lại mật khẩu: ')) throw new Error('Mật khẩu không khớp.');
    await provisionOwner(password, command === 'reset');
    console.log('Đã lưu owner an toàn.');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Thiết lập thất bại.'); process.exitCode = 1; }
  finally { await db.end(); }
}
