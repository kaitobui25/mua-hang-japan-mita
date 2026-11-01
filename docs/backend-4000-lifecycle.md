# Local backend 4000 lifecycle (Windows PowerShell 5.1)

`scripts/mita-backend-control.ps1` exposes Start, Stop, Restart and Status. It controls only backend 4000 under the current Windows user; it does not require an API login or owner role. Staff can request Start through the desktop UI.

Examples for the desktop integrator (run asynchronously outside the UI thread):

```powershell
$session = [guid]::NewGuid().ToString('N') # one fresh ID per desktop instance
& "$PSScriptRoot/mita-backend-control.ps1" -Action Start -Mode Dev -SessionId $session
& "$PSScriptRoot/mita-backend-control.ps1" -Action Restart -Mode Start -SessionId $session
& "$PSScriptRoot/mita-backend-control.ps1" -Action Status
# On desktop close: always pass BOTH arguments; never issue unqualified Stop.
& "$PSScriptRoot/mita-backend-control.ps1" -Action Stop -SessionId $session -OnlyIfSessionOwned
```

Start mode executes `npm run start`; Dev executes `npm run dev` (tsx watch). An existing verified helper-owned instance returns `Started = false` without transferring session ownership. Start/Restart readiness requires HTTP 200, JSON `ok: true` and the matching launch ID within 30 seconds. Start returns `{ State, Started, Owner }` as a PowerShell object. Status returns `{ State, Owner }`; failures throw and are audited. A CLI in a separate powershell.exe process should format returned objects as JSON explicitly if its caller needs structured IPC. Mode must be supplied explicitly on Restart if Dev is desired.

If dependencies are missing, the helper throws before installation. After the user explicitly confirms, the caller may retry using `-InstallDependenciesConfirmed`; this installs backend dependencies only. Do not preselect or automatically set this switch. PostgreSQL startup uses only the existing `backend/.local-db` cluster and PostgreSQL 18 binaries, on loopback 5433. When 5433 is ready, the listener PID, executable, PostgreSQL `-D` argument, `pg_ctl status`, and read-only `SHOW data_directory` must all identify the existing Mita cluster; a different PostgreSQL is rejected even if Windows reused a PID. The helper never initializes, migrates or stops the database. Child backend configuration is pinned to local 5433 and API 4000 even if the caller inherited VPS settings.

The wrapper launches npm suspended, assigns it to an unnamed Windows Job Object, then resumes it. Closing that job terminates only that launch's npm/tsx process tree, including watch children; there is no arbitrary PID/port kill. Stop checks the recorded process creation time, exact helper command line/path and Windows SID, then signals the unique launch file. The server's optional local file guard requests graceful shutdown; after three seconds the wrapper closes its own job. Shutdown works even when health is failing. Unknown listeners are never adopted, started over or terminated. Restart refuses unknown/unhealthy listeners; explicitly stopping an existing verified job is still allowed without targeting the listener. No backend is automatically relaunched after a crash; Dev retains npm's requested tsx watch behavior for source edits.

The private `Run` action is for the wrapper only and requires a matching owner record. Records, per-launch stdout/stderr and JSONL audit entries live under `.agents/runtime/backend-4000/`. Dead owner records are safe to replace only if 4000 has no listener. Stop without `-OnlyIfSessionOwned` is an explicit current-user manual stop; desktop closing must use the session guard. A backend launched independently of this helper is treated as unknown, even if its health endpoint responds.

Safe checks: `powershell.exe -NoProfile -File scripts/test-mita-backend-control-static.ps1`, `powershell.exe -NoProfile -File scripts/test-mita-desktop-ports-static.ps1`, backend TypeScript `--noEmit`, and `npm test --prefix backend` (disposable test database). `scripts/test-mita-desktop-ports-window.ps1` opens the actual WinForms UI, tests both layouts and saves screenshots under the ignored runtime directory without initiating any lifecycle action. Live Dev, Start, Restart, Stop and closing a session-owned Desktop were verified on Windows; installing missing packages was not exercised because the existing backend dependencies were present. Never run live tests without first checking port 4000 and existing worker activity.
