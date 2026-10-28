# Mita Japan — local storefront

## Version và phát hành lên VPS Hermes

- Version công khai do chủ dự án tự đặt trong [`release.json`](release.json), hiện là **`0.3`**; website hiển thị nhỏ ở cuối footer. Không dùng `version` trong `package.json` để hiển thị phiên bản cửa hàng.
- Để triển khai: commit với chuỗi **`[deploy]`** trong message của **commit cuối cùng được push lên `main`**, sau đó `git push origin main`. GitHub Actions tự test, build trên Ubuntu Linux x64 và chuyển release xuống Hermes. Commit không có `[deploy]` không triển khai.
- Xem [quy trình deploy, phiên bản, SSH key và rollback](deploy/mita/ci-deploy.md), [workflow GitHub Actions](.github/workflows/mita-deploy.yml) và [runbook vận hành VPS](docs/hermes-vps-runbook.md). Không build Next.js trên VPS RAM 1 GiB. Migration database không tự chạy trong pipeline.

Website mua hộ Nhật dành cho khách Việt. Garden UI (Next.js), catalog/checkout API (Fastify + TypeScript), PostgreSQL 18 chạy trực tiếp trên Windows. **Checkout chỉ là mô phỏng, không thu tiền thật.** Giá bán VND dùng chính sách tỷ giá/phụ phí lưu trong PostgreSQL, **không phải báo giá đang giao dịch**.

Admin local tại `/admin`: một owner, Tổng quan / Sản phẩm / Đơn hàng / Cấu hình. Xem [hướng dẫn khởi tạo owner, chạy/dừng, backup/restore và sử dụng Admin](docs/admin-local.md). Không Docker, truy cập LAN/internet hoặc tự khởi động cùng Windows.

## Bắt đầu (Windows, không Docker)

Yêu cầu: Node.js 22+, PostgreSQL 18 tại `C:\Program Files\PostgreSQL\18\bin`.

```powershell
npm install
cd backend
npm install
cd ..
./scripts/start-local.ps1
```

Mở **http://127.0.0.1:3000**. API tại `http://127.0.0.1:4000/api/health`, PostgreSQL thử nghiệm tại `127.0.0.1:5433`. Script tạo PostgreSQL cluster **riêng** tại `backend/.local-db` lần đầu, chỉ lắng nghe loopback để không đụng dịch vụ PostgreSQL đang chạy trên 5432. Mỗi tiến trình ghi log trong `.agents/runtime` (đã gitignore).

## Dữ liệu thật và đồng bộ

- Seed whey: <https://www.amazon.co.jp/gp/bestsellers/hpc/3457072051>.
- Seed đồ ăn trẻ em: <https://www.amazon.co.jp/s?k=%E3%83%99%E3%83%93%E3%83%BC%E3%83%95%E3%83%BC%E3%83%89&i=food-beverage>.
- `cd backend; npm run worker:once` uses Scrapling FetcherSession + BeautifulSoup (no fallback). CAPTCHA, verification/login and 403 stop all Amazon requests immediately. HTTP 429 slows pacing and retries at most twice in the same request; exhaustion persists the shared source cooldown. Retry-After waits up to 10 seconds are honored; longer waits stop immediately into cooldown. Re-entry is once at 04:00 JST on the following calendar day, only through the scheduled worker. `npm run worker:daily` uses pg-boss, with no downtime catch-up. Runs retain good snapshots, use `failed`/`partial` on errors, and attempt at most 200 unique detail ASINs per category.
- `./scripts/start-local.ps1` tự bật **hai tiến trình riêng biệt**: Amazon catalog worker (04:00 JST) và name translator (05:00 JST), mỗi tiến trình có PID/log riêng. Cả hai chỉ chạy khi PC đang bật; lịch bỏ qua ngày bị tắt máy, không chạy bù lúc khởi động.
- `cd backend; npx tsx src/worker.ts import` nạp snapshot quan sát thật từ `backend/data/observed-amazon.json`, chỉ để chạy local trong trường hợp nguồn tạm lỗi. Mỗi giá có `observedAt` nguồn; **giá quá 24 giờ sẽ bị khóa checkout**.
- Các biến thể ASIN chỉ được gộp khi nguồn cung cấp `parentAsin` hoặc `sourceProductId` rõ ràng; không suy đoán từ tên sản phẩm. Database cũ không được tự động ghép nhóm, nên chưa nhất thiết có biến thể đang hiển thị sau nâng cấp.

