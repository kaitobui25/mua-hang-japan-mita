# 07 — Implement: Gallery, tiếng Việt OpenRouter, mô tả và biến thể Amazon

**Ngày:** 27/10/2026 JST  
**Trạng thái:** `implementing` — owner đã chốt Q1–Q9; ngày 27/10/2026 đổi Q1 từ OpenCode sang **OpenRouter trực tiếp trên PC**, bắt đầu triển khai.  
**Phạm vi:** hai danh mục catalog hiện tại; giữ hệ thống Mita Next.js/Fastify/PostgreSQL và worker trên Windows.

## 1. Yêu cầu đã xác định

- Với **mỗi ASIN**, thu thập tối đa **5 ảnh thật**, ưu tiên ảnh độ phân giải cao từ trang chi tiết, dùng ảnh nhỏ hợp lý trong danh sách và gallery trong trang sản phẩm.
- Chỉ giữ **URL ảnh nguồn** trong DB; **không tải/cache ảnh trên VPS** trong phạm vi lần này.
- Giữ tên gốc; bổ sung tên tiếng Việt theo ngữ cảnh, bảo toàn thương hiệu, số liệu, đơn vị, mã; có thể dịch **sau** khi thu thập dữ liệu.
- Thu thập nội dung trang chi tiết: đặc điểm, thành phần, cách sử dụng, thông số, cảnh báo/lưu ý; bản dịch nếu có phải có dấu vết nguồn, không tự sáng tác.
- Lấy thuộc tính thực tế như style, size, hương vị, quy cách; tìm ASIN con và nhóm khi có bằng chứng quan hệ nguồn. **ASIN con luôn là định danh duy nhất**.
- Khi chọn biến thể, ảnh, nội dung, giá, tình trạng và giỏ/đơn phải khớp **ASIN đã chọn**.

## 2. Kiểm tra code hiện có

- `backend/src/db/schema.sql`: `products` có `name`, `image_url`, `variant_group_*`; không có gallery, nội dung chi tiết, bản dịch hay thuộc tính variant chuẩn hóa.
- `backend/src/ingestion/source.ts` và `sync.ts`: đồng bộ chủ yếu qua trang liệt kê, chưa enrich detail cho toàn bộ ASIN; giới hạn phát hiện 200 ASIN/danh mục hiện hành.
- `backend/src/ingestion/detail.ts`: mới parse title, giá, ảnh chính (`data-old-hires` nếu có), availability; chưa parse gallery, bullet/ingredients, bảng thông số, variant attributes/child ASINs.
- `backend/src/catalog.ts`: API trả một `imageUrl` và sibling có mã nhóm xác minh; chưa có description/attributes cho khách.
- `src/components/catalog/product-detail.tsx`: ảnh đơn và radio list tên ASIN; UI đã giữ lựa chọn theo ASIN; `description` sẽ hiển thị nếu API bổ sung.
- `src/components/ui/product-image.tsx`: `<img>` trực tiếp từ URL nguồn; chưa có gallery/responsive thumbnail.
- `docs/hermes-vps-runbook.md`: public read-only, 122 sản phẩm `local_test_only` hiện có; admin qua tunnel; worker PC; không backup; CI `[deploy]` không tự migrate DB.

## 3. Nguồn dịch OpenRouter trên PC (quyết định mới thay thế OpenCode)

- PC có biến môi trường `OPENROUTER_API_KEY` (đã kiểm tra **chỉ sự hiện diện**, không đọc/ghi giá trị). Gọi trực tiếp OpenRouter Chat Completions bằng HTTPS từ **worker PC**; không dùng OpenCode CLI cho bước dịch.
- Danh sách model theo **đúng thứ tự fallback** owner chọn, chỉ dùng ID `:free`:

| Thứ tự | Model | OpenRouter model ID |
| --- | --- | --- |
| 1 | Gemma 4 31B | `google/gemma-4-31b-it:free` |
| 2 | Nemotron 3 Ultra 550B | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| 3 | Gemma 4 26B A4B | `google/gemma-4-26b-a4b-it:free` |
| 4 | Inkling Small | `thinkingmachines/inkling-small:free` |
| 5 | Nemotron 3.5 Lightning | `nvidia/nemotron-3.5-lightning:free` |

