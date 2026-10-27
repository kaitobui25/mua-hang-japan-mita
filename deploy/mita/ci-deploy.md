# Deploy Mita Japan using `[deploy]` in the commit message

## Owner actions

Edit **only** `release.json` when you want a new displayed version (starting at `0.3`). It is read by `src/components/layout/footer.tsx`. Neither `package.json` version controls the website footer. Commits without the exact `[deploy]` marker do **not** deploy.

```bash
git add .
git commit -m "Thay đổi bình thường"
git push -u origin main

# Only when ready to send the HEAD commit to Hermes:
git add .
git commit -m "Phát hành phiên bản 0.3 [deploy]"
git push origin main
```

Only the **last (HEAD)** commit message in a pushed batch is checked. Put `[deploy]` in the last commit; no deploy if an earlier commit alone has the marker. A GitHub Actions `workflow_dispatch` is **build-only**, so diagnostics cannot accidentally deploy. Workflow does not push or reset anything in Git; it uses `contents: read`.

## Pipeline

`.github/workflows/mita-deploy.yml`: push main with HEAD `[deploy]` → Ubuntu x64 Node 22, disposable PostgreSQL 16 → backend typecheck/tests/build → QA tests → Next.js production standalone build → bundle `web/`, `api/` (including Linux node_modules), `release-info.json` → SHA256 → SSH streamed bundle into the *forced-command-only* Mita receiver → atomic release switch → localhost and public endpoint checks. Worker on Windows is not part of the server release. The version is informational; a release's unique identity is `v<version>-<commit-short-sha>`.

Remote SSH gate and receiver are installed root-owned as `/usr/local/sbin/mita-ci-gate` and `/usr/local/sbin/mita-ci-receive`. Its restricted SSH public key entry for **ubuntu** must be:

```
restrict,command="/usr/local/sbin/mita-ci-gate" ssh-ed25519 <dedicated-deploy-public-key> mita-github-actions
```

That key cannot open a normal SSH shell, forward ports, or run arbitrary commands. The gate stores SSH stdin to a temporary archive as ubuntu, then invokes a fixed root receiver without piping binary through sudo's TTY. The receiver validates SHA-256, archive paths, embedded version/revision, layout and health. It only restarts `mita-api.service` and `mita-web.service` and changes `/opt/mita/current`, returning the symlink to the old release on failed health checks. PostgreSQL data is untouched; schema changes require separate, reviewed additive migrations **before** code deployment. The script creates no backups. E-KAIWA, system Node, Caddy and Hermes Gateway must not be modified by it.

GitHub repository Actions secrets (configured by repository owner):

* `MITA_DEPLOY_SSH_KEY`: dedicated Ed25519 private key, NOT the owner's existing SSH key.
* `MITA_DEPLOY_HOST`: pinned VPS IP/address.
* `MITA_DEPLOY_KNOWN_HOSTS`: independently verified SSH host key line, to prevent host impersonation.

Owner-only final secret activation on the development PC (the key file stays gitignored):

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts/enable-mita-github-deploy.ps1
```

The VPS has a dedicated public-key entry restricted to `/usr/local/sbin/mita-ci-gate`. This step sends the corresponding private key to the repo's encrypted Actions secret without revealing it in the shell command line. Existing Hermes personal SSH keys are not uploaded. Keep the deploy key private and delete it locally when no longer needed (after confirming it is present in GitHub Secrets).

**Do not** store the deploy private key in Git or application logs. If the key is exposed, revoke its `authorized_keys` entry and replace the GitHub secret.

## Troubleshooting

* No `[deploy]` in last push commit → Actions skips release job, expected.
* Unconfigured secret or key → release fails closed before connecting to Hermes.
* New build unhealthy → Mita reverts to previous code; database is not rolled back.
* Replaying same successful SHA → fails because release ID is immutable. Create a new commit to redeploy.
* Look up the run in GitHub Actions; Mita remains at its previous release on build/test/checksum errors.
* Existing 1 GiB VPS makes **any** service restarts risky; keep production monitoring and review changes involving schema, Caddy, SSH, Node runtime or shared services separately.
