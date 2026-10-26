# Mita Japan — local storefront

Website mua hộ Nhật dành cho khách Việt. Garden UI (Next.js), catalog/checkout API (Fastify + TypeScript), PostgreSQL 18 chạy trực tiếp trên Windows. **Checkout chỉ là mô phỏng, không thu tiền thật.** Giá bán bằng VND dùng tỷ giá/phụ phí cố định trong cấu hình, **không phải báo giá đang giao dịch**.

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
- `cd backend; npm run worker:once` thu thập một lần bằng HTTP parser; khi thay đổi markup, worker có fallback qua BrowserOS Neo MCP (`127.0.0.1:9010/mcp`) nếu Neo đang chạy. HTTP 403/429/CAPTCHA dừng và yêu cầu xử lý, không dùng Neo để vượt chặn. `npm run worker:daily` dùng pg-boss để lập lịch 04:00 JST hằng ngày. Tối đa 200 ASIN mỗi danh mục, ASIN độc nhất; lỗi chỉ cập nhật trạng thái đồng bộ, không xóa snapshot tốt.
- `./scripts/start-local.ps1` tự bật daily worker nếu chưa chạy; có thể chạy lại script để phục hồi dịch vụ sau khi khởi động lại Windows.
- `cd backend; npx tsx src/worker.ts import` nạp snapshot quan sát thật từ `backend/data/observed-amazon.json`, chỉ để chạy local trong trường hợp nguồn tạm lỗi. Mỗi giá có `observedAt` nguồn; **giá quá 24 giờ sẽ bị khóa checkout**.

Trang Amazon có thể hiển thị dữ liệu và giá khác giữa phiên, khu vực và thời điểm. Mita chưa xác minh quyền công khai ảnh, nội dung và giá lấy từ Amazon; `rightsStatus: local_test_only` chỉ dành cho môi trường phát triển, không công bố website thương mại khi chưa có quyền sử dụng và quy trình kiểm duyệt hàng nhập khẩu.

## Luồng thử nghiệm

Trang chủ → danh mục whey/đồ ăn trẻ em → mở sản phẩm → thêm giỏ → `Giỏ hàng` → `Thanh toán`. API tự kiểm tra lại sản phẩm và giá trong PostgreSQL, chốt snapshot theo đơn `simulation_created`; tiền hàng thu ngay **chỉ hiển thị mô phỏng**, ước tính phí vận chuyển thu sau và không ghi nhận thanh toán. Không có cổng thanh toán, OTP hoặc thẻ thật.

## Cấu hình

API đọc biến môi trường ở `backend/.env.example`: `DATABASE_URL`, `API_PORT`, `FX_JPY_TO_VND` (mặc định 190 VND/JPY), `SERVICE_FEE_PERCENT` (mặc định 12). Nền tảng tách module nhỏ theo `backend/src/{catalog,pricing,orders,ingestion,db}`. Không có Docker, Redis hoặc dịch vụ bắt buộc ngoài Node và PostgreSQL. Bộ phận frontend dùng `/api/*` cùng origin, Next chuyển qua `127.0.0.1:4000`.

## Kiểm tra

```powershell
cd backend
npm run typecheck
npm run db:migrate
cd ..
npm run build
```
