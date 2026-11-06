# Deploy Mita Japan using `[deploy]` in the commit message

## Owner actions

**One-click Windows release (source behavior):** After reviewing/authorizing the effects below, double-click `deploy-one-click.bat` at the repository root. It pins the **already committed HEAD** and verifies Git/SSH access, runs the local migration runner, checks/ensures the reviewed One-Click deploy ledger through the SSH tunnel, calls the title-revision migration, syncs catalog + translations + images, verifies the data, pushes the exact pinned commit to `main`, waits for the exact GitHub Actions run, then checks DuckDNS HTTPS, release revision, catalog, public checkout validation, private Admin paths and E-KAIWA. The window stays open until any key is pressed, including on failure. **It does not stage or commit untracked/unfinished local work.** Data sync preserves production Admin accounts, historical orders, pricing policy, catalog toggle and rights flags; approved translations have the source-matched newer Codex revision exception below. It does not scrape Amazon or charge a payment method. Read `docs/hermes-vps-runbook.md` for prerequisites.

**Hermes receiver version gate:** `/usr/local/sbin/mita-ci-receive` is a separately installed, root-owned script; a GitHub push does not update it. It must match `deploy/mita/receive-ci-release.sh` before the first checkout release. Release 0.3's receiver expected public `/thanh-toan` HTTP 404, while release 0.4 expects 200. Leaving the old receiver installed causes an otherwise healthy release to roll back after its readiness polling. Install and syntax-check the Mita-only receiver through the authorized owner SSH access; do not alter E-KAIWA or the global Caddy configuration.

`powershell.exe -NoProfile -File scripts/deploy-one-click.ps1 -DryRun` performs DB-read-only preflights, but **is not an offline/static check**: it authenticates `gh`, fetches `origin/main`, creates runtime output, reads DPAPI credentials and opens/closes an SSH tunnel. `-DataOnly` skips code push/release but still applies local schema, prepares the deploy ledger, applies title-revision DDL and writes/verifies catalog data. `-MigrationsOnly` skips local migration/catalog transfer/code release but applies VPS deploy-ledger, translation, nightly-ledger and title-revision migrations; it is separately authorized maintenance. Combined with `-DryRun`, it checks without DB writes. SSH agent, owner Hermes key, encrypted VPS DB credentials and `gh` authentication must already be configured.

**Current reviewed One-Click scope:** the normal wrapper calls the full local `backend/src/db/migrate.ts` runner and `migrate-vps-title-revisions.mjs --apply` before catalog sync. The VPS migration adds `name_revision`, `name_generation`, `name_model` to `product_translations`, alongside conditional reviewed `catalog_deploy_ledger` preparation. Under AGENTS.md, deliberate owner launch covers these **unchanged, reviewed normal One-Click steps**; standalone migration, `-DataOnly`/`-MigrationsOnly`, new/modified SQL and unrelated DB writes require separate scope review/authorization. The local runner also applies Admin, notifications/email, title, Codex, worker settings and Amazon quotes SQL; it is not an API startup fix. This documentation update authorizes no production operation.

The wrapper will not push after migration/verification failure, but earlier committed DB phases remain committed. Normal One-Click does not require a separate `-MigrationsOnly` for a missing deploy ledger. Verify local DB `127.0.0.1:5433/postgres` separately from forwarded VPS DB `127.0.0.1:15432/mita` (remote PostgreSQL `5432`); inspect sanitized live identity, required tables/columns/indexes, active jobs, locks and listener ownership. The wrapper refuses occupied `15432`; never kill/adopt an unknown tunnel to clear it. **Owner reaffirmed 2026-11-06: no backup/dump and no backup prerequisite for One-Click.** Transaction rollback works only before commit; a subsequent code rollback cannot restore committed data without an external backup.

Edit **only** `release.json` when changing the displayed version (currently `0.4` in this checkout). It is read by `src/components/layout/footer.tsx`. Neither `package.json` version controls the website footer. An ordinary push without the exact `[deploy]` marker does **not** deploy; guarded One-Click `workflow_dispatch` can deploy without that marker. The file version does not prove the live revision.

```bash
git add -- <reviewed-task-paths>
git commit -m "Thay đổi bình thường"
git push -u origin main

# Only when ready to send the HEAD commit to Hermes:
git add -- release.json <reviewed-release-paths>
git commit -m "Phát hành phiên bản 0.4 [deploy]"
git push origin main
```

