# Mita Japan — DuckDNS trên PC Windows

> **LƯU TRỮ LỊCH SỬ — không còn là hướng dẫn triển khai hiện tại (27/10/2026).** Website chính hiện chạy trên **VPS Hermes** tại `https://mitajapanshop.duckdns.org` (A = `217.142.225.255`), HTTPS hoạt động; **không cần và không được mở cổng router tại nhà**. Caddy/Next/Fastify/PostgreSQL chính đều trên VPS, chỉ Amazon worker + BrowserOS Neo trên PC qua SSH. Xem **`docs/hermes-vps-runbook.md`**. Những địa chỉ `trycloudflare.com`, phát biểu chưa có HTTPS và các lệnh cập nhật DuckDNS không chỉ định IP bên dưới là thông tin của phương án cũ, **không còn hiệu lực**. `scripts/duckdns.ps1` hiện bắt buộc `-Ip 217.142.225.255` và từ chối `-Watch`.

**Hostname đã đăng ký:** `mitajapanshop.duckdns.org` trong DuckDNS bằng tài khoản Google `nothink1314@gmail.com`. **Trạng thái:** DNS A và cập nhật IP đã hoạt động; HTTPS trên tên miền chính chưa truy cập được vì router chưa chuyển tiếp cổng 80/443. DuckDNS chỉ cập nhật DNS, không cung cấp hosting.

## Trước khi mở internet

1. Hostname `mitajapanshop` đã được đăng ký. Token DuckDNS được lưu dạng DPAPI theo tài khoản Windows trong `.agents/runtime/duckdns.token`, không đưa vào chat hoặc Git. Script cập nhật `scripts/duckdns.ps1` đã trả `OK`.
2. **Việc còn lại để dùng domain chính:** đăng nhập vào router/gateway Yamaha tại `192.168.24.1` bằng kênh quản trị được cấp quyền, xác minh IP WAN và cấu hình port forward TCP `80` và `443` về `192.168.24.15`. Giao diện HTTP/HTTPS của router không phản hồi từ máy Windows; UPnP mapping không được hỗ trợ qua Windows. Nếu WAN thực tế là CGNAT, cần IP public/giải pháp VPS thay cho port forward.
3. Chỉ dùng nội dung, ảnh, giá có quyền công bố. Chế độ public trả **chỉ sản phẩm `rights_status='verified'`**; dữ liệu `local_test_only` vẫn có thể thấy trong môi trường phát triển.
4. Backup PostgreSQL theo `docs/admin-local.md`. Chỉ mở router sau khi kiểm tra trực tiếp cấu hình Caddy và mọi đường Admin/API nhạy cảm bị chặn.

**Đã thử thực tế 27/10/2026:** Caddy trên PC nghe TCP 80/443 nhưng Let's Encrypt từ bên ngoài nhận `Connection refused` ở `160.86.229.166` trên cả HTTP-01 và TLS-ALPN-01. **Đã dừng Caddy HTTPS chính** để tránh retry ACME liên tục; sau khi cấu hình router/firewall, khởi động lại bằng lệnh `caddy run --config ./deploy/Caddyfile --adapter caddyfile`. Máy Windows hiện không chạy với quyền Administrator nên có thể còn cần quyền nâng cấp để thêm Windows Firewall rules inbound 80/443. Không gọi `mitajapanshop.duckdns.org` đã online cho đến khi CA cấp cert và BrowserOS Neo mở được từ internet.

## Lệnh vận hành

Chạy từ thư mục gốc dự án bằng PowerShell trên máy Windows. Không cần Docker hoặc server riêng.

