# Strict Top100 publication

`MITA_STRICT_TOP100=1` enables server-side strict publication. Unset, `0`, and all other values leave existing runtime behavior unchanged. Restart the API after changing it. Empty qualified data stays empty in strict mode; it never enables the mode or triggers a fallback.

Activate only after documented, licensed review evidence is available for the exact ASINs and an owner has reviewed publication rights. The owner visibility override is not a copyright license. Do not crawl restricted Amazon pages or insert synthetic evidence into a real database.

Only sellable, owner-rights-eligible products in `thuc-pham-bo-sung` and `thuc-pham-cho-be` participate. An observed basis plus group ID defines a group; otherwise each ASIN is independent. The existing `amazon_product_metrics` view requires exact-ASIN scope and rights, two distinct dated written review IDs in the current Asia/Tokyo year, preferring verified purchases and falling back to ordinary written reviews. Aggregate spec ratings remain display/order fallback only and cannot qualify a group.

At most 100 groups per category are selected before search, sorting and pagination, using the maximum qualified exact-ASIN ratingsCount, never a sibling sum. Sellable explicit siblings of selected groups share membership even without their own qualifying evidence. Public detail, variants, cart lookups, home/search lists and the checkout order's transactional product selection use this membership. Order persistence is unchanged. The three UI sort choices and default ratingsCount ordering are unchanged.

Tests reuse the feature branch disposable publication runner and guarded synthetic fixtures. Compile with `node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit false --outDir backend/.test-publication`, copy `backend/src/db/*.sql` into `backend/.test-publication/src/db/`, then run `node backend/.test-publication/tests/run-publication.js publication.test.js spec-ratings.test.js`; the publication suite runs with both flag values; existing regression suites run with the flag off. Synthetic evidence is restricted to random `mita_test_<16 hex>` databases.

Integration validation: backend and frontend TypeScript checks, frontend production build, and the full backend test suite (209/209) passed. The dedicated publication suite passed in both modes (4 tests each), plus two frontend star-rendering tests. All test evidence uses disposable databases; no production records or source-worktree files were changed.
