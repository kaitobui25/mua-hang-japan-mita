# Mita Japan Windows desktop

Double-click `scripts/start-mita-desktop.bat` on Windows with Windows PowerShell
5.1 and .NET Framework installed. This opens a native WinForms window, with black
background and white Consolas text. No Node, browser, or PowerShell 7 is required
by the desktop client. The launcher uses a process-local execution policy bypass;
it does not change machine policy. Organization policy may still block it.

To log in, the backend must be running at `http://127.0.0.1:4000` with its
owner account configured. If it is offline, select PC API `4000` in **Cổng**
and explicitly confirm **Chạy** (Dev or Start); opening Desktop never starts
the backend by itself. Leave the username blank for the owner, or enter a staff
username when supported, then click **Đăng nhập**. The client reads the role
from `/session`; staff can view data but cannot use owner write controls.
The **Cổng** tab also allows a freshly authenticated owner to request a start
or cooperative stop of verified Mita PC gateway and supervisor. Those services
are independent of backend 4000. Closing Desktop attempts to stop only backend
4000 launched by this exact Desktop session, never another instance or the DB;
in-flight controls must finish first.

Authentication uses `POST /api/admin/login` with `{password}` for the owner or
`{username,password}` for staff, the backend's
`mita_admin` cookie in an in-memory CookieContainer, and the returned CSRF token
in `X-CSRF-Token`. Every request sends `Origin: http://127.0.0.1:4000`.
Redirects and proxies are disabled. There is no configurable remote API and no
unauthenticated fallback. Password input clears immediately after submission;
passwords, cookies and tokens are never written to disk or logs. They necessarily
exist temporarily in process memory; .NET strings cannot be reliably zeroed.
Use **Logout** to revoke the server session. Closing discards local credentials;
the server session expires according to the existing backend's eight-hour policy.

- **Overview:** authenticated `/overview` snapshot with unread alerts and recent
  orders alongside sync and relay status. Pending, processing and merchandise
  value tiles are calculated from the returned recent orders (up to five), not
  from all orders. Processing includes confirmed, purchasing, purchased and
  shipping states. A `+` on the unread count means the VPS relay is unavailable
  and its count is unknown. At narrower window sizes the tiles and panels stack;
  scroll the overview to reach the lower panel.
  The right-side diagnostics additionally compares local PC versus VPS
  PostgreSQL table/column/index counts, catalog totals and differences by ASIN,
  full/short Vietnamese name, original name and ordered gallery source URLs.
  Local-only control tables and VPS-only transfer ledgers are *informational*,
  not automatically errors. Source capture times are shown separately. The
  remote source being inaccessible yields **unknown**, never zero or a stale
  VPS comparison.
- **Notifications:** unread order notifications from local and (if
  explicitly configured) VPS sources, refreshed independently of the selected tab, with
  source identifiers and a confirmed `Đã xem` acknowledgement via the same
  Admin API. The authenticated VPS relay includes the customer's name and
  locked merchandise amount in VND (shipping excluded), but never phone,
  email or address; private remote order details cannot be opened from
  the local Orders tab.
- **Orders:** paged `/orders`, search by ID/phone, and single order state changes.
  Before each write the client fetches `/orders/:id`, checks the allowed transition
  and payment prerequisite, then asks for confirmation showing the origin and
  target. The backend remains authoritative and audits the PATCH.
- **Products:** PC/VPS source selector and read-only, complete-catalog ASIN
  comparison through `/desktop/snapshot` and `/desktop/products`. Use Vietnamese
  short name when valid, otherwise full Vietnamese, otherwise the source name
  labelled **Chưa có tên Việt**. The table marks differences in existence,
  original/full/short title and ordered gallery source URLs with short reasons;
  **Chỉ khác biệt** filters the union before paging (50 rows/page). Search
  includes ASIN, original and translated names; source and comparison status
  are shown explicitly. On VPS failure, PC remains viewable but no difference
  conclusions are made, and old VPS rows are cleared. VPS never accepts edits.
  In PC mode, the existing visibility action still re-fetches the exact ASIN
  from the authoritative local `/products` endpoint before confirming PATCH.
- **Pricing:** `/pricing` view and editable JPY/VND rate (four decimals), service
  fee (two decimals). Saving re-fetches the current policy and rejects a changed
  version. The PUT includes the original version and the current expiry policy
  for backend optimistic locking. Refresh preserves edited inputs; **Bỏ bản
  nháp** discards them and reloads the policy.
