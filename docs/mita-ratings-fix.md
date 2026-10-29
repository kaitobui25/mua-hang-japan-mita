# Mita ratings — 2026-10-29

The owner's later requirement supersedes ADR 0017 for ordinary popular sorting:
use Amazon **ratings count**, not written-review count. The `reviews` URL/API
sort key remains compatible; its label now says ratings. Default and unknown
sort keys use the same descending order, nulls last, with ASIN tie-breaking.
Ordering occurs before variant grouping and pagination.

Existing `product_details.specs["Customer Reviews"]` values such as
`4.2 4.2 out of 5 stars (76)` supply stars and ratings for cards and details.
Only the complete observed format is accepted, with matching scores in 0–5
and a nonnegative safe integer count. Correct comma thousands groups are
accepted; malformed or missing values remain unknown. No backfill, migration,
collector request, or production database mutation is required.

Structured Amazon metrics take precedence per field, including zero. Spec
fallback is read before translation and retains the product detail observation
time. When combining snapshots, the earlier timestamp is used so newer metrics
cannot make old spec data appear fresh. Neither fallback count nor stars create
written-review evidence or current-year qualification. The existing `top-reviews`
gate, cap, ordering, and qualification are unchanged.

Validation:

- `npm run lint`
- `npm --prefix backend run typecheck`
- `npm --prefix backend test` (creates a disposable local database)
- `node --test --experimental-test-isolation=none src/components/catalog/amazon-stars.test.mjs`

The regression suites include strict SQL parsing, list/detail agreement, sorting
before pagination, structured zero precedence, conflicting written-review
counts, stale timestamps, Top100 exclusion, and the rendered shared stars UI.
