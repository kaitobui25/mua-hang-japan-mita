# Amazon.co.jp department-level assisted-purchase QA

## Scope and pass criteria

- **User-specified scope (2026-11-12):** every current top-level **Amazon.co.jp** department, not the two Mita Shop ingestion seeds.
- Select **exactly two distinct, real products shown on page 1** of each department. Record the observed listing URL, timestamp, ASIN and DOM evidence; do not extrapolate membership from old search results.
- Submit the exact Amazon URL to Mita's Cloudflare-facing quote endpoint. A pass requires a **source-backed JPY-priced quote and an independently persisted, payable-later priced checkout order** in an isolated QA database; neither a preview nor an unpriced `purchase_request` is a pass.
- Compute the pass rate only over the complete verified page-1 sample: `successful priced checkouts / (2 × verified top-level department count)`. With 31 departments and 62 sampled links, reaching at least 99% requires **62/62** passes.
- Do **not** create a real Amazon order, take payment, alter active databases, bypass CAPTCHA/429/source cooldown, or imply that a local Cloudflare Quick Tunnel is the production deployment.
- Report digital-only, subscription-only, gift-card and other fundamentally ineligible departments as explicit coverage blockers, **not** quietly excluded passes. A stable scope exclusion requires a user decision.

## Candidate top-level taxonomy; not yet verified against current Amazon UI

The table is a **research checklist**, not evidence that the department's current page-1 products were tested. A Japanese category-reference article (published 2026-10-17, updated 2026-11-08) reports 31 top-level departments: https://nanbonan.jp/guide/amazon-category-ichiran-browse-node/ . Amazon's own SearchIndex catalog confirms many category names but has a different grouping: https://webservices.amazon.co.jp/paapi5/documentation/locale-reference/japan.html . Verify actual department membership on Amazon after lawful source access resumes.

| # | Amazon.co.jp department | Page-1 URLs & two source-backed ASINs | Priced checkout |
| -: | --- | --- | --- |
| 1 | DIY・工具・ガーデン | Pending | Not tested |
| 2 | おもちゃ | Pending | Not tested |
| 3 | ゲーム | Pending | Not tested |
| 4 | スポーツ＆アウトドア | Pending | Not tested |
| 5 | ドラッグストア | Pending | Not tested |
| 6 | パソコン・周辺機器 | Pending | Not tested |
| 7 | ビューティー | Pending | Not tested |
| 8 | ファッション | Pending | Not tested |
| 9 | ペット用品 | Pending | Not tested |
| 10 | ベビー＆マタニティ | Pending | Not tested |
| 11 | ホーム＆キッチン | Pending | Not tested |
| 12 | ホビー | Pending | Not tested |
| 13 | 大型家電 | Pending | Not tested |
| 14 | 家電＆カメラ | Pending | Not tested |
| 15 | 文房具・オフィス用品 | Pending | Not tested |
| 16 | 楽器・音響機器 | Pending | Not tested |
| 17 | 産業・研究開発用品 | Pending | Not tested |
| 18 | 車＆バイク | Pending | Not tested |
| 19 | 食品・飲料・お酒 | Pending | Not tested |
| 20 | 本 | Pending | Not tested |
| 21 | 洋書 | Pending | Not tested |
| 22 | DVD | Pending | Not tested |
| 23 | ミュージック | Pending | Not tested |
| 24 | PCソフト | Pending | Not tested |
| 25 | Amazonデバイス・アクセサリ | Pending | Not tested |
| 26 | Amazon整備済み品 | Pending | Not tested |
| 27 | Kindleストア | Pending | Not tested |
| 28 | Prime Video | Pending | Not tested |
| 29 | アプリ＆ゲーム | Pending | Not tested |
| 30 | デジタルミュージック | Pending | Not tested |
| 31 | ギフトカード | Pending | Not tested |

## Verified baseline and current blocker

- Previous sample: two **Mita ingestion subcategories** (food supplements and baby foods), 20 genuine page-1 product URLs in total, **19/20 priced checkout**, one backordered product accepted only as an unpriced purchase request. **None of those 20 are established as the mandatory two URLs from each of the 31 top-level Amazon departments.**
- Read-only local source gate on **2026-11-13 18:43 JST** reports `amazon.co.jp` cooldown through **2026-11-14 04:00 JST**, reason Amazon HTTP 200 CAPTCHA/login/access verification. `amazon.co.jp:quote` has no local cooldown row; quote requests are a separately gated operation and do not establish listing page-1 provenance. Do not attempt fresh Amazon listing retrieval while the catalog source gate blocks it.
- A separately labeled **third-party candidate-only** snapshot (`.agents/runtime/amazon-offsite-candidates-20261113.json`) contains 42 product-link candidates from 21 independently grouped top-three lists at https://nanbonan.jp/ranking/ (retrieved 2026-11-13). This source is not the Amazon page-1 DOM, mixes broad/subcategories and some unrelated products, and does **not** count as verified department membership, page-1 rank, current offer, or QA pass.
- No completed all-department numerator or denominator is yet evidenced. Do not claim 99% on the basis of backend unit tests or the earlier 20-link subcategory sample.