- Khi model lỗi mạng, timeout, HTTP 429, 5xx, hoặc trả JSON không hợp lệ → **thử model kế tiếp trong cùng yêu cầu**, ghi model đã dùng/trạng thái; chỉ retry vòng sau theo giới hạn rõ, không vòng lặp vô tận. Khi toàn bộ đều lỗi → để `pending`/`failed`, giữ nguồn gốc, không chặn catalog. HTTP 401/403 do **API key chung** cần báo lỗi cấu hình, không kỳ vọng đổi model sẽ sửa được.
- Tất cả model miễn phí có quota/tình trạng có thể thay đổi. **Inkling Small free có giới hạn cho agentic harness** theo trang model; nếu endpoint từ job không cho phép sử dụng, bỏ qua khi lỗi và thử model số 5, không lách điều kiện sử dụng. Không tự đổi sang model trả phí hoặc `openrouter/free` ngoài danh sách.
- Chỉ gửi tên/nội dung sản phẩm đã quan sát; không gửi dữ liệu người mua, session, API key hay thông tin nội bộ. Docs: https://openrouter.ai/docs/quickstart ; https://openrouter.ai/docs/api-reference/limits .

## 4. Quyết định Grill Q1–Q9 — ĐÃ CHỐT

| Mã | Quyết định owner | Cách hiểu triển khai |
| --- | --- | --- |
| **Q1 A (được thay ngày 27/10)** | **OpenRouter 5 free models** | Worker PC gọi lần lượt 5 model bảng trên, tự fallback khi model bị limit/lỗi; `OPENROUTER_API_KEY` lưu ở môi trường PC, không gửi dữ liệu khách hàng. |
| **Q2: Không cần kiểm duyệt** | **Tự động công bố bản dịch** | Không thêm bước duyệt thủ công hoặc hàng chờ Admin. Có kiểm tra kỹ thuật chống lỗi JSON/mất thương hiệu/đổi số liệu; bản dịch lỗi không được dùng, vẫn giữ gốc. |
| **Q3: Chỉ tên Việt** | **Thứ tự thuật ngữ Việt → Anh → Nhật** | Trong tên hiển thị, ưu tiên tiếng Việt; từ không có cách diễn đạt Việt phù hợp dùng tiếng Anh, chỉ dùng tiếng Nhật nếu cũng không có cách diễn đạt tiếng Anh. **Không hiện thêm tên Nhật phụ**. Giữ tên nguồn trong DB để truy vết và tìm kiếm. Thương hiệu/mã/thông số giữ đúng danh tính gốc. |
| **Q4 B** | **Lấy lại thông tin chi tiết hằng ngày** | Trong lượt quét 04:00 JST trên PC, refresh cả ảnh, mô tả, thuộc tính và giá cho các ASIN được xử lý; không có refresh tự động nếu PC/worker tắt. |
| **Q5 A** | **Tổng tối đa 200 ASIN/danh mục/lượt** | Hạn mức gồm ASIN hiện có và ASIN con mở rộng; dedupe theo ASIN. Phần vượt hạn mức ghi pending/deferred cho lần sau, không tự bỏ hoặc vượt cap. |
| **Q6 A** | **Nhóm biến thể theo nguồn được xác minh** | Không suy đoán từ tên hoặc hình; chưa có mã nhóm đáng tin cậy thì các ASIN độc lập, không thêm UI Admin để tự ghép nhóm. |
| **Q7 A** | **URL ảnh nguồn** | Tối đa 5 URL ảnh khác nhau mỗi ASIN; ưu tiên high-res có thật, không mirror/cache file sang VPS. |
| **Q8 A** | **Mô tả có cấu trúc** | Chỉ thu thập đặc điểm, thành phần, cách dùng, thông số, cảnh báo và thuộc tính; không thu nguyên bố cục A+ quảng cáo. |
| **Q9 B** | **Chỉ dịch tự động** | Không thêm công cụ Admin sửa tay hay khóa bản dịch do người chỉnh. Dịch lại khi văn bản nguồn thay đổi. |

