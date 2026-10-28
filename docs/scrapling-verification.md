# Scrapling implementation verification — 2026-10-28

The approved plan 08 is implemented and the local Windows Amazon worker has been restarted with Scrapling. Reference files read: `C:/phong/AI/test/supplement-style-150/adapters/scrapling_client.py`, plus `parser.py` and `runner.py` at that sample project's root (not under adapters). No sample source was edited. The existing five-image limit and source-block safety remain intact.

Live entrypoints: daily sync uses one lazy `ScraplingSession` spanning both listing/detail categories; Admin Import uses `collectDetail` backed by the same bridge and enqueues observed children. Child downloads occur only through the existing PostgreSQL queue. No automated Neo collection methods remain. Explicit manual verification remains. Node source mutex, both persisted source gates, rights, prices and snapshots retain existing semantics. The 04:00 JST Amazon and separate 05:00 JST translator schedules are unchanged. No Amazon request, source-block clear, push or VPS deployment was performed.

Added Python BeautifulSoup parser/transport, Node JSONL bridge, virtualenv setup/preflight, Windows launcher preflight, offline fixtures, and documentation. Script parsing reads bounded JSON values without evaluating JavaScript. Gallery and variants reject unrelated owners/current ASINs. All redirects are refused without following. Max two transient retries, 1.2-second pacing, no retries after denial, per-run success/failure cache, no recursive Python child fetching. IPC limits: 4 KiB Node request, 2 MiB Python response, 8 MiB received HTML, 110-second deadline; at most 400 unique detail cache entries across two categories.

Verified:

- Python 3.12.10; installed Scrapling 0.5 and BeautifulSoup 4.15.0 into the project-owned `backend/.venv-scrapling` on the Windows PC. Exact versions are pinned. The dependency API was inspected and tested using loopback HTTP only. Correct Scrapling parameter is `follow_redirects=False`; internal retry count is zero (outer loop owns retry policy).
- 14 Python offline/loopback tests pass: both listings, detail fields, image evidence and provenance, variants, identity mismatch, scoped script data, normal sign-in links versus login forms, denial latch, bounded retries, success/failure cache, redirect refusal and actual FetcherSession redirect behavior.
- Windows dependency/session preflight passes against the project-owned virtualenv without any source request. Actual Python JSONL startup/error response was checked using an invalid operation, without source requests.
- Backend typecheck and production build pass.
- Compiled JavaScript validation in disposable local PostgreSQL databases passes the relevant existing suites: enrichment 7, detail sync 1, gallery 12, Admin 18, ingestion 12, detail 9, schedule 1 (60 tests total). Includes 200 unique-ASIN limit, child overflow, source blocks across runs/imports, rights/freshness preservation, partial snapshots, five-photo persistence and additive migration. Two additional pure bridge tests pass and check five-photo normalization and denial reporting order.

Codex CLI sandbox limitations (resolved by independent Windows terminal checks):

- Codex sandbox denied some Python setup and Node subprocess operations. The real Windows terminal successfully installed all dependencies and ran the complete backend test runner in its own isolated test databases. No global packages were installed.
- The worker was restarted with the new code, independent translator left running; schedules remain `catalog.daily = 0 4 * * *` and `translation.names.daily = 0 5 * * *` in `Asia/Tokyo`.
- The live `source_access_blocks` row is still `amazon.co.jp / needs_human` and was not cleared. No real Amazon collection was attempted as part of this activation.

## Independent Windows terminal verification

Chat On Steroids Core successfully ran `scripts/setup-scrapling.ps1` in the real Windows terminal; Python dependencies were installed into `backend/.venv-scrapling` and the offline preflight passed. The local backend `npm test` passed 93/93 tests **after** the final five-photo assertion changes, and Python passed 13/13 then 14/14 fixture/loopback tests. Existing five-image catalog and database limit are retained; no new schema migration is required for Scrapling.
