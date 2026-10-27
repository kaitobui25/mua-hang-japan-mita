# Admin MVP verification — 27 October 2026

Implemented ADR 0009/0010 and plan 04 milestones A–E in the existing Next.js / Fastify / PostgreSQL app. No extra admin service, Docker, remote deployment, Windows service or Task Scheduler was added.

## Results

- Backend TypeScript check and frontend `npm run lint`: passed.
- Production Next.js build: passed, including all admin routes, storefront routes and middleware.
- 29 backend checks: 16 admin/security/checkout checks, 9 ingestion checks, 3 variant checks, 1 PostgreSQL scheduler check. Tests ran against a disposable database, not the operating owner/catalog.
- HTTP smoke test: unauthenticated redirects with no customer data, login, all four protected pages, order detail, forged-Origin rejection, logout/session revocation, and existing storefront/cart/checkout pages passed.
- Additive migration applied twice to the local database after creating a backup; no policy reseeding on repeat. A custom-format PostgreSQL backup was restored into a separate database; products, orders and policy snapshots were readable.
- PowerShell start/stop scripts: syntax checked. Existing services were left running; only temporary QA services on 3100/4100 were stopped.

Security checks cover salted scrypt hashes, single-owner setup, password reset/revocation, persisted login throttling, expired/logout sessions, all admin API authorization, loopback IP/Host, CSRF/Origin, no-store responses, URL canonicalization/SSRF boundaries, hidden public details/catalog/checkout and siblings, hide preservation after ingestion/re-import, stale/rights/availability checks, queue deduplication/limits/failure/interruption states, atomic pricing/audit rollback, concurrent policy writers and coherent checkout snapshots.

The scheduler integration uses pg-boss `TestClock` with real PostgreSQL: no dispatch before 04:00 JST, one dispatch while the worker stays active across 04:00, no catch-up after downtime. It does not change the Windows clock or claim a live Amazon scan occurred at wall-clock 04:00.

## Environment limits

This Codex sandbox rejects Node child-process spawning (`spawn EPERM`), so the normal `tsx` test command and default Next build worker could not run here. Equivalent checks used TypeScript-emitted JavaScript with Node's in-process test mode, and a temporary Next build harness with webpack in-process and threaded workers. Final build artifacts are isolated under ignored `.verification/next`; shipping Next configuration does not enable those worker overrides. `npm test` outside this sandbox uses the documented disposable-database runner.

BrowserOS tool calls returned “MCP tool call requires approval, but approval policy is never.” Visual browser QA could not be performed. HTTP tests do not substitute for checking rendered layout, keyboard use and interactive confirmation dialogs in a browser. Live Amazon detail parsing remains subject to source markup/access; fixture tests verify fields, identity, price, denial behavior and no fabricated products.

## First use

Restart the project services to load the new code, run `npm run admin:setup` from an interactive terminal in `backend`, then open `/admin`. No real owner password was selected or installed by the implementation/tests. See [local operations](admin-local.md) for setup/reset, manual start/stop and backup/restore.
