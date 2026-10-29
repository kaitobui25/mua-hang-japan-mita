# Mita Windows worker lifecycle and daily VPS sync

Scope: Mita processes under this checkout only. The three cron queues stay at 04:00, 05:00 and 05:15 **Asia/Tokyo**, with their original five-minute dispatch allowance. A late Windows boot is recorded as skipped; no work is replayed.

## Local startup and stop

- Manual: `./scripts/start-local.ps1` starts local API/web and the worker supervisor. `./scripts/start-local-detail.ps1` starts a detail-only worker supervisor when no supervisor is active. Do not run both modes simultaneously.
- Windows logon task: `MitaJapan-LocalWorkers` was registered and verified on 2026-10-29 with `./scripts/register-mita-boot.ps1 -Apply`. Its trigger is logon for the Windows owner account, because SSH-agent and DPAPI are account-scoped. This does not run while Windows is at the sign-in screen.
- Logon launcher `start-mita-on-boot.ps1` only starts the existing Mita PostgreSQL cluster and supervisor, never imports source data, runs migrations, or starts the public website. It requires the backend dependencies and already initialized cluster.
- `./scripts/stop-local.ps1` writes private stop requests; workers exit after their daily jobs or Mita source/import lock releases, and outside dispatch windows. To stop the local DB use `-StopDatabase` only after the supervisor exits. Never terminate an active job via Task Manager.
- Logs and state live under `.agents/runtime/` and are private/untracked: `mita-supervisor.jsonl`, `mita-daily-YYYY-MM-DD.json`, `nightly-sync.out.log`, `nightly-sync.err.log`, individual worker logs, and `llama*.log`. State values are `running`, `completed`, `partial`, `failed`, `skipped`. A crash may leave a `running` sync marker; it needs manual inspection.

## Code updates and llama

The supervisor fingerprints each worker's relevant files. After 30 seconds of stable change, it restarts only the changed worker once the corresponding PostgreSQL advisory lock is free. It defers restarts from ten minutes before through seven minutes after that worker's daily due time, and while import/crawl/translation holds its lock. On Windows the final Node process termination is abrupt, so do not consider this an external all-job-drained IPC protocol; backend jobs must hold the documented advisory locks throughout their critical work.

`llama-on-demand.mjs` binds `127.0.0.1:8080` as a request gateway. Its owned GGUF child binds `127.0.0.1:8081` only after a detail inference request. Concurrent requests share one startup. The gateway waits for model health and stops that exact child after 15 minutes without active requests. If either port is occupied by an unrelated process, the launcher or request fails without stopping it. It never restarts a detail translation job by itself.

## Nightly sync and migration

`nightly-vps-sync.ps1` runs only when the supervisor has terminal outcomes for all three workers for the **same JST day**. It opens an approved, temporary SSH tunnel on local `15432`, reads the existing DPAPI credential, then executes `backend/scripts/sync-catalog-vps.mjs --apply` and `--verify`. It refuses an occupied port rather than trusting an unknown tunnel. If the machine missed all three jobs, no nightly batch is attempted.

**Before first nightly sync**: review/apply required additive schema migrations in the established manual migration process, and separately run `node backend/scripts/migrate-vps-sync-ledger.mjs --apply` while the approved SSH tunnel and `MITA_VPS_DATABASE_URL` are configured. Its `--dry-run` checks ledger presence read-only. Daily sync never executes `schema.sql`, `admin.sql`, or other DDL. VPS translation/ledger DDL was explicitly applied on 2026-10-29; it remains separate from subsequent daily syncs.

The remote `catalog_sync_ledger` reserves one attempt per JST day. Its `run_id`, three worker outcomes, local repeatable-read watermark, source hash, remote hash, and commit state are durable. Reservation happens before the remote catalog transaction; the final state and data commit together. A lost connection after commit does not justify replay: inspect the ledger and data verification output. A `running` or `failed` day is not retried automatically. Manual `--apply` also consumes the day's ledger slot, so schedule deployments/data-only operations accordingly.

Gallery transfers replace positions as a single transaction per ASIN when the source has a newer, apparently complete snapshot. Because this database schema has no persisted dimensions/provenance, shorter snapshots and explicitly tiny URL modifiers are treated as partial, preserving previous images. This is conservative: the script cannot independently certify the required 800px short edge; upstream parsing must still prove that. The daily sync does not copy orders, shipping/pricing settings, Admin roles, or remote rights/visibility decisions. New products receive the VPS defaults for rights and sale state.

Checks that require a controlled test environment: simultaneous cron/worker drain, local PostgreSQL locks, SSH tunnel ownership, remote migration repeatability, disconnect before/after remote COMMIT, and real DuckDNS API/ASIN reconciliation. No production synchronization or live Amazon request is part of the static tests.

On 2026-10-29 JST, the manually authorized once-per-day data-only batch committed and verified 831 products, 831 name rows, 12,701 atomic detail slots (1,554 translated), and zero per-table mismatches. Ledger status was `completed`. This is **not** evidence that the new code was deployed or that the five gallery QA products have five HiRes photos; these remain separate release/scan checks.

The owner-only Admin issue page reads **current persisted** name/detail warning metadata from PostgreSQL (included in the normal daily catalog data transfer), independently of the host-local `.agents/runtime/translation-warnings.jsonl` **event history**. The latter remains Windows-only unless separately transported; a missing VPS JSONL is not a missing PostgreSQL warning. Admin authentication and localhost restrictions still apply.

The supervised Windows worker defaults to `AMAZON_GALLERY_PILOT_DATE=2026-10-30`
until reviewed; the date arms **only** that JST date's 04:00 scheduled dispatch.
For the currently known cooldown, the earliest possible date is 2026-10-30;
a later source Retry-After still wins. No manual command runs this pilot.
An empty, invalid, expired, or future setting fails closed; there is no catch-up.
Keep the setting present after the run to prevent daily broad backfill while QA
is pending. **After the five ASINs have been reviewed on DuckDNS**, explicitly
set `AMAZON_GALLERY_PILOT_DATE=verified` in the supervisor's environment and
restart the Amazon worker outside its scheduled window to resume future normal
scheduled discovery. Simply unsetting the variable re-arms the safe default.

The pilot skips listings, selects only B08FTSH6KP, B08F63WK3Z, B087JZ84K7,
B083XCNJTV, B07BZ9NR18 in `thuc-pham-cho-be` regardless of rank, and attempts at
most five distinct queue items. No child ASIN expansion is performed. Existing
source lock, cooldown, denial handling, snapshots, and 200/category ceiling
remain in force. A `galleryPilot` marker in `sync_runs.note` is committed before
requests under the source advisory lock. Once claimed, success, partial failure,
crash, and restart all consume the single pilot; changing the date does not
rearm it. A denied cooldown does not claim it. Do not delete the marker to retry.

Release `f85df3c` was verified live on DuckDNS on 2026-10-29 and the Windows
supervisor/AtLogOn activation was verified. The actual five-ASIN gallery pilot
and source image dimension proof remain outstanding. Before broad backfill,
verify the saved real nine-HiRes HTML offline, then review all five DuckDNS
product galleries after an authorized scheduled run: actual image identities,
source provenance, dimensions, thumbnail exclusion, old-cover preservation on
partial results, and honest missing-image counts. The existing Python wrapper
test uses generated URLs; it is not evidence of a captured real-page fixture or
of live results for these five products.
