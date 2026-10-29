# Mita Japan — Kế hoạch khắc phục 8 vấn đề sau Grill Me (29/10/2026 JST)

**Trạng thái:** Đã chốt yêu cầu; PLAN ONLY, chưa triển khai hoặc deploy. **Ưu tiên chủ cửa hàng:** chất lượng tiếng Việt → ảnh Amazon HiRes → trình bày thông tin; hoàn thiện cơ chế vận hành sau, nhưng triển khai tối thiểu những phụ thuộc cần để kết quả xuất hiện trên DuckDNS.

## 1. Quyết định chủ cửa hàng — không hỏi lại

| Câu | Quyết định cuối |
| --- | --- |
| 1A | Khi code worker cập nhật, tự nhận biết bản mới và restart đúng worker **sau khi job đang chạy kết thúc**, không cần thao tác tay. |
| 2B | Windows tắt hoặc bỏ lỡ giờ 04:00/05:00/05:15 JST thì **bỏ lượt, không chạy bù**; worker tự khởi động cùng Windows. |
| 3A | llama-server bật theo nhu cầu, tắt sau **15 phút không còn công việc/phiên inference**, tự bật lại khi cần. |
| 4 | Tạo **công tắc riêng kiểm tra ngữ nghĩa bản dịch**, mặc định **OFF**. Khi OFF, nếu output dịch có text sử dụng được dù sai số, đơn vị, mã, thương hiệu thì **vẫn lưu/hiển thị nguyên văn**; ghi issue và cảnh báo nhỏ có đường dẫn log trong **Admin**. Không đồng nhất với nút verified. |
| 5A | Khôi phục 6 tên lỗi lịch sử, hiển thị bản dịch đã có dù warning, tự thử lại trong giới hạn; cảnh báo/link log ở Admin; tên chuyên ngành/brand được giữ nguyên khi cần. |
| 6A | Dịch tiếng Nhật và tiếng Anh cho toàn bộ nguồn detail; features, ingredients, usage, cautions và **nhãn** specs; **giá trị** specs giữ byte-for-byte; chưa dịch thì giữ nguồn. |
| 7A | OpenRouter model miễn phí cho **tên**, local GGUF cho **chi tiết**, không phát sinh phí API. |
| 8A | Tách lỗi Amazon thực sự với cảnh báo thiếu giá; ghi riêng ASIN mới, cập nhật, saved, failed, deferred, blocked; không xóa giá/snapshot đã xác minh. |
| 9 | CAPTCHA: **bỏ qua ASIN**, giảm nhịp và chờ phù hợp; nếu nguồn cho phép, thử lại **một lần** sau vài phút theo backoff/Retry-After; vẫn gặp chặn thì hoãn đến lượt **ngày sau**. Không giải CAPTCHA, đổi proxy hay vượt chặn; cảnh báo/link log trong Admin. |
| 10A | Tối đa **5 URL ảnh riêng biệt** từ nguồn thực, mỗi URL đã chứng minh đủ chất lượng khoảng **800 px trở lên**. Nếu nguồn có ít hơn thì hiện ít hơn; tuyệt đối không tự sửa URL thumbnail. |
| 11A | Kiểm thử fixture có **9 hiRes** trước; xác minh **5 ASIN** trên DuckDNS; sau đó backfill hàng đợi thiếu ảnh có giới hạn/không xóa gallery tốt. |
| 12A | Phần thông tin sản phẩm có mục rõ ràng, đoạn ngắn, bullet, nhấn mạnh từ khóa, icon tiết chế, khối dài thu gọn; không tạo nội dung y tế/marketing không có nguồn. |
| 13B | Đồng bộ Windows → VPS **một đợt/ngày, sau các job đã hoàn thành**, có kiểm tra đối soát và không ghi đè dữ liệu mới bằng dữ liệu cũ. |
| 14B | Phân kỳ: **dịch → ảnh → UX → vận hành**. Nghiệm thu trên DuckDNS + PostgreSQL + log; không tuyên bố xong khi chỉ unit-test đạt. |

