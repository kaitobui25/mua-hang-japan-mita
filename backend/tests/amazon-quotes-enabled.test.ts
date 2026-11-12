import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amazonQuotesEnabled } from '../src/config.js';

const localDb = 'postgresql://mita_local@127.0.0.1:5433/postgres';

test('local Windows backend defaults Amazon quotes ON without an env flag', () => {
  assert.equal(amazonQuotesEnabled({}, 'win32'), true);
  assert.equal(amazonQuotesEnabled({ API_PORT: '4000', DATABASE_URL: localDb }, 'win32'), true);
});

test('explicit flag overrides the default, including local opt-out', () => {
  assert.equal(amazonQuotesEnabled({ AMAZON_QUOTES_ENABLED: '0' }, 'win32'), false);
  assert.equal(amazonQuotesEnabled({ AMAZON_QUOTES_ENABLED: '1' }, 'linux'), true);
  assert.equal(amazonQuotesEnabled({ AMAZON_QUOTES_ENABLED: '' }, 'win32'), false);
});

test('VPS, different DB/port, and Linux never enable quotes implicitly', () => {
  assert.equal(amazonQuotesEnabled({}, 'linux'), false);
  assert.equal(amazonQuotesEnabled({ MITA_VPS_WORKER: '1' }, 'win32'), false);
  assert.equal(amazonQuotesEnabled({ API_PORT: '4100' }, 'win32'), false);
  assert.equal(amazonQuotesEnabled({ DATABASE_URL: 'postgresql://mita@127.0.0.1:15432/postgres' }, 'win32'), false);
  assert.equal(amazonQuotesEnabled({ DATABASE_URL: 'postgresql://mita_local@127.0.0.1:5433/test' }, 'win32'), false);
});
