# 06 — Mita Japan: thử nghiệm Codex CLI dịch/rút gọn tên và điều tra SEO P2-04 đến P2-07 (02/11/2026)

> **Nhật ký lịch sử, không phải đặc tả vĩnh viễn.** Khi tiếp tục phải đối chiếu yêu cầu mới nhất, `AGENTS.md`, code/DB/VPS thực tế. Các tác vụ SEO trong phiên này **chỉ điều tra, chưa sửa**. Các file thử nghiệm dịch nằm ngoài Git repository chính, trong `C:\phong\AI\web\mita-japan\my-test`.

## 1. Yêu cầu người dùng theo thứ tự

1. Sau một phiên benchmark OpenRouter chưa có model dịch tiếng Việt tốt, người dùng yêu cầu nghiên cứu **các model/reasoning modes của Codex CLI** để dịch tên sản phẩm trong `my-test`, ưu tiên **ít quota/limit nhưng kết quả tốt**, thử thật và tổng hợp báo cáo.
2. Tiếp tục hỏi **GPT-6.1 Sol + Low**, trong **một lượt vừa dịch vừa rút gọn**, xử lý tối đa bao nhiêu **ký tự tên nguồn**; yêu cầu thử thực tế, không đoán từ context window.
3. Yêu cầu phân loại **7 việc SEO P2** trong production audit: việc nào bắt buộc ưu tiên, nên làm, có cũng được, không cần thiết.
4. Yêu cầu phối hợp `/codex-cli-control` điều tra **P2-04 đến P2-07 cần sửa những file code và dữ liệu DB nào**, chỉ điều tra, chưa yêu cầu triển khai sửa.
5. Cuối phiên yêu cầu **summary toàn bộ phiên và ghi vào `.agents/chatgtplog`**.

Công cụ được người dùng chỉ định: **Chat On Steroids Core — mana-phong**, điều khiển Codex CLI đăng nhập sẵn trên PC. Không tự sử dụng model API trả phí, không thay thế bằng OpenRouter khi người dùng yêu cầu Codex CLI. Người dùng ưu tiên đơn giản, trung thực, ít câu hỏi; trước tác vụ nhiều bước trình bày kế hoạch ngắn.

## 2. Môi trường, phạm vi và an toàn

- Project Windows: `C:\phong\AI\web\mita-japan\mua-hang-japan-mita`; workdir CoS: `/ai/web/mita-japan/mua-hang-japan-mita`.
- Thử nghiệm độc lập: `C:\phong\AI\web\mita-japan\my-test` / `/ai/web/mita-japan/my-test`; **không thuộc repository ứng dụng chính**.
- Git HEAD khi điều tra SEO: `090cadd`. Có sẵn các untracked `.agents/plan/14_mua_ho_amazon_grill_20261030.md`, `.agents/plan/15_mita_vps_full_site_seo_audit_plan_20261102.md`, `reports/`; không được coi chúng là thay đổi do phiên này.
- Production SEO audit: `reports/seo/20261102_production/production-seo-audit-20261102.md`, kiểm tra ngày 02/11/2026, ghi release production `5794a6887377` (khác local HEAD), 51 URL mẫu, sitemap 840 URL (832 sản phẩm + 8 trang chung). Không có GSC; PSI quota 429, **không có dữ liệu index/traffic và CWV đủ điều kiện**.
- PostgreSQL local **chỉ đọc**: `127.0.0.1:5433/postgres`, role `mita_local`, dùng `BEGIN READ ONLY` + `ROLLBACK`. `15432` là tunnel tạm tới VPS, không dùng trong phiên.
- **Không** ghi dữ liệu DB, migration, restart worker/API, đụng VPS, sync/deploy, sửa code website hoặc làm thay đổi setting Admin.
- Codex CLI `0.161.0`, đăng nhập ChatGPT; trên PC elevated Windows sandbox có vấn đề, sử dụng `windows.sandbox="unelevated"` (sandbox vẫn bật) với read-only. Lệnh Codex từ CoS Core. Không dùng cờ bypass sandbox.
- Trong benchmark dịch cần effort Low/Medium; helper `Invoke-Codex.ps1` khi đó không có tham số effort nên harness gọi **Codex CLI trực tiếp thông qua CoS**, với `-c model_reasoning_effort="low|medium"`, `--ephemeral`, `--ignore-user-config`, `-s read-only`, UTF-8 stdin để không hỏng tiếng Nhật/ký tự JSON.

## 3. Thử nghiệm so sánh model Codex dịch tên sản phẩm

