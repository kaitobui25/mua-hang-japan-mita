# Mita Japan — local storefront

## Version và phát hành lên VPS Hermes

- Version công khai do chủ dự án tự đặt trong [`release.json`](release.json), hiện là **`0.4`**; website hiển thị nhỏ ở cuối footer. Không dùng `version` trong `package.json` để hiển thị phiên bản cửa hàng. Đây là version trong checkout, không chứng minh revision đang chạy trên VPS.
- Khi được phép phát hành, `deploy-one-click.bat` ghim HEAD đã commit, chuẩn bị schema/data, đồng bộ và xác minh VPS rồi push đúng SHA lên `main`. Push có **`[deploy]`** trong message HEAD kích hoạt Actions; One-Click cũng có thể dùng `workflow_dispatch` có kiểm tra SHA/request ID khi không có tagged push. Push thường không có marker không tự deploy. Wrapper không stage/commit thay owner; xem phạm vi migration và side effect ở [CI deploy](deploy/mita/ci-deploy.md) trước khi chạy.
- Xem [quy trình deploy, phiên bản, SSH key và rollback](deploy/mita/ci-deploy.md), [workflow GitHub Actions](.github/workflows/mita-deploy.yml) và [runbook vận hành VPS](docs/hermes-vps-runbook.md). Không build Next.js trên VPS RAM 1 GiB. Migration database không tự chạy trong pipeline.

Website mua hộ Nhật dành cho khách Việt. Garden UI (Next.js), catalog/checkout API (Fastify + TypeScript), PostgreSQL 18 chạy trực tiếp trên Windows. **Checkout tạo đơn `pending_confirmation`, `unpaid`, thanh toán thủ công; không tự thu tiền.** `simulation_created` chỉ còn cho fixture/luồng mô phỏng lịch sử. Giá VND dùng chính sách tỷ giá/phụ phí trong PostgreSQL, không phải tỷ giá thị trường thời gian thực. `PUBLIC_READ_ONLY=1` đóng tạo đơn.

Admin local tại `/admin`: Owner/Staff theo quyền backend, có Tổng quan / Sản phẩm / Đơn hàng / Cấu hình / Thông báo / Nhật ký lỗi. Xem [hướng dẫn Admin](docs/admin-local.md), [Desktop](docs/mita-desktop.md) và [lifecycle worker](docs/mita-workers-runbook.md). Dịch vụ local dùng loopback; website public là bản phát hành riêng trên VPS. Worker có launcher AtLogOn khi owner đã đăng ký, không mặc định chạy ở màn hình đăng nhập Windows.

## Bắt đầu (Windows, không Docker)

Yêu cầu: Node.js **22.12.0+**, PostgreSQL 18 tại `C:\Program Files\PostgreSQL\18\bin`; worker Amazon còn cần môi trường Python/Scrapling theo `scripts/check-scrapling.ps1`.

```powershell
npm install
cd backend
npm install
cd ..
```

**Không dùng `scripts/start-local.ps1` như lệnh kiểm tra hoặc sửa API:** script có thể tạo cluster `backend/.local-db`, khởi động PostgreSQL, cài dependency, luôn chạy `db:migrate`, rồi khởi chạy API/web/Supervisor. Chỉ chạy sau khi xác minh target, owner tiến trình, SQL và được phép cho các thao tác stateful/DB tương ứng. Không tin listener có sẵn chỉ từ số cổng. Desktop có điều khiển backend 4000 dùng cluster đã tồn tại, không init/migrate/reset; xem [lifecycle backend](docs/backend-4000-lifecycle.md).

Khi dịch vụ đã được khởi chạy hợp lệ: web **http://127.0.0.1:3000**, API `http://127.0.0.1:4000/api/health`, DB local `127.0.0.1:5433`. `15432` là tunnel tạm tới DB VPS, không phải DB local. `/api/health` chỉ kiểm tra kết nối (`SELECT 1`), không chứng minh schema tương thích. Log riêng nằm trong `.agents/runtime` (gitignored).