**Bất biến từ các quyết định trước:** Không can thiệp E-KAIWA; không tự tạo backup; không mở Admin ra public, không lộ log/khóa; không tự đổi rights_status; không dùng model trả phí; không đổi checkout/giá đã chốt, order snapshot; giữ source để so sánh; không chạy crawler khi nguồn bị từ chối. Việc cho phép hiển thị translation warning **không** được nới rào bảo vệ cấu trúc (blank/HTML/script/JSON lỗi, ASIN sai, output bị cắt, XSS). Dịch bị sai liều lượng vẫn mang nguy cơ gây hiểu nhầm: giữ source và issue để người quản trị đối chiếu, không tự đánh dấu đã được kiểm chứng.

## 2. Bằng chứng ban đầu và gốc lỗi, không coi là nghiệm thu

- Amazon 29/10 04:00–04:19 JST: run #11, 148 ASIN discovered từ listing, 349 detail attempted, 347 saved/upsert (không phải 347 sản phẩm mới), 9 issues (6 thiếu giá, 1 HTTP 400, 1 ASIN mismatch, 1 HTTP 200 challenge), 486 deferred (có cả mục cần quét lại). **347/347** detail có gallery:partial, **0** colorImages.initial.
- Trong 347 detail cập nhật chỉ **15 gallery** được ghi mới; 332 gallery cũ giữ nguyên. 15 gallery mới vẫn có thumbnail rất nhỏ. Windows và VPS đã đối chiếu có cùng 70 URL/15 ASIN của lượt sáng.
- HTML Amazon lưu sẵn của B0D32RZY9M chứa **9 hiRes** bên trong dạng JavaScript A.$.parseJSON(...); cả parser Python thực tế và parser TypeScript độc lập đều không nhận dạng được dạng này. Parser Python trả 1 ảnh lớn + 7 thumbnail 38x50. Các fixture JSON đơn giản đã tạo cảm giác đạt test nhưng không phản ánh HTML thật.
- Luồng thực chạy: sync.ts → ScraplingSession → amazon_bridge.py → amazon_parser.py; sửa ảnh TS ở enrichment.ts trước đây không áp dụng vào luồng Python này. Worker từ 28/10 13:18 JST chưa nạp thay đổi về gallery ở release 0.4 ngày 29/10 00:29.
- 5 ASIN QA cũ B08FTSH6KP, B08F63WK3Z, B087JZ84K7, B083XCNJTV, B07BZ9NR18 có 5 URL raw/ASIN nhưng 4 URL là thumbnail; không được quét lại ngày 29/10.
- Name Translator từ 28/10 14:24 JST chưa nạp thay đổi sau 22:11; code cũ hạ 5 tên warning thành failed; ASIN thứ sáu chưa có candidate. Cần phục hồi có kiểm tra, không gán 6 lỗi cho riêng provider.
- Detail translator Windows đã backfill 10.788 slot tiếng Anh vào queue local ngày 29/10; **chưa chứng minh** đã dịch xong hoặc đồng bộ toàn bộ lên VPS. Lịch 05:15 chỉ chạy một lượt với giới hạn hiện tại 100 sản phẩm, không catch-up.

## 3. Lộ trình thi công — ưu tiên theo tác động khách hàng

### P0 — Điều kiện an toàn trước thay đổi, không thay nghiệp vụ

1. Chụp **số đếm kiểm tra đọc-only** trên local/VPS trước migration: products, image quality/identity, translations success/warning/failed, atomic slots, sync run, source gates, phiên bản code và PID worker. Không tự tạo backup.
2. Định nghĩa hợp đồng Publication và Warning riêng: **structural_invalid** = không thể lưu/hiển thị output dịch; **semantic_warning** = usable text, giữ nguyên candidate và source, hiển thị, issues lưu bền; **provider_failure** = không có usable candidate, fallback source. Các dữ liệu liên quan đơn hàng không được ảnh hưởng.
3. Đưa mọi thay đổi schema qua migration additive/idempotent; có dry-run/verify; log không được chứa Authorization, customer PII hoặc HTML response thô. Kết quả nhập/hiển thị phải bị ràng buộc với ASIN nguồn và thời gian quan sát.
4. Vì 14B ưu tiên giao diện, ở giai đoạn này chỉ **restart thủ công có kiểm soát** khi cần áp dụng phiên bản mới để QA, chưa xây full supervisor. Mọi restart phải drain job và không làm chạy bù.

