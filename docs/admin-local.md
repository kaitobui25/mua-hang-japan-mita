# Mita Japan Admin — hướng dẫn local

Admin dùng chung Next.js, Fastify và PostgreSQL của cửa hàng. Mở **http://127.0.0.1:3000/admin** trên chính máy này. Chỉ một owner; không có đăng ký web. Đơn `simulation_created` chưa thu tiền, chưa mua trên Amazon.

## Bật / dừng thủ công trên Windows

Node.js 22+, PostgreSQL 18; cài dependencies một lần bằng `npm install` ở thư mục gốc và `backend`. Từ thư mục gốc chạy:

```powershell
./scripts/start-local.ps1
cd backend
npm run admin:setup
```

Lệnh setup yêu cầu terminal tương tác, nhập kín và xác nhận mật khẩu 12–128 ký tự. Không truyền mật khẩu trên command line, qua pipe, file hoặc biến môi trường. Lệnh từ chối nếu owner đã tồn tại. Dùng nhất quán `127.0.0.1` hoặc `localhost` khi đăng nhập; cookie không chia sẻ giữa hai host.

`start-local.ps1` khởi động cluster riêng `backend/.local-db` tại **127.0.0.1:5433**, migration, API **127.0.0.1:4000**, Amazon worker **04:00 JST**, translator **05:00 JST** (hai tiến trình tách biệt) và web **127.0.0.1:3000**. Log và PID nằm trong `.agents/runtime` (không commit). Đây là thao tác do bạn chạy, không cài Windows service hoặc Task Scheduler.

```powershell
# Từ thư mục gốc; chỉ dừng tiến trình mà script đã khởi chạy và ghi PID.
./scripts/stop-local.ps1
# Nếu muốn dừng cả PostgreSQL riêng của dự án:
./scripts/stop-local.ps1 -StopDatabase
```

Nếu các tiến trình đã chạy từ trước bản nâng cấp, dừng chúng bằng terminal đã mở hoặc Task Manager sau khi xác định đúng tiến trình của dự án, rồi chạy lại. Script không dừng tiến trình không do nó ghi nhận. Có thể chạy foreground trong ba terminal riêng: `cd backend; npm run start`, `cd backend; npm run worker:daily`, `npm run dev` ở thư mục gốc. Dừng mỗi terminal bằng Ctrl+C. Bật PostgreSQL/migration trước. Không bind `0.0.0.0`, mở port, hoặc truy cập qua LAN/internet.

Sau restart Windows cần tự chạy lại. Đồng bộ Amazon **04:00 Asia/Tokyo** và dịch **chỉ tên** **05:00 Asia/Tokyo** mỗi ngày chỉ diễn ra nếu PC và **tiến trình tương ứng** đang hoạt động đúng giờ. Job cũ từ downtime bị bỏ qua; mở Admin không chạy bù. ASIN Amazon đang chờ chỉ xử lý khi worker bật. Tên đã có bản dịch `success` không được dịch lại dù Amazon đổi nội dung; mô tả sẽ có hệ thống dịch khác sau này. `Làm mới kết quả` để xem tiến độ. Không có nút quét lại toàn catalog trong Admin.

## Bốn mục

- **Tổng quan:** số đơn mô phỏng 7 ngày, sản phẩm có thể hiển thị, 5 đơn mới, lần sync và tối đa 50 lỗi thật. Thiếu kết quả theo lịch được cảnh báo, không giả thành công. Không gửi email/SMS.
- **Sản phẩm:** tìm tên/ASIN, lọc danh mục/ẩn; `Ẩn` có xác nhận, giữ lịch sử và chặn catalog/detail/checkout. Sync và nhập lại không bỏ ẩn. `Hiện lại` không vượt kiểm tra quyền nội dung, điều kiện bán hay giá 24 giờ. Dán ASIN hoặc URL HTTPS Amazon.co.jp rồi chọn danh mục và `Thêm`: chỉ là **đã tiếp nhận**. ASIN đã có mở bản cũ; job trùng đang chạy được tái sử dụng. Tối đa 20 yêu cầu mỗi giờ/đang chờ. CAPTCHA/403/429 exhausted retries pause all Amazon work until the next eligible daily scan. Job gián đoạn quá 5 phút chuyển `failed`.
- **Đơn hàng:** tìm mã/điện thoại, đọc người nhận và snapshot giá JPY/VND, tỷ giá/phụ phí, vận chuyển ước tính thu sau. Chỉ xem; không trạng thái thanh toán, sửa, xóa hoặc ghi chú.
- **Cấu hình:** tỷ giá VND/JPY (>0 đến 10.000, tối đa 4 số lẻ), phụ phí (0–100%, tối đa 2 số lẻ), một nút `Lưu thay đổi`. Xác nhận cả hai giá trị trước/sau và giá thử từ backend. Lưu nguyên tử cùng version/audit; chỉ áp dụng giá catalog/đơn mới. Tab cũ bị từ chối nếu policy đã đổi, cần tải lại.

