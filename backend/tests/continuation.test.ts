import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextAmazonRetryAt, amazonPauseUntil, amazonGate } from '../src/ingestion/source-access.js';

test('cooldown is following calendar day at 04:00 JST, including before 04:00 and year rollover', () => {
  for (const [now, due] of [
    ['2026-10-27T15:01:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-10-27T18:59:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-10-27T19:00:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-10-28T14:59:00Z', '2026-10-28T19:00:00.000Z'],
    ['2026-12-31T15:00:00Z', '2027-01-01T19:00:00.000Z']
  ]) assert.equal(nextAmazonRetryAt(new Date(now)).toISOString(), due);
});

test('Amazon Retry-After can extend but never shorten the next permitted 04:00 JST window', () => {
  const now = new Date('2026-10-29T01:00:00Z');
  const baseline = '2026-10-29T19:00:00.000Z';
  assert.equal(amazonPauseUntil(now).toISOString(), baseline);
  assert.equal(amazonPauseUntil(now, 'invalid').toISOString(), baseline);
  assert.equal(amazonPauseUntil(now, '2026-10-29T02:00:00Z').toISOString(), baseline);
  assert.equal(amazonPauseUntil(now, '2026-11-01T00:00:00+00:00').toISOString(), '2026-11-01T00:00:00.000Z');
});