### P1 — Tiếng Việt và cảnh báo minh bạch: vấn đề 3, 4, 6

**Backend:** backend/src/translation/jobs.ts, openrouter.ts, warnings.ts, local.ts, detail-jobs.ts, catalog.ts, detail-text.ts; schema.sql; backend/src/admin/data.ts và routes.ts.

1. Bổ sung setting **validateTranslationSemantics=false mặc định**, chỉ owner được thay đổi, audit + version optimistic. Không tái sử dụng hide_local_test_only; cấu hình này không thay đổi quyền bán/checkout.
2. Khi OFF, bộ kiểm tra vẫn **đánh giá và ghi issue** nhưng không bỏ usable output vì numbers_changed, units_changed, product_codes_changed, brand_changed, residual_japanese/english; loại bỏ nhánh rejectUnsafeEnglishDetail chặn semantic warning. Cấu trúc không hợp lệ, lỗi model/provider, sai ASIN/batch, XSS vẫn reject/fallback nguồn.
3. Ghi per-ASIN/slot: source_hash, source, candidate, validator result, engine/model, attempt, createdAt, severity, link log. Retry tối đa 3 attempt/item, giữ candidate warned gần nhất, ngừng retry khi chạm cap; đã success hợp lệ không tự thay.
4. Phục hồi **đúng 6 tên** từ lần 05:00 29/10 bằng SQL review/transaction theo từng ASIN: năm tên còn candidate + issues phục hồi warning; tên không có candidate giữ source và đưa lại queue. Không reset attempts hàng loạt và không xem warning thành failed vô điều kiện.
5. Detail Translator dịch cả EN và JP; **ưu tiên xử lý backlog frozen đã tạo** và các field thiếu/warning, tôn trọng giới hạn model/local, checkpoint/resume từng slot; thông số value không dịch, không làm mất mảng/nhãn trùng. Đo throughput và nêu **ETA dựa trên số thực**, không hứa hoàn thành 10.788 slot trong một buổi.
6. Admin owner-only hiện **một dòng warning nhỏ** có link đến màn xem **log đã lọc và redacted** theo ASIN/slot/run (trang nguồn chỉ local/private). Không dùng file:// hoặc public link đến .agents/runtime; với log JSONL local, endpoint chỉ đọc hoặc stream có auth, giới hạn kích thước và không lộ absolute path. Public dùng usable translation như owner quyết định, chưa có candidate thì nguồn gốc.
7. Đảm bảo danh mục, chi tiết, tìm kiếm và API DuckDNS đọc name có warning + detail atomic warning đúng nguồn; không ẩn sản phẩm vì quality dịch. Ảnh hưởng tới tên sản phẩm trong đơn cũ phải bằng **snapshot order**, không ghi đè.

**Nghiệm thu P1:** 6 case cũ (5 warned + 1 missing) xử lý đúng; test check OFF mặc định, ON bật check nhưng không xóa candidate cũ; unit test mismatch liều lượng/mã vẫn **log đúng**; zero malformed output được hiển thị; EN/JP slots chuyển sang tiếng Việt; đối soát API live ít nhất 5 ASIN, source/translation/slot và Admin link log.

### P2 — Ảnh HiRes đúng nguồn và backfill: vấn đề 8, một phần 5

**Luồng chính:** backend/python/amazon_parser.py, amazon_bridge.py, backend/src/ingestion/scrapling.ts, sync.ts, store.ts, enrichment.ts, backend/src/catalog.ts, schema.sql, tests Python/TS.

