# Manual two-catalog production run — 2026-10-28 JST

This record captures **real Windows local** runs of Amazon collection, OpenRouter name translation, and local GGUF detail translation in the owner's requested order. It is not a VPS deployment. Full logs are under the ignored `.agents/runtime/` directory.

## 1. Amazon collection — both categories

| Pass | JST start | JST end | Elapsed | Result |
|---|---|---|---:|---|
| First `worker:once` | 15:19:58 | 15:42:08 | 1,330.488 s | 400 ASIN attempts (200/category), 398 saved, 30 reported issues; `sync_runs.id=9`, `partial` |
| Second `worker:backfill` | 15:42:45–47 | 16:01:19 | 1,114.650 s | 353 ASIN attempts (200 supplements, 153 baby food), 351 saved, 52 reported issues; `sync_runs.id=10`, `partial` |

The second pass encountered an Amazon CAPTCHA / login-verification page. `source_access_blocks` records the next eligible retry as **2026-10-29 04:00 JST**. Do not manually bypass the gate, claim collection fully complete, or misinterpret `saved` as a count of newly unique products. The two pass totals are **2,445.138 seconds** (~40m45s), **753 attempts** and **749 saved snapshots**, with possible ASIN overlap.

Log paths: `.agents/runtime/manual-amazon-20261028-151958.log`, `.agents/runtime/manual-amazon-backfill2-20261028-154245.log`.

## 2. OpenRouter product-name translation

- Manual worker: `npm run worker:translate --prefix backend`
- JST start: **16:01:47**; end: **16:17:39**; duration **952.512 s** (~15m53s)
- Result: **575 titles saved**, **157 rejected**, `paused: false`; normal exit 0. Previously successful titles remain unchanged.
- At the start of this step, the catalog had 816 products, with 84 previously successful translated titles. At completion approximately 659 titles were successful in total.
- Log path: `.agents/runtime/manual-openrouter-20261028-160147.log`.

## 3. GGUF local product-detail translation

- Model: `Index-Translate-2B.Q4_K_M.gguf` through loopback llama.cpp Vulkan / Intel Arc Pro.
- Manual worker: `DETAIL_TRANSLATION_LIMIT=1000`, `npm run worker:translate:details --prefix backend`.
- JST start: **16:18:20.300**; long-running, **not complete at this checkpoint**.
- Local Chat On Steroids command session: **70917**. Resume using `write_stdin` with an empty input. The wrapper prints `GGUF_END_JST`, `GGUF_SECONDS`, and `GGUF_EXIT` when complete.
- Log path: `.agents/runtime/manual-gguf-20261028-161820.log`.
- At **16:22:22 JST**, DB showed **16 product ASINs touched**, **152 validated atomic translations**, and **36 pending/failed items**. This is a progress checkpoint, **not final totals**.
- Corpus upper bound from all raw detail fields is approximately **13,456 atomic slots** over 816 products. A direct read-only count using the production `detailItems()` filter found exactly **1,882 Japanese-bearing atomic strings** eligible for local translation: **1,726** in supplements (468 eligible products) and **156** in baby food (345 eligible products). Existing full legacy translations on 3 ASINs were excluded. Actual inference is limited to these Japanese-bearing strings, not all raw fields. Detail translation remains materially slower than name translation.

The worker preserves specs **values byte-for-byte**, translating Japanese specs **keys only**, with independent validation and retry for `features`, `ingredients`, `usage`, and `cautions`. Already successful strings and legacy detail snapshots remain frozen.

## Validation and source-control boundary

- Improved atomic numeric validation allows common Vietnamese `4,5g` / Japanese `4.5g`, and count-one `một`/`mỗi` without loosening measurement/code checks. Code commit: **`3d8a179`**.
- Typecheck passed, focused local tests **16/16**, full backend suite **126/126**.
- Daily workers retain their original schedules: Amazon **04:00**, OpenRouter title **05:00**, local GGUF detail **05:15**, all JST.
- No push and no VPS deployment.

## Safe progress queries

```sql
SELECT p.category_slug, count(DISTINCT i.asin) AS products_touched,
       count(*) FILTER (WHERE i.translated IS NOT NULL) AS successful_strings,
       count(*) FILTER (WHERE i.translated IS NULL) AS pending_strings
FROM local_detail_translation_items i
JOIN products p ON p.asin=i.asin
GROUP BY p.category_slug ORDER BY 1;

SELECT error_code, count(*)
FROM local_detail_translation_items
WHERE translated IS NULL
GROUP BY error_code ORDER BY count(*) DESC;
```

Run checks read-only. Avoid starting a second GGUF manual worker while the live worker holds advisory lock `70400301`. After the current job exits, collect its end timestamp and final item totals before updating this record.