Only the **last (HEAD)** commit message in a pushed batch is checked for a push-triggered deploy. The One-Click wrapper can instead trigger a guarded `workflow_dispatch` with the pinned SHA and unique request ID, which can **deploy**; unlike historical build-only dispatch, the current workflow validates these inputs and the `main` revision. Workflow does not push or reset anything in Git; it uses `contents: read`.

These are operation examples, not verification commands or authorization to commit/push. Stage only reviewed task paths; preserve unrelated modified/untracked files. The wrapper checks that its data/migration executable paths match pinned HEAD; other working-tree edits are not published.

## Pipeline

`.github/workflows/mita-deploy.yml`: push main with HEAD `[deploy]` → Ubuntu x64 Node 22, disposable PostgreSQL 16 → backend typecheck/tests/build → QA tests → Next.js production standalone build → bundle `web/`, `api/` (including Linux node_modules), `release-info.json` → SHA256 → SSH streamed bundle into the *forced-command-only* Mita receiver → atomic release switch → localhost and public endpoint checks. Worker on Windows is not part of the server release. The version is informational; a release's unique identity is `v<version>-<commit-short-sha>`.

Remote SSH gate and receiver are installed root-owned as `/usr/local/sbin/mita-ci-gate` and `/usr/local/sbin/mita-ci-receive`. Its restricted SSH public key entry for **ubuntu** must be:

```
restrict,command="/usr/local/sbin/mita-ci-gate" ssh-ed25519 <dedicated-deploy-public-key> mita-github-actions
```

That key cannot open a normal SSH shell, forward ports, or run arbitrary commands. The gate stores SSH stdin to a temporary archive as ubuntu, then invokes a fixed root receiver without piping binary through sudo's TTY. The receiver validates SHA-256, archive paths, embedded version/revision, layout and health. It only restarts `mita-api.service` and `mita-web.service` and changes `/opt/mita/current`, returning the symlink to the old release on failed health checks. GitHub Actions does not migrate/write production PostgreSQL (tests use a disposable CI DB). Windows One-Click schema/data phases are separate and have the authorization boundary above. No automatic backup is created. E-KAIWA, system Node, Caddy and Hermes Gateway must not be modified by it.

Catalog sync itself executes no DDL. Nightly/manual `--apply` uses once-per-JST-day `catalog_sync_ledger`; One-Click `--deploy-apply` uses per-run `catalog_deploy_ledger` with the shared writer lock and source preflights. Never clear claims or retry an uncertain commit. Newer Codex names can replace an approved title only when revision/generation/model and exact source checks pass; newer existing remote revisions are retained. Gallery snapshots may commit as `partial` while preserving prior good images; inspect commit state and verify data instead of assuming partial means no changes. See [worker/sync runbook](../../docs/mita-workers-runbook.md).

GitHub repository Actions secrets (configured by repository owner):

* `MITA_DEPLOY_SSH_KEY`: dedicated Ed25519 private key, NOT the owner's existing SSH key.
* `MITA_DEPLOY_HOST`: pinned VPS IP/address.
* `MITA_DEPLOY_KNOWN_HOSTS`: independently verified SSH host key line, to prevent host impersonation.

Owner-only final secret activation on the development PC (the key file stays gitignored):

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts/enable-mita-github-deploy.ps1
```

The VPS has a dedicated public-key entry restricted to `/usr/local/sbin/mita-ci-gate`. This step sends the corresponding private key to the repo's encrypted Actions secret without revealing it in the shell command line. Existing Hermes personal SSH keys are not uploaded. Keep the deploy key private and delete it locally when no longer needed (after confirming it is present in GitHub Secrets).

**Verified end-to-end on 27 October 2026:** all three GitHub secrets are present; push of commit `eca2fa1bfa9d` containing `[deploy]` completed run [40478008591](https://github.com/kaitobui25/mua-hang-japan-mita/actions/runs/40478008591) successfully, including the SSH deploy step. The live VPS release path and embedded revision matched; Mita and E-KAIWA health passed.

**Do not** store the deploy private key in Git or application logs. If the key is exposed, revoke its `authorized_keys` entry and replace the GitHub secret.

## Troubleshooting

* No `[deploy]` in last push commit → Actions skips release job, expected.
* Unconfigured secret or key → release fails closed before connecting to Hermes.
* New build unhealthy → Mita reverts to previous code; database is not rolled back.
* Replaying same successful SHA → fails because release ID is immutable. Create a new commit to redeploy.
* Look up the run in GitHub Actions; Mita remains at its previous release on build/test/checksum errors.
* Existing 1 GiB VPS makes **any** service restarts risky; keep production monitoring and review changes involving schema, Caddy, SSH, Node runtime or shared services separately.
