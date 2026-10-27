# 05 — Kế hoạch đưa Mita Japan lên DuckDNS

**Ngày:** 27/10/2026 (JST)  
**Trạng thái:** `production + temporary HTTPS tunnel running` — DuckDNS đã tạo/đồng bộ IP, production đã chạy, **HTTPS trực tiếp trên DuckDNS còn bị chặn bởi kết nối inbound**.  
**Mục tiêu:** truy cập storefront bằng `https://mitajapanshop.duckdns.org` từ internet; giữ Admin chỉ dùng trên chính máy Windows qua `http://127.0.0.1:3000/admin`.

## 1. Phạm vi và lựa chọn ban đầu

- **DuckDNS chỉ cấp tên miền DNS động**, không chạy ứng dụng. Phương án đầu tiên: giữ Next.js + Fastify + PostgreSQL trên PC Windows hiện tại, dùng **Caddy** làm reverse proxy HTTPS công khai, DuckDNS trỏ đến IP public của mạng này.
- Giữ một codebase/DB. Next.js production (`npm run build` rồi `npm run start`) và Fastify chỉ nghe `127.0.0.1`; Caddy nhận kết nối public cổng **80/443**, chuyển đến Next trên `127.0.0.1:3000`. Next tiếp tục rewrite `/api/*` đến Fastify trên `127.0.0.1:4000`; PostgreSQL nghe `127.0.0.1:5433`.
- **Giới hạn đợt public đầu:** chỉ trang giới thiệu/danh mục/chi tiết và API đọc cần thiết. Chưa công khai Admin, worker, DB, `/api/health`, `/api/sync-status` hay API nhập ASIN. **Tắt đường checkout từ internet** trong đợt đầu vì `POST /api/checkout` hiện tạo đơn mô phỏng nhưng ghi tên, điện thoại, địa chỉ thực; chỉ mở lại sau khi chốt yêu cầu dữ liệu cá nhân, chống spam và nghiệp vụ nhận đơn.
- **Ràng buộc nguồn Amazon:** code hiện dùng `rights_status IN ('local_test_only','verified')` cho catalog. Trước khi public phải lọc chỉ `verified` ở API public, gồm detail/biến thể và điều kiện checkout; không phát ảnh, mô tả, giá chưa được cấp quyền. Nếu chưa có dữ liệu `verified`, storefront public chỉ hiển thị nội dung/ảnh tự tạo hoặc được phép sử dụng và trạng thái danh mục trống phù hợp.
- **Giữ quyết định Admin Q9 và khởi chạy thủ công Q10:** owner chỉ mở Admin qua localhost; website/worker không tự khởi động cùng Windows. Khi PC tắt/ngủ, website và lịch quét sẽ ngừng hoạt động. Việc tự động cập nhật địa chỉ DuckDNS (nếu cần) là cấu hình DNS riêng, không tự bật ứng dụng.

```text
Khách internet → https://<ten-mien>.duckdns.org → DuckDNS A record → IP WAN/router
                                                    ↓ 80/443 (port forward)
                                             Caddy trên Windows
                                             ├─ chặn /admin, /api/admin, API ngoài danh sách
                                             └─ 127.0.0.1:3000 (Next production)
                                                        └─ /api/* → 127.0.0.1:4000 (Fastify)
                                                                        └─ 127.0.0.1:5433 (PostgreSQL)
Owner trên cùng PC → http://127.0.0.1:3000/admin (không đi qua Caddy public)
```

## 2. Các mốc thực hiện theo thứ tự

### A — Kiểm tra có thể truy cập từ internet hay không (bắt buộc làm trước)