- **Workers:** four independent tiles (Amazon, Vietnamese names, detailed translation,
  PC → VPS sync), with right-side status and an Owner-only schedule/manual panel.
  The read-only JST snapshot is combined with authenticated `/workers` counts,
  current-cycle Codex progress, last run and bounded warning-ASIN diagnostics.
  Missing or malformed status is unavailable, not treated as zero progress or proof
  that a process is running. Owner can select OpenRouter or Codex CLI for the names
  worker, save each worker's JST schedule, and request 1–300 products manually.
  Requests are rejected while a conflicting worker or sync is active; they are not
  queued or automatically retried. If the authenticated Workers API is unavailable,
  Owner write controls remain disabled and process health is not inferred from
  snapshots. Sync requests remain behind the Cổng daily three-worker barrier
  and remote ledger.
- **Cổng:** switch between **Mạng nhện** (default) and **Danh sách PC/VPS**,
  both backed by the same node/edge topology. This shows 10 Mita PC/VPS ports,
  separately labelled process nodes, and read-only shared infrastructure.
  Selecting a node highlights its relationships and opens the resizable right
  detail pane. It starts collapsed, opens on node activation, and can be
  collapsed again. Its default width is now approximately **175px** and any
  resized width is saved per Windows user under
  `%LOCALAPPDATA%\MitaJapan\desktop-layout.json`. The network diagram and
  controls are unchanged. Plain-language purpose, status and troubleshooting
  appear first; technical probe paths and relationships are opt-in under
  **Thông tin kỹ thuật**.
  Read-only
  TCP, HTTP health, PostgreSQL readiness and SSH checks run independently of
  authenticated Admin requests. Polling defaults to 15 seconds, adjustable to
  15–300 seconds in Cổng, and runs only while this tab is selected. Lost SSH
  monitoring does **not** prove VPS services have stopped. On-demand ports
  `8081` and `15432` may be normally **Không chạy**. Lines represent configured
  application, conditional or control relationships, not measured traffic.
  Moving dashes (optional) only illustrate routes; no rate or percentage is
  invented. **Bật/Dừng an toàn** applies only to PC gateway `8080` and
  supervisor `19978`: confirm the impact, revalidate the owner session using
  `/session`, then launch a bounded, named local command. The local helper
  verifies PID, start time, script, executable and listener ownership and
  refuses unverified occupants. Stops are cooperative; gateway stop is
  refused while supervisor or known workers are active. Audit outcomes are
  written without credentials to
  `.agents/runtime/mita-port-control-audit.jsonl`. The UI never claims an
  immediate change before a follow-up probe. PostgreSQL, VPS web/API and
  shared infrastructure remain **monitoring only**.
  Selecting PC API `4000` in either layout also reveals **Dev / Start**, **Chạy**,
  **Dừng**, and **Restart** in that node's detail area. This Windows-local control
  is independent of Admin login: Owner and Staff may start the local backend,
  without gaining any additional API permissions. Nothing starts on Desktop open.
  Each interactive action requires confirmation (default No). Missing backend
  dependencies require a second explicit confirmation before `npm install`.
  Dev runs `npm run dev` (tsx watch); Start runs `npm run start` (tsx).
  PostgreSQL 5433 is started only if an existing Mita local cluster is present
  and inactive; it is never initialized, migrated, reset or stopped by this UI.
  The new backend is verified with `/api/health` and launch ownership, with a
  30-second readiness window after preflight. Only the creating Desktop session
  can Stop/Restart it; Desktop close attempts to stop only its own instance.
  Unknown port-4000 listeners are never adopted or killed. UI status, session
  log and `.agents/runtime/backend-4000/audit.jsonl` show the outcomes. See
  `docs/backend-4000-lifecycle.md` for containment and failure behavior.
  If API `4000` is unavailable, Cổng monitoring still works; old 8080/19978
  Owner controls remain disabled until `/session` can be revalidated.
  Selecting **Sync** shows the latest JST daily state (`pending`, `running`,
  `completed`, `partial` or `failed`) and whether a matching local process is
  actually observable; a stale `running` snapshot is never treated as proof of
  a running job. **Đồng bộ ngay** requires Owner authentication revalidated
  after confirmation, three terminal worker outcomes from the same JST day,
  free advisory locks, verified Supervisor IPC and no existing conflicting
  tunnel/worker. The Supervisor alone dispatches the finite sync using the
  original protected 15432 tunnel and remote daily ledger; Desktop never
  starts a second worker or directly calls the transfer. No Stop or automatic
  retry exists. **Forced same-day rerun is not available** until remote ledger
  attempt history and idempotency can prove it safe; completed, partial,
  running and uncertain claims remain protected. The updated Supervisor must
  be restarted by the existing safe operator procedure before its new IPC can
  accept requests; Desktop never restarts that service automatically.
  Selecting **Tunnel 15432** allows Owner to request a separate diagnostic SSH
  forwarding session, only when the port is free and the approved SSH identity
  and agent are ready. It expires within five minutes or is stopped on closing
  the Desktop session. It is not a catalog sync and does not send DB queries;
  it never adopts or kills a tunnel belonging to the scheduled Sync.
  Owner/Staff login now shows a persistent role/failure message beside the
  form, distinguishing invalid credentials, 429 lockout and local API outage.