## Khôi phục quyền owner

Từ terminal local tin cậy: `cd backend; npm run admin:reset`. Nhập kín `RESET OWNER`, mật khẩu mới và xác nhận. Lệnh giữ một owner, thu hồi mọi phiên và ghi audit không chứa mật khẩu. Không có web reset hoặc mật khẩu mặc định. Ai đọc được DB/local filesystem có thể thay đổi dữ liệu: chỉ dùng máy/tài khoản Windows tin cậy. Phiên hết hạn sau 8 giờ, cookie HttpOnly/SameSite=Strict; logout thu hồi ngay. Năm lần thử đăng nhập trong 15 phút bị giới hạn; reset local có kiểm soát cũng xóa giới hạn này.

## Backup / restore / nâng cấp

Dừng API/worker trước backup nếu cần một điểm phục hồi ổn định. PostgreSQL vẫn bật. Chạy từ thư mục gốc; giữ backup ở nơi riêng vì chứa thông tin người nhận và hash owner/session:

```powershell
$pgbin = 'C:\Program Files\PostgreSQL\18\bin'
New-Item -ItemType Directory -Path .backups -Force
& "$pgbin\pg_dump.exe" -h 127.0.0.1 -p 5433 -U mita_local -d postgres -Fc -f .backups/mita-before-admin.dump
if ($LASTEXITCODE -ne 0) { throw 'Backup failed' }
cd backend
npm run db:migrate
cd ..
# Restore vào DB MỚI để kiểm tra, không ghi đè DB đang dùng:
& "$pgbin\createdb.exe" -h 127.0.0.1 -p 5433 -U mita_local mita_restore_check
& "$pgbin\pg_restore.exe" -h 127.0.0.1 -p 5433 -U mita_local -d mita_restore_check --exit-on-error .backups/mita-before-admin.dump
& "$pgbin\psql.exe" -h 127.0.0.1 -p 5433 -U mita_local -d mita_restore_check -c 'SELECT count(*) FROM products; SELECT count(*) FROM orders;'
```

Migration thêm bảng/cột/index trong transaction, giữ dữ liệu cũ. Tỷ giá/phụ phí env (`FX_JPY_TO_VND=190`, `SERVICE_FEE_PERCENT=12` mặc định) chỉ seed DB **một lần**; chạy lại migration không ghi đè policy. Đơn cũ giữ snapshot, version cũ để null. Nếu cần rollback, dừng app, phục hồi backup vào DB mới, xác minh số liệu, rồi trỏ `DATABASE_URL` tới DB phục hồi và dùng code tương ứng. Không drop DB gốc hoặc xóa cột để rollback trực tiếp. Backup từ trước Admin chưa có owner; backup sau Admin cần `admin:reset` sau restore để thu hồi các phiên cũ. Không dùng code storefront cũ với DB có sản phẩm đang ẩn vì code cũ chưa kiểm tra cờ ẩn.

`.env.example` là mẫu, không tự nạp. Đặt biến môi trường trong terminal trước khi chạy lệnh. `DATABASE_URL` mặc định chỉ loopback; `API_PORT` mặc định 4000 và `WEB_PORT` 3000. Nếu đổi port, dùng cùng `API_PORT` cho build/start frontend và backend; đặt `WEB_PORT` backend bằng port frontend để kiểm tra Origin.

## Kiểm tra cho developer

`cd backend; npm run typecheck; npm test` rồi từ gốc `npm run lint; npm run build`. `npm test` tạo DB `mita_test_<random>` riêng, seed schema và chạy toàn bộ tests rồi xóa DB test; role PostgreSQL local cần quyền CREATEDB. Không reset owner hoặc dữ liệu của DB vận hành. Không dùng test database làm cửa hàng.

Nội dung/ảnh Amazon hiện chỉ dùng local (`local_test_only`), không tự được cấp quyền xuất bản. Giá quá 24 giờ vẫn xem được nhưng không checkout; quyền chưa xác minh không xuất hiện ở public catalog. Adapter ASIN chỉ lấy URL chuẩn cố định, từ chối redirect và dừng khi nguồn yêu cầu con người. Lịch 04:00 có test PostgreSQL/pg-boss với clock điều khiển xuyên qua giờ lịch và downtime; không thay đổi đồng hồ Windows. Lần chạy nguồn thật lúc 04:00 cần máy/worker bật và `sync_run` thực tế, không suy ra từ cấu hình cron.

Amazon denials now use a shared next-day 04:00 JST cooldown with one scheduled re-entry. Imports remain pending while the source is cooling down; an attempted denied import fails. No manual ACK or CAPTCHA-open workflow is required. See [migration and worker contract](amazon-cooldown.md).
