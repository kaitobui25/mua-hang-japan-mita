# 08 — Mita Japan: bật cấu hình gallery verified, launcher job chạy tay, kiểm tra 20 ảnh và phân tích job 04:00 (05–06/11/2026)

> **Nhật ký session, không phải xác nhận runtime hiện tại.** Tiếp tục công việc phải đọc `AGENTS.md`, kiểm tra Git/DB/process/schedule/source gate thực tế. Phân biệt code đã sửa, test mô phỏng, job thực tế đã chạy, bản local và production. Đây là tóm tắt session ChatGPT, không phải yêu cầu tự chạy lại worker hay deploy.

## 1. Mục đích và các yêu cầu người dùng

1. Giải thích biến `AMAZON_GALLERY_PILOT_DATE` và vì sao Amazon gallery còn nhiều ảnh nhỏ; trước đó đã có pilot năm ASIN thành công ngày **30/10/2026**, nhưng chưa backfill rộng.
2. Người dùng yêu cầu **`AMAZON_GALLERY_PILOT_DATE=verified`**; tạo **một file .bat ở root**, nhấp đúp chọn một trong **3 job sáng**: Amazon 04:00, dịch tên 05:00, GGUF chi tiết 05:15. Amazon cần bốn lựa chọn: **chỉ ảnh / chỉ giá / kiểm tra sản phẩm còn trên Amazon / full như 04:00**. Kết thúc phải báo thành công, thất bại và lý do. Yêu cầu phối hợp **Codex CLI / codex-cli-control**.
3. Sau khi người dùng chạy một lượt Amazon images thật, người dùng hỏi “có thành công không?” vì báo cáo có `completed, 20/20` nhưng dòng cuối lại nói không thành công; yêu cầu kiểm tra log và sửa nếu sai.
4. Người dùng yêu cầu **5 link sản phẩm local** trong lượt 20 ASIN để tự xem gallery.
5. Người dùng hỏi **từ nay job 04:00 sẽ làm gì**, thứ tự ưu tiên 1–7 và **cách nó tìm sản phẩm mới**. Lượt này chỉ phân tích luồng code; **không yêu cầu, không triển khai thay đổi thuật toán ưu tiên**.
6. Cuối session yêu cầu tóm tắt và ghi vào `.agents/chatgtplog/` (file này).

Repository Windows: `C:\phong\AI\web\mita-japan\mua-hang-japan-mita`; connector workspace: `/ai/web/mita-japan/mua-hang-japan-mita`. Web local thường dùng `http://127.0.0.1:3000`, DB local `127.0.0.1:5433/postgres`, nguồn Amazon `amazon.co.jp`. Giờ lịch là **Asia/Tokyo**.

## 2. Những gì đã triển khai và đã commit

**Commit local đã thực hiện trong session** (không push/deploy trong các bước này):

- `15c7ba4 feat(local): add manual morning jobs and Amazon scan modes` — 13 file: `run-mita-jobs.bat`, `scripts/run-mita-jobs.ps1`, `backend/src/manual-jobs.ts`, `backend/src/ingestion/manual-scan.ts`, bổ sung `ScraplingSession.inspect()`, `backend/python/amazon_bridge.py`, các thay đổi trong `sync.ts`, `detail-jobs.ts`, Supervisor/startup config; test `backend/tests/manual-scan.test.ts`, `backend/python/test_amazon.py`, tài liệu `docs/mita-manual-jobs.md`.
- `33ada65 fix(local): report manual worker exit code reliably` — sửa PowerShell sử dụng `Start-Process -Wait -PassThru` thay vì chỉ poll `HasExited/Refresh` (đã gây `ExitCode=null`), đồng thời chỉ in `sourceErrors` khi Amazon mode `full`.

**Hành vi launcher**:

- Nhấp đúp `run-mita-jobs.bat` tại root → chọn job Amazon, names hoặc detail. Chọn Amazon → `images`, `price`, `presence`, `full`. Các chế độ 1–3 chọn 1–300 ASIN (mặc định 20); full dùng cơ chế/giới hạn của job 04:00; dịch tên/GGUF có giới hạn. Phải nhập đúng chữ `CHAY` mới phát động job.
- Runner chỉ kết nối **PostgreSQL local 127.0.0.1:5433/postgres**, không tự đồng bộ VPS; lưu JSON `MITA_WORKER_RESULT` và hai log stdout/stderr tại `.agents/runtime/manual-jobs/`.
- `images`: ưu tiên các ASIN ít ảnh hợp lệ, bổ sung/thay ảnh nguồn có chứng cứ; không đổi giá/tên/tồn kho. `price`: chỉ cập nhật giá JPY có chứng cứ hiện tại (Codex CLI review phát hiện lỗi có thể lấy nhầm *reference price*; đã sửa lọc `priceToPay`, từ chối số giá mâu thuẫn). `presence`: xác minh trang chi tiết và ASIN, phân biệt `present` / HTTP 404 / không xác minh; **không xóa/ẩn sản phẩm** dựa vào 404/CAPTCHA/403. `full`: dùng `syncCatalog` cho cả khám phá listing và quét detail.
- Có Windows mutex, Postgres advisory locks chống chạy trùng; kiểm tra source cooldown, CAPTCHA/403/429 và Retry-After; không tự vượt chặn. Lỗi DB có trạng thái `unresolved`, không coi như thành công. `full` ghi marker `trigger:manual` để Supervisor không hiểu nhầm lượt chạy tay là job 04:00.
- GGUF báo **slot văn bản** dịch được/lỗi, không đánh đồng slot và sản phẩm hoàn tất.
- `scripts/mita-supervisor.mjs` đổi fallback `AMAZON_GALLERY_PILOT_DATE` sang `verified`; `scripts/start-mita-supervisor.ps1` đặt rõ `verified`. Đây là **thay đổi cấu hình code/launch**, không chứng minh Supervisor đang sống đã nhận env mới.

**Kiểm thử tại thời điểm triển khai**:

- `npm test --prefix backend`: **331/331 PASS**, dùng DB disposable, không ghi DB catalog local thật.
- `backend/tests/manual-scan.test.ts`: **9/9 PASS** với dependency mô phỏng.
- Python Amazon parser: **37 test, 0 failure, 2 skipped**.
- `npm run typecheck --prefix backend`, `node --check`, parser PowerShell 5.1, PowerShell `-SelfTest`, `git diff --check`: PASS.
- Codex CLI được yêu cầu review read-only **hai lượt**, các phát hiện chính về giá tham chiếu, báo cáo lỗi OpenRouter và đời sống env Supervisor đã được xử lý/ghi chú. **Không** chạy thử Amazon thật chỉ để test code.

## 3. Một lượt quét ảnh thực tế của người dùng và sửa lỗi thông báo

Người dùng tự chạy **Amazon / images / limit 20** ngày **05/11/2026 lúc 13:48 JST**, prefix report:
`20261105-134812-amazon-images-3ee0e82e700742fd9dc9acb25462a265`.

- File JSON tại `.agents/runtime/manual-jobs/<prefix>.json`: `state:completed`, `selected:20`, `attempted:20`, `succeeded:20`, `updated:20`, `failed:0`, `deferred:0`, `unresolved:0`, `failures:[]`; có đủ 20 ASIN với `outcome:updated`.
- Log `.out.log` có **20 dòng `MANUAL_AMAZON_ITEM … OK updated`** và 1 dòng `MITA_WORKER_RESULT`; `.err.log` **0 byte**.
- Lỗi launcher: JSON ngoài cùng có `exitCode:null`, dòng cuối in “Job không đủ điều kiện tuyên bố thành công”. Kết luận **worker đã hoàn thành 20/20; dòng cảnh báo do PowerShell đọc `ExitCode` không đúng**, đã sửa trong commit `33ada65`. Thử exit code giả 0/3 với `Start-Process -Wait -PassThru` đều đọc đúng; không chạy lại Amazon.
- Kiểm tra read-only database 20 ASIN: **20/20 có record products**, **20/20 có ảnh gallery**, tổng **52 dòng `product_images`**, **8/20 có trên một ảnh**. Do đó **“20 updated” KHÔNG có nghĩa “20 sản phẩm đều có 5 ảnh”**; chỉ 8 có nhiều ảnh. Người dùng được khuyên không cần chạy lại do dòng cảnh báo.
- Chưa xác minh trực tiếp giao diện browser từng sản phẩm; xác minh ở cấp báo cáo/log/DB local, **không đồng nghĩa đã đồng bộ VPS hoặc có thay đổi trên website production**.