### Ảnh, mô tả và bản dịch tiếng Việt

- Worker PC lấy trang chi tiết mỗi ASIN (bao gồm backlog từ các lần trước), lưu tối đa 5 **URL** ảnh thực, các phần đặc điểm/thành phần/cách dùng/thông số/cảnh báo và thuộc tính biến thể có bằng chứng. Lượt xử lý tối đa 200 ASIN độc nhất **trên mỗi danh mục**, gồm ASIN con; refresh khi lịch 04:00 JST chạy thực tế. Nếu Amazon chặn hoặc thiếu dữ liệu, giữ snapshot tốt cuối cùng và ghi lỗi.
- **Translator độc lập chỉ dịch tên** lúc **05:00 JST**, không được kích hoạt bởi Amazon worker, CAPTCHA, Admin Import hay startup. Gọi OpenRouter qua `OPENROUTER_API_KEY` ở môi trường Windows (không đưa key vào `.env.example`, Git, VPS hay log). Danh sách model `:free` kế thừa từ [plan 07](.agents/plan/07_mita_product_detail_enrichment_grill_plan.md), bỏ qua Inkling Small hạn chế agentic harness. 429, timeout hoặc phản hồi lỗi thử các model được phép tiếp theo. Không tự trả phí.
- Dịch **tối đa 100 tên/1 request; JSON request thực tế tối đa 24.000 byte UTF-8; dự toán output bảo thủ tối đa 8.192 token**, chạy liên tục trong lượt 05:00 đến khi hết ASIN chưa dịch, quota miễn phí hoặc provider không khả dụng. Giữ 2 request dự phòng, khoảng cách request tối thiểu 3.2 giây và khóa PostgreSQL chống hai translator đồng thời. `status='success'` và có tên Việt là **đã dịch xong vĩnh viễn theo ASIN**: hôm sau không dịch lại, kể cả khi Amazon đổi tên/nội dung. Tên Việt cũ vẫn hiển thị; tên Nhật lưu riêng. Các ASIN lỗi được thử lại ở lượt 05:00 tiếp theo. **Dịch mô tả sẽ do model/tiến trình khác thực hiện sau; lịch hiện tại hoàn toàn không dịch mô tả.** Bản dịch mô tả đầy đủ đã lưu từ trước vẫn giữ trong DB.
- Chạy thủ công ngoài lịch khi cần: `cd backend; npm run worker:translate` (chỉ tên). Daemon độc lập: `npm run worker:translate:daily`. Không tự chạy bù nếu 05:00 PC tắt; khi quota hết phải đợi 05:00 ngày sau. Log tại `.agents/runtime/translator.out.log` và `translator.err.log`.
- Lấy dữ liệu của catalog cũ mà không chờ tới 04:00: `cd backend; npm run worker:backfill:seed` (xếp hàng không gọi Amazon), `npm run worker:backfill:status` (xem tiến độ), `$env:BACKFILL_LIMIT_PER_CATEGORY='15'; npm run worker:backfill` (lấy thật, 1–200 ASIN/danh mục/lượt). Có thể đặt `$env:BACKFILL_CATEGORY_SLUG='thuc-pham-bo-sung'` để chỉ xử lý một danh mục. Lệnh backfill không truy cập trang listing và không chạy khi đã có ASIN cần người xác minh.
- **Amazon CAPTCHA/403/429:** daily scans, Admin Import and backfill share the PostgreSQL source mutex and `source_access_blocks.retry_after_at`. Imports/manual runs cannot consume the daily re-entry. A failed re-entry reserves the next calendar day at 04:00 JST; a crash keeps that reservation. No operator ACK, automatic browser opening, proxy rotation or CAPTCHA solver. Owner status shows the next eligible retry. Translation stays a separate 05:00 JST process.
- **Amazon bị chặn quá 30 giây:** worker ghi bền `continuation_due_at` và `timeout_recorded_at` để hiển thị thời điểm chặn, tiếp tục chờ người xác minh; không tự retry/ACK hay kích hoạt dịch. Translator chỉ chạy theo lịch 05:00 riêng, dịch tên có sẵn ngay cả khi Amazon bị chặn. `npm run worker:backfill:status` hiển thị số tên đã dịch và số bản dịch đầy đủ lịch sử cùng trạng thái chặn nguồn.
- **Migration before worker restart:** run `cd backend; npm run db:migrate` as a separate controlled DB operation. See [cooldown migration runbook](docs/amazon-cooldown.md). It converts legacy active states without deleting errors, attempts, prices or snapshots. Q5=A archives and retires only the pre-cooldown source block once under the source mutex; fresh blocks are protected. Web/VPS deployment does not run migrations.
- **Phát hành VPS:** các bảng mới `product_images`, `product_details`, `product_translations` (cột additive `name_only`, `detail_attempted_at`), `product_detail_queue` và `source_access_blocks` phải được tạo bằng migration có kiểm soát **trước** khi push commit `[deploy]`; GitHub Actions hiện chỉ build/deploy code và không migrate PostgreSQL. Không chạy dịch tại VPS và không mở API key OpenRouter cho web/backend VPS.

