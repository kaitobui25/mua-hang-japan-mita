# Telegram new-order alerts

The existing Gmail scheduler starts after Fastify listens and uses one 15-second
timer for both channels. Each has independent activation, delivery receipts,
leases, retries and an in-flight guard. Either channel can run alone. A failure
or slow batch in one channel does not block the other. Admin acknowledgement
does not suppress delivery. Checkout and simulation behavior are unchanged.

Telegram uses native fetch and the official [sendMessage API](https://core.telegram.org/bots/api#sendmessage).
The recipient is locked in code and SQL to private chat `7480163903`.
Only order UUID, event ID, UTC event time, an unpaid-order notice and private
Admin access instructions are sent. No customer or item details are selected.
The stable event ID helps recognize possible duplicates: delivery is at least
once, since a crash after Telegram accepts a message but before the receipt is
saved can result in another send after lease expiry.

## Enablement (separate owner-approved operation)

No token, flags, schema changes or service actions are provisioned by this feature.
All of these gates must pass: Linux, `NODE_ENV=production`,
`MITA_TELEGRAM_ALERTS_ENABLED=1`, `MITA_TELEGRAM_ALERTS_VPS=1`, and a syntactically
valid `MITA_TELEGRAM_BOT_TOKEN` from the protected API process environment.
There is no configurable chat ID and no fallback token file.

Before deployment, identify the actual VPS database with read-only
`current_database()`, `inet_server_addr()`, `inet_server_port()` queries and compare
tables, columns and indexes against `backend/src/db/telegram-delivery.sql` using
`information_schema`, `to_regclass` and `pg_indexes`. Review the exact SQL and obtain
separate authorization for the migration. It creates two new tables and a work
index, references the existing outbox, and inserts no activation or delivery rows.
It is additive and reapplicable; PostgreSQL DDL locks still require review.
Do not run the full migration bundle merely to enable this channel.

The SQL is wired into the standard migration runner, disposable test runner and
build assets. **Adding it changes the local full migration bundle. The existing
One-Click authorization does not authorize this new SQL.** Review the changed
bundle before any later One-Click launch. CI never migrates production. Apply the
reviewed Telegram SQL separately on the approved target before enabling flags.

Release with flags off, verify deployed revision/schema, then provision the
protected systemd EnvironmentFile and explicitly approve restarting only
`mita-api.service`. Inspect the existing unit/EnvironmentFile path first; do not
assume a path or overwrite unrelated settings. Use restrictive ownership and
permissions. Never put tokens in source, shell arguments, logs, chat, screenshots,
frontend variables, deployment bundles or command examples.

The first enabled poll durably records the Telegram activation watermark.
Only outbox events created at or after that watermark qualify. Existing Gmail
activation and receipts have no effect on it. Disabling and re-enabling retains
the watermark and resumes eligible pending deliveries; events during downtime
after first activation remain eligible. No pre-activation events are backfilled.

## Later secure connection test from Windows Terminal

This is an owner-operated option, not a command to execute through the agent.
Open a private Windows Terminal session outside CoS/agent execution and screen
sharing/recording. Connect interactively with `ssh -t <approved-owner-host>` using
the verified host key. In a remote Bash session, turn off tracing and read the
token using a hidden terminal prompt:

```bash
set +x
read -rsp 'Telegram bot token (hidden): ' MITA_TELEGRAM_BOT_TOKEN
printf '\n'
export MITA_TELEGRAM_BOT_TOKEN
python3 - <<'PY'
import json, os, urllib.request
try:
    url = 'https://api.telegram.org/bot' + os.environ['MITA_TELEGRAM_BOT_TOKEN'] + '/getMe'
    with urllib.request.urlopen(url, timeout=10) as response:
        body = json.load(response)
    print('Bot identity verified' if body.get('ok') and body.get('result', {}).get('username') == 'Mita01Bot'
          else 'Bot identity verification failed')
except Exception:
    print('Bot identity verification failed')
PY
unset MITA_TELEGRAM_BOT_TOKEN
```

The token is typed into the hidden remote prompt, never a command argument or
CoS transcript; this check writes no secret file and sends no message. The Bot API
requires the token in its HTTPS path internally, so never print URLs or raw HTTP
exceptions. Ensure there is no session recorder or HTTP tracing. The owner must
first send `/start` to `@Mita01Bot`. Verify the private chat identity separately
without printing update bodies. A later explicitly authorized smoke message must
say `TEST KẾT NỐI` and contain no order data; it does not prove checkout delivery.
Provision the actual protected environment only in a separately approved session.

## Delivery and recovery

Each poll seeds at most 200 rows and attempts at most 10 deliveries per channel.
Unique event/chat rows prevent duplicate enqueue. Short transactions use
`FOR UPDATE SKIP LOCKED`; network requests happen outside locks. Each Telegram
request has a 10-second timeout and rejects redirects; the lease is two minutes.
Expired leases can be reclaimed. Attempt numbers fence receipt updates against
stale workers. Five attempts is the maximum, including crashed sends; an expired
fifth lease becomes failed. Backoff starts at 30 seconds, grows by four, caps at
two hours, and respects longer valid Telegram `429 retry_after` delays (sanity
bounded to one year). 4xx other than 429 fail permanently; network/timeout/5xx or
malformed responses retry. Only normalized failure codes are saved or logged.
No automatic failed-row reset, credential rotation replay or manual retry exists.

Observe counts by `state`, attempts, next-attempt/lease times and normalized
failure codes in `order_telegram_deliveries`; successful rows have `message_id`
and `sent_at`. Logs use fixed channel codes, never raw Telegram responses.
Shutdown stops the shared timer and awaits both current batches. Verify this
against the running revision separately from mocked/disposable tests.

Rollback: disable Telegram flags and approve the API restart. Keep activation and
receipts to preserve history and avoid replay. A committed external message cannot
be rolled back; dropping ledger tables loses deduplication. Do not delete rows or
force replay as a troubleshooting shortcut.
