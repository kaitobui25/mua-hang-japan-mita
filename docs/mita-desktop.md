# Mita Japan Windows desktop

Double-click `scripts/start-mita-desktop.bat` on Windows with Windows PowerShell
5.1 and .NET Framework installed. This opens a native WinForms window, with black
background and white Consolas text. No Node, browser, or PowerShell 7 is required
by the desktop client. The launcher uses a process-local execution policy bypass;
it does not change machine policy. Organization policy may still block it.

The existing backend must already be running at `http://127.0.0.1:4000` with its
owner account configured. Enter that owner's password and click **Owner login**.
The desktop never starts/restarts the backend, database, gateway or workers.
Closing the window leaves existing processes alone.

Authentication uses `POST /api/admin/login` with `{password}`, the backend's
`mita_admin` cookie in an in-memory CookieContainer, and the returned CSRF token
in `X-CSRF-Token`. Every request sends `Origin: http://127.0.0.1:4000`.
Redirects and proxies are disabled. There is no configurable remote API and no
unauthenticated fallback. Password input clears immediately after submission;
passwords, cookies and tokens are never written to disk or logs. They necessarily
exist temporarily in process memory; .NET strings cannot be reliably zeroed.
Use **Logout** to revoke the server session. Closing discards local credentials;
the server session expires according to the existing backend's eight-hour policy.

- **Overview:** authenticated `/overview` snapshot, including sync warnings.
- **Orders:** paged `/orders`, search by ID/phone, and single order state changes.
  Before each write the client fetches `/orders/:id`, checks the allowed transition
  and payment prerequisite, then asks for confirmation showing the origin and
  target. The backend remains authoritative and audits the PATCH.
- **Products:** paged `/products`, search by name/ASIN, and visibility toggle.
  An exact ASIN is re-fetched before confirming and PATCHing visibility.
- **Pricing:** `/pricing` view and editable JPY/VND rate (four decimals), service
  fee (two decimals). Saving re-fetches the current policy and rejects a changed
  version. The PUT includes the original version for backend optimistic locking.
- **Workers:** read-only current JST day's `.agents/runtime/mita-daily-YYYY-MM-DD.json`
  snapshot with modification time, job states and sync state. Missing/malformed
  status is shown as unavailable. A snapshot is not a process health check.
- **Logs:** session-only accepted-write activity. No raw worker logs, arbitrary
  server response bodies, customer records, passwords or session values are logged.
  Overview exposes existing authenticated sync diagnostics on screen only.

Refresh reloads the selected tab; automatic refresh runs every 30 seconds while
authenticated. Pricing inputs are replaced by authoritative values on refresh;
save edits before that interval. HTTP tasks are asynchronous and polled by a
WinForms timer, with a 12-second timeout and one request at a time. Controls are
disabled while requests run. Confirmation defaults to No. Failed writes are never
automatically retried; after a timeout, re-fetch before deciding whether to retry.
HTTP errors are displayed with safe status guidance; offline/API format errors
have a visible recovery message. There is no persistent local cache or second DB.

This is the bounded desktop implementation of plan 13 / ADR 0017. Payment/refund
and shipping-fee edits, imports, catalog/translation settings, durable order alerts,
OS notifications and external push are not implemented here. Use the existing
Admin UI for those supported operations. No notification event API currently
exists in the inspected Admin routes, so the desktop does not claim delivery.
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

This only parses source: it does not execute the script or call the API. Manual
GUI smoke testing should use an isolated test backend and test records, never
live orders: login, tab navigation, paging/search, offline failure, logout, stale
pricing rejection, and cancelling each confirmation. No window or live write is
needed for the read-only parse check.