Năm link local đã cung cấp (mỗi ASIN được kiểm tra có **5 gallery rows** trong DB lúc đó):

1. `http://127.0.0.1:3000/san-pham/B0BFKKV6G4`
2. `http://127.0.0.1:3000/san-pham/B0C434QCVN`
3. `http://127.0.0.1:3000/san-pham/B0C4367PMJ`
4. `http://127.0.0.1:3000/san-pham/B0DHWGYH56`
5. `http://127.0.0.1:3000/san-pham/B0F5W6KR4M`

## 4. Job tự động 04:00 hoạt động thực tế thế nào?

**Luồng code hiện tại (khác launcher `images` chạy tay)**, qua `backend/src/worker.ts` → `syncCatalog()` → `processCategoryDetails()` → `ingestObservations()`:

1. Worker lịch `04:00 Asia/Tokyo` có cửa sổ dispatch **tối đa 5 phút**; nếu worker khởi động trễ/bỏ lỡ lịch thì **skip, không catch-up**. Sau đó còn phụ thuộc pilot gate, source cooldown, advisory locks.
2. `seedExistingDetails()` thêm các ASIN sản phẩm cũ vào `product_detail_queue` nếu chưa có.
3. `session.discover()` quét các trang Amazon seed (xem dưới), parse listing để lấy ASIN/tên/ảnh/giá sơ bộ, lọc ASIN hợp lệ, **khử trùng theo ASIN**; đưa vào hàng đợi.
4. `processCategoryDetails()` lấy từng ASIN trong hàng đợi theo **`last_attempt_at ASC NULLS FIRST, enqueued_at ASC, asin ASC`**; nghĩa là ưu tiên chưa từng thử, sau đó lâu chưa quét, rồi vào hàng đợi sớm nhất. **Không có ưu tiên tuyệt đối cho ASIN mới hoặc ảnh thiếu** trong full job.
5. Mở `https://www.amazon.co.jp/dp/<ASIN>` qua Scrapling/Python parser để thu thập chung **gallery ảnh, giá JPY, trạng thái tồn kho, tên gốc, features/ingredients/usage/specs/cautions, biến thể** (khi có nguồn hợp lệ). ASIN con được phát hiện từ trang detail có thể được enqueue, không tự suy diễn biến thể.
6. `ingestObservations()` upsert sản phẩm mới/cũ, bảo toàn ảnh tốt và giá cũ nếu source không có dữ liệu đáng tin. Quét tối đa **200 ASIN cho mỗi danh mục** mỗi lượt (cấu hình có thể còn giới hạn thấp hơn); vì vậy không bảo đảm quét hết catalog 832 ASIN trong một sáng.
7. Ghi `sync_runs`, `sync_errors`, hàng đợi, số attempted/saved/deferred, warning; báo partial/failed khi thích hợp. Sau 04:00, các job khác theo lịch: **05:00 dịch tên (Codex/OpenRouter theo setting)**, **05:15 dịch chi tiết GGUF**; Supervisor có cơ chế sync VPS theo điều kiện riêng, **không mặc định rằng mọi lượt 04:00 đã lên VPS**.

**Nguồn phát hiện sản phẩm mới hiện đang hardcode tại `backend/src/ingestion/source.ts`**:

- `thuc-pham-bo-sung`: `https://www.amazon.co.jp/gp/bestsellers/hpc/3457072051` — Best Sellers thuộc HPC, quét **tối đa 6 trang**, mỗi trang có ASIN trong listing. Đây là ranking bán chạy, không phải feed toàn bộ sản phẩm vừa đăng.
- `thuc-pham-cho-be`: `https://www.amazon.co.jp/s?k=%E3%83%99%E3%83%93%E3%83%BC%E3%83%95%E3%83%BC%E3%83%89&i=food-beverage` — tìm từ khóa tiếng Nhật **ベビーフード**, quét **tối đa 5 trang**.
- Parse `data-asin` thành ASIN chính xác, khử trùng trong trang/quét; xác định sản phẩm mới khi có ASIN chưa có trong DB/hàng đợi và việc đọc detail lưu thành công. Không tìm toàn bộ Amazon, không truy vấn tùy ý nhiều từ khóa; không cam kết tìm hết SP mới.

