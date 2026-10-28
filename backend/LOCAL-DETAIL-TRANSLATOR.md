# Local atomic DETAIL translator (Windows + PostgreSQL)

This worker calls the existing llama-server Vulkan runtime at `http://127.0.0.1:8080/v1` only. It does not start, install or download a runtime or model. The OpenRouter name translator remains unchanged at **05:00 Asia/Tokyo**. Product names and brands are never submitted to local inference or written by this worker.

## Translation contract

- Translate each Japanese string in `features`, `ingredients`, `usage` and `cautions` independently into Vietnamese.
- For `specs`, translate Japanese **attribute keys only**. Values never enter the model request and are preserved exactly, including Japanese text, whitespace, line endings, Unicode, dosage and units. Non-Japanese keys stay unchanged.
- Preserve every spec entry. If a translated key conflicts with another translated or original key, append ` [original key]`; append a numeric suffix when that label also conflicts. Original keys are reserved even while pending. Prototype-like keys are treated as data.
- Save each validated string immediately, independently of other strings. Pending or failed strings remain Japanese on the product page; successful siblings are visible immediately. Failures cannot revoke successes or hide the independently translated name.
- Freeze the source detail snapshot on first processing. Successful strings are never retranslated, even after Amazon changes its source. Remaining failed strings retry against that original snapshot. Existing successful full translations are retained and never sent to the model again, regardless of source hash.

The idempotent additive schema adds `local_detail_translations` (immutable snapshots) and `local_detail_translation_items` (one source/output/retry record per ASIN and slot). The worker never writes `product_translations`, so it cannot affect the 05:00 name worker. Snapshot and item initialization is transactional; each subsequent string update commits independently. Catalog reads combine successful atomic outputs with original pending strings. Legacy successful full details take precedence and remain visible after source changes.

## Commands and scheduling

After the runtime owner has configured the existing server and applied `npm run db:migrate`, use PowerShell from `backend`:

```powershell
$env:LLAMA_BASE_URL = 'http://127.0.0.1:8080/v1' # default
$env:LLAMA_MODEL = 'Index-Translate-2B' # configured server alias
$env:DETAIL_TRANSLATION_LIMIT = '100' # products per pass, 1..1000
npm run worker:translate:details:daily

# Explicit manual pass, at most three products (not three strings):
$env:DETAIL_TRANSLATION_LIMIT = '3'
npm run worker:translate:details
```

`DATABASE_URL` uses the existing Windows PostgreSQL backend configuration. `worker:translate:detail` remains an alias for the manual `once` command.

Daily mode registers pg-boss queue `translation.details.daily`, cron `15 5 * * *`, timezone `Asia/Tokyo`. There is **no startup run, catch-up or 30-second inference polling**. A queued job runs only within five minutes of the current 05:15 window and only if this process was already running at that time. Missed jobs are skipped. A session advisory lock prevents concurrent daily/manual DETAIL workers. The 05:00 name queue, catalog ingestion schedules and lifecycle scripts are unchanged by this backend implementation.

A failed string records a safe error code and a 12-hour retry delay, making it eligible at the next daily window; successful strings are excluded forever. Invalid output continues to other strings. HTTP errors or an unavailable model pause the pass after recording the failed string; remaining strings wait for the next scheduled or explicitly requested manual pass. There is no immediate retry loop or provider fallback. Ctrl+C aborts inference and closes the scheduler/database resources.

## Local inference limits

Requests use a short Chinese translation instruction and **one plain string**, never a large JSON translation task. `max_tokens` is **1800**, with a **2000 UTF-8 input-byte** ceiling (covering the live corpus's 1520-byte ingredient strings) to leave prompt/template room in the existing server's **4096-token context**. The backend does not resize the runtime context. Oversized individual strings remain pending with a retry error; they are never truncated or silently discarded. Configure the existing runtime to use 4096 context through the runtime owner's setup.

Only numeric HTTP loopback endpoints on `/v1` are accepted (`127.0.0.1` or `[::1]`); credentials, redirects, query overrides and external hosts are rejected. No API keys, OpenRouter calls, discovery or remote fallback are used. Requests time out after 180 seconds. Truncated, empty, JSON-shaped, reasoning-tagged or still-Japanese outputs are rejected. Numeric content, common measurement units and product codes must match the original string. These checks cannot prove semantic translation quality; output remains model-dependent. Spec values are protected by bypassing inference entirely.

## Verification without live services

From `backend`:

```powershell
npm run typecheck
npm run build
npm run test:local-details
```

`test:local-details` compiles the tests into ignored `.test-local/` and runs in-process with mocked HTTP and SQL boundaries. It performs **no model requests or database connections/writes**. It covers spec values and collisions, partial persistence, retry isolation, source freezing, permanent legacy successes, cancellation, locks, rollback, local-only request shape, output limits, CLI parsing and no-catch-up scheduling. Existing translation unit tests can also run from that compiled directory.

The repository-wide `npm test` creates a disposable PostgreSQL database and therefore writes to a database. Do not run it when live database writes are prohibited. Migration application and real model/database smoke tests belong to the runtime owner; they were not performed for this change.
