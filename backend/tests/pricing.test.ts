import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFresh, validateExpiryPolicy } from '../src/pricing.js';
import { canCheckoutProduct, publicProduct, type DbProduct } from '../src/catalog.js';
import { config } from '../src/config.js';
const policy = { version: 1, fxJpyToVnd: 190, serviceFeePercent: 12, checkPriceExpiry: false, priceExpiryDays: 1 };
const old = new Date(Date.now() - 10 * 86400000);
const product = { asin: 'PRICE00001', name: 'Fixture', rights_status: 'verified', admin_hidden_at: null,
  sale_status: 'ready', availability: 'in_stock', price_jpy: 1000, price_observed_at: old, last_seen_at: old } as DbProduct;
test('optional expiry preserves price timestamps and other checkout gates', () => {
  const previous = config.publicReadOnly;
  config.publicReadOnly = false;
  try {
    assert.equal(canCheckoutProduct(product, policy), true);
    assert.equal(canCheckoutProduct(product, { ...policy, checkPriceExpiry: true }), false);
    assert.equal(canCheckoutProduct(product, { ...policy, checkPriceExpiry: true, priceExpiryDays: 11 }), true);
    assert.equal(publicProduct(product, policy).priceObservedAt, old.toISOString());
    for (const patch of [{ price_jpy: null }, { price_jpy: 0 }, { price_jpy: -1 }, { price_jpy: NaN },
      { availability: 'out_of_stock' }, { availability: 'unknown' }, { sale_status: 'pending_review' }, { admin_hidden_at: old }]) {
      assert.equal(canCheckoutProduct({ ...product, ...patch }, policy), false);
    }
    assert.equal(canCheckoutProduct({ ...product, price_observed_at: null }, policy), true);
    assert.equal(canCheckoutProduct({ ...product, price_observed_at: null }, { ...policy, checkPriceExpiry: true }), false);
  } finally { config.publicReadOnly = previous; }
});
test('expiry validates integer days and exact age boundary', () => {
  for (const priceExpiryDays of [1, 365]) validateExpiryPolicy({ checkPriceExpiry: false, priceExpiryDays });
  for (const priceExpiryDays of [0, -1, 366, 1.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => validateExpiryPolicy({ checkPriceExpiry: true, priceExpiryDays } as never));
  }
  assert.throws(() => validateExpiryPolicy({ checkPriceExpiry: 'true', priceExpiryDays: 1 } as never));
  const realNow = Date.now;
  Date.now = () => 2000000000000;
  try {
    assert.equal(isFresh(new Date(Date.now() - 86400000), 1), true);
    assert.equal(isFresh(new Date(Date.now() - 86400001), 1), false);
    assert.equal(isFresh(new Date(Date.now() + 1), 1), false);
    assert.equal(isFresh('invalid', 1), false);
  } finally { Date.now = realNow; }
});
