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
- `cd backend; npm run worker:once` thu thập một lần bằng HTTP parser; lỗi tạm thời được retry tối đa 3 lần với backoff. Khi markup lỗi hoặc giá không đọc được, worker thử bổ sung qua BrowserOS Neo MCP (`127.0.0.1:9010/mcp`) tại local. HTTP 403/429/CAPTCHA (kể cả trang phân trang) dừng truy cập nguồn đó và yêu cầu xử lý, **không dùng Neo để vượt chặn**. Các trang thu thập thành công vẫn được lưu và lỗi được báo `partial`/`needs_human`. `npm run worker:daily` dùng pg-boss để lập lịch 04:00 JST hằng ngày. Tối đa 200 ASIN mỗi danh mục, ASIN độc nhất; không xóa snapshot tốt khi lỗi.
- `./scripts/start-local.ps1` tự bật daily worker nếu chưa chạy; có thể chạy lại script để phục hồi dịch vụ sau khi khởi động lại Windows.
- `cd backend; npx tsx src/worker.ts import` nạp snapshot quan sát thật từ `backend/data/observed-amazon.json`, chỉ để chạy local trong trường hợp nguồn tạm lỗi. Mỗi giá có `observedAt` nguồn; **giá quá 24 giờ sẽ bị khóa checkout**.
- Các biến thể ASIN chỉ được gộp khi nguồn cung cấp `parentAsin` hoặc `sourceProductId` rõ ràng; không suy đoán từ tên sản phẩm. Database cũ không được tự động ghép nhóm, nên chưa nhất thiết có biến thể đang hiển thị sau nâng cấp.

### Ảnh, mô tả và bản dịch tiếng Việt

- Worker PC lấy trang chi tiết mỗi ASIN (bao gồm backlog từ các lần trước), lưu tối đa 5 **URL** ảnh thực, các phần đặc điểm/thành phần/cách dùng/thông số/cảnh báo và thuộc tính biến thể có bằng chứng. Lượt xử lý tối đa 200 ASIN độc nhất **trên mỗi danh mục**, gồm ASIN con; refresh khi lịch 04:00 JST chạy thực tế. Nếu Amazon chặn hoặc thiếu dữ liệu, giữ snapshot tốt cuối cùng và ghi lỗi.
- Worker PC dịch **sau khi** có nội dung nguồn bằng OpenRouter qua `OPENROUTER_API_KEY` ở môi trường Windows (không đưa key vào `.env.example`, Git, VPS hay log). Thử năm model `:free` theo đúng thứ tự đã chốt trong [plan 07](.agents/plan/07_mita_product_detail_enrichment_grill_plan.md); 429, timeout, response lỗi hoặc bản dịch sai cấu trúc sẽ chuyển sang model kế tiếp. Không tự trả phí. Bản dịch hợp lệ tự hiển thị; tên Nhật gốc vẫn giữ trong DB để truy vết và tìm kiếm.
- Chạy riêng bản dịch khi không cần scrape: `cd backend; npm run worker:translate`. Mỗi lượt dịch xử lý tối đa 30 sản phẩm; chạy lại sau khi model free hết giới hạn. Nếu cả năm model đều lỗi, website vẫn dùng tên gốc và không tự tạo thông tin sản phẩm giả. Worker không tự chạy khi PC tắt.
- **Phát hành VPS:** các bảng mới `product_images`, `product_details`, `product_translations`, `product_detail_queue` phải được tạo bằng migration có kiểm soát **trước** khi push commit `[deploy]`; GitHub Actions hiện chỉ build/deploy code và không migrate PostgreSQL. Không chạy dịch tại VPS và không mở API key OpenRouter cho web/backend VPS.

Trang Amazon có thể hiển thị dữ liệu và giá khác giữa phiên, khu vực và thời điểm. Mita chưa xác minh quyền công khai ảnh, nội dung và giá lấy từ Amazon; `rightsStatus: local_test_only` chỉ dành cho môi trường phát triển, không công bố website thương mại khi chưa có quyền sử dụng và quy trình kiểm duyệt hàng nhập khẩu.

## Luồng thử nghiệm

Trang chủ → danh mục whey/đồ ăn trẻ em → mở sản phẩm → thêm giỏ → `Giỏ hàng` → `Thanh toán`. API tự kiểm tra lại sản phẩm và giá trong PostgreSQL, chốt snapshot theo đơn `simulation_created`; tiền hàng thu ngay **chỉ hiển thị mô phỏng**, ước tính phí vận chuyển thu sau và không ghi nhận thanh toán. Không có cổng thanh toán, OTP hoặc thẻ thật.

## Cấu hình

Mẫu biến môi trường ở `backend/.env.example` (không tự nạp): `DATABASE_URL`, `API_PORT`, `WEB_PORT`, `FX_JPY_TO_VND` (seed mặc định 190 VND/JPY), `SERVICE_FEE_PERCENT` (seed mặc định 12). Sau migration, policy DB là nguồn giá; chỉnh đồng thời hai thông số qua Admin, không đổi snapshot đơn cũ. Nền tảng tách module nhỏ theo `backend/src/{admin,catalog,pricing,orders,ingestion,db}`. Không có Docker, Redis hoặc dịch vụ bắt buộc ngoài Node và PostgreSQL. Frontend dùng `/api/*` cùng origin, Next chuyển qua loopback Fastify.

## Kiểm tra

```powershell
cd backend
npm run typecheck
npm test
npm run db:migrate
cd ..
npm run lint
npm run build
```
