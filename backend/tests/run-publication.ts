import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';

// Every suite gets a disposable database; never reset a developer's owner/data.
const database = `mita_test_${randomBytes(8).toString('hex')}`;
const control = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
const url = new URL(config.databaseUrl);
url.pathname = `/${database}`;
let created = false;
try {
  await control.query(`CREATE DATABASE ${database}`);
  created = true;
  const isolated = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    await isolated.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    await isolated.query(await readFile(new URL('../src/db/admin.sql', import.meta.url), 'utf8'));
    await isolated.query(await readFile(new URL('../src/db/order-notifications.sql', import.meta.url), 'utf8'));
    await isolated.query(await readFile(new URL('../src/db/email-delivery.sql', import.meta.url), 'utf8'));
    await isolated.query(await readFile(new URL('../src/db/title-presentations.sql', import.meta.url), 'utf8'));
    await isolated.query(await readFile(new URL('../src/db/remove-needs-human.sql', import.meta.url), 'utf8'));
    await isolated.query('INSERT INTO pricing_policy(id,fx_jpy_to_vnd,service_fee_percent) VALUES(1,190,12)');
  } finally { await isolated.end(); }
  const selected = process.argv.length > 2 ? process.argv.slice(2) : ['publication.test.js'];
  const files = (await readdir(new URL('.', import.meta.url))).filter(f => f.endsWith('.test.js') && (!selected.length || selected.includes(f))).map(f => fileURLToPath(new URL(f, import.meta.url)));
  let failed = false;
  for (const file of files) {
  for (const mode of file.endsWith('publication.test.js') ? ['0', '1'] : ['0']) {
  const code = await new Promise<number>((resolve, reject) => {
    // Suites share one disposable database; parallel DDL from independent
    // fixtures can deadlock even when the application code is correct.
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--experimental-test-isolation=none', file],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.toString(), MITA_STRICT_TOP100: mode } });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
  if (code) failed = true;
  }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