1. Bổ sung fixture offline **HTML Amazon đã lưu** có dạng colorImages.initial = A.$.parseJSON('...') với 9 hiRes; parse wrapper như **chuỗi JSON có kiểm tra**, không eval/execute JS; xử lý escaping, giới hạn dung lượng/depth và ASIN provenance. Vẫn hỗ trợ direct JSON, hiRes/large/main/data-old-hires/data-a-dynamic-image. Loại script recommendation/child không khớp.
2. Thống nhất **một** hợp đồng gallery giữa Python collector, TypeScript storage và public API. Mỗi URL có identity, source provenance và chứng cứ kích thước (Amazon explicit metadata hoặc kiểm tra nguồn hợp lệ); không suy ra 800px từ thumbnail modifier thiếu/khó hiểu; nhận diện SR/US/SH/SX/SY và compound variants; không tạo URL giả, không vượt quyền nguồn.
3. Lưu **tối đa 5 ảnh phân biệt >=800px nếu nguồn chứng minh**; giữ ảnh cover hợp lệ, thay thumbnail theo **identity** khi có URL tốt hơn, không dùng nhãn gallery:partial để cấm mọi cải thiện. Nếu chỉ có một ảnh lớn thì API trả một và ghi trạng thái thiếu ảnh; không xóa gallery tốt khi nguồn thiếu.
4. Xây queue chuyên **image_refresh_needed**/priority có checkpoint, không vượt 200 detail ASIN/danh mục/lượt và không spam nguồn; ASIN QA chưa được thử ngày 29/10 phải có lịch quay vòng công bằng. Chạy nguồn chỉ trong lịch/chính sách đã chốt, không phát sinh catch-up.
5. Kiểm thử ít nhất 5 ASIN đa dạng trên DuckDNS sau data sync, so URL/ASIN/độ phân giải/identity trực tiếp với raw source; sau khi QA thì backfill các ASIN thiếu gallery. Đừng đánh giá thành công bằng số URL raw trong PostgreSQL.

**Nghiệm thu P2:** offline fixture trả 5/9 hiRes hợp lệ (theo cap) và **0 thumbnail**; ASIN khác không lẫn ảnh, không mất cover tốt; API + frontend trên 5 mẫu trả đúng số URL đủ điều kiện (có thể dưới 5 khi nguồn thiếu). Báo cáo rõ ASIN chưa thể lấy đủ ảnh, không nói đã sửa hết khi nguồn thiếu.

### P3 — Trình bày thông tin như cửa hàng: vấn đề 7

**Phạm vi:** backend/python/amazon_parser.py, backend/src/ingestion/source.ts, schema/API, translation/detail-text.ts, src/components/catalog/product-detail.tsx, src/app/globals.css, src/types/catalog.ts.

1. Bổ sung nội dung có cấu trúc an toàn theo **section → block paragraph/bullet/key-value → text span/emphasis**; ưu tiên cấu trúc nguồn quan sát được. Không dùng dangerouslySetInnerHTML/raw HTML Amazon hoặc tự sinh claim.
2. Phân nhóm **Đặc điểm nổi bật / Thành phần / Cách dùng / Lưu ý / Thông số**, bullet ngắn, bold từ khóa có căn cứ, icon cố định phù hợp loại mục; trên mobile có thu gọn phần dài nhưng cảnh báo an toàn vẫn tìm thấy và đọc đầy đủ.
3. Text leaf được dịch riêng giữ mapping source và metadata; không dịch giá trị specs; fallback cho legacy string[] để không mất nội dung. Kiểm thử A11Y (heading order, semantic list, keyboard, screen reader), responsive và biến thể/checkout.

**Nghiệm thu P3:** 5 trang DuckDNS đọc dễ hơn, có headings/list/bold/paragraphs và không mất bất kỳ cảnh báo, định lượng, thành phần nào so với nguồn đã lưu.

### P4 — Vận hành ổn định: vấn đề 1, 2, 5, 6 và 13B

**Phạm vi:** scripts/start-local.ps1, start-local-detail.ps1, stop-local.ps1; wrapper/Windows Task Scheduler; backend/src/worker.ts, translator.ts, detail-translator.ts; ingestion/source-access.ts, sync.ts; backend/scripts/sync-catalog-vps.mjs; docs runbook/Admin.