**Ưu tiên người dùng hỏi 1–7:** ChatGPT đề xuất theo giá trị kinh doanh: (i) **giá và tồn kho**; (ii) **khôi phục ảnh HiRes**; (iii) **làm mới sản phẩm cũ**; (iv) **tìm sản phẩm mới**; (v) **mô tả/thông số**; báo cáo chạy xuyên suốt. **Đây chỉ là đề xuất, chưa sửa queue/scheduler theo thứ tự này.** Full 04:00 thực tế quét ASIN theo lịch sử `last_attempt_at`, sau đó lấy nhiều dữ liệu chung trong một lần gọi detail; không có bảy job thực thi lần lượt theo thứ tự đó. Mode `images` chạy tay *có* chọn ASIN thiếu ảnh tốt trước.

## 5. Việc chưa xong / cảnh báo cần xác minh khi tiếp tục

- **Supervisor runtime gate:** tại lần kiểm tra trong session ngày 05/11/2026, Supervisor PID **46316** được khởi động **02/11/2026**, trước khi source code launcher đổi sang `verified`. Snapshot `.agents/runtime/mita-daily-2026-11-05.json` báo Amazon **`skipped`**; không có chứng cứ environment của tiến trình cũ đã được cập nhật. **Chưa restart Supervisor trong session này**. Cần xác minh tiến trình/child env, lock và lịch *hiện tại* trước khi khởi động lại có kiểm soát; không được tuyên bố job hôm sau chắc chắn chạy hay tự catch-up.
- **Bật `verified` trên code không đủ chứng minh job Amazon đã quay lại quét lịch 04:00.** `shouldRunDaily()` còn yêu cầu worker đã hoạt động trước giờ hẹn và event nằm trong cửa sổ 5 phút. Không ép chạy lại hoặc bỏ source safety.
- **Chưa thay đổi chiến lược ưu tiên queue** theo đề xuất. Nếu người dùng muốn ưu tiên sửa ảnh cho toàn catalog, trước tiên thỏa thuận rõ ưu tiên mới, ngân sách và cách tránh bỏ đói các ASIN cũ; test trên DB tạm. Không tự triển khai chỉ từ câu hỏi phân tích.
- **Gallery còn chưa đồng đều:** lượt 20 sản phẩm có 52 ảnh/20 ASIN, 8 có nhiều ảnh; không được nói mọi sản phẩm đã 5 ảnh hoặc toàn bộ catalog đã backfill HiRes.
- **Không có push/deploy/VPS sync được thực hiện bởi các tác vụ launcher và khắc phục exit-code.** Git ở cuối session trước đạt local commits `15c7ba4`, `33ada65`. Khi ghi nhật ký này (06/11/2026), Git HEAD đã có thêm các commit SEO khác `312a764`, `515c337` không thuộc tác vụ launcher; không gộp chúng như công việc session này.
- Các file untracked hiện có từ những session khác trong `.agents/chatgtplog/`, `.agents/plan/`, `designs/assets/logo/`, `reports/` phải được giữ nguyên; chỉ tạo nhật ký mới. Không tự add/commit hoặc xóa chúng.

## 6. Tiếp tục ở đâu?

- Launcher: `run-mita-jobs.bat` → `scripts/run-mita-jobs.ps1` → `backend/src/manual-jobs.ts` / `backend/src/ingestion/manual-scan.ts`.
- Daily worker: `scripts/mita-supervisor.mjs`, `scripts/start-mita-supervisor.ps1`, `backend/src/worker.ts`, `backend/src/ingestion/{sync,source,scrapling,store}.ts`, `backend/python/{amazon_bridge,amazon_parser}.py`.
- Vận hành: `docs/mita-manual-jobs.md`, `docs/mita-workers-runbook.md`, `.agents/runtime/manual-jobs/` (chỉ private local).
- Nếu chỉ hỏi ưu tiên/tìm sản phẩm, giải thích sự khác nhau giữa **đề xuất** và **hiện thực**; không sửa code khi chưa được yêu cầu.
