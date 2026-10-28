# Amazon cooldown and legacy migration (owner decisions Q1=B, Q2=C, Q3=A, Q4=A, Q5=A)

Active sync states are running/success/partial/failed, detail queue states pending/success/failed, and import states pending/running/succeeded/failed. Historical sync_errors and audit messages remain verbatim, including legacy needs_human text.

CAPTCHA, HTTP 403 and login/verification stop source requests immediately. No fallback or challenge solver runs. HTTP 429 slows the persistent FetcherSession pace and allows at most two retries per request. Retry-After (seconds or HTTP date) is honored up to 10 seconds; a longer value enters cooldown without issuing an early retry or hanging IPC. Minimum request pacing stays 1.2 seconds; slower pacing survives a successful 429 retry for the rest of that session.

The shared source_access_blocks.retry_after_at is the following **JST calendar day's 04:00**, even if denial occurred before today's 04:00. Daily scans, imports and backfill hold advisory lock 70400200 across gate checks and source requests. Imports/manual commands never claim a due gate. Only the scheduled 04:00 worker (existing five-minute dispatch allowance, no catch-up after downtime) can reserve one re-entry. It advances the deadline to tomorrow before fetching. New denial replaces the cooldown; transient failure or crash retains tomorrow's reservation. An error-free run removes the gate. Translation remains independent at 05:00 JST.

Owner overview/API and worker:backfill:status expose the cooldown deadline. A cooldown run reports failed, or partial if good observations were saved before denial. An attempted denied import fails; untouched imports remain pending. The 200 unique ASIN/detail-attempt budget per category and run, serial mutex, good snapshots, catalog visibility and price history are unchanged. Manual ACK and CAPTCHA-open commands are retired.

## Controlled migration handoff

The orchestrator must independently test, apply the migration to the intended local database, verify it, and restart only the Amazon worker. This implementation does not migrate an existing local/production DB, restart workers, deploy, push or commit.

1. Pause the Amazon worker so old code cannot write legacy states after migration. Leave translation alone. Select the intended database explicitly and verify the target; do not run against production as part of this task.
2. From backend run `npm run db:migrate`. The source mutex is taken before schema/data changes and held through the transaction. The compiled build includes all three SQL assets. For a separately managed migration, take `SELECT pg_advisory_xact_lock(70400200)` immediately after BEGIN, then run schema.sql, admin.sql, and remove-needs-human.sql before COMMIT; the last SQL also takes the same transaction advisory lock. This is independent of web/VPS deployment.
3. Verify the two old queue rows are pending with unchanged last_attempt_at, no active legacy states remain, and sync_runs mapped to partial when saved_count > 0, otherwise failed. Legacy imports become pending, except duplicate ASIN losers become failed. Existing pending/running imports take precedence. Error text, audit, products, galleries, detail/translation snapshots and prices are retained.
4. Q5=A already confirms manual Amazon access. The migration archives the full old block (including legacy timer fields) into source_access_block_history and retires it exactly once, in the same locked transaction. A pre-cooldown row has NULL retry_after_at; new code always writes a non-NULL deadline. The data_migrations marker prevents reruns from clearing another old-format row, and any fresh non-NULL block survives even the first run. Do not issue DELETE/ACK against a fresh gate.
5. Verify the archive/marker and source_access_blocks, then restart only the Amazon worker. Use `npm run worker:backfill:status` to inspect queue counts and next retry. Starting daily mode does not perform an immediate scan; use only the approved schedule. Do not probe Amazon during verification.

Offline regression coverage includes legacy/duplicate migration, fresh-block protection and idempotence, shared lock exclusion, deterministic JST date boundaries, due-only daily re-entry, repeated-denial stop, HTTP 429 retry/Retry-After bounds (including transient exhaustion after a 429), snapshot preservation, ASIN fairness/budget and separate 04:00/05:00 schedules.

## Implementation verification (2026-10-28, unelevated Windows sandbox)

- Backend and frontend TypeScript checks passed; backend production build passed and includes remove-needs-human.sql.
- Python: 22 offline/loopback tests passed using backend/.venv-scrapling/Scripts/python.exe. Only the local redirect fixture server was contacted.
- Normal `npm test --prefix backend` could not start esbuild (`spawn EPERM`). Compiling tests with tsc and running each file with `node --test --experimental-test-isolation=none` against its own disposable local PostgreSQL database produced 89 passing TypeScript tests. The remaining 5 Scrapling subprocess IPC tests failed because this sandbox denies child-process spawning; they require the orchestrator's independent run. No tests were removed or marked skipped to hide that limitation.
- The final migration was retested after adding full legacy-block archival: passed. It verifies legacy state conversions, duplicate imports, unchanged attempt times/products/prices/errors/audit, full old-block archive, lock exclusion, fresh-block protection and idempotence.
- Only newly created mita_test_cooldown_* disposable databases were migrated and dropped. Existing application/production databases and worker processes were untouched. No real Amazon request, CAPTCHA action, external sample edit, commit, push or deployment occurred.