1. Supervisor **Windows startup** chỉ cho các service Mita; fingerprint phiên bản mỗi worker, drain job/PG advisory lock, restart đúng worker sau cập nhật. Không giết nhầm tiến trình theo tên hoặc PID cũ; không restart E-KAIWA. Giữ 04:00, 05:00, 05:15 JST và **không chạy bù** khi máy tắt; log missed window.
2. llama lifecycle owner-only 127.0.0.1:8080: readiness trước inference, giữ model nếu còn request/job, tự stop sau **15 phút idle thực**; khởi động lại cho job sau. Timeout/port conflict phải dừng an toàn, không kill service khác, không khởi động detail run chỉ vì model vừa bật.
3. Báo cáo Amazon phân biệt discovery mới, attempted, saved/upsert, price_missing, parse_error, identity_mismatch, source_verification, deferred (cả pending/refresh), chính xác các category/ASIN và log private. Không xóa giá cũ, tôn trọng price_observed_at và sale freshness.
4. CAPTCHA/403/429: đánh dấu ASIN retry/deferred và source state; **không giải CAPTCHA, không đổi IP/fingerprint hoặc tiếp tục quét hàng loạt khi source đang chặn**. Chỉ một retry sau vài phút **nếu server cho phép / không có Retry-After dài hoặc tín hiệu dừng toàn nguồn**; nếu vẫn chặn thì next daily 04:00, giữ last good snapshot. Mọi lần retry đi qua global lock, pacing/backoff, tổng request budget; Admin warning có link owner-only đến log redacted.
5. **Sync once per day**: sau Amazon, name và detail jobs kết thúc/được ghi nhận skipped, khởi chạy một lượt Windows → VPS bằng cơ chế tunnel hiện có (không đụng orders/pricing/admin permissions). Dùng run watermark và upsert theo source_observed_at/updated_at và source hash; verify counts + hashes/samples; tránh lỗi 15432 occupied và công bố rõ sync fail/partial. Nếu nguồn quá tải và không hoàn tất trong ngày, ghi trạng thái chưa sync/đợi lượt kế, không nhận vơ dữ liệu đã tới DuckDNS.
6. Ra release code bằng [deploy] sau test; data-only không phụ thuộc vào code deploy nhưng schema phải tương thích. Kiểm tra live revision, 5 ASIN công khai, Admin private, đơn hàng/giá không đổi và E-KAIWA còn hoạt động. Rollback code tới release trước; migration additive không rollback phá dữ liệu; không tạo backup tự động theo ý owner.

**Nghiệm thu P4:** test update code khi job đang chạy không mất job/dupe; Windows boot trễ bỏ lịch; restart idle có code mới; llama stop sau 15 phút idle và wake next request; lỗi Amazon có count + link log; nightly sync một lần, idempotent, không ghi đè source mới; DuckDNS đúng số liệu sau verify.

## 4. Phân công và kiểm tra độc lập

- **Codex CLI (delegated):** phân tích/chỉnh lõi Python HiRes + tests, translation warning/status/schema + tests, và review kiến trúc riêng từng nhánh; chỉ cấp write khi bước implement được owner kích hoạt. Phân chia các vùng file **không trùng nhau** với prime.
- **Chat On Steroids prime:** giữ đặc tả owner, tích hợp với Admin/frontend, migration/daily-sync/supervisor, QA thực local+VPS, đối chiếu output Codex và diff. Nếu Codex có code fail, prime sửa và tái test trước claim.
- **Subagents độc lập:** audit security/role/log và regression từ 8 issue; test offline Amazon HTML, query PostgreSQL đọc-only, kiểm thử UX/A11Y. Chỉ tạo worker phù hợp ở giai đoạn thi công, không làm tool thừa trong giai đoạn plan.
- **Các cổng chất lượng:** Python unittest; backend TS build/typecheck+unit/integration; frontend lint/build/A11Y; Postgres migration repeatability; worker graceful-shutdown/schedule in controlled environment; QA 5 ASIN DuckDNS sau đồng bộ; cấu hình Admin OFF, log links private; regression checkout/price/rights/variants; E-KAIWA health.