## Dữ liệu thật và đồng bộ

- Seed whey: <https://www.amazon.co.jp/gp/bestsellers/hpc/3457072051>.
- Seed đồ ăn trẻ em: <https://www.amazon.co.jp/s?k=%E3%83%99%E3%83%93%E3%83%BC%E3%83%95%E3%83%BC%E3%83%89&i=food-beverage>.
- `cd backend; npm run worker:once` uses Scrapling FetcherSession + BeautifulSoup (no fallback). CAPTCHA, verification/login and 403 stop all Amazon requests immediately. HTTP 429 slows pacing and retries at most twice in the same request; exhaustion persists the shared source cooldown. Retry-After waits up to 10 seconds are honored; longer waits stop immediately into cooldown. Re-entry is once at 04:00 JST on the following calendar day, only through the scheduled worker. `npm run worker:daily` uses pg-boss, with no downtime catch-up. Runs retain good snapshots, use `failed`/`partial` on errors, and attempt at most 200 unique detail ASINs per category.
- Supervisor quản lý **ba worker độc lập**: Amazon, dịch tên (OpenRouter hoặc Codex CLI theo settings), dịch chi tiết GGUF local. Lịch mặc định lần lượt **04:00 / 05:00 / 05:15 JST**; Owner có thể đổi lịch qua Workers settings. Mỗi tiến trình có log riêng; không chạy bù khi khởi động muộn. Xem [runbook](docs/mita-workers-runbook.md).
- `cd backend; npx tsx src/worker.ts import` ghi snapshot quan sát từ `backend/data/observed-amazon.json` vào DB; chỉ dùng local khi được phép nhập dữ liệu, không phải lệnh kiểm tra. Mỗi giá giữ `observedAt` nguồn. Checkout kiểm tra tuổi giá theo `pricing_policy.check_price_expiry` và `price_expiry_days` (1–365 ngày); khi tắt kiểm tra, tuổi giá không chặn đặt hàng.
- Các biến thể ASIN chỉ được gộp khi nguồn cung cấp `parentAsin` hoặc `sourceProductId` rõ ràng; không suy đoán từ tên sản phẩm. Database cũ không được tự động ghép nhóm, nên chưa nhất thiết có biến thể đang hiển thị sau nâng cấp.

### Ảnh, mô tả và bản dịch tiếng Việt

