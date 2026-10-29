import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from './pool.js';
import { config } from '../config.js';
import { validatePolicy } from '../pricing.js';

const path = fileURLToPath(new URL('./schema.sql', import.meta.url));
const client = await db.connect();
try {
  validatePolicy({ fxJpyToVnd: config.fxJpyToVnd, serviceFeePercent: config.serviceFeePercent });
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(70400200)');
  await client.query(await readFile(path, 'utf8'));
  await client.query(await readFile(new URL('./admin.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('./order-notifications.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('./email-delivery.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('./title-presentations.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('./remove-needs-human.sql', import.meta.url), 'utf8'));
  await client.query('INSERT INTO pricing_policy(id,fx_jpy_to_vnd,service_fee_percent) VALUES(1,$1,$2) ON CONFLICT DO NOTHING', [config.fxJpyToVnd, config.serviceFeePercent]);
  await client.query('COMMIT');
  console.log('Mita database schema applied');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await db.end();
}