## 5. Biên nghiệm thu tổng

1. **Chất lượng translation:** usable warning được xuất bản/hiển thị theo cấu hình OFF mặc định, log lưu đúng ASIN/slot và link trong Admin, error không làm mất bản dịch, không nhầm toggle verified, không cho phép output rác hoặc code/script. 6 tên lịch sử có phân loại và kết quả phục hồi có kiểm tra; backlog EN/JP có báo cáo processed/remaining.
2. **Ảnh:** parser active đọc đúng 9 HiRes fixture, chọn tối đa 5 nguồn xác thực; public chỉ có ảnh đủ độ phân giải, product-image provenance đúng; nguồn thiếu thì ghi thiếu, không tự giả.
3. **Trình bày:** 5 sản phẩm QA có layout mới và bảo toàn 100% thông tin nguồn quan trọng; không có nội dung y tế do AI tự sinh.
4. **Worker:** boot, update, idle, restart, skip missed và một daily sync đều có log đo được; không ảnh hưởng dịch vụ khác.
5. **Amazon:** log rõ 9 issue cũ và mọi issue mới, không xem 347 upserts là 347 ASIN mới, deferred định nghĩa minh bạch, CAPTCHA xử lý có giới hạn và tuân thủ nguồn.
6. **Không tuyên bố xong chỉ vì test xanh:** lấy bảng đối chiếu cùng ASIN/field từ nguồn lưu → Windows DB → VPS DB → API DuckDNS → giao diện; ghi riêng unknown/blocked/deferred.

## 6. Ràng buộc và phát hiện phải xem trước thi công

- **Xung đột tài liệu lịch sử:** ADR 0011 từng yêu cầu reject mọi thay đổi số/liều lượng; ADR 0012 chốt bỏ missed run (giữ nguyên); plan 11 ngày 28/10 đã cho phép warning nhưng chưa có switch Admin. ADR 0013–0016 ghi quyết định mới và supersede đúng phần thay đổi; không xóa ADR cũ.
- **Nguy cơ output sai số:** owner chấp nhận semantic validation OFF; log là bằng chứng **phát hiện lỗi**, không phải phê duyệt sự chính xác. Không chèn sửa số/đơn vị tự động.
- **Thiếu raw HTML:** archived HTML có 9 ảnh là bằng chứng một trường hợp; không mặc định 347 sản phẩm cùng dạng markup. Cần kiểm thử nhiều mẫu độc lập trước live backfill.
- **Hàng đợi detail dài:** không giả định tốc độ Index-Translate-2B đủ dịch backlog trong một ngày; giới hạn free API và local throughput phải được đo thực.
- **Không đồng bộ log bằng file public:** log Windows có thể chỉ xem từ Admin owner-only trên Windows; VPS chỉ nhận summary/snapshot tối thiểu cần thiết; không expose filesystem/credentials.
- **Không tự khởi tạo backup:** đây là chủ trương owner; migration phải additive và có rollback ứng dụng/tài liệu khôi phục cụ thể.

## 7. Kết quả Codex CLI architecture review — 10 điều kiện bắt buộc

Codex CLI read-only đã kiểm tra riêng plan theo đúng 14 câu trả lời (thread 01a18533-ea80-7a82-82d0-63f2bb7884a5). Prime đưa các phát hiện thành **gates**; không mở thêm phạm vi checkout/accounting.

