import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgBoss, TestClock } from 'pg-boss';
import { config } from '../src/config.js';
import { dailyCron, dailyTimezone, shouldRunDaily } from '../src/ingestion/schedule.js';

test('PostgreSQL scheduler dispatches across 04:00 JST while active and skips downtime', async () => {
  const clock = new TestClock('2026-10-27T18:59:00Z');
  const errors: unknown[] = [];
  let dispatched = 0;
  const makeWorker = async () => {
    const started = new Date(clock.now());
    const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'schedule_verification', clock,
      cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1, supervise: false });
    boss.on('error', error => errors.push(error));
    await boss.start();
    await boss.createQueue('catalog.daily');
    await boss.work('catalog.daily', { includeMetadata: true, pollingIntervalSeconds: 1 }, async jobs => {
      for (const job of jobs) if (shouldRunDaily(job.createdOn, started, new Date(clock.now()))) dispatched++;
    });
    await boss.schedule('catalog.daily', dailyCron, {}, { tz: dailyTimezone });
    return boss;
  };
  let boss = await makeWorker();
  try {
    await clock.tick(59000);
    assert.equal(dispatched, 0);
    await clock.tick(6000);
    assert.equal(dispatched, 1, 'one dispatch when active across 04:00 JST');
    await boss.stop({ graceful: false });
    // The worker is absent across the next scheduled occurrence.
    await clock.setTime('2026-10-28T19:06:00Z');
    boss = await makeWorker();
    await clock.tick(10000);
    assert.equal(dispatched, 1, 'restarting after the schedule does not scan to catch up');
    assert.deepEqual(errors, []);
  } finally { await boss.stop({ graceful: false }); }
});