Trang Amazon có thể hiển thị dữ liệu và giá khác giữa phiên, khu vực và thời điểm. Mita chưa xác minh quyền công khai ảnh, nội dung và giá lấy từ Amazon; `rightsStatus: local_test_only` chỉ dành cho môi trường phát triển, không công bố website thương mại khi chưa có quyền sử dụng và quy trình kiểm duyệt hàng nhập khẩu.

## Luồng thử nghiệm

Trang chủ → danh mục whey/đồ ăn trẻ em → mở sản phẩm → thêm giỏ → `Giỏ hàng` → `Thanh toán`. API tự kiểm tra lại sản phẩm và giá trong PostgreSQL, chốt snapshot theo đơn `simulation_created`; tiền hàng thu ngay **chỉ hiển thị mô phỏng**, ước tính phí vận chuyển thu sau và không ghi nhận thanh toán. Không có cổng thanh toán, OTP hoặc thẻ thật.

## Cấu hình

Mẫu biến môi trường ở `backend/.env.example` (không tự nạp): `DATABASE_URL`, `API_PORT`, `WEB_PORT`, `FX_JPY_TO_VND` (seed mặc định 190 VND/JPY), `SERVICE_FEE_PERCENT` (seed mặc định 12). Sau migration, policy DB là nguồn giá; chỉnh đồng thời hai thông số qua Admin, không đổi snapshot đơn cũ. Nền tảng tách module nhỏ theo `backend/src/{admin,catalog,pricing,orders,ingestion,db}`. Không có Docker, Redis hoặc dịch vụ bắt buộc ngoài Node và PostgreSQL. Frontend dùng `/api/*` cùng origin, Next chuyển qua loopback Fastify.

## Kiểm tra

**Lưu ý DB:** chạy integration bằng `cd backend; npm test` vì `tests/run.ts` tạo database kiểm thử cô lập. Không gọi trực tiếp `tsx --test tests/admin.test.ts` trên DB local thật (các fixture test có thao tác ghi dữ liệu).

```powershell
cd backend
npm run typecheck
npm test
npm run db:migrate
cd ..
npm run lint
npm run build
```