Nguồn: `my-test/input-20.json`, 20 tên gốc lấy từ SQL (10 thực phẩm bổ sung, 10 thực phẩm cho bé), không dùng tên Việt cũ làm dữ liệu đầu vào cho lượt dịch chính. `codex-translate-test.ps1` chạy cùng 8 ASIN cố định với prompt JSON tiếng Việt, yêu cầu giữ ASIN/thương hiệu/số/hương vị/quy cách:

| Codex model | Effort | Trả tên Việt | Giữ multiset số | Vẫn có chữ Nhật | Input tokens (cached) | Output tokens |
|---|---|---:|---:|---:|---:|---:|
| `gpt-6-luna` | low | 8/8 | 8/8 | 2/8 | 15.166 (11.776) | 455 |
| `gpt-reserve` | low | 8/8 | 8/8 | 3/8 | 14.825 (10.496) | 646 |
| `gpt-6.1-sol` | **low** | **8/8** | 8/8 | **0/8** | 15.858 (12.416) | 441 |
| `gpt-6.1-sol` | medium | 8/8 | 8/8 | 3/8 | 17.245 (12.416) | 457 |

- Trên mẫu nhỏ này chọn **GPT-6.1 Sol Low**; không chứng minh Medium luôn kém, chỉ là không có cải thiện trong lần thử. Không thử High vì không cần và tốn quota.
- Một lượt Sol Low dịch **20/20** tên tiếng Việt; **19/20** giữ multiset số, **0** còn chữ Nhật. Dùng **17.985 input (12.416 cached), 1.197 output tokens**, khoảng **25,7 giây**.
- Rà soát nội dung thấy các cụm nguồn lỗi/tối nghĩa (`Retreat`, `Handpickles`, `Compare to Food`), lặp “thức ăn dặm” và đếm số gói lặp. Chỉ gửi lại **6 ASIN** bằng Sol Low; lượt sửa dùng **17.581 input (12.416 cached), 333 output**, khoảng **11,8 giây**.
- Kết hợp 20 bản sau sửa: **20/20 có tiếng Việt; 20/20 giữ multiset chữ số; 0 chữ Nhật**. **7 sản phẩm vẫn có cảnh báo dữ liệu nguồn**, không được coi bản dịch đã xác thực về ngữ nghĩa/thành phần thực phẩm.
- Tổng quy trình chọn (20 + sửa 6): **35.566 input (24.832 cached), 1.530 output**, khoảng **38 giây**, chưa tính so thủ công. Không suy ra chính xác quota/USD từ input/output vì CLI có overhead và cached tokens.
- Lúc đầu có báo quota 5h 94%, tuần 61%; sau các lượt 5h 93%, tuần 61% — số phần trăm làm tròn, **không phải mức phí mỗi sản phẩm**.
- File: `my-test/CODEX-REPORT.md`, `codex-best20.csv`, `codex-best20.json`, `codex-comparison.json`, `codex-results/`, `codex-translate-test.ps1`, `codex-evaluate.mjs`, `codex-finalize.mjs`.
- So với benchmark OpenRouter trước đó: model free Nemotron Lightning chỉ trả tiếng Anh/phần lớn giữ nguyên; Gemma bị 429, Ultra trả `choices:[]`; không thể xếp hạng chất lượng dịch các model không tạo kết quả. Thử Codex ở đây không sửa hệ thống OpenRouter đang chạy.

## 4. Đo khả năng **một lượt dịch đầy đủ + rút gọn tên**

- Đọc thêm dữ liệu từ PostgreSQL local, xuất `my-test/input-scale.json` **651 sản phẩm** (20 tên mẫu cố định + 631 tên chọn deterministically theo `md5(asin)`).
- Một Codex request cho mỗi batch; model **`gpt-6.1-sol` Low**; xuất JSON `products:[{asin,full,short}]`; `short` tối đa **120 ký tự Unicode**, nếu không giữ đủ facts thì **`null`**. Không sửa DB.
- Mỗi batch chỉ chạy một lần; các ký tự được đếm trên **tên nguồn**, không tính prompt, JSON/ASIN/brand; validator kiểm đủ ASIN, các giá trị số, dấu Việt, chữ Nhật và độ dài.

| Batch | Ký tự tên nguồn | Trả đủ ASIN/JSON | Full giữ đủ các **giá trị số phân biệt** | Tên short <=120 | Short null | Output tokens | Thời gian |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 2.104 | 20/20 | 20/20 | 14 | 6 | 1.598 | 35 giây |
| 80 | 8.371 | 80/80 | 80/80 | 74 | 6 | 6.730 | 70 giây |
| 160 | 17.623 | 160/160 | 158/160 | 150 | 10 | 13.754 | 168 giây |
| 320 | **35.073** | **320/320** | **320/320** | **291** | **29** | **26.266** | **302 giây** |

