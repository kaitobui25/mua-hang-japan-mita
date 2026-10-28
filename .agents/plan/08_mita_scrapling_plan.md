# Mita Japan — Replace Amazon crawler with Scrapling (Grill Me accepted)

**Date:** 2026-10-28 JST
**Status:** implemented and activated on local PC; source gate remains blocked pending manual verification
**Owner decisions:** Q1 replace current HTTP Fetch + Cheerio now; Q2 use the supplied Scrapling FetcherSession + BeautifulSoup + style discovery and per-ASIN detail with cache; Q3 listing and detail; Q4 remove BrowserOS Neo from automated collection; Q5 PC Windows only.

## Scope and integration

- Existing Amazon worker stays at **04:00 JST**, translator independently at **05:00 JST**. Node/TypeScript retains pg-boss, PostgreSQL persistence, admin import queue, source-wide Amazon mutex and 200 unique attempted detail ASIN/category/run ceiling.
- Replace live listing and detail reads with a **single persistent Python FetcherSession** per collection run, or a small bounded session subprocess for manual Admin imports. Keep the supplied `C:\phong\AI\test\supplement-style-150\adapters\scrapling_client.py` and sibling `parser.py`/`runner.py` as reference **without editing the test project**.
- Python uses BeautifulSoup to extract ASIN, Japanese name, observed JPY price, description/feature fields, real Amazon-owned gallery URLs, and available style/size/flavor/etc selections from verified on-page HTML / scoped JSON scripts. Require confirmed ASIN identity and source evidence; never invent values, images or groups.
- Style ASINs are enqueued into existing PostgreSQL detail queue and each is fetched at `/dp/{ASIN}` and saved as its own observation **only within the same 200-ASIN/category/run budget**. Reuse current-session cache by canonical ASIN to prevent duplicate page downloads. Any overflow remains queued for a later run.
- Python/Node bridge is bounded and deterministic: JSON protocol on stdin/stdout, errors and progress on stderr, explicit status/URL/provenance, no untrusted URLs or scripts executed. Subprocess must be shut down when worker stops; Python needs no database credentials.
- Python env/requirements pinned and preflighted on **Windows PC**. Do not deploy collector on VPS; existing PC-based tunnel worker remains the only supported remote-DB collector.

## Failure and safety rules

- Keep HTTP/timeout handling and request pacing from reference: reusable session, at most 2 retries for transient failures, rate limit requests. Stop immediately for 403/429/CAPTCHA/login/verification and persist `needs_human` + source-wide block **before further requests**. No automatic CAPTCHA solving, proxy rotation, alternate engine, browser fallback, auto-ACK or repeat probes against denied Amazon access.
- Do not erase last valid snapshots, price timestamps, ASIN variants or recorded source evidence upon failure; do not publish price/description/images unless actually observed. Keep existing checkout freshness rules and existing admin import safeguards.
- Option 1 is replaced as the live default, not silently invoked as fallback; BrowserOS Neo removed from automated collection. Existing manual owner verification is a separate explicit action until independently replaced.

## Implementation order

1. Inspect existing ingestion and the exact sample code, obtain Codex architecture review, document decisions.
2. Implement persistent Scrapling Python client and BeautifulSoup listing/detail/style parser with bounded Node IPC and rate/timeout limits; preflight dependencies without touching global Python packages.
3. Route daily discovery, detail/backfill and admin imports through Scrapling. Preserve queue lock/block gate, 200-ASIN budget and page-specific provenance.
4. Test offline fixture parity for both category listings, detail imagery/variants, child cache and identity, errors and source block; verify timeout/process shutdown, DB/snapshot invariants and 04:00/05:00 separation.
5. Update Windows startup/docs and activate only after tests; do not clear existing Amazon block or generate any unapproved live scrape. Roll back by reverting the isolated adapter commit, never by clearing the DB block.

## Acceptance criteria

- Production ingestion imports and daily worker no longer call `getHtml`/Cheerio/Neo collection.
- Verified title/JPY price/detail/image and style ASINs match offline fixture evidence; invalid/missing fields remain empty and bad ASIN/canonical identity is rejected.
- Every style ASIN in the queue contributes to the same capped attempt budget and has its own observation; same ASIN is not downloaded twice within a live session.
- Source-wide blocked state prevents *both* listing and detail requests across processes and survives restart; no bypass of CAPTCHA/403/429; partial results retain old valid snapshots.
- All relevant isolated tests/typecheck pass, process lifecycle managed and logs clearly identify Scrapling source adapter.