1. Owner đăng nhập DuckDNS và đăng ký hostname **`mitajapanshop`** nếu còn trống. **Không gửi DuckDNS token trong chat/Git**; cấu hình riêng trên máy. BrowserOS Neo hiện dừng ở bước chọn tài khoản Google.
2. Xác định IP WAN của router và IP public quan sát từ ngoài, kiểm tra có **CGNAT**, double NAT, nhà mạng chặn inbound 80/443 hay không; xác nhận có quyền chỉnh port forwarding. Chưa đổi DNS hoặc mở firewall ở giai đoạn này.
3. Nếu WAN có IPv4 public và 80/443 được phép: chọn **nhánh Windows tự host**. Đặt DHCP reservation/IP LAN ổn định cho PC, rồi mới cấu hình chuyển tiếp cổng ở mốc C.
4. **Điểm dừng:** nếu CGNAT hoặc không thể mở inbound, DuckDNS một mình không giải quyết được. Chuyển sang phương án **VPS có public IP** (DuckDNS trỏ VPS, dựng Next/Fastify/DB và backup/restore an toàn) hoặc giải pháp tunnel được owner chốt riêng; không mở cổng vô ích hoặc triển khai tunnel tùy tiện.

**Nghiệm thu A:** có đường truy cập public khả thi đã kiểm tra, biết IP đích và tên miền dự kiến; nếu không khả thi thì quyết định nhánh khác **trước** khi cài proxy.

### B — Chuẩn bị ứng dụng cho môi trường public

1. Backup PostgreSQL theo `docs/admin-local.md`, kiểm tra khả năng restore vào DB kiểm tra; giữ nguyên owner, đơn và catalog hiện tại. Ghi lại trạng thái Git, không ghi đè các tài liệu đang modified.
2. Sửa bộ lọc quyền nội dung ở `backend/src/catalog.ts`: API public chỉ trả hàng có quyền `verified`. Rà soát ảnh ngoài, metadata, trang rỗng và hiển thị nhãn mô phỏng; giữ `robots: noindex` ở đợt thử nghiệm.
3. Ẩn/khóa CTA đặt hàng công khai trong UI cho đến khi có quy trình chấp nhận dữ liệu khách; lớp proxy tiếp tục chặn POST `/api/checkout` như lớp bảo vệ bổ sung. Không gọi đơn mô phỏng là đơn đã thanh toán.
4. Tạo đường chạy production riêng (ví dụ `scripts/start-public.ps1` và `stop-public.ps1`) cho `next build`/`next start`, API, worker, Caddy; giữ `start-local.ps1` phục vụ phát triển. Kiểm tra không dùng Next `dev` khi public, không chạy build chồng vào `.next` của dev đang chạy.
5. Chạy typecheck/test/lint/build và smoke test trên loopback trước khi nối internet. Xác minh Next vẫn rewrite `/api/catalog` đúng Fastify.

**Nghiệm thu B:** production chạy bằng localhost, trang chủ/danh mục/chi tiết hoạt động; không lộ dữ liệu `local_test_only`; checkout public được khóa; backup có thể restore.

### C — DuckDNS, Caddy và HTTPS

1. Cấu hình cập nhật bản ghi **A (IPv4)** qua router có hỗ trợ DuckDNS; nếu router không hỗ trợ, dùng updater PowerShell với HTTPS API DuckDNS, kiểm tra phản hồi `OK`, cập nhật định kỳ phù hợp khi máy đang bật (tham khảo 5 phút). Giữ token trong nơi lưu bí mật riêng, không commit, không in URL/token vào log. Chỉ cấu hình AAAA/IPv6 khi đường vào IPv6 đã được kiểm tra; xóa record cũ không còn trỏ đúng.
2. Cài Caddy cho Windows, cấu hình Caddyfile theo đúng tên miền, reverse proxy đến `127.0.0.1:3000`. Lưu certificate/state của Caddy ở nơi bền vững, có hướng dẫn start/stop và backup cấu hình.
3. **Chặn ngay tại Caddy** mọi `/admin`, `/admin/*`, `/api/admin`, `/api/admin/*`; với `/api/*` chỉ **allowlist GET/HEAD** `/api/categories`, `/api/catalog`, `/api/catalog/products/*` trong đợt đầu, trả `404/405` cho các route/phương thức khác. Giữ nguyên Host công khai đến Next để middleware Admin tiếp tục từ chối truy cập từ domain DuckDNS; không biến forwarded headers thành bằng chứng truy cập local. Kiểm thử lại cả đường dẫn có slash cuối, encoding và Host giả mạo.
4. Caddy kiểm tra đúng Host/domain; không làm Caddy forward trực tiếp vào Fastify/DB. Chạy `caddy validate` và smoke test cấu hình trước khi mở inbound.
5. Cấu hình Windows Firewall chỉ cho Caddy nhận TCP **80/443**, router NAT/port forward chỉ **80/443 → PC**. **Không forward 3000, 4000, 5433 hoặc 9010**. Caddy tự xin/gia hạn chứng chỉ HTTPS khi DNS và 80/443 hoạt động; HTTP chuyển sang HTTPS.