## 5. Thiết kế kỹ thuật đã chốt

1. **Dữ liệu nguồn:** worker trên Windows lấy chi tiết mỗi ASIN trong cap 200/danh mục/lần, dùng HTTP parser và BrowserOS Neo khi markup lỗi theo chính sách hiện hữu. Lưu tối đa 5 ảnh, nội dung có cấu trúc, thuộc tính biến thể, ID nhóm được nguồn xác nhận và timestamp riêng; không tự tạo ảnh, liều dùng, thuộc tính, quan hệ, giá. 403/429/CAPTCHA → dừng và `needs_human`.
2. **Schema mở rộng tương thích:** thêm `product_images` (ASIN, thứ tự 1–5, `source_url` unique theo ASIN), `product_details` (ASIN, các trường nội dung nguồn có cấu trúc, `variant_attributes`, `source_observed_at`, provenance) và `product_translations` (ASIN, locale `vi`, tên/nội dung đã dịch, `source_hash`, model, trạng thái, thời gian). Giữ `products.name` là tên nguồn và `products.image_url` là ảnh cover để tương thích dữ liệu cũ. Mỗi ASIN con giữ primary key riêng; mọi bản ghi bổ sung foreign key về ASIN.
3. **Thu thập và backfill hằng ngày:** tạo job detail chạy cho cả hàng hiện có và ASIN mới, có giới hạn tốc độ, dedupe và lượt xử lý tối đa 200 unique ASIN/danh mục; xử lý backlog công bằng qua nhiều ngày nếu số hàng vượt cap. Với mỗi ASIN hoàn tất, refresh ảnh/nội dung/giá/availability; không ghi timestamp giá mới nếu không thật sự đọc được giá; lỗi giữ snapshot hợp lệ cuối và ghi sync error. Chỉ chạy lúc worker PC hoạt động xuyên 04:00 JST; không quét bù khi tắt PC.
4. **Dịch nền tự động sau scrape:** gọi OpenRouter 5 `:free` model trên từ **worker PC**, qua một client HTTPS nhỏ, timeout và fallback thứ tự cố định khi limit/lỗi, không đưa dữ liệu khách hàng, secret hay hồ sơ đơn lên model. Đầu ra JSON theo schema và từ điển Nhật–Việt theo ngành hàng; bảo toàn thương hiệu, ASIN, số/đơn vị, hương vị/quy cách, không tự chế công dụng hay cảnh báo. Lưu bản dịch + `source_hash`, `model_id`, lỗi gần nhất để chỉ dịch lại khi nguồn đổi; tự công bố bản dịch hợp lệ **không chờ người duyệt**. Nếu hết key/rate limit/model lỗi, trạng thái pending/failed và giữ tên/nội dung nguồn. Dịch không cần cùng lượt scrape.
5. **Hiển thị và API:** danh sách dùng ảnh đại diện/thumbnail phù hợp; trang chi tiết có gallery tối đa 5 ảnh nét, các mục mô tả có cấu trúc và bộ chọn theo thuộc tính có thật. **Tên khách thấy là một chuỗi duy nhất ưu tiên Việt; thuật ngữ không dịch tự nhiên sang Việt mới dùng Anh, sau cùng Nhật.** Không đặt tên Nhật thứ hai trên màn hình. Có thể tìm kiếm bằng tên gốc và tên dịch trong backend. Đổi ASIN đổi đồng bộ ảnh, mô tả, giá JPY/VND, availability, khả năng mua; giỏ/đơn gắn ASIN thực và snapshot tương ứng, không suy ra một tổ hợp tùy chọn chưa tồn tại.
6. **Vận hành:** giữ read-only public và checkout chặn như hiện tại; không đổi `rights_status`, công tắc `local_test_only`, lịch 04:00, quyền Admin hay mô hình DB duy nhất trên Hermes. Migration chỉ **additive/idempotent**, áp dụng và kiểm thử riêng trước commit `[deploy]`; CI chỉ phát hành code. Không cấu hình backup vì quyết định owner hiện hành; thay đổi schema cần xét khả năng rollback code mà DB vẫn tương thích.