- Worker PC lấy trang chi tiết mỗi ASIN (bao gồm backlog từ các lần trước), lưu tối đa 5 **URL** ảnh thực, các phần đặc điểm/thành phần/cách dùng/thông số/cảnh báo và thuộc tính biến thể có bằng chứng. Lượt xử lý tối đa 200 ASIN độc nhất **trên mỗi danh mục**, gồm ASIN con; refresh khi lịch 04:00 JST chạy thực tế. Nếu Amazon chặn hoặc thiếu dữ liệu, giữ snapshot tốt cuối cùng và ghi lỗi.
- **Translator độc lập chỉ dịch tên**, lịch mặc định **05:00 JST**, không được kích hoạt bởi Amazon worker, CAPTCHA, Admin Import hay startup. Owner chọn `openrouter` hoặc `codex` trong Workers settings. OpenRouter dùng `OPENROUTER_API_KEY` ở môi trường Windows (không đưa key vào Git, VPS hay log), các model miễn phí được phép; 429/timeout/lỗi thử model tiếp theo, không tự trả phí. Codex CLI local dịch tên đầy đủ/rút gọn với kiểm tra nguồn, revision/generation, quota và bản ghi xác minh automation riêng; không dịch chi tiết hoặc tự fallback sang engine khác. Hành vi cụ thể nằm ở `backend/src/translator.ts` và `backend/src/translation/`.
- **Giới hạn OpenRouter:** tối đa 100 tên/request, JSON tối đa 24.000 byte UTF-8, dự toán output tối đa 8.192 token; giữ 2 request dự phòng, cách request tối thiểu 3.2 giây và khóa PostgreSQL chống chạy trùng. Tên `status='success'` có nội dung được giữ, không tự dịch lại theo ngày hoặc thay đổi nguồn; tên Nhật lưu riêng. Bản có nội dung nhưng không đạt validator có thể hiển thị với warning nội bộ, thử lại tối đa 3 lần. Các quy tắc này không mô tả vòng đời revision của Codex. Cả hai engine chỉ dịch tên, không dịch detail; bản dịch đầy đủ lịch sử vẫn giữ trong DB.
- Khi được phép chạy worker ngoài lịch: `cd backend; npm run worker:translate` dùng engine đang lưu; `worker:translate:daily` là daemon dịch tên (không chạy trùng Supervisor). Menu `run-mita-jobs.bat` hỗ trợ Amazon Ảnh/Giá/Presence/Full, tên và GGUF với xác nhận `CHAY`, không tự sync VPS; xem [manual jobs](docs/mita-manual-jobs.md). Quota/cooldown vẫn áp dụng; không tự chạy bù. Log theo launcher trong `.agents/runtime/`.
- **Dịch chi tiết local 05:15 JST**: `IndexTeam/Index-Translate-2B-GGUF` Q4_K_M bằng `llama.cpp` Vulkan trên Intel Arc Pro, chỉ truy cập `127.0.0.1:8080`; dịch từng chuỗi `features`, `ingredients`, `usage`, `cautions`, và **chỉ KEY của `specs`**, không sửa VALUE. Bản dịch có nội dung nhưng sai điều kiện validator vẫn hiển thị trên web, cảnh báo được lưu nội bộ; đầu ra rỗng, lỗi HTTP/timeout hoặc không cấu trúc đúng vẫn dùng nguồn gốc. Thử lại tối đa 3 lần với bản dịch chưa đạt, giữ vĩnh viễn bản đã thành công. Không fallback OpenRouter/API, không chạy bù nếu máy tắt lúc 05:15. Xem [hướng dẫn worker dịch chi tiết](backend/LOCAL-DETAIL-TRANSLATOR.md) và [quyết định Grill Me mới](.agents/plan/11_translation_warning_policy_20261028.md). Worker bắt đầu cùng `./scripts/start-local.ps1` hoặc riêng bằng `./scripts/start-local-detail.ps1`.
- **Chẩn đoán lỗi dịch:** Cả OpenRouter, GGUF và translator bổ sung sau này ghi các warning/lỗi vào `.agents/runtime/translation-warnings.jsonl` (file JSONL trên máy worker, không phục vụ công khai). Admin local chỉ hiển thị một dòng “Dịch có lỗi, ghi tại ...”; website khách không hiển thị nhãn warning. Chỉ dữ liệu dịch không đạt mới có warning; điều kiện bán/checkout vẫn dựa trên giá, tồn kho và quyền hiển thị như trước. Dữ liệu đã thành công không bị dịch lại. Chi tiết: [chính sách warning](.agents/plan/11_translation_warning_policy_20261028.md).
- Backfill khi được phép ghi dữ liệu/chạy worker: `cd backend; npm run worker:backfill:seed` xếp hàng nhưng không gọi Amazon; `worker:backfill:status` chỉ xem tiến độ. `$env:BACKFILL_LIMIT_PER_CATEGORY='15'; npm run worker:backfill` lấy thật, 1–200 ASIN/danh mục/lượt; có thể đặt `BACKFILL_CATEGORY_SLUG='thuc-pham-bo-sung'`. Backfill không lấy listing, vẫn chịu source mutex/cooldown và không được tiêu thụ lượt re-entry dành cho scheduled worker.
- **Amazon CAPTCHA/403/429:** daily scans, Admin Import and backfill share the PostgreSQL source mutex and `source_access_blocks.retry_after_at`. Imports/manual runs cannot consume the daily re-entry. A failed re-entry reserves the next calendar day at 04:00 JST; a crash keeps that reservation. No operator ACK, automatic browser opening, proxy rotation or CAPTCHA solver. Owner status shows the next eligible retry. Translation stays a separate 05:00 JST process.
- **Trạng thái chặn nguồn:** đọc `source_access_blocks.retry_after_at` và trạng thái hiện tại; không dùng cơ chế chờ người ACK/continuation cũ để quyết định chạy lại. Translator vẫn có lịch riêng và có thể dịch tên đã lưu khi Amazon bị chặn. `worker:backfill:status` là lệnh xem tiến độ.
- **Migration trước rollout:** xác minh identity DB và schema live bằng truy vấn chỉ đọc, review SQL rồi xin phép trước thao tác DB. `db:migrate` áp dụng nhiều SQL, gồm Admin, notifications/email, title presentations, Codex, workers control và Amazon quotes; không dùng như bước khởi động/sửa login. Xem [cooldown runbook](docs/amazon-cooldown.md). GitHub Actions không migrate; Windows One-Click có các bước migration riêng, phải kiểm tra phạm vi ở [CI deploy](deploy/mita/ci-deploy.md).
- **Phát hành VPS:** các bảng mới `product_images`, `product_details`, `product_translations` (cột additive `name_only`, `detail_attempted_at`), `product_detail_queue` và `source_access_blocks` phải được tạo bằng migration có kiểm soát **trước** khi push commit `[deploy]`; GitHub Actions hiện chỉ build/deploy code và không migrate PostgreSQL. Không chạy dịch tại VPS và không mở API key OpenRouter cho web/backend VPS.

