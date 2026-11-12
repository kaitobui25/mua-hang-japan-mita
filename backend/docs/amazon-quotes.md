# Amazon quote API

Backend implementation of plan 14 and ADR 0019 (2026-11-04). No catalog import occurs.
Amazon reading is enabled by default only on Windows with API port `4000` and the
exact local `127.0.0.1:5433/postgres` database. `AMAZON_QUOTES_ENABLED=0` explicitly
disables it; `AMAZON_QUOTES_ENABLED=1` explicitly enables it in other environments.
`PUBLIC_READ_ONLY=1` blocks quote and checkout writes. Next.js routes local `/api/*`
traffic to that backend, not a second quote-only port. Other deployments remain
disabled by default. Interactive quote access has its **own** key
`source_access_blocks.source='amazon.co.jp:quote'` and advisory lock `70400201`.
The daily catalog/import/backfill uses `amazon.co.jp` and lock `70400200`.
A catalog block does not disable a customer's single-product quote, and a quote
CAPTCHA/403/429 does not pause catalog work. Both flows retain independent durable
denial markers, next-day safe retry reservation, and rate/source verification guards.
Allowing a quote request does not guarantee that Amazon will accept it.

The old standalone `4010` smoke backend/database is not part of the normal local
runtime. Do not reuse smoke quote IDs in carts or orders, delete source cooldown rows,
or apply schema migration automatically at startup. Active schema changes require a
verified backup and transactional migration review; disposable test databases remain
separate from the single operational database.

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
  `shippingType: 'unverified'` and `freeJapanShipping: false` mean that even
  domestic Japanese shipping remains unverified and is excluded from the
  merchandise amount; Mita must confirm it separately before payment or buying.
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

### Preview and purchase requests when Amazon shipping is conditional

For the newer selected one-time Amazon accordion, identical repeated hidden ASIN
inputs are accepted only if all carry the requested identity. A unique visible
one-time total is used instead of its different per-unit/subscription prices.
Some Amazon products instead use a single active `form#addToCart` with no
accordion; these are eligible only with a matching product ASIN, selected
offer ID, unambiguous seller, one-time total, visible enabled add-to-cart,
stock, and an explicit matching quantity selection. A selected accordion
without a quantity dropdown can support exactly **one** unit when it shows
exactly **one** remaining unit and a visible enabled add-to-cart action.
Neither pattern is permission to treat a subscription quantity field as the
one-time quantity. Explicit backorders (such as a `1–2 months to dispatch`
notice) do not prove in-stock checkout and remain source-backed contact requests.
If the source additionally proves an exact selected offer ID, selected quantity,
stock (including an explicit Japanese `残りN点` count), and a matching selected-row
merchant name (including `Amazon.co.jp`), the merchandise
can receive a locked-price quote **without any domestic shipping promise**:
`shippingType='unverified'`, `freeJapanShipping=false`, `amazonDelivery=null`,
and separate later shipping confirmation. This does not label a generic
`無料配送` promotion as unconditional free standard shipping. The selected seller
name must be unambiguous across its repeated merchant links and seller labels;
otherwise the quote is rejected. Legacy/ambiguous
offers still fail closed and must never inherit an unrelated seller or price.
Checkout of an already issued, single-use locked-price quote does not repeat
the source lookup rate limit; it revalidates the persisted capability and
its expiry. Manual Owner payment marking for an Amazon quote additionally
requires the customer's confirmed final shipping fee.

When a genuine exact-ASIN preview has one valid observed product price but the
buybox cannot verify seller, stock, offer ID, quantity or either a verified
shipping arrangement or the narrowly guarded unverified-shipping path above,
Mita **does not issue a locked-price quote**. In particular,
`初回注文特典` is an Amazon first-order shipping offer, not proof that
Mita customers receive unconditional free shipping. Instead,
`POST /api/amazon/quotes` may reply HTTP 422 with
`details: { preview, requestId, expiresAt }`. The UUID is issued only
after a single genuine Amazon source read and stored in `amazon_quotes` as
`kind: 'purchase_request_preview'`, expiring 15 minutes after observation.
There is no additional Amazon fetch. A source with no verified product identity
or no single observed current price cannot issue a request capability.