1. **Daily sync chỉ chuyển dữ liệu, không chạy DDL Admin.** Hiện backend/scripts/sync-catalog-vps.mjs khi --apply gọi schema.sql, admin.sql, remove-needs-human.sql. Tách migration được duyệt khỏi daily data sync; test không có DDL hoặc write ngoài các bảng cho phép.
2. **Gallery là snapshot nguyên tử theo ASIN, không upsert position đơn lẻ.** Hiện đồng bộ (asin,position) có thể để lại ảnh vị trí 2–5 khi local giảm còn 1. Chỉ thay gallery khi snapshot mới hơn và đủ chất lượng; nếu partial, merge theo image identity có provenance. Test 5→1, 1→5, reorder, bản cũ đến muộn.
3. **Structural vs semantic phải tách thành hai cổng.** Hiện warnings.ts kiểm usable chưa bao phủ HTML/script tổng quát và local.ts có trim. Test HTML/script/injection/JSON không hợp lệ ở mọi đầu vào; OFF chỉ ngừng chặn semantic, không tắt security. Khi publish warning phải giữ candidate và nguồn để đối chiếu.
4. **Manifest phục hồi đúng 6 ASIN, không SQL đại trà:** B0DDXYC8NL, B0FSL4CP1M (previous product_codes_changed), B0H1GZLGK9, B0H5C5GHMP, B0H5C6PKR1 (previous numbers_changed) còn candidate; B0G5XT3VHX chưa có candidate. Trước transaction kiểm current source_hash/name/status/attempts và expected old/new status; repeat phải idempotent. Retry cap không được loại nhầm ASIN thứ sáu.
5. **Một daily sync có ledger bền theo ngày JST:** terminal state completed/skipped/partial/failed cho ba worker, run watermark, global lock, content hashes chứ không chỉ counts. Crash sau remote COMMIT trước status update phải không ghi sai; test disconnect ở cả hai biên; không sync bù ngày bỏ lỡ.
6. **Restart tránh cửa sổ cron:** shouldRunDaily/shouldRunTranslation/shouldRunDetailTranslation yêu cầu startedAt <= due; restart ngay trước mốc 04:00/05:00/05:15 có thể bỏ lượt nếu process mới lên muộn. Hoãn restart qua dispatch window hoặc ghi missed minh bạch; không thêm catch-up. Test ba mốc, drain >5 phút, queue stale.
7. **Một lifecycle owner/lease cho llama:** check PID + creation time + executable/model path + port; không chỉ timer idle. Test hai request đồng thời, request đúng phút 15, inference lỗi và port 8080 do process khác giữ; không kill nhầm.
8. **Amazon outcome và warning tách biệt; công thức đối soát:** attempted unique ASIN khác số HTTP requests vì retry. Final outcome per attempt loại trừ saved/deferred/blocked/failed, còn warning độc lập. Test run #11: 349 attempted, 347 saved, 9 issues gồm 6 thiếu giá vẫn saved, 2 detail failed và 1 listing HTTP 400.
9. **CAPTCHA retry không mặc định được phép nếu thiếu Retry-After.** Chỉ retry một lần khi có bằng chứng tích cực là lỗi transient/page-scoped và nguồn cho phép; nếu không xác định, 403/429/HTTP200 verification hoặc source gate còn active thì dừng đến hôm sau. Test Retry-After giây/HTTP-date, restart trong backoff, nhiều process/source lock.
10. **Nối metadata xuyên suốt:** tiêu chuẩn size là **cạnh ngắn >=800px** khi có kích thước thực/metadata đáng tin; image identity/provenance bền. UI detail cần block/leaf ID ổn định qua reorder; translation slot index-based và sync detail JSON cũ phải có migration/API version hoặc backward compatibility. Test Python → DB → daily sync → API → React với 9 HiRes fixture; reorder, specs key trùng và values giữ byte-for-byte.

**Khi thi công:** điều kiện trên là bắt buộc để nghiệm thu P1–P4, không chỉ là ghi chú; Codex chỉ review, không sửa code.

## 8. Tham chiếu tài liệu

- ADR 0013 — chính sách dịch semantic warning, Admin switch và log.
- ADR 0014 — parser gallery Amazon, hình ảnh và CAPTCHA.
- ADR 0015 — worker Windows, llama on-demand, nightly sync.
- ADR 0016 — trình bày detail có cấu trúc.
- docs/mita-domain-glossary.md — domain model, state machine và thuật ngữ.

**Trạng thái cuối giai đoạn này:** chỉ viết plan/ADR/glossary và review; chưa fix 8 vấn đề, chưa restart worker, chưa deploy lên DuckDNS.
