import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextAmazonRetryAt, amazonGate } from '../src/ingestion/source-access.js';

test('cooldown is following calendar day at 04:00 JST, including before 04:00 and year rollover', () => {
  for (const [now, due] of [
    ['2026-10-27T15:01:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-10-27T18:59:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-10-27T19:00:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-10-28T14:59:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-12-31T15:00:00Z', '2027-01-01T19:00:00.000Z']
  ]) assert.equal(nextAmazonRetryAt(new Date(now)).toISOString(), due);
});
