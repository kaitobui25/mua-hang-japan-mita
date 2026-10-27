# Mita web release for Hermes

This folder contains the reproducible tooling for the **web** half of `/opt/mita/releases/<release-id>/web`. The release helper itself does not connect to Hermes, configure Caddy/DNS, install software there, or start services. The API is packaged separately under `api/` in the same release by the backend deployment workflow.

**Production status (27 October 2026):** `mitajapanshop.duckdns.org` is live on Hermes; a Linux x64 release built by GitHub Actions was staged through the restricted SSH receiver and health-checked. GitHub Actions secrets for the dedicated deploy key, VPS host and pinned known-host entry are configured. See `ci-deploy.md` for the HEAD `[deploy]` commit marker. **Operational commands and precautions are in `docs/hermes-vps-runbook.md`.**

## Build on Linux

Use a fresh Ubuntu 24.04 checkout in CI or WSL2's **Linux filesystem**, with Node.js >=22.12, npm, and the same architecture as the VPS. First check the VPS architecture (`uname -m` and `/opt/mita/node22/bin/node -p 'process.arch'` once the separate Node runtime exists): `x64` for x86_64 or `arm64` for aarch64. Never replace the VPS system Node.js `/usr/bin/node` (used by E-KAIWA). If this PC has no WSL2 distro, `web-release.github-actions.yml` is a manually dispatched Ubuntu x64 GitHub Actions workflow **template**; copy it into `.github/workflows/mita-web-release.yml` and commit it only when GitHub CI is authorized. It uploads artifacts for operator review without accessing the VPS.

Windows-generated `.next/standalone` is not a Linux release: it can contain Windows native optional dependencies and absolute Windows junction/symlink targets. Next.js also requires the separately copied `.next/static` directory. The Linux script builds and packs both, using the locked dependencies, `API_PORT=4100` and `NEXT_PUBLIC_READ_ONLY=1` **at build time** (Next.js compiles these settings into the artifact).

From the project root, for an x86_64 target:

```bash
MITA_TARGET_ARCH=x64 npm run build:release:linux
```

For an ARM64 VPS, use an ARM64 Linux build runner with `MITA_TARGET_ARCH=arm64`. Optional `MITA_RELEASE_ID` sets a stable release folder name; `MITA_ARTIFACT_DIR` chooses the output folder. By default the script generates a UTC timestamp and Git short hash. It writes `<id>-web-linux-<arch>.tar.gz` plus `.sha256` in `.verification/mita-artifacts/` (ignored by Git). Upload it only when the release is approved.

## Release contract (operator actions after authorization)

1. Verify the archive's SHA-256 on the target Linux host and that its architecture matches the installed isolated Node 22 runtime. Extract it in `/opt/mita/releases/<id>/`, producing `web/server.js`, `web/.next/` and optionally `web/public/`; separately stage `api/` in the same release. No `npm install` or `next build` is needed on the VPS for the web artifact.
2. Configure the dedicated `mita` service account and independent `/opt/mita/node22/bin/node`, retaining existing system Node and unrelated services. Allow the account to read release files and, if required by Next cache behavior, write `web/.next/cache` only. The `mita-web.service` template binds loopback `127.0.0.1:3100`, expects the backend on `127.0.0.1:4100` and enforces the read-only UI flag. Keep API database credentials in its separate `/etc/mita/mita.env` environment file; the web service does not read that file.
3. When both services and their configuration are staged and approved, select the release using an atomic `current` symlink rename, install the Mita-only systemd units, then test locally. Do not publicize the site until memory, E-KAIWA isolation, catalog-rights and Caddy route checks pass. Public admin and checkout stay blocked by the separately reviewed Caddy rules.

The initial web unit limits its Node heap to 192 MiB and total memory to 256 MiB, to cap its impact on the shared 1 GiB host. These are **starting test values**: monitor RSS, OOM and the other services during 1/5/10/19-client canary tests. If the VPS cannot sustain the load without impacting existing services, stop the rollout rather than raise the 1 GiB capacity limit or disable E-KAIWA. The API service, PostgreSQL loopback setup, private SSH worker tunnel, DNS, and public Caddy access are separate release stages.
