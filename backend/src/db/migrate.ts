import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from './pool.js';

const path = fileURLToPath(new URL('./schema.sql', import.meta.url));
try {
  await db.query(await readFile(path, 'utf8'));
  console.log('Mita database schema applied');
} finally {
  await db.end();
}
