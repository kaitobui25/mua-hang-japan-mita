#!/usr/bin/env node
// Read-only customer-facing verification. The invalid checkout request must
// never create a real order; do not send customer details from this script.
import assert from 'node:assert/strict';

const base = 'https://mitajapanshop.duckdns.org';
const bannedCopy = [
  'Hàng Nhật chọn lọc. Giá VND. Đang mô phỏng đặt hàng.',
  'Ảnh từ dữ liệu catalog khi nguồn cho phép hiển thị.',
  'Chưa thể thanh toán sản phẩm này. Hệ thống yêu cầu',
  'Tạo đơn mô phỏng'
];
function lowResolution(url) {
  const modifier = new URL(url).pathname.match(/\._([^/]+)_\.(?:jpe?g|png|webp)$/i)?.[1] ?? '';
  const dimensions = [...modifier.matchAll(/(?:^|_)(?:AC_)?(?:SL|SX|SY|SR|US|UX|UY|UL|SS)(\d+)(?:,(\d+))?(?=_|$)/gi)]
    .flatMap(match => [Number(match[1]), ...(match[2] ? [Number(match[2])] : [])]);
  return dimensions.length > 0 && Math.max(...dimensions) < 800;
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20000), redirect: 'manual', ...options });
  return response;
}

async function html(path) {
  const response = await request(path);
  assert.equal(response.status, 200, `${path}: expected HTTP 200, got ${response.status}`);
  const body = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /text\/html/i);
  for (const copy of bannedCopy) assert.equal(body.includes(copy), false, `${path}: obsolete copy ${copy}`);
  return body;
}

await html('/');
await html('/thanh-toan');
const listingResponse = await request('/api/catalog?limit=100&page=1');
assert.equal(listingResponse.status, 200, 'Catalog API');
const catalog = await listingResponse.json();
assert.ok(catalog.total >= 5 && Array.isArray(catalog.items), 'Catalog must have at least five products');
const selected = catalog.items.filter(p => p.canCheckout && p.priceVnd > 0).slice(0, 5);
assert.equal(selected.length, 5, 'Need five orderable, priced catalog cards');

for (const product of selected) {
  const asin = product.asin;
  assert.match(asin, /^[A-Z0-9]{10}$/);
  const response = await request(`/api/catalog/products/${asin}`);
  assert.equal(response.status, 200, `${asin}: detail API`);
  const detail = await response.json();
  assert.equal(detail.asin, asin);
  assert.equal(detail.canCheckout, true, `${asin}: must allow ordering`);
  assert.ok(detail.priceVnd > 0, `${asin}: missing positive VND price`);
  assert.ok(typeof detail.name === 'string' && detail.name.trim(), `${asin}: missing product name`);
  for (const url of detail.imageUrls ?? []) {
    assert.equal(lowResolution(url), false, `${asin}: gallery includes resized thumbnail ${url}`);
  }
  await html(`/san-pham/${asin}`);
  console.log(`PASS ${asin} detail/html price=${detail.priceVnd} gallery=${(detail.imageUrls ?? []).length} title=${detail.name.slice(0, 90)}`);
}

for (const path of ['/admin/login', '/api/admin/session', '/api/other']) {
  assert.equal((await request(path)).status, 404, `${path} must remain private`);
}
const invalid = await request('/api/checkout', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
});
assert.equal(invalid.status, 422, 'Invalid checkout must return 422 without persisting');
const ekaiwa = await fetch('https://ekaiwa.duckdns.org/', { signal: AbortSignal.timeout(20000), redirect: 'manual' });
assert.equal(ekaiwa.status, 200, 'E-KAIWA must remain available');
console.log(`PASS PUBLIC QA: 5/5 orderable products + checkout validation + Admin isolation + E-KAIWA (catalog=${catalog.total})`);
