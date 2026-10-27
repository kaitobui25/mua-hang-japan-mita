import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The migrations are loaded relative to the compiled db/migrate.js module.
const source = fileURLToPath(new URL('../src/db/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/db/', import.meta.url));
await mkdir(destination, { recursive: true });
for (const sql of ['schema.sql', 'admin.sql']) {
  await copyFile(`${source}/${sql}`, `${destination}/${sql}`);
}