- Batch 320 dùng **36.644 input (12.416 cached), 26.266 output tokens**, prompt + input JSON 60.897 ký tự; **320 trả đủ đúng thứ tự ASIN**, nhưng **3 tên X-PLOSION vẫn phần lớn tiếng Anh**; 319/320 giữ đúng **tần suất** từng số (trường hợp còn lại đã gộp số trùng); validator về số phân biệt đạt 320/320. 291 short hợp lệ theo kiểm tra số và chiều dài, không phải chứng nhận ý nghĩa.
- Batch 160 có **2 trường hợp sai/thiếu giá trị số** (`B0H6Y4P57V`, `B0G1LG5C37`). Batch 80 giữ đủ giá trị số nhưng vẫn có 1 tên whey giữ tiếng Anh. Không được tuyên bố hiệu quả tuyệt đối hay suy tỷ lệ lỗi thống kê từ một lần chạy.
- **Giới hạn cao nhất ĐÃ CHỨNG MINH bằng thử nghiệm: ít nhất 35.073 ký tự tên nguồn / 320 sản phẩm** trong một lượt vừa dịch vừa rút gọn. **Không xác định được trần cứng tuyệt đối**; cache model hiển thị context window 500.000 tokens nhưng ký tự nguồn, input tokens và khả năng xuất JSON không thể đồng nhất.
- **Khuyến nghị vận hành thận trọng:** batch khoảng **80 tên / 8.000–9.000 ký tự nguồn** có validator ASIN, giá trị số, tiếng Việt, hương vị, thương hiệu, độ tuổi và retry chọn lọc; hoặc 20 tên khi muốn khoanh vùng lỗi. Không tự động đưa bản dịch chưa được kiểm duyệt lên production.
- File: `my-test/CODEX-SCALE-REPORT.md`, `scale-summary.json`, `input-scale.json`, `scale-results/sol-low-N.{prompt.txt,txt,jsonl,meta.json}`, `codex-scale-test.ps1`, `codex-scale-evaluate.mjs`, `codex-scale-report.mjs`.
- Script JavaScript kiểm tra syntax và tái tổng hợp báo cáo PASS. Không có sửa trực tiếp catalog/worker Mita trong phần test.

## 5. Phân loại SEO P2 (7 vấn đề, theo ưu tiên kinh doanh Mita)

Nguồn: `reports/seo/20261102_production/production-seo-audit-20261102.md:57-71`.

- **P2-04 (title/H1/nội dung tiếng Việt): ưu tiên cao nhất, cần làm** vì người mua tìm bằng tiếng Việt; phải đúng ASIN, hương vị, thương hiệu, độ tuổi, số lượng.
- **P2-07 (sitemap/ASIN redirect): cần sửa lỗi đã xác nhận**, phối hợp **P1-01** chuyển từ vị cacao sang vị tự nhiên; không suy rộng toàn bộ 832 URL có lỗi.
- **P2-05 (link phân trang crawlable): nên làm**, đặc biệt trang phân trang thực; sitemap đã hỗ trợ Google khám phá ASIN nên không kết luận mọi trang sâu đều mất index.
- **P2-06 (canonical/index trang chung): làm có chọn lọc**, cần owner chốt giỏ/checkout có nên `noindex`; self-canonical không phải yêu cầu bắt buộc để Google index.
- **P2-03** meta description riêng: nên có, không trực tiếp bắt buộc cho thứ hạng.
- **P2-01** JSON-LD Product/Offer/Breadcrumb: nên có khi phản ánh chính xác mô hình mua hộ, quyền ảnh/rating/giá; không phải điều kiện index.
- **P2-02** Open Graph/Twitter: có thể hoãn đối với Google SEO, chủ yếu chia sẻ link xã hội.

Đây là **ưu tiên thực dụng**, không phải tuyên bố các yếu tố trên là “điều kiện bắt buộc” theo quy tắc Google.

## 6. Điều tra độc lập cùng Codex CLI: P2-04 đến P2-07 — file code và DB