The mobile preview uses the same `product-detail` hierarchy and CSS as the
catalog product page (image, localized title, rating, VND price, quantity,
purchase button, shipping note, ASIN and product information). The only extra
product field is Amazon's advertised delivery date when explicit in the first
delivery option; conditional first-order delivery is labelled as conditional.
It removes the separate source-information cards, translation bar and
instructions shown on the earlier Amazon preview.

The mobile preview displays a functional **Yêu cầu đặt mua**
button. It opens a customer contact form which calls
`POST /api/amazon/purchase-requests` with
`{ requestId, checkoutKey: UUID, quantity: 1..99, customer: { name, phone, address, email? }, confirmed: true }`.
The backend ignores submitted title/price/seller fields and reads the original,
unexpired preview under a row lock. Duplicate submissions with the same key
return the original ID; consumed requests with any other key return 409.
Contact submission uses the source-issued, once-only capability and does not
consume an additional Amazon source-lookup rate-limit slot; the last eligible
preview in a rate window remains actionable.
Its persisted `orders.status='purchase_request'` and
`order_items.quote_snapshot.kind='purchase_request'` explicitly mean
**manual quote/contact requested, not an order to purchase at Amazon**.
The observed Amazon JPY price is retained as evidence; `unit_price_vnd=0`
and `merchandise_vnd=0` are schema placeholders, NOT a free product or
customer amount due. `estimated_shipping_vnd=NULL`, no shipping token,
no charge, and no seller/stock facts are manufactured. Owner must contact
the customer with a new confirmed quote before any actual purchase/payment.
Owner cannot mark these requests paid/confirmed or set final shipping in this
state; cancellation remains available. Owner notification clearly labels
these records as requests. A real customer submission sends a real Owner
alert; tests must use only disposable DB.

For display only, a rejected source preview also includes `estimatedPriceVnd`
calculated from the current persisted Mita pricing policy (JPY/VND exchange
rate plus service fee). This is **not** inserted as a locked order price and
cannot be used by the regular checkout. Verified quotes retain their own
locked `unitPriceVnd`. The storefront displays VND as its primary currency.
Only explicit Amazon calendar dates from the first, non-fastest delivery
option may be shown; relative/ambiguous dates remain unknown.

Japanese product text is translated to Vietnamese on the backend, without
sending customer/order data, using Google's publicly accessible free web
translation endpoint. This interface is unofficial, has no availability
guarantee, and may respond with HTTP 429; there are no retries on denial,
proxy rotation or CAPTCHA workarounds. Native bounded HTTPS requests have a
short timeout, cap source and response bytes, and return optional
`translated` display-only fields; the original source snapshot remains
unaltered for identity, checkout and auditing. On failure the original
source text remains visible rather than fabricated Vietnamese.

### Source preview on rejected offers

An `offer_not_verified` `QuoteError` (422) may include exactly this details shape:

```ts
{ preview: {
  asin: string;
  sourceUrl: string; // https://www.amazon.co.jp/dp/<ASIN>, no query parameters
  title: string; // source #productTitle, plain text, at most 1000 characters
  observedAt: string; // ISO timestamp of the same source observation
  priceJpy?: number; // optional positive integer, at most 100000000
  estimatedPriceVnd?: number; // display-only, not a committed quote
  translated?: { title?: string; description?: string; features?: string[]; /* more source fields */ };
  advertisedJapanDeliveryDate?: string; // explicit YYYY-MM-DD only
  advertisedDeliveryConditional?: boolean; // e.g. 初回注文特典
  observedDetails?: { images?: string[]; brand?: string; description?: string; features?: string[];
    ingredients?: string; usage?: string; warnings?: string;
    specifications?: { name: string; value: string }[]; rating?: number; reviewCount?: number };
  deliveryText?: string; // optional text from the product buybox delivery block
  freeDelivery?: true; // only when a free-delivery label appears inside that block
} }
```

The preview requires the same valid public HTML response, one exact `input#ASIN`,
a unique visible title and no conflicting canonical product URL.
CAPTCHA/blocked responses and ASIN mismatches carry no preview. Text excludes
scripts, hidden content and markup. Price is read from primary product current-price
regions (including `#desktop_buybox #corePrice_feature_div .a-offscreen`) without
requiring selected-offer, seller, stock, quantity or accordion verification.
Conflicting/malformed/hidden prices, reference/list prices and recommendation prices
are omitted. The main image uses validated `data-old-hires` or `src` from
`#landingImage`; other images are confined to `#altImages`. The preview may
also carry product facts, features/specifications and Amazon aggregate rating/count.
No image or review is synthesized from the ASIN or Mita catalog.

