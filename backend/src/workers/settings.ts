import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';

export type WorkerKey = 'amazon' | 'names' | 'detail';
export type WorkerEngine = 'openrouter' | 'codex';
export type WorkerSchedules = Record<WorkerKey, string>;
export type WorkerSettings = { version: number; engine: WorkerEngine; schedules: WorkerSchedules };
export const defaultWorkerSettings: WorkerSettings = {
  version: 1, engine: 'openrouter', schedules: { amazon: '04:00', names: '05:00', detail: '05:15' }
};
const keys = ['amazon', 'names', 'detail'] as const;
const timeRe = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateWorkerSettings(value: unknown): WorkerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_worker_settings');
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.version) || (input.version as number) < 1 ||
      (input.engine !== 'openrouter' && input.engine !== 'codex')) throw Error('invalid_worker_settings');
  const times = input.schedules;
  if (!times || typeof times !== 'object' || Array.isArray(times) ||
      Object.keys(times).sort().join(',') !== [...keys].sort().join(',')) throw Error('invalid_worker_schedules');
  const schedules = times as Record<string, unknown>;
  if (keys.some(key => typeof schedules[key] !== 'string' || !timeRe.test(schedules[key] as string))) {
    throw Error('invalid_worker_schedules');
  }
  const minutes = keys.map(key => {
    const [hour, minute] = (schedules[key] as string).split(':').map(Number);
    return hour * 60 + minute;
  });
  // Conservative guard; runtime leases still reject actual overruns.
  if (minutes[0] + 15 > minutes[1] || minutes[1] + 15 > minutes[2] ||
      minutes[2] >= 24 * 60 - 15) throw Error('worker_schedule_conflict');
  return { version: input.version as number, engine: input.engine,
    schedules: { amazon: schedules.amazon as string, names: schedules.names as string, detail: schedules.detail as string } };
}

type Query = Pick<PoolClient, 'query'>;
export async function readWorkerSettings(client: Query = db): Promise<WorkerSettings> {
  const result = await client.query<{ version: number; engine: WorkerEngine; schedules: WorkerSchedules }>(
    'SELECT version,engine,schedules FROM worker_control_settings WHERE id=1');
  if (!result.rows[0]) throw Error('worker_settings_migration_required');
  return validateWorkerSettings(result.rows[0]);
}

export async function writeWorkerSettings(value: unknown, actorId: string,
  connect: () => Promise<PoolClient> = () => db.connect()): Promise<WorkerSettings> {
  const input = validateWorkerSettings(value);
  if (!actorId) throw Error('worker_owner_required');
  const client = await connect();
  try {
    await client.query('BEGIN');
    const previous = await readWorkerSettings(client);
    if (input.version !== previous.version) throw Error('worker_settings_version_conflict');
    const updated = await client.query(
      'UPDATE worker_control_settings SET version=version+1,engine=$1,schedules=$2::jsonb,updated_at=now() WHERE id=1 AND version=$3 RETURNING version,engine,schedules',
      [input.engine, JSON.stringify(input.schedules), input.version]);
    if (!updated.rows[0]) throw Error('worker_settings_version_conflict');
    const next = validateWorkerSettings(updated.rows[0]);
    await client.query('INSERT INTO worker_control_audit(actor_id,before_value,after_value) VALUES($1,$2::jsonb,$3::jsonb)',
      [actorId, JSON.stringify(previous), JSON.stringify(next)]);
    await client.query('COMMIT');
    return next;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export function nextWorkerWindow(job: WorkerKey, settings: WorkerSettings, now = new Date()): string {
  const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const due = new Date(day + 'T' + settings.schedules[job] + ':00+09:00');
  if (due.getTime() <= now.getTime()) due.setUTCDate(due.getUTCDate() + 1);
  return due.toISOString();
}

export function cronAtJst(hhmm: string): string {
  if (!timeRe.test(hhmm)) throw Error('invalid_worker_schedules');
  return Number(hhmm.slice(3)) + ' ' + Number(hhmm.slice(0,2)) + ' * * *';
}

export function lastDueAtJst(now: Date, hhmm: string): Date {
  if (!timeRe.test(hhmm)) throw Error('invalid_worker_schedules');
  const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const due = new Date(day + 'T' + hhmm + ':00+09:00');
  if (due > now) due.setUTCDate(due.getUTCDate() - 1);
  return due;
}

/** Compatibility only for a database that has not received this optional schema. */
export async function readWorkerSettingsOrLegacy(): Promise<WorkerSettings> {
  try { return await readWorkerSettings(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '42P01') {
      return defaultWorkerSettings;
    }
    throw error;
  }
}