- Đã đọc `AGENTS.md`, audit production, Next.js `src/`, backend `backend/src/`, SQL `backend/src/db/`. Nhờ Codex CLI **`gpt-6.1-sol` read-only** kiểm tra độc lập bốn P2; Codex xác nhận nguyên nhân/đường đi và **không sửa file/DB, không deploy**. Lưu ý Codex đọc code và bằng chứng audit, **không tự truy vấn DB**; CoS tự làm SQL read-only.
- **P2-04 — tên SEO/H1**:
  - `backend/src/catalog.ts:75-105` nạp bản dịch rồi projection title; `backend/src/translation/catalog.ts:27-50` đọc `product_translations.name`; `backend/src/translation/title-presentation.ts:11-38` dùng `product_title_presentations.short_name` **chỉ khi source_name và translated_name còn khớp**.
  - `src/app/(store)/san-pham/[id]/page.tsx:10-21` lấy `product.name` làm SEO title; meta description lấy `product.description` hoặc `detail.features` hoặc fallback và **cắt 160 ký tự**. `src/components/catalog/product-detail.tsx:77` hiển thị H1 từ tên variant đã chọn. `backend/src/catalog.ts:39-73` hiện không trả trường `description` riêng.
  - `backend/src/translation/compact-title.ts:17-50` validator chặt (<=120, giữ brand/số; tự từ chối tên có trên 4 số); `:62-109` gọi OpenRouter free và lưu CAS; `:136-189` quota-bound backfill; `backend/src/translator.ts:9-18` có gọi `compactPendingTitles()`. Chưa chứng minh scheduled job hoạt động đúng production.
  - `backend/src/translation/jobs.ts:143-175` **giữ bất biến các hàng `status='success'`**; không thể chỉ rerun worker để sửa tất cả bản dịch tiếng Anh/sai. Cần quy trình sửa được kiểm chứng, có provenance và rollback, không tự phá `products.name`.
  - **DB:** dữ liệu `product_translations`, `product_title_presentations`, `product_title_attempts`; **không cần migration trên bằng chứng hiện có**, nhưng cần **chỉnh dữ liệu bản dịch lỗi một cách có kiểm soát** sau khi được người dùng cho phép.
- **P2-05 — phân trang**:
  - `src/components/catalog/catalog-view.tsx:52-55,80` nút `button` + `router.push` không tạo `href` crawlable.
  - `src/app/(store)/san-pham/page.tsx:7-10` canonical luôn `/san-pham`; `src/app/(store)/danh-muc/[slug]/page.tsx:10-13` luôn canonical danh mục gốc, kể cả page=2. `src/lib/server-catalog.ts:30-57` parse params/server fetch; `backend/src/server.ts:51-56`, `backend/src/catalog.ts:125-176` đã hỗ trợ SQL `LIMIT/OFFSET`.
  - **Sửa code frontend** để phân trang thực dùng Next Link `href`, metadata/canonical có chính sách theo page; tách khỏi sort/filter/search. **Không sửa DB**.
- **P2-06 — canonical và index**:
  - `src/app/layout.tsx:6-11` root `robots: index,follow`; `src/app/(store)/page.tsx` chưa khai báo canonical; `cach-mua-hang/page.tsx:5`, `danh-gia/page.tsx:6-9`, `gio-hang/page.tsx:4`, `thanh-toan/page.tsx:4` metadata thiếu canonical tương ứng.
  - `src/app/sitemap.ts:8-10` **đưa giỏ và checkout vào sitemap** mặc dù chúng không phải landing page tìm kiếm thông thường.
  - **Sửa metadata/sitemap code-only** sau khi owner chốt có `noindex` giỏ/checkout hay không. Đừng tự suy diễn chính sách từ audit.
- **P2-07 — ASIN redirect/sitemap**:
  - `src/lib/preferred-variant.ts:5-14` chọn biến thể còn đặt được theo điểm thuộc tính (ưu tiên kích thước), **không bắt buộc hương vị trùng**.
  - `src/app/(store)/san-pham/[id]/page.tsx:24-30` thực hiện Next `redirect` nếu đề xuất ASIN khác; `src/components/catalog/product-detail.tsx:26-53,65` còn tự chọn variant, `window.history.replaceState` và đổi document title/canonical trên client.
  - `backend/src/catalog.ts:107-123` lấy đúng sibling theo `variant_group_basis` + `variant_group_id`; `src/app/sitemap.ts:12-31` lấy **tất cả ASIN công khai của mọi sibling** mà không kiểm tra URL thực sự redirect.
  - Production audit xác nhận `B084MCDYF6` (GronG **cacao**) HTTP **307** sang `B07N8H8WRB` (GronG **Natural/không hương vị**) trong mẫu. **Sửa logic giữ nguyên ASIN/hương vị và hiện trạng thái không đặt được**, không gộp hoặc xóa ASIN, rồi mới đồng bộ sitemap/canonical theo URL hợp lệ. Đây cũng là **P1-01**.
  - **DB:** các bảng `products`, `product_details.variant_attributes`; chưa có bằng chứng cần đổi nhóm hoặc migration. Không dùng `sale_status`/giá như lý do để chuyển khách sang hương vị khác.

