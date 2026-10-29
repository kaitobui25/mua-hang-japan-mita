# Owner order alerts from the public VPS to Windows local Admin

**Status: optional, disabled until configured. Not deployed.** Local PostgreSQL
does not receive public VPS orders from nightly catalog sync. The public order's
outbox event remains in VPS PostgreSQL and the owner uses the local Admin
notification panel to poll for it every **15 seconds while the page is open**.
An Admin alert means *order placed*, not *payment received*. No Zalo/Facebook
provider push is implied.

## Data path and boundaries

```text
VPS customer checkout -> VPS orders + order_notification_outbox (one transaction)
       -> Mita Caddy HTTPS /api/order-alert-relay (bearer required)
       -> local Fastify owner Admin GET /api/admin/notifications
       -> Windows browser Admin panel (15s polling, owner session required)
       -> owner "Đã xem" -> local Admin CSRF-authenticated POST
           -> HTTPS bearer POST to VPS -> VPS outbox acknowledged_at
```

The relay returns only event sequence ID, opaque order UUID, event type,
creation/acknowledgement timestamps and order processing status. It returns **no
customer names, phone numbers, email, addresses, order items, financial amounts,
Admin cookies or login credentials**. This deliberately does not make
private order detail pages accessible publicly.

VPS sequence IDs are mapped to `vps:<id>` in the local Admin response; local IDs
remain decimal. IDs are deduplicated by source + event ID. Acknowledgements are
idempotent on the VPS; if a remote acknowledgement fails, nothing is marked
locally. The source is identified explicitly as `vps` so it cannot be mistaken
for a local checkout. VPS order detail links are not constructed against the
local PostgreSQL store. To view private details, use the **separately
authenticated VPS Admin over its existing SSH localhost tunnel** documented in
`hermes-vps-runbook.md`.

## Required configuration (two separate API processes)

Generate one **random, independent 32-byte base64url bearer secret** using an
approved secret manager or offline cryptographic generator. It must match
`^[A-Za-z0-9_-]{43,128}$`. Never reuse the Admin password, SSH private key,
GitHub token or customer data. Never put it in Git, browser code, a URL, Caddy
config, command-line flags or logs.

| Host | Environment variable | Value |
| --- | --- | --- |
| **VPS Fastify** | `MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN` | Generated random bearer secret |
| **Windows local Fastify** | `MITA_ORDER_ALERT_RELAY_OUTBOUND_URL` | **Exactly** `https://mitajapanshop.duckdns.org/api/order-alert-relay` |
| **Windows local Fastify** | `MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN` | Same bearer secret |

On VPS, securely add the inbound variable to the existing root-managed
`/etc/mita/mita.env` (permissions owner-only, ideally `0600`), and confirm
the **actual** `mita-api.service` loads this file; the checked-in repository
does not include its installed unit. Restart only the API after review.
On Windows, supply the outbound variables to the **local backend process**
(started by `scripts/start-local.ps1` or equivalent) using its local secret
configuration. The Windows Next.js frontend does **not** receive either token.
If the launcher creates a fresh process environment, ensure these variables
reach its Fastify child before startup. Do not use `NEXT_PUBLIC_*` variables.

The VPS-specific Caddy site `/etc/caddy/mita.caddy` must be updated **manually,
only after review and authorization** to match
`deploy/mita/Caddyfile` (new exact GET relay route and pattern-scoped POST
acknowledgement). Validate Caddy config, reload Caddy, and verify Mita and
E-KAIWA public QA together. Do not replace the global
`/etc/caddy/Caddyfile`, expose `/api/admin/*`, or open ports
`3100/4100/5432` to the internet. The new Caddy rules are not installed by
building the backend or by ordinary CI release.

## Behavior and verification

- **No inbound token:** VPS relay returns 404 (disabled). A configured relay
  with a missing or incorrect Authorization header returns **403** for both
  GET and POST. All responses use `Cache-Control: no-store`.
- **No outbound configuration:** local Admin continues to show its own
  notifications and reports `relayStatus: disabled`.
- **Invalid/partial configuration, invalid TLS, redirects, malformed response,
  incorrect token, network failure or timeout:** local Admin still shows local
  notifications and explicitly reports `relayStatus: unavailable`. The
  unread count may be incomplete while remote is unavailable.
- **Configured:** local `GET /api/admin/notifications` joins local and VPS
  events; the owner page polls every 15 seconds. Local
  `POST /api/admin/notifications/vps:<event-id>/ack` requires owner session,
  valid Origin and CSRF token; Fastify then sends the bearer-authenticated
  acknowledgement to VPS. The public relay has no CORS credential access and
  accepts neither Admin session cookies nor browser CSRF as authorization.
- **Hard limit:** it is browser polling, so no notification when the browser
  Admin page or PC is closed/offline. No employee account/role, SMS, Zalo or
  Facebook push is provided. The local Admin overview's
  `newOrderAlertCount` includes the VPS unread count when the relay is
  connected, and shows an unavailable warning otherwise. The Windows GUI
  Notifications tab polls the same owner-protected endpoint every 30 seconds
  when selected. No VPS order snapshots/PII are copied.

After **authorized** deployment, verify via a safe staging event or new
legitimate pending-confirmation order (no real customer details in test logs):

1. Without bearer token, the public HTTPS GET and POST relay endpoints respond
   403; `/api/admin/*` still responds 404 on the public domain.
2. With the secret supplied through secure process configuration, relay GET
   returns event metadata only and never customer PII; authenticated POST
   acknowledges the event. Wrong or expired credentials cannot acknowledge it.
3. Open the **local** Admin notification panel as owner; verify the VPS event
   appears within its next polling cycle, labelled VPS, with no local order-detail
   link. Acknowledge, then verify the same `acknowledged_at` persists on VPS.
4. Temporarily deny network or use an invalid relay token in a test environment:
   UI reports unavailable, local notifications still load, and remote
   acknowledgement is not falsely marked complete. Verify no bearer secrets or
   customer PII appear in logs.

Rotate the inbound and outbound secret together if compromised. This optional
public endpoint increases the Internet-facing surface, so the deployment owner
must review the Caddy allowlist and VPS service environment before activation.
