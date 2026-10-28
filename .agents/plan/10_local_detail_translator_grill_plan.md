# Mita Japan — local detail translator (Grill Me decisions, 2026-10-28)

## Final user decisions

1. **`specs`: translate the Japanese ATTRIBUTE NAMES/KEYS ONLY; preserve all values verbatim.** This supersedes the earlier answer interpreted as translating keys and values. Keep existing product-name translator (OpenRouter) at **05:00 JST**; local model must never rewrite product names.
2. Preserve previously translated detail even when Amazon's original changes; do **not** retranslate successful old text automatically. This may leave old directions/warnings; keep Japanese source separately and document that limitation.
3. Save valid translated fields independently. Keep failed/invalid text in Japanese, retry missing items on later scheduled runs without discarding validated siblings.
4. Local **IndexTeam/Index-Translate-2B-GGUF Q4_K_M**, using llama.cpp **Vulkan** on Intel Arc Pro, model stored under `C:\phong\AI\web\mita-japan\models` (outside Git repo). Prefer GPU layers 99, 4096 context, 12 CPU threads, temperature 0, reasoning off, ~1800 max output, bounded input size.
5. No external-model fallback (no OpenRouter) for detail jobs. Offline server => defer/retry, leave translated titles intact.
6. **05:15 Asia/Tokyo** every day, in independent process/pg-boss queue, skip missed runs when PC was off; no startup catch-up.
7. Smoke test a small real sample today after safety checks, translate full backlog starting with the next daily **05:15 JST** scheduled job.

## Scope and invariants

Translate Japanese `features[]`, `ingredients[]`, `usage[]`, `cautions[]` into Vietnamese. For `specs` translate **keys only**, retain value text (numbers, ingredients, warnings, maker codes etc.) exactly as observed. Never invent health claims or change doses/quantities/units. Keep input source and brand unchanged; use glossary when compatible with constrained translation, but avoid silently replacing source semantics. Preserve arrays/order, handle translated key collisions without overwriting original specs.

Persist local detail snapshots and per-atomic-field tracking in independent PostgreSQL `local_detail_translations` and `local_detail_translation_items` tables. Do not write `product_translations`, which remains owned by the 05:00 OpenRouter name worker and historical full translations. Preserve successful titles and historical detail. Use an additive migration. Catalog overlay must retain old successful detail even when Amazon source_hash changes. Build independent `detail` scheduler, keep Amazon 04:00 + name 05:00 unchanged. No push or VPS deployment.

## Implementation path

1. Verify Windows llama.cpp Vulkan binary and GGUF model; SHA validation of runtime; no API key for local inference. Start server bound to `127.0.0.1`, select a private port, fail closed when unavailable. Benchmark short strings, glossary prompt and number preservation; GPU fallback is **not** OpenRouter.
2. Codex CLI: implement modular backend detail worker, per-section retry/persistence, 05:15 scheduler, unit/integration tests, schema updates and docs. Prime agent: download runtime/model, scripts/start/stop integration, smoke test and independent validation.
3. Run backend typecheck/build/tests and Python tests if affected. Start only the new worker/service, verify pg-boss cron and source data. Manual `--limit` smoke, capture pass/fail, leave incomplete fields retriable; full batch awaits next 05:15.
4. Check git diff, commit local and clean worktree, docs and final report.

## Live environment at planning

- Windows, Intel Core Ultra 7 155H (22 threads), ~63.5 GB RAM, Intel Arc Pro integrated GPU, Windows Vulkan loader present; native llama.cpp/Ollama initially not installed.
- 210 Amazon product detail rows; features on 210, ingredients 146, usage 57, cautions 42, specs 210.
- Existing 05:00 translator and Amazon worker run as distinct processes. Maintain their schedules without interruption.