This is product information for display only, not a verified quote or locked-price
checkout capability. A separate, server-issued purchase request ID may allow
human follow-up as described above. If the main product delivery block contains `無料配送`, `通常配送無料`
or `FREE delivery`, the UI labels that **observed source statement** as free
delivery, including the original source wording. It does not establish standard
service, a specific recipient/address, quantity, eligibility or checkout authority.
It never sets verified quote `freeJapanShipping`. The strict quote rejection and
source/cooldown guards remain unchanged; no new Amazon fetch is made.
The local preview may include source image URLs; it does not return HTML or cookies.
The live publishing rights of image/description content remain a separate issue to
review before any production deployment. No permission-reference is fabricated.

## Optional product display metadata (plan 18)

`PublicOffer` / `AmazonQuote` may carry an optional `display` object, separate from
offer terms. It has `provenance: { asin, sourceUrl, observedAt, permissionReference }`
and optional fields:

| Field | Meaning / maximum |
| --- | --- |
| `images` | Up to 10 distinct HTTPS media-amazon.com image URLs, each 2048 characters |
| `brand` | Original brand text, 500 characters |
| `description` | Original plain text, 12000 characters |
| `features` | Up to 20 distinct source bullets, each 2000 characters |
| `ingredients`, `usage`, `warnings` | Explicitly labelled source sections, each 4000 characters |
| `specifications` | Up to 40 distinct `{ name, value }` rows, 500 / 2000 characters |
| `rating` | Explicit Amazon aggregate score, greater than 0 and at most 5 |
| `reviewCount` | Explicit Amazon aggregate rating count (including ratings without written reviews), not the number of extracted review excerpts |
| `reviews` | Up to 10 distinct `{ body, title?, rating? }` excerpts, body 4000 / title 500 characters |

Missing, ambiguous, malformed or oversized fields are omitted; an empty `display`
is omitted entirely. Text is extracted without HTML/scripts, hidden or aria-hidden
content, with block/line boundaries preserved as spaces. Consumers must render it
as text, never as raw HTML. Numbers, units, model/brand identifiers and original
language are retained **in the stored source snapshot**. The response may
add the optional display-only Google translation described above. Aggregate
ratings/counts belong to Amazon and must never be labelled as Mita reviews.

Extraction uses only the same validated selected-ASIN page response after all offer
guards succeed. Images come from the rendered landing image / gallery, not alternate
variant scripts or catalog fallback. No image/review request, alternate variant
selection or additional source access is performed. Unverified offers still fail
closed even if product metadata exists. Existing `imageUrl` behavior is unchanged.

**Permission gate:** `parsePublicOffer(html, asin, quantity, observedAt, permission?)`
and `readPublicOffer(asin, quantity, permission?)` accept a trusted backend-only
`AmazonDisplayPermission` containing a nonempty `reference` to reviewed source/display
rights evidence and an explicit `fields` allowlist. For example, a review permitting
only brand and features supplies `{ reference: "review-record-id", fields: ["brand",
"features"] }`; it does not authorize ratings, reviews or images. Never derive this
permission from request input or page claims, or include private credentials in the
reference. The reference records a decision; the parser cannot establish legal rights.

There is no default permission or new environment toggle. The normal quote API caller
does not supply permission, so new metadata stays absent until source/rights review
and separately reviewed trusted caller wiring. This implementation supplies parsing
and DTO support without claiming that real Amazon content or commercial display
rights have been verified. Existing quote building preserves optional display data;
refresh comparison excludes it. Pricing, expiry, checkout terms and persistence SQL
are unchanged; no migration is needed for this optional JSON snapshot property.

Focused offline verification: `node --import tsx --test tests/amazon-quote-source.test.ts
tests/amazon-quotes-unit.test.ts` from `backend/`. Both suites use synthetic HTML and
mock fetch responses; neither issues DB queries or live Amazon requests. The standard
full test runner still requires a verified disposable database target as documented
above. No live schema or runtime claims follow from these unit tests.

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

The reader uses its own `AMAZON_QUOTE_ACCESS_LOCK`, `amazonQuoteGate` and persistent
quote-scoped CAPTCHA/403/429 pause handling, separate from scheduled collectors.
It makes one bounded, timed public HTTPS
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