- **Logs:** Owner and Staff can read the same sanitized timeline of local
  Supervisor, Worker, PC control and backend events, read from fixed bounded
  runtime JSONL sources, plus local/VPS catalog/translation/transfer-claim
  database events. Only fixed safe event titles and timestamps are exposed;
  raw stdout/stderr, arbitrary message strings, customer data, passwords,
  session and machine identifiers are omitted. Default is **last 24 hours**;
  filters allow source, severity and up to seven days (where retained). Missing,
  unavailable and truncated sources are shown explicitly rather than claimed
  empty. This does not replace dedicated technical log files.

Refresh reloads the selected tab; Products/Overview/Logs take an on-demand
read-only snapshot when the tab opens or the user presses **Làm mới** and retain
it while paging/filtering; snapshots are per-session, in memory, and bounded.
On Windows, the authenticated local Admin API uses the previously approved
strict-host-key SSH identity to read a fixed VPS PostgreSQL evidence query on
demand; **no tunnel, transfer or remote write** is initiated. Administrators
can disable remote inspection via `MITA_DESKTOP_DIAGNOSTICS_SSH=0` before
starting the backend. SSH/key failure shows VPS unavailable, not stale data.
Other tabs continue automatic refresh every 30 seconds while
authenticated. Notifications have a separate interval, defaulting to 30 seconds
and adjustable from 10 to 300 seconds for the current process only. A `+` in the
count means the VPS is unavailable and its unread count is unknown. HTTP tasks are asynchronous and polled by a
WinForms timer, with a 20-second timeout and one request at a time. The Cổng
monitor uses its own bounded worker, not this request queue. Controls are
disabled while requests run. Confirmation defaults to No. Failed writes are never
automatically retried; after a timeout, re-fetch before deciding whether to retry.
HTTP errors are displayed with safe status guidance; offline/API format errors
have a visible recovery message. There is no persistent local cache or second DB.

This is the bounded desktop implementation of plan 13 / ADR 0017. Payment/refund
and shipping-fee edits, imports, catalog/translation settings, OS push
notifications, staff account management and external Zalo/Facebook push are not implemented
here. Durable order alerts and acknowledgement work only when the connected
Admin API can read the correct local or configured VPS source. See
`docs/order-alert-relay.md` for optional VPS configuration.
Order and product APIs expose no optimistic version/ETag: re-fetch + confirmation
reduces stale decisions but cannot eliminate a concurrent update between read and
write. The backend's existing workflow checks and audit remain in force. Pricing
has a real version conflict check. List paging is 50 records; search resets to page
one. Workers tab never sends signals, stops processes or writes status files.

## Safe validation without launching a window

Run from the repository root in Windows PowerShell 5.1:

```powershell
$tokens = $null
$parseErrors = $null
$path = (Resolve-Path scripts/mita-desktop.ps1).Path
$null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { $parseErrors; throw 'Desktop script parse failed' }
```

For Cổng, run
`powershell.exe -NoProfile -NonInteractive -File scripts/test-mita-desktop-ports-static.ps1`
as well. This checks the PowerShell 5.1 parser and monitoring/control safety
contracts without launching any live probes or service control.

This only parses source: it does not execute the script or call the API. Manual
GUI smoke testing should use an isolated test backend and test records, never
live orders: login, tab navigation, paging/search, offline failure, logout, stale
pricing rejection, and cancelling each confirmation. No window or live write is
needed for the read-only parse check.

## Workers deployment prerequisites (not an implicit migration)

This feature branch has **not** been installed on the running Supervisor or
backend. Before any live rollout, inspect the live database identity, tables,
columns, indexes and active locks with read-only queries, obtain a restorable
backup, and get explicit authorization for migrations, service restarts and VPS
changes. Local migrations include `codex-names.sql` and `workers-control.sql`.
The remote PostgreSQL schema also needs the optional revision columns before
revision-aware catalog sync can be enabled; the explicit, separately authorized
script is `node backend/scripts/migrate-vps-title-revisions.mjs --dry-run` then
`--apply` with the approved SSH-forwarded VPS database URL. Never run the
migration or nightly sync as part of a test. Compare remote title source,
generation and revision through disposable-DB regression tests first.

The 20-product Codex CLI translation trial was read-only: it generated 20
nonempty full titles with 18 short titles and 2 full-title fallbacks. Four
full titles still contained Japanese characters; manual semantic review is
necessary before claiming their translations are all accurate. This trial did
not update the live database or VPS.