**Nghiệm thu C:** `https://<ten-mien>.duckdns.org` có chứng chỉ hợp lệ từ mạng ngoài; `/admin` và `/api/admin/*` không thể truy cập, API không cho phép bị chặn ở proxy; Fastify/DB/Neo không có cổng public.

### D — Kiểm tra công khai, vận hành và rollback

1. Dùng điện thoại qua **4G/5G (tắt Wi-Fi)** hoặc máy ngoài LAN để thử trang chủ, danh mục, tìm kiếm, chi tiết, ảnh hợp lệ, trạng thái rỗng và lỗi. Kiểm tra redirect HTTP→HTTPS, chứng chỉ, response API, không có mixed content.
2. Kiểm tra âm tính từ internet: `/admin`, `/admin/login`, `/api/admin/session`, `/api/checkout` (POST), `/api/health`, `/api/sync-status` phải bị từ chối; không lộ dữ liệu owner/đơn, kể cả với Host/Origin tự sửa. Kiểm tra localhost Admin vẫn đăng nhập và hoạt động bình thường.
3. Theo dõi log Caddy/API, giới hạn request và kích thước body cho các route public; không log cookie, token, thông tin cá nhân. Kiểm tra worker và `sync_runs` thực tế — **không coi lịch 04:00 JST đã chạy** nếu thiếu bằng chứng.
4. Viết hướng dẫn một trang: cách bật/dừng thủ công, DNS update, kiểm tra HTTPS, sao lưu, cách nhận biết DNS đổi IP, và giới hạn máy cá nhân tắt/ngủ. Ghi rõ tiêu chí chuyển VPS nếu cần 24/7.
5. **Rollback:** ngừng Caddy/chuyển tiếp 80/443, ngừng updater nếu cần, khôi phục app local từ mã đang chạy và backup khi có thay đổi dữ liệu; xác minh `/admin` vẫn chỉ dùng qua `127.0.0.1`. Không xóa DB gốc hoặc reset owner.

**Nghiệm thu D:** external smoke test PASS, đường quản trị bị chặn từ internet, API/DB không lộ trực tiếp; có cách vận hành và rollback đã kiểm chứng.

## 3. Điều kiện để thực hiện

| Cần xác định | Lý do |
| --- | --- |
| Tên miền DuckDNS muốn dùng | Đặt hostname thực tế trong updater/Caddy/cert |
| Mạng nhà có IPv4 public/được port forward không | Quyết định self-host Windows hay chuyển VPS |
| Public trước chỉ xem sản phẩm hay cần gửi yêu cầu thật | Plan mặc định **chỉ đọc**, không lấy thông tin cá nhân khi còn mô phỏng |
| Nội dung/ảnh sản phẩm có quyền công bố | Catalog hiện có trạng thái `local_test_only`, chưa đạt điều kiện public |

**Không yêu cầu owner cung cấp:** mật khẩu Admin, DuckDNS token, mật khẩu PostgreSQL hay thông tin đăng nhập router qua chat. Các bước liên quan đăng nhập/bí mật thực hiện trên máy của owner.

