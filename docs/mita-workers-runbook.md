# Mita Windows worker lifecycle and daily VPS sync

Scope: Mita processes under this checkout only. The three cron queues default to 04:00, 05:00 and 05:15 **Asia/Tokyo**, with a five-minute dispatch allowance. Owner settings in `worker_control_settings` can change Amazon/name/detail schedules and select the name engine (`openrouter` or `codex`). The workers refresh schedules every 60 seconds; Supervisor reads the same settings for its dispatch/restart windows. Times must be ordered, at least 15 minutes apart, with detail before 23:45. A late Windows boot is recorded as skipped; no work is replayed. These are source contracts, not proof of the settings or revision in an existing process.

## Local startup and stop

- Manual: `./scripts/start-local.ps1` can initialize/start the local PostgreSQL cluster, installs missing dependencies and **always runs `db:migrate`** before starting API/web/Supervisor. It is not a safe diagnostic/start-only command; review target, SQL and process ownership and obtain authorization for its DB/service effects first. `./scripts/start-local-detail.ps1` starts a detail-only worker supervisor when no supervisor is active. Do not run both modes simultaneously.
- Windows logon task: `MitaJapan-LocalWorkers` uses `./scripts/register-mita-boot.ps1 -Apply` (an authorized stateful operation). Its trigger is logon for the Windows owner account, because SSH-agent and DPAPI are account-scoped. This does not run while Windows is at the sign-in screen. The 2026-10-29 registration record is historical; inspect current task/process ownership before relying on it.
- Logon launcher `start-mita-on-boot.ps1` only starts the existing Mita PostgreSQL cluster and supervisor, never imports source data, runs migrations, or starts the public website. It requires the backend dependencies and already initialized cluster.
- `./scripts/stop-local.ps1` writes private stop requests; workers exit after their daily jobs or Mita source/import lock releases, and outside dispatch windows. To stop the local DB use `-StopDatabase` only after the supervisor exits. Never terminate an active job via Task Manager.
- Logs and state live under `.agents/runtime/` and are private/untracked: `mita-supervisor.jsonl`, `mita-daily-YYYY-MM-DD.json`, `nightly-sync.out.log`, `nightly-sync.err.log`, individual worker logs, and `llama*.log`. State values are `running`, `completed`, `partial`, `failed`, `skipped`. A crash may leave a `running` sync marker; it needs manual inspection.

## Code updates and llama

The supervisor fingerprints each worker's relevant files. After 30 seconds of stable change, it restarts only the changed worker once the corresponding PostgreSQL advisory lock is free. It defers restarts from ten minutes before through seven minutes after that worker's daily due time, and while import/crawl/translation holds its lock. On Windows the final Node process termination is abrupt, so do not consider this an external all-job-drained IPC protocol; backend jobs must hold the documented advisory locks throughout their critical work.

`llama-on-demand.mjs` binds `127.0.0.1:8080` as a request gateway. Its owned GGUF child binds `127.0.0.1:8081` only after a detail inference request. Concurrent requests share one startup. The gateway waits for model health and stops that exact child after 15 minutes without active requests. If either port is occupied by an unrelated process, the launcher or request fails without stopping it. It never restarts a detail translation job by itself.

## Owner settings and manual jobs

Desktop Workers uses authenticated `/api/admin/workers` and Owner-only settings/manual endpoints. A manual request covers 1–300 products and goes through Supervisor IPC, advisory locks and a durable request journal; acceptance is not completion. Conflicting work or an unresolved earlier request fails closed, without queueing, stopping jobs or automatic retry. Manual worker outcomes do not replace the three scheduled outcomes required for nightly sync.

The separate `run-mita-jobs.bat` menu requires `CHAY` confirmation and targets only local `127.0.0.1:5433/postgres`. Amazon modes are images, price, presence (1–300 ASINs, default 20), and Full (the normal discovery/detail budget, up to 200 ASINs per category). Names uses the configured engine; GGUF reports translated text slots separately from products. It does not migrate, sync or deploy. See [manual jobs](mita-manual-jobs.md); source cooldown/denial and lock guards still apply. These commands write local data and are not smoke tests.

Codex names requires local automation verification, CLI login/quota and the Codex schema. It stores source-backed full/short names with revision/generation metadata; OpenRouter limits and permanent-success rules must not be generalized to this engine. Neither name engine translates detail slots or silently falls back to the other. Detail translation remains local GGUF.

Amazon cooldown re-entry is a separate guard: `backend/src/ingestion/source-access.ts` still uses the fixed 04:00 JST five-minute window and next-calendar-day reservation. Changing the configurable Amazon schedule does not move this guard; a blocked run outside that window cannot consume re-entry. Do not bypass the gate to reconcile a schedule mismatch.

## Nightly sync and migration

`nightly-vps-sync.ps1` runs only when the supervisor has terminal outcomes for all three workers for the **same JST day**. It opens an approved, temporary SSH tunnel on local `15432`, reads the existing DPAPI credential, then executes `backend/scripts/sync-catalog-vps.mjs --apply` and `--verify`. It refuses an occupied port rather than trusting an unknown tunnel. If the machine missed all three jobs, no nightly batch is attempted.

**Before first nightly sync**: review/apply required additive schema migrations in the established manual migration process, and separately run `node backend/scripts/migrate-vps-sync-ledger.mjs --apply` while the approved SSH tunnel and `MITA_VPS_DATABASE_URL` are configured. Its `--dry-run` checks ledger presence read-only. Daily sync never executes `schema.sql`, `admin.sql`, or other DDL. VPS translation/ledger DDL was explicitly applied on 2026-10-29; it remains separate from subsequent daily syncs.

