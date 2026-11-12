import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleTranslateText } from '../src/amazon-translate.js';
import { advertisedAmazonDelivery } from '../src/amazon-quote-source.js';

test('free Google Translate adapter sends only fixed Google host and Vietnamese target', async () => {
  const text = 'ピタゴラス ' + Date.now().toString();
  let checked = false;
  const mock = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://translate.googleapis.com');
    assert.equal(url.pathname, '/translate_a/single');
    assert.equal(url.searchParams.get('client'), 'gtx');
    assert.equal(url.searchParams.get('sl'), 'ja');
    assert.equal(url.searchParams.get('tl'), 'vi');
    assert.equal(url.searchParams.get('q'), text);
    checked = true;
    return new Response(JSON.stringify([[['Hình học Pythagoras', text]]]), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  assert.equal(await googleTranslateText(text, mock), 'Hình học Pythagoras');
  assert.equal(checked, true);
});

test('Google translation failure never invents Vietnamese text', async () => {
  const denied = (async () => new Response('Forbidden', { status: 403 })) as typeof fetch;
  assert.equal(await googleTranslateText('安全警告の説明', denied), null);
  assert.equal(await googleTranslateText('Plain English', denied), 'Plain English');
  assert.equal(await googleTranslateText('安全警告'.repeat(400), denied), null);
  const malformed = (async () => new Response('{', {
    headers: { 'content-type': 'application/json' }
  })) as typeof fetch;
  assert.equal(await googleTranslateText('使用方法を表示', malformed), null);
});

test('first-order Japanese promotion has an advertised date but is not an unconditional delivery promise', () => {
  const observed = new Date('2026-11-12T05:30:00Z');
  assert.deepEqual(advertisedAmazonDelivery(
    '無料配送 11月14日 土曜日にお届け（初回注文特典） または 最も早い配送 明日 11月13日にお届け',
    observed), { date: '2026-11-14', conditional: true });
  assert.equal(advertisedAmazonDelivery('最も早い配送 明日 11月13日にお届け', observed), null);
  assert.equal(advertisedAmazonDelivery('お届け日未定', observed), null);
  assert.equal(advertisedAmazonDelivery('無料配送 13月40日にお届け', observed), null);
  assert.deepEqual(advertisedAmazonDelivery('無料配送 1月2日にお届け', new Date('2026-12-31T02:00:00Z')),
    { date: '2027-01-02', conditional: false });
});