Trang Amazon có thể hiển thị dữ liệu và giá khác giữa phiên, khu vực và thời điểm. Mita chưa xác minh quyền công khai ảnh, nội dung và giá lấy từ Amazon; `rightsStatus: local_test_only` chỉ dành cho môi trường phát triển, không công bố website thương mại khi chưa có quyền sử dụng và quy trình kiểm duyệt hàng nhập khẩu.

## Luồng thử nghiệm

Trang chủ → danh mục → sản phẩm → giỏ hàng → đặt hàng. API kiểm tra lại sản phẩm, giá và policy trong PostgreSQL, lưu snapshot đơn `pending_confirmation` / `unpaid`. Mua hộ Amazon qua `/mua-ho-amazon` dùng báo giá có thời hạn, có thể đưa vào giỏ cùng catalog. Phí vận chuyển cuối cùng có bước xác nhận riêng; chưa thu tiền tự động. Không gửi đơn hay gọi báo giá Amazon chỉ để kiểm tra tài liệu.

## Cấu hình

Mẫu biến môi trường ở `backend/.env.example` (không tự nạp): `DATABASE_URL`, `API_PORT`, `WEB_PORT`, `FX_JPY_TO_VND` (seed mặc định 190 VND/JPY), `SERVICE_FEE_PERCENT` (seed mặc định 12). Sau migration, policy DB là nguồn giá; chỉnh đồng thời hai thông số qua Admin, không đổi snapshot đơn cũ. Nền tảng tách module nhỏ theo `backend/src/{admin,catalog,pricing,orders,ingestion,db}`. Không có Docker, Redis hoặc dịch vụ bắt buộc ngoài Node và PostgreSQL. Frontend dùng `/api/*` cùng origin, Next chuyển qua loopback Fastify.

## Kiểm tra

Kiểm tra tĩnh thông thường (không cần migrate/build):

```powershell
npm run lint
npm run typecheck --prefix backend
```

Integration dùng `npm test --prefix backend` **chỉ sau khi đọc `backend/tests/run.ts` và xác minh target an toàn**: runner tạo/drop DB dùng một lần. Không chạy trực tiếp các file test ghi DB vào DB đang dùng. Migration là thao tác riêng cần phép; không chạy Next production build vào `.next` dùng chung với dev server đang hoạt động. Với thay đổi tài liệu thuần túy, rà source/diff và `git diff --check` là đủ; các kiểm tra đó không chứng minh runtime, schema live hay deploy.