The remote `catalog_sync_ledger` reserves one nightly/manual `--apply` attempt per JST day. Its `run_id`, three worker outcomes, local repeatable-read watermark, source hash, remote hash, and commit state are durable. Reservation happens before the remote catalog transaction; the final state and data commit together. A lost connection after commit does not justify replay: inspect the ledger and data verification output. A `running` or `failed` day is not retried automatically.

**One-Click Deploy** calls `sync-catalog-vps.mjs --deploy-apply` and uses a separate per-run ledger, so a known committed nightly result does not itself block a later One-Click update on the same JST day. Each run must pass schema/source preflights, acquire the shared writer lock, commit and verify. A known committed `partial` gallery snapshot differs from a still-`running` or uncertain claim, which requires inspection before another run. The wrapper checks `catalog_deploy_ledger` and applies its **reviewed additive/idempotent** migration only if missing; no separate `-MigrationsOnly` is required for that table.

**Current One-Click authorization boundary (AGENTS.md):** the owner's deliberate launch of the reviewed normal wrapper covers the existing full local `db:migrate` bundle, conditional `catalog_deploy_ledger` migration and VPS `migrate-vps-title-revisions.mjs --apply` (three additive revision columns) before sync. New/changed SQL and standalone migration commands need separate review and authorization. `-MigrationsOnly` additionally applies translation and nightly-ledger migrations and is separately authorized maintenance, not a default prerequisite. `-DataOnly` still writes DB and requires its own approval. `-DryRun` makes no DB writes/push but still fetches Git, reads DPAPI credentials, opens an SSH tunnel and writes local runtime logs; it is not an offline static check. Nightly sync itself never executes DDL. See [CI deploy](../deploy/mita/ci-deploy.md).

**Owner reaffirmed 2026-11-06:** One-Click creates no backup/dump and does not require one. Transaction rollback works only before commit; without an external backup, later data loss cannot be restored. Keep identity, tunnel ownership, migration scope, locks and sync-claim safeguards. This documentation update authorizes no operation.

Gallery transfers replace positions as a single transaction per ASIN when the source has a newer, apparently complete snapshot. Because this database schema has no persisted dimensions/provenance, shorter snapshots and explicitly tiny URL modifiers are treated as partial, preserving previous images. This is conservative: the script cannot independently certify the required 800px short edge; upstream parsing must still prove that. The daily sync does not copy orders, shipping/pricing settings, Admin roles, or remote rights/visibility decisions. New products receive the VPS defaults for rights and sale state.

Checks that require a controlled test environment: simultaneous cron/worker drain, local PostgreSQL locks, SSH tunnel ownership, remote migration repeatability, disconnect before/after remote COMMIT, and real DuckDNS API/ASIN reconciliation. No production synchronization or live Amazon request is part of the static tests.

On 2026-10-29 JST, the manually authorized once-per-day data-only batch committed and verified 831 products, 831 name rows, 12,701 atomic detail slots (1,554 translated), and zero per-table mismatches. Ledger status was `completed`. This is **not** evidence that the new code was deployed or that the five gallery QA products have five HiRes photos; these remain separate release/scan checks.

The owner-only Admin issue page reads **current persisted** name/detail warning metadata from PostgreSQL (included in the normal daily catalog data transfer), independently of the host-local `.agents/runtime/translation-warnings.jsonl` **event history**. The latter remains Windows-only unless separately transported; a missing VPS JSONL is not a missing PostgreSQL warning. Admin authentication and localhost restrictions still apply.

## Gallery pilot: historical gate and current launcher

`scripts/start-mita-supervisor.ps1` now explicitly sets
`AMAZON_GALLERY_PILOT_DATE=verified`, and `mita-supervisor.mjs` defaults an unset
value to `verified`. This enables normal future scheduled discovery instead of
re-arming the old 2026-10-30 pilot. Existing Supervisor processes retain their
old environment; a worker reload from an old Supervisor is not proof the new
setting was adopted. Activation requires an authorized, ownership/lock-checked
Supervisor restart; do not replay a missed schedule. The launcher comment records
pilot completion/owner approval, not fresh evidence of every live gallery.

An explicitly supplied date still arms the legacy single-date pilot gate. It
has no catch-up, respects cooldown/Retry-After and cannot be run manually.

The pilot skips listings, selects only B08FTSH6KP, B08F63WK3Z, B087JZ84K7,
B083XCNJTV, B07BZ9NR18 in `thuc-pham-cho-be` regardless of rank, and attempts at
most five distinct queue items. No child ASIN expansion is performed. Existing
source lock, cooldown, denial handling, snapshots, and 200/category ceiling
remain in force. A `galleryPilot` marker in `sync_runs.note` is committed before
requests under the source advisory lock. Once claimed, success, partial failure,
crash, and restart all consume the single pilot; changing the date does not
rearm it. A denied cooldown does not claim it. Do not delete the marker to retry.

Release `f85df3c` and Supervisor/AtLogOn checks on 2026-10-29 are historical
evidence, not the current deployed revision. For any new gallery claim, inspect
captured source evidence and the actual deployed galleries: image identities,
dimensions, thumbnail exclusion, old-cover preservation on partial results and
honest missing-image counts. Generated-URL parser tests do not prove live image
quality. Do not reset pilot markers or bypass cooldown/leases to obtain a rerun.
