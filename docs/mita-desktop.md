# Mita Japan Windows desktop

Double-click `scripts/start-mita-desktop.bat` on Windows with Windows PowerShell
5.1 and .NET Framework installed. This opens a native WinForms window, with black
background and white Consolas text. No Node, browser, or PowerShell 7 is required
by the desktop client. The launcher uses a process-local execution policy bypass;
it does not change machine policy. Organization policy may still block it.

The existing backend must already be running at `http://127.0.0.1:4000` with its
owner account configured. Leave the username blank for the owner, or enter a
staff username when the backend supports it, then click **Đăng nhập**. The
client reads the role from `/session`; staff can view data but cannot use owner
write controls.
The desktop does not start/restart the backend or database. The **Cổng** tab
can request a start or cooperative stop of two verified Mita-owned PC services
(gateway and supervisor), only for a freshly authenticated **owner**. Closing
the window does not stop services; an in-flight control must finish first.

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
- **Products:** paged `/products`, search by name/ASIN, and visibility toggle.
  An exact ASIN is re-fetched before confirming and PATCHing visibility.
- **Pricing:** `/pricing` view and editable JPY/VND rate (four decimals), service
  fee (two decimals). Saving re-fetches the current policy and rejects a changed
  version. The PUT includes the original version and the current expiry policy
  for backend optimistic locking. Refresh preserves edited inputs; **Bỏ bản
  nháp** discards them and reloads the policy.
- **Workers:** read-only current JST day's `.agents/runtime/mita-daily-YYYY-MM-DD.json`
  snapshot with modification time, job states and sync state. Missing/malformed
  status is shown as unavailable. A snapshot is not a process health check.
- **Cổng:** switch between **Mạng nhện** (default) and **Danh sách PC/VPS**,
  both backed by the same node/edge topology. This shows 10 Mita PC/VPS ports,
  separately labelled process nodes, and read-only shared infrastructure.
  Selecting a node highlights its relationships and opens details. Read-only
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
  immediate change before a follow-up probe. PC API `4000`, PostgreSQL,
  temporary sync tunnel `15432`, VPS web/API and shared infrastructure are
  **monitoring only**, without buttons to terminate those services.
  When local API `4000` is unavailable, port monitoring still works, but
  owner controls are disabled because the application cannot securely refresh
  the owner session. Start the existing backend separately from `backend`
  with `npm run dev`, then log in. No unauthenticated local-control fallback
  is provided.
- **Logs:** session-only accepted-write activity. No raw worker logs, arbitrary
  server response bodies, customer records, passwords or session values are logged.
  Overview exposes existing authenticated sync diagnostics on screen only.

Refresh reloads the selected tab; automatic refresh runs every 30 seconds while
authenticated. Notifications have a separate interval, defaulting to 30 seconds
and adjustable from 10 to 300 seconds for the current process only. A `+` in the
count means the VPS is unavailable and its unread count is unknown. HTTP tasks are asynchronous and polled by a
WinForms timer, with a 12-second timeout and one request at a time. The Cổng
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