## 6. Thứ tự triển khai khi bắt đầu implement

1. **M1 — Schema/API contract:** bổ sung migrations, types và mapping nguồn/Việt, gallery, thuộc tính; đảm bảo app phiên bản cũ vẫn chạy với schema mới.
2. **M2 — Ingestion chi tiết:** parser Amazon detail, metadata ảnh high-res, nhóm biến thể có bằng chứng, job 04:00 hằng ngày và cap 200 unique ASIN/danh mục bao gồm ASIN con; backfill dữ liệu cũ và xử lý partial errors.
3. **M3 — Dịch tự động:** xác minh OpenRouter API key (không tiết lộ), test 5 model `:free` và lỗi giả lập 429/timeout/response JSON; xây worker dịch riêng, tự fallback rồi lưu kết quả/metadata; chỉ model free và degrade gracefully khi quota cạn.
4. **M4 — API/UI:** hiển thị một tên theo chuỗi ngôn ngữ Việt → Anh → Nhật, gallery 5 ảnh, mô tả có cấu trúc, bộ chọn đúng ASIN; kiểm thử đồng bộ giỏ và tồn kho.
5. **M5 — QA/phát hành:** fixtures parser/detail/variant, kiểm thử migration, fetch API, UI, translated-data fallback, stale-price, public rights; chạy migration đã review riêng, rồi phát hành code bằng commit HEAD `[deploy]`, smoke-test Hermes và E-KAIWA, theo dõi RAM trên VPS 1 GiB.

## 7. Điều kiện nghiệm thu

- Mỗi ASIN trả tối đa 5 ảnh URL hợp lệ, ảnh không trùng; trang detail chuyển ảnh và thay ảnh theo ASIN; thiếu ảnh không render sai/hỏng trang.
- Tên nguồn luôn giữ trong DB; UI không hiển thị hai tên Nhật/Việt song song, chỉ một tên với ưu tiên từ vựng Việt → Anh → Nhật; bản dịch tự công bố khi hợp lệ, có trạng thái và model nguồn; không đổi số liệu/brand; khi key hết hạn/mất mạng catalog vẫn hoạt động.
- Nội dung phân tách rõ đặc điểm/thành phần/cách dùng/thông số/cảnh báo; không sinh thông tin khi nguồn thiếu; không đánh đồng nội dung AI sinh với xác nhận pháp lý/y tế.
- Chọn mọi tổ hợp thuộc tính chỉ đưa tới ASIN có thật; mỗi ASIN gắn giá, availability, ảnh đúng; checkout tiếp tục chặn theo chính sách read-only và giá hết hạn.
- Không tự thay `rights_status`, admin-hidden, chính sách hiển thị `local_test_only`, không thay dữ liệu đơn hàng trước đó; migrations idempotent, không ảnh hưởng site E-KAIWA.
- Mỗi lượt quét xử lý tối đa 200 ASIN độc nhất **trên từng danh mục** kể cả ASIN con; chi tiết được refresh hằng ngày khi PC worker có hoạt động; phần chưa xử lý được ghi rõ và tiếp tục lần sau.

**Điều kiện chạy dịch thật:** `OPENROUTER_API_KEY` trên PC hiện có mặt; chưa xác thực thành công API cho từng model. Cần thử trực tiếp trên mẫu sản phẩm, xác nhận quota, ghi lỗi sạch không lộ khóa. Tất cả gọi từ PC, không lưu khóa trong DB/Git, không chạy dịch tại VPS.

**Phạm vi hiện tại:** triển khai theo thứ tự từng milestone, test + commit từng mốc; không đưa migration trực tiếp vào CI `[deploy]` vì CI chỉ rollback code, không rollback DB.
