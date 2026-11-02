import test from 'node:test';
import assert from 'node:assert/strict';
import { cronAtJst, defaultWorkerSettings, lastDueAtJst, nextWorkerWindow, validateWorkerSettings, writeWorkerSettings } from '../src/workers/settings.js';

test('Worker settings validate chronological JST hours and no overlap', () => {
  assert.deepEqual(validateWorkerSettings(defaultWorkerSettings), defaultWorkerSettings);
  for (const schedules of [
    { amazon: '05:00', names: '05:10', detail: '05:30' },
    { amazon: '05:00', names: '06:00', detail: '06:10' },
    { amazon: '05:00', names: '05:15', detail: '24:01' },
    { amazon: '07:00', names: '05:00', detail: '05:15' }
  ]) assert.throws(() => validateWorkerSettings({ version: 1, engine: 'codex', schedules }));
  assert.throws(() => validateWorkerSettings({ version: 1, engine: 'other', schedules: defaultWorkerSettings.schedules }));
  assert.throws(() => validateWorkerSettings({ version: 1, engine: 'codex', schedules: {
    ...defaultWorkerSettings.schedules, unexpected: '12:00'
  } }));
});

test('Next schedule is UTC ISO but uses JST clock and never catches up', () => {
  assert.equal(nextWorkerWindow('names', defaultWorkerSettings, new Date('2026-11-02T19:00:00Z')),
    '2026-11-02T20:00:00.000Z');
  assert.equal(nextWorkerWindow('names', defaultWorkerSettings, new Date('2026-11-02T20:30:00Z')),
    '2026-11-03T20:00:00.000Z');
});
test('Custom cron and due-time calculations handle JST rollover', () => {
  assert.equal(cronAtJst('06:45'), '45 6 * * *');
  assert.equal(lastDueAtJst(new Date('2026-11-02T22:00:00Z'), '06:45').toISOString(),
    '2026-11-02T21:45:00.000Z');
  assert.equal(lastDueAtJst(new Date('2026-11-02T21:00:00Z'), '06:45').toISOString(),
    '2026-11-01T21:45:00.000Z');
});

test('Versioned Owner config uses transaction and rolls back on audit failure', async () => {
  let committed = false;
  let rolledBack = false;
  let released = false;
  const client = {
    async query(sql: string) {
      if (sql === 'SELECT version,engine,schedules FROM worker_control_settings WHERE id=1') {
        return { rows: [defaultWorkerSettings] };
      }
      if (sql.startsWith('UPDATE worker_control_settings')) {
        return { rows: [{ ...defaultWorkerSettings, version: 2 }] };
      }
      if (sql.startsWith('INSERT INTO worker_control_audit')) throw Error('audit_failed');
      if (sql === 'COMMIT') committed = true;
      if (sql === 'ROLLBACK') rolledBack = true;
      return { rows: [] };
    },
    release() { released = true; }
  };
  await assert.rejects(() => writeWorkerSettings(defaultWorkerSettings, 'owner-1', async () => client as never), /audit_failed/);
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
  assert.equal(released, true);
});