## 7. SQL read-only đã xác minh trên PostgreSQL local

- Xác nhận DB đích `postgres` / `127.0.0.1:5433` / `mita_local` từ query runtime.
- `products` **832** dòng; **832** bản dịch tên `success` hoặc `warning` tại locale `vi`:
  - `success, name_only=true`: **823**.
  - `warning, name_only=true`: **6**.
  - `success, name_only=false`: **3**.
  - **0** hàng `product_title_presentations`, **0** hàng `product_title_attempts` — có schema nhưng **chưa có dữ liệu rút gọn**.
- Ví dụ tên nguồn/bản dịch lưu trong DB vẫn sai hoặc tiếng Anh: REYS `B0C6X64277` đang có **“Cổ Trang 7 Loại Vitamin”**; `B06Y69FKT2` còn `Milk Chocolate Flavor`; `B08F63WK3Z` tên rất dài. **`status=success` là trạng thái pipeline, không phải chứng nhận ngữ nghĩa**.
- `B084MCDYF6` và `B07N8H8WRB` cùng `variant_group_basis='parent_asin'`, `variant_group_id='B0DKH791FB'`, nhưng thuộc tính `flavor_name` là **“Cocoa flavor”** và **“Natural”** khác nhau. DB local đều `sale_status='ready'`, `availability='in_stock'`, cùng giá JPY 6.980 và `rights_status='local_test_only'`; không dùng snapshot local để kết luận vì sao một URL production bị redirect ở thời điểm audit.
- `catalog_settings.hide_local_test_only=false`, `pricing_policy.check_price_expiry=false` tại thời điểm kiểm; bản ghi đa số `local_test_only` vẫn công khai bởi owner policy. **Không bật/tắt switch** và không thay chính sách quyền.
- Schema đã có các bảng/cột cần thiết. Không tìm thấy yêu cầu migration cho P2-04...07; **chỉ P2-04 có thể phải cập nhật dữ liệu** sau khi kiểm chứng nguồn/quyền và được duyệt.

## 8. Kế hoạch sửa tối thiểu được đề xuất, chưa được phép thực thi

1. **P2-07 + P1-01 trước:** giữ nguyên URL và identity/variant sản phẩm đã yêu cầu, không redirect sang khác hương vị chỉ vì không đặt được; test các trường hợp Cocoa/Natural/Strawberry/Banana, còn đặt được/không; sau đó kiểm tra sitemap và canonical đồng bộ.
2. **P2-04:** xác minh/sửa bản dịch tiếng Việt sai, phân biệt **tên nguồn**, **tên Việt đầy đủ**, **tên rút gọn trình bày** và **SEO title**; tránh metadata cắt những đoạn mô tả kém chất lượng; giữ nguyên lịch sử/provenance. Không tự ghi hàng loạt vào DB, không vượt guard `success`/policy. Kiểm thử `backend/tests/translation-catalog.test.ts`, `title-presentation.test.ts`, `compact-title.test.ts`, `variants.test.ts`.
3. **P2-05:** link phân trang thực `href`, canonical riêng cho page có nội dung khác, phân biệt sort/filter/search. Test SSR HTML page 1/2/3 cả catalog và danh mục.
4. **P2-06:** owner quyết định trang indexable; thêm canonical tự thân cho trang nội dung có ích, cân nhắc `noindex` giỏ/checkout và loại khỏi sitemap khi đã chốt. Test page metadata/robots/sitemap sau thay đổi.
5. Mọi triển khai code phải kiểm `npm run lint`, `npm run typecheck --prefix backend` nếu backend đổi; test backend **chỉ trên DB tạm** theo `AGENTS.md`; kiểm HTTP HTML/sitemap/redirect sau deploy **được phép**. Không tự triển khai VPS hoặc migration.

**Giới hạn cuối phiên:** chưa kiểm tra production runtime mới hơn audit; không đo GSC, không đo PSI; chưa sửa code, DB, worker, VPS, không tạo commit cho các thay đổi ứng dụng. Log này chỉ lưu kết quả và các khuyến nghị để người dùng quyết định bước tiếp theo.
