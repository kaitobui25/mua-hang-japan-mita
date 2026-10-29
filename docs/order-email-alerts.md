# Order email alerts to the two owner addresses

**Prepared in code; disabled by default. Not activated, deployed or tested against Gmail.**

When the VPS checkout commits a genuine `pending_confirmation` order, it
already commits the `order_placed` event into
`order_notification_outbox`. The optional **VPS-only** API process can read
those events and send a brief notification via authenticated Gmail SMTP to
exactly these two recipient addresses:

- `mitajapan@gmail.com`
- `nothink1315@gmail.com`

These are **recipients only**. No sender identity, Gmail account or app password
has been supplied or assumed. Emails contain only the order UUID, current order
status, creation timestamp in UTC, and an instruction to open the protected
Admin through the existing SSH/localhost route. The email never contains buyer
name/phone/address/email, item lines, payments or Admin/session credentials.
The message says an order was **placed**, not paid.

## Setup on the VPS

1. Apply reviewed **additive** migration
   `backend/src/db/email-delivery.sql` to the **VPS PostgreSQL** before
   activating the sender. Normal `npm run db:migrate` and the compiled build
   also include this file. This migration creates delivery receipts and an
   empty activation table; it **does not** activate historical events or send.
   Nightly local→VPS catalog sync must not copy these tables or checkout rows.
2. Obtain a Gmail/Google Workspace SMTP account with 2-Step Verification and
   an approved Gmail **app password**, using the account owner’s protected
   credential management. Never ask a customer to provide login credentials.
   Add these variables only to the VPS API process's protected environment
   (expected `/etc/mita/mita.env`; verify the live systemd unit uses it):

   | Environment variable | Required value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `MITA_EMAIL_ALERTS_ENABLED` | `1` |
   | `MITA_EMAIL_ALERTS_VPS` | `1` (explicit VPS-only opt-in) |
   | `MITA_GMAIL_SMTP_USER` | SMTP account's complete email address |
   | `MITA_GMAIL_SMTP_FROM` | Same email address as SMTP user |
   | `MITA_GMAIL_SMTP_APP_PASSWORD` | Gmail app password, **16 characters without spaces** |

   Use file permissions `0600` for secrets and `EnvironmentFile` as supported
   by the existing systemd unit. Do not store secrets in Git, `.env.example`,
   PowerShell command arguments, the frontend, logs, emails, or the Caddy file.
   This code does not read a file by itself; only inherited process environment.
3. Review the VPS-only service configuration before restarting **only**
   `mita-api.service`. The worker starts in the real API entrypoint after
   Fastify is listening. It requires Linux, `NODE_ENV=production`, both
   opt-in flags, valid sender/from equality and a nonempty valid app password.
   If any condition fails it is disabled, and checkout still works.

The sender uses Nodemailer via `smtp.gmail.com` port **465** with implicit TLS,
certificate verification, TLS 1.2 minimum, authenticated SMTP and bounded
connection/socket timeouts. Both recipients are hardcoded as a strict
allowlist; no customer-controlled email address becomes a recipient. No
fallback to port 25, opportunistic plaintext or other host.

## Delivery, retries and failure behavior

On its first **properly enabled** start, the API writes an activation timestamp
to `order_email_delivery_activation` exactly once. Only events with
`order_notification_outbox.created_at >= activated_at` are eligible. **Old VPS
orders are not emailed when SMTP is enabled later.** Restarts preserve this
watermark; events created since activation remain eligible after downtime.
Backfilling older events needs a separately reviewed procedure and is not
automated.

Every 15 seconds while the VPS API runs, the worker inserts independent
`order_email_deliveries` records for each eligible event and recipient, with
unique `(event_id, recipient_email)`. It leases due deliveries using
PostgreSQL `FOR UPDATE SKIP LOCKED` to avoid concurrent workers taking the
same row. It sends outside the transaction; SMTP failure never affects an
already committed checkout. Success records `sent_at`; errors store only
safe `smtp_transient`/`smtp_permanent` codes, with no raw SMTP responses.

Temporary errors retry with exponential delays (30 seconds, 2 minutes,
8 minutes, 32 minutes; then at most 2 hours) and a strict **five-attempt**
limit. SMTP 5xx errors fail that recipient without retry. An expired
send lease is reclaimed after 120 seconds; each individual claim uses its
own current time even when processing a long batch. After five attempts it becomes
persistently `failed`. Inspect and remediate such rows through a secure DB
session; the worker does not automatically reset terminal failures.

The system offers **durable per-recipient at-least-once sending**, not provable
exactly-once Gmail delivery. If SMTP accepts a message and the process crashes
before `sent_at` is recorded, a retry can send a duplicate; a stable
`Message-ID` helps recipients group messages but cannot guarantee
deduplication. Do not treat a `sent` receipt as evidence an inbox user read
the message. Gmail sending limits and provider throttling still apply.

## Verification before any live activation

Run `npm run typecheck`, `npm test`, and `npm run build` from `backend`.
The integration suite uses a **mock SMTP sender**, disposable PostgreSQL
database and no genuine Gmail authentication or network send. It verifies:
real checkout -> two receipts; simulation and pre-activation events excluded;
unique concurrent claims; strict sender recipient list; per-recipient retry
timing and 5xx failure; five-attempt exhaustion; lease recovery; and no PII in
the email body or persisted error fields.

After a separately approved production rollout, inspect only safe metadata:
`state`, `attempt_count`, `next_attempt_at`, `last_failure_code`, `sent_at`
from `order_email_deliveries`. Never print recipient data joined to orders,
SMTP credentials or message bodies in logs. Check whether Gmail rejects
authentication without copying its raw error into an issue or chat. If needed
to stop mail promptly, change `MITA_EMAIL_ALERTS_ENABLED=0` and restart the
API; queued events stay durable. Admin/GUI order alerts continue separately
without relying on email.

**Production status:** No Gmail credentials, live VPS systemd service details
or successful Gmail delivery have been verified here. Secrets must be
configured by the owner outside chat. No live email was sent.
