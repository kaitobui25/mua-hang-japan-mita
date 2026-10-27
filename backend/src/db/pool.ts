import pg from 'pg';
import { config } from '../config.js';

export const db = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
// An idle connection can fail when the PC tunnel disappears. Never leave it unhandled.
db.on('error', () => console.error('Database connection lost; check database/tunnel connectivity.'));
