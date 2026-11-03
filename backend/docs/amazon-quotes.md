# Amazon quote API

Backend implementation of plan 14. No catalog import occurs. Public Amazon reading is
disabled unless `AMAZON_QUOTES_ENABLED=1`; this change does not enable it, migrate an
active database or start a service. `PUBLIC_READ_ONLY=1` blocks quote and checkout writes.

## Frontend contract

- `POST /api/amazon/quotes` with `{ input: "ASIN or HTTPS Amazon JP product URL", quantity: 1 }`
  returns `{ quote }`. Short links are rejected. Treat `quote.id` as an opaque cart capability.
  The reader verifies the exact selected quantity; it rejects a page that ignores a
  quantity request. It does not infer quantity eligibility from a quantity dropdown.
- Display `title`, `variant`, `seller`, `quantity`, `priceJpy`, `unitPriceVnd`, `lineTotalVnd`,
  `observedAt`, `expiresAt`, `amazonDelivery`, `vietnamDelivery`, `deliveryDays` and
  `shippingEvidence`. Dates are `{ start, end }` or `null`. Vietnam dates are Mita estimates
  with calendar days added, not Amazon promises. The delivery destination is unverified;
  never label it Osaka. Unknown shipping is `shippingEstimatedVnd: null`, never zero.
- `POST /api/amazon/quotes/:id/refresh` returns `{ quote, changed, requiresConfirmation: true }`.
  Keep the cart item if refreshing fails. Never extend an old expiry locally. Replace the
  quote only after displaying it and obtaining confirmation. Quantity/variant changes
  require a new lookup; quantities on an existing quote cannot be changed at checkout.
- Existing `POST /api/checkout` accepts mixed carts:

  ```json
  {
    "customer": { "name": "...", "phone": "0901234567", "address": "..." },
    "items": [{ "asin": "CATALOG001", "quantity": 1 }],
    "quoteItems": [{ "quoteId": "UUID", "confirmed": true, "acknowledgeMissingEta": true }],
    "checkoutKey": "cryptographically random UUID, generated once for this submission"
  }
  ```

  `items` can be omitted for quote-only checkout. `confirmed: true` means the customer
  reviewed product, variant, seller, quantity, price and shipping terms. Require
  `acknowledgeMissingEta: true` when the displayed quote has no ETA. A quote's quantity
  and price come exclusively from its server snapshot. Multiple quotes for the same ASIN,
  or a quote and catalog line with the same ASIN, are retained as separate order lines.
  Keep `checkoutKey` private; reuse it for an identical network retry, never a changed
  submission. Reusing the same key returns the original order ID and, for Amazon orders,
  the shipping token. Catalog-only checkout also accepts an optional key for idempotent
  retries; legacy requests without a key still work. The browser retains the exact
  in-flight payload/key until a definite response, rather than refreshing first.
- Expired checkout automatically attempts a fresh lookup after rolling back. HTTP 409
  `quote_refresh_required` contains `details: { quote, changed, requiresConfirmation, previousQuoteId }`.
  Show and confirm the replacement, update its ID and use a fresh checkout key for the
  changed payload. A failed lookup never creates an order or extends the old quote.
  For several expired items, repeat until all are refreshed and confirmed.
- Checkout returns `orderId`, locked merchandise totals and `shippingConfirmationToken`.
  Retain the token privately with the order. It is a bearer capability, not a URL query
  parameter. Unknown shipping remains `null`. Quotes are consumed once under row locks;
  final expiry validation uses the DB wall clock immediately before commit. Successful
  orders preserve the price; Mita absorbs later Amazon merchandise price increases.
- To read a later fee proposal, `POST /api/amazon/orders/:id/shipping` with `{ token }`
  returns only `shippingProposedVnd`, `shippingFinalVnd` and `confirmedAt`, never PII.
  Show the proposed fee and obtain separate customer approval. Then
  `POST /api/amazon/orders/:id/shipping/confirm` with `{ token, shippingVnd }` applies
  only the exact current proposal. A superseded proposal returns 409.

Quote routes use `Cache-Control: no-store`. Expected error codes include
`invalid_amazon_input`, `offer_not_verified`, `amazon_quotes_disabled`, `amazon_busy`,
`amazon_cooldown`, `amazon_blocked`, `amazon_rate_limited`, `amazon_unavailable`,
`quote_rate_limited`, `missing_eta_acknowledgement`, `quote_already_ordered`,
`checkout_key_conflict` and `shipping_confirmation_conflict`. Disabled/unavailable
sources use 503; invalid input uses 400; conflicts use 409; unverified offers use 422.

## Owner and persistence

Authenticated Admin `GET/PUT /api/admin/amazon-quote-settings` reads/updates
`{ version, deliveryDays }` with optimistic concurrency and an audit event. Days default
to 7 and accept 0–90. Existing authentication, Owner role and CSRF checks apply.
Submitted quote snapshots retain the old days, dates and per-line pricing policy.
For a mixed cart, the order-wide pricing fields describe catalog pricing; each quote's
`order_items.quote_snapshot.pricingPolicy` describes its locked price.

Existing Admin order lists/details and Owner notifications include quote orders.
Setting `shippingFinalVnd` on a quote-containing order proposes the fee and returns
`requiresCustomerConfirmation: true`; it does not apply the fee. Once confirmed, that
fee cannot be rewritten through the ordinary Admin update. Customer approval is
recorded separately. This does not send a customer message or capture any payment.

`src/db/amazon-quotes.sql` is wired into migration, disposable test initialization and
SQL asset copying. Apply it only in a separately authorized release with backup and
live-schema verification. It adds tables/columns/indexes and permits NULL estimated
shipping; it does not rewrite legacy orders. The `order_items` legacy composite primary
key `(order_id,asin)` is replaced with an identity `line_id` primary key and partial
unique indexes for catalog lines and quote IDs, so repeated ASINs do not collide.
This needs live-schema/dependency checks and a migration lock review before any release.
Reverting application code leaves the data intact; do not drop quote snapshots or recreate
NOT NULL while unknown shipping rows exist.

## Access guards and release gaps

The reader shares `AMAZON_ACCESS_LOCK`, `amazonGate` and persistent CAPTCHA/403/429
pause handling with existing collectors. It makes one bounded, timed public HTTPS
request, without cookies, redirects, alternate proxies, retry loops or PC dependence.
Persistent limits allow 6 attempts per socket peer and 30 globally per minute across
quote/refresh/quote checkout requests. The API does not trust forwarded IP headers;
with a reverse proxy the peer limit is shared by its customers.

Parsing is deliberately conservative: exact ASIN, one selected one-time offer, price,
seller, variant, selected quantity, stock and unconditional non-Prime free standard shipping
must be established together. Generic or threshold-based free-delivery messages fail
closed; unrecognized text or alternate markup is rejected. Explicit
unambiguous Japanese dates/ranges are retained; relative dates, shorthand ranges and
unresolved year rollover remain unknown. No source HTML, cookies or account data are
stored. Snapshots record source URL and observed time; the target address is unverified.

Tests use synthetic HTML/fetch responses and a disposable database. They do not prove
real Amazon markup coverage, permission to republish data, category/import eligibility,
free shipping at Mita's real address, VPS runtime behavior or customer notification
delivery. Resolve these operational checks separately before enabling the reader.
