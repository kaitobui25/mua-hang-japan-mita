# Mita Japan: Remove needs_human, use bounded source cooldown (Grill Me Q1–Q5)

**Date:** 2026-10-28 JST. **Decision:** Q1=B, Q2=C, Q3=A, Q4=A, Q5=A. **Status:** implemented and verified locally.

## Product contract

1. Remove `needs_human` from all *active* business states: `sync_runs`, `product_detail_queue`, `catalog_import_requests`, owner status/API, and new errors. Do not generate it again. Preserve `pending`, `success`/`succeeded`, `failed`, `partial`, `running` as applicable. Historical errors and audit remain intact (including legacy messages).
2. CAPTCHA, HTTP 403, verification/login: **stop all Amazon requests immediately** (no challenge solver and no fallback), persist one shared source-wide cooldown with next eligible **04:00 JST on the following calendar day**. Daily worker automatically gets *one* re-entry at that scheduled window, never unbounded/repeated probing. Failure on next day sets another cooldown; no operator ACK.
3. HTTP 429: reduce request pace and retry **up to twice** in the current FetcherSession request (honor longer `Retry-After` when feasible without runaway hangs). After exhaustion persist source cooldown until **04:00 JST the following calendar day**, stop this scan and imports. No retry on 403/CAPTCHA.
4. Existing two detail queue rows `needs_human` → `pending`, preserving last_attempt_at and historical `sync_errors`. Any historical `sync_runs.needs_human` → `partial` if saved_count > 0 else `failed`; historical imports `needs_human` → `pending` or `failed` if duplicate constraints require. Migrate DB constraints idempotently and independently of web/VPS deployment. No data deletion or price rewriting.
5. Owner says *Amazon access was manually checked and works* (Q5=A). After migration and verification, clear the **old** source-wide block once under existing advisory lock. Future new blocks must remain until their next eligible daily re-entry. Never clear a fresh new denial automatically early.
6. Keep 200 ASIN/detail attempts per category/run, serial source mutex across daily/imports/backfill, existing 1.2s pacing minimum, independent translation 05:00 and 04:00 local Amazon worker (no catch-up), no proxy rotation or CAPTCHA bypass. Preserve good snapshots, catalog visibility and no VPS push/deploy.

## Implementation sequence

1. Change source error classifier and Python bridge: blocked vs 429 `rate_limited`, retry bound/pace, no `needs_human` in live response.
2. Shared cooldown state in `source_access_blocks` (`retry_after_at` timestamp with migration) and JST next-day 04:00 deterministic helper. Guard *all* source entrypoints. On scheduled daily scan, claim due gate under advisory lock; otherwise don't fetch. A cooldown counts as `failed`/`partial` sync, not a new state.
3. Update queue state machine, Admin Import, worker commands/status, remove obsolete manual ACK and CAPTCHA-open flow from normal operations. Keep optional manual Amazon verification separate if needed, but no status dependent on it.
4. Add idempotent schema/data migration. Test legacy migration, concurrent lock, 403/CAPTCHA single-stop + next-day automatic re-entry, 429 two bounded retries and cooldown, snapshot preservation, ASIN fairness/budget, and worker/translation schedule isolation.
5. Run full tests; migrate local DB under access lock, reconcile two old ASINs and remove legacy block because Q5=A; restart only Amazon Worker (translator untouched). Verify DB and log; commit local with clean tree, no push.

## Local completion (2026-10-28 JST)

- Backup: `.agents/runtime/before-needs-human-migration-20261028.dump` (241241 bytes), before database migration.
- Local PostgreSQL migration passed. Queue: `B0FD9C1FD9` and `B00JWK5ILK` now `pending`; totals `pending=216`, `success=209`. Sync runs 6/7/8 became `partial`/`failed`/`failed`. Legacy Amazon block archived with original timings, then retired under advisory lock; migration marker persisted.
- pg-boss schedules unchanged: catalog 04:00 JST, translator 05:00 JST. Restarted Amazon Worker only; translator was not stopped. No unscheduled live Amazon probe, Git push or VPS deployment.
- Final tests: backend 94/94, Python Scrapling 22/22; backend typecheck/build and frontend typecheck passed. See `docs/amazon-cooldown.md` for implementation and verification details.