## 4. Tài liệu tham chiếu

- Mita local: `README.md`, `docs/admin-local.md`, `docs/admin-verification.md`, `docs/adr/0009-minimal-owner-admin.md`, `docs/adr/0010-admin-catalog-and-pricing-rules.md`.
- DuckDNS API chính thức: https://www.duckdns.org/spec.jsp
- DuckDNS cập nhật trên Windows/router: https://www.duckdns.org/install.jsp
- Caddy reverse proxy/HTTPS: https://caddyserver.com/docs/quick-starts/reverse-proxy và https://caddyserver.com/docs/automatic-https
- Next.js tự host: https://nextjs.org/docs/app/guides/self-hosting

**Chưa thực hiện:** cấu hình router/firewall inbound, mua VPS, tự khởi động app cùng Windows, tích hợp thanh toán thật hoặc công bố dữ liệu Amazon chưa được cấp quyền.

## 5. Kết quả triển khai thử 27/10/2026

- Đã cấu hình `mitajapanshop.duckdns.org` trong `deploy/Caddyfile`; có `scripts/start-public.ps1`, `stop-public.ps1`, `duckdns.ps1` và hướng dẫn tại `docs/duckdns-local.md`.
- Fastify public `PUBLIC_READ_ONLY=1` chỉ đưa sản phẩm `verified` ra catalog, không tạo đơn; frontend public `NEXT_PUBLIC_READ_ONLY=1` thông báo chỉ đọc. Next build dùng `.next-public` để không đè môi trường dev. Admin localhost giữ nguyên.
- TypeScript frontend/backend và 29/29 backend tests đã pass. Caddy 2.11.7 cài trên Windows; `caddy validate` pass. Production preview Next:3100, API:4100, proxy thử Caddy:8088. HTTP test xác nhận trang chủ và GET catalog 200, Admin/API nội bộ và checkout bị chặn 404. BrowserOS Neo đã mở home/danh mục qua 8088 và xác nhận route `/admin/login` bị chặn.
- PostgreSQL hiện có **122 sản phẩm `local_test_only`**, chưa có `verified`: catalog public trống theo đúng quy tắc. IP public quan sát từ máy: `160.86.229.166`, IP LAN: `192.168.24.15`. **Đã đăng nhập DuckDNS bằng `nothink1314@gmail.com`, đăng ký hostname và cập nhật IP qua API thành công**, token được mã hóa vào `.agents/runtime/duckdns.token` (ignored).
- **Production đang hoạt động:** Next localhost:3000, Fastify:4000, worker theo lịch khi bật máy, updater DuckDNS 5 phút/lần. Caddy chính từng nghe 80/443, nhưng Let's Encrypt báo `Connection refused` ở WAN trên cả hai cổng; đã dừng Caddy chính để tránh retry ACME liên tục. Gateway `192.168.24.1` có MAC thuộc Yamaha; HTTP/HTTPS quản trị không mở từ máy này, UPnP mapping không khả dụng; chưa xác minh WAN có CGNAT. Tài khoản Windows hiện tại không có quyền Administrator để chỉnh firewall.
- **Đã có HTTPS internet tạm thời:** qua Cloudflare Quick Tunnel → Caddy loopback:8088 → Next production. URL hiện tại `https://europe-groove-classified-accordance.trycloudflare.com/` (thay đổi khi tunnel khởi động lại). BrowserOS Neo đã xác nhận mở trang chủ/danh mục; HTTP GET public = 200, Admin/API nội bộ/checkout = 404. URL tạm không thay cho hostname DuckDNS.
- **Cần owner/nhà quản trị mạng:** xác minh IP WAN router và tạo port forwarding TCP 80/443 về `192.168.24.15`, cùng với Windows Firewall cho phép Caddy nhận hai cổng đó. Sau khi hoàn tất, kiểm tra cấp chứng chỉ và domain thật qua Neo. Không yêu cầu mật khẩu router hoặc token DuckDNS trong chat.
