# Mita Japan — translation warning policy, finalized Grill Me decisions 2026-10-28

## User's final answers (supersede earlier reject-and-hide behavior)

User asked for all translation errors, whether from OpenRouter, GGUF, or any future translator, to still be shown on the customer website when a **usable translation string** exists; rejection by numeric/unit/brand/code semantic validator becomes **warning only**, rather than suppressing that string. The owner will review the errors casually later. Exact answers: `1B, 2A, 3A, 4 log và admin, 5A, 6C, 7A, 8A JSONL, 9 admin chỉ show 1 dòng duy nhất "Dịch có lỗi, ghi tại ...", 10A`.

1. **Legacy scope:** Include existing failed names/details as well as future jobs. Prior discarded provider replies cannot be reconstructed; retranslate such items. Do not rewrite historical successful translations.
2. **Show usable model text despite failed semantic fact checks.** A wrong numeric dosage, quantity, unit, product code, brand, or residual Japanese marks warning, but the usable model-generated translation displays unchanged. Preserve source separately and record why warning occurred. This supersedes earlier logic that hid the rejected translation. Do **not** silently replace or invent facts yourself.
3. **No usable output:** For HTTP/timeout/quota, malformed/truncated JSON, missing ASIN, blank or structurally unparseable response, display the original source instead and log failure. Never show malformed JSON, reasoning or incomplete garbage as a translation.
4. **Warning UI scope:** JSONL log + local Admin only. The public customer website shows usable model translation without a warning badge; no detailed warning list/badges in frontend.
5. **Warning granularity shown in app:** Product-level warning aggregation; logs may specify the exact field/slot for debugging.
6. **Retries:** At most **three attempts total per failed or warned item**; keep the latest usable candidate and its warning; when improved output passes validator, replace warned candidate with approved success. At exhaustion, retain the latest warned candidate and cease automatic retries. On operational failure with no usable output, preserve original source and stop after cap; preserve scheduler skip-missed behavior. Legacy rows with attempts >=3 should not automatically retry without owner resetting the counter; any unattempted legacy failed names start from a clean counter if existing schema lacks precise attempts.
7. **Immutability of successful:** A prior validated/approved name or detail remains permanently unchanged, including when Japanese source changes. Only missing/warned items may be considered for retries.
8. **Log destination:** Append-only machine-readable UTF-8 **JSONL** at `.agents/runtime/translation-warnings.jsonl` under repository root on the Windows worker. Log ASIN, locale, field/slot, engine/model, timestamp, attempt number, original text, translated candidate (when available), validation issue codes, and result. No API keys, Authorization, customer PII, or HTTP response bodies. Do not introduce a database-powered warning review table. It is acceptable to use minimal DB metadata needed for persistence/retries, not DB log storage. File is gitignored. Logs must not be publicly served.
9. **Admin:** Exactly **one** visible line about translation errors on Admin overview, e.g. `Dịch có lỗi, ghi tại .agents/runtime/translation-warnings.jsonl`. No detailed table, no Approve/Reject actions, no additional admin page.
10. **Checkout:** Translation warnings alone never change product sale eligibility, visibility, or checkout. Existing rights/stock/price gates still apply.

## Architecture/compatibility requirements

- OpenRouter 05:00 JST is name-only; GGUF 05:15 JST is detail-only; Amazon 04:00 JST. No schedule changes or catch-up; keep locks, quota safeguards, and model restrictions.
- GGUF translates `features`, `ingredients`, `usage`, `cautions`, and specs **keys only**; specs **values byte-for-byte** untouched. Overlay for warned key must preserve unique keys and values. Keep each field source-frozen, arrays/order stable.
- Future translation engines should be able to use a shared warning classification/logging contract. Do not add an unrequested public warning badge.
- For OpenRouter batch, structurally valid JSON/ASIN-aligned output may have a few semantically erroneous titles; keep their candidate names individually as warned while accepting valid siblings. A malformed entire batch is *not* usable.
- Retry must not endlessly call free API after cap; limit to three per ASIN (not per batch). Avoid losing warnings when a source snapshot changes or a process crashes.
- Add safe additive SQL schema migrations; tests must use isolated DB as already configured. Do **not** directly mutate production DB without separate controlled migration approval from user.
- Preserve native worktree, no Git push/deploy unless separately requested. Save code with focused and full tests, then local commit once reviewed.

## Work partition

- Codex CLI subagent: backend translators, schema, persistence, JSONL logger, rendering overlay, tests. Do not edit `src/app/admin/**`, `backend/src/admin/**`, or docs.
- Primary agent: single-line Admin UI, this spec and README/runbook, integration tests, independently reviewing Codex changes and commits.