```powershell
# Thử bản production riêng khi local dev vẫn hoạt động (cổng 3100/4100):
./scripts/start-public.ps1 -Preview
# Dừng bản preview:
./scripts/stop-public.ps1

# Chỉ dùng khi cần thiết lập lại token (token hiện đã được lưu mã hóa):
./scripts/duckdns.ps1 -Setup
# Kiểm tra cập nhật DNS một lần (chỉ báo OK hoặc lỗi, không lộ token)
./scripts/duckdns.ps1

# Khi quyết định chuyển từ dev sang bản public:
./scripts/stop-local.ps1
./scripts/start-public.ps1

# Caddy nhận 80/443 và tự quản HTTPS; phải kiểm tra domain/forward trước
caddy validate --config ./deploy/Caddyfile --adapter caddyfile
caddy run --config ./deploy/Caddyfile --adapter caddyfile
```

`start-public.ps1` dùng `.next-public` (không tranh thư mục `.next` với Next dev), xây bản tối ưu và chạy Next + Fastify qua loopback. Mặc định public chỉ đọc: không tạo đơn, không nhận dữ liệu liên hệ; worker chạy 04:00 JST nếu máy vẫn bật. Khi đã thiết lập token, updater DuckDNS được bật mỗi 5 phút **trong lúc public app chạy** và dừng cùng `./scripts/stop-public.ps1`. Không cài tự khởi động Windows.

`deploy/Caddyfile` giữ `127.0.0.1:3000` làm upstream, chỉ public GET/HEAD catalog, chặn `/admin`, `/api/admin`, checkout và API nội bộ. **Không forward** 3000, 4000, 5433, 9010. Trên router chỉ forward TCP 80/443 tới IP LAN ổn định của PC; Windows Firewall chỉ cho Caddy nhận 80/443. Admin vẫn dùng `http://127.0.0.1:3000/admin` trên chính máy; không truy cập bằng DuckDNS.

**Phương án tạm đã kiểm thử:** Cloudflare Quick Tunnel qua Caddy chỉ nghe loopback `127.0.0.1:8088`, URL dạng `https://*.trycloudflare.com` (hiện tại `https://europe-groove-classified-accordance.trycloudflare.com`). URL này thay đổi mỗi khi khởi tạo tunnel mới và chỉ dùng để thử nghiệm, không được liên kết trực tiếp bằng DNS A của DuckDNS. Kiểm thử qua BrowserOS Neo và HTTPS cho kết quả: GET trang chủ, danh mục, catalog = 200; các route `/admin`, `/api/admin`, `/api/health`, `/api/sync-status`, `/thanh-toan`, POST `/api/checkout` = 404. Để dừng toàn bộ tiến trình public, proxy và tunnel do dự án khởi động: `./scripts/stop-public.ps1`.

## Kiểm tra nghiệm thu

- Qua mạng ngoài LAN: HTTP chuyển HTTPS với chứng chỉ hợp lệ, trang chủ/danh mục/chi tiết mở được; thử cả tìm kiếm và trạng thái không có sản phẩm.
- `/admin`, `/admin/login`, `/api/admin/session`, `/api/health`, `/api/sync-status`, `/thanh-toan`, `POST /api/checkout` không truy cập qua DuckDNS. Không giả định các đường chặn đã hoạt động nếu chưa thử HTTP thật qua tên miền.
- `GET /api/catalog` chỉ trả hàng `verified`; snapshot Amazon `local_test_only` không xuất hiện. Chưa có quyền sử dụng thì catalog trống là đúng.
- Nếu có sự cố: dừng Caddy (Ctrl+C trong terminal), `./scripts/stop-public.ps1`, gỡ forward 80/443, rồi `./scripts/start-local.ps1` để trở lại dev. Không xóa DB hoặc tài khoản owner.

**Đã kiểm chứng:** hostname thuộc tài khoản Google đã chọn; DuckDNS update API báo OK; storefront production/HTTPS tạm hoạt động. **Chưa kiểm chứng:** router WAN/CGNAT, port forward, HTTPS qua `mitajapanshop.duckdns.org`, quyền công bố nội dung Amazon. Không tuyên bố domain chính đã online trước khi hoàn tất những bước đó.
