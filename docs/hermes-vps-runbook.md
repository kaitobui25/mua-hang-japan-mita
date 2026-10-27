# Mita Japan — vận hành production trên VPS Hermes

**Triển khai thực tế:** 27/10/2026 (JST). **Domain:** `https://mitajapanshop.duckdns.org/` → `217.142.225.255`. **Plan và quyết định:** `.agents/plan/06_mita_hermes_vps_postgresql_grill_plan.md`.

## Sơ đồ dịch vụ

```text
Khách internet
  → HTTPS mitajapanshop.duckdns.org → Hermes:443/Caddy
  → Next.js standalone          127.0.0.1:3100 (mita-web.service)
  → Fastify                     127.0.0.1:4100 (mita-api.service)
  → PostgreSQL 16               127.0.0.1:5432 (database mita)

PC Windows (chỉ khi owner khởi động thủ công)
  → worker Node/TypeScript + BrowserOS Neo 127.0.0.1:9010
  → SSH outbound 22             127.0.0.1:15432 → VPS:127.0.0.1:5432

E-KAIWA giữ nguyên: ekaiwa.duckdns.org → Caddy → 127.0.0.1:7860
```

Trên VPS: Ubuntu 24.04, **giữ VPS 1 GiB RAM**, Node `v22.23.4` riêng ở `/opt/mita/node22/bin/node`; `/usr/bin/node` của hệ thống vẫn `v18.19.1`. PostgreSQL 16 (cluster `16/main`) chỉ listen `127.0.0.1:5432`, preset `shared_buffers=32MB`, `max_connections=20`, `work_mem=1MB`, autovacuum 1 worker, `jit=off`. Config nằm tại `/etc/postgresql/16/main/conf.d/90-mita-lowmem.conf`. **Không mở 3100/4100/5432/9010 ra internet.**

`mita-web.service` giới hạn memory 256 MiB và Node heap 192 MiB; `mita-api.service` giới hạn 180 MiB và heap 128 MiB. PostgreSQL và hai dịch vụ Next/Fastify cùng chia sẻ RAM với E-KAIWA, Hermes Gateway và cron trading; nếu OOM, swap I/O liên tục hoặc các dịch vụ cũ chậm đi thì **dừng Mita trước**, không nâng VPS hoặc dừng E-KAIWA trái yêu cầu owner.

Website giai đoạn 1 là **public read-only**: Caddy chỉ cho API đọc catalog, chặn `/admin`, `/api/admin`, `/thanh-toan`, các API riêng, POST checkout; backend còn tắt checkout. Admin chỉ mở qua SSH về localhost. `rights_status=local_test_only` **không được công bố**; sau migration có 122 sản phẩm loại này nên khách nhìn thấy **0 sản phẩm**, đúng theo kiểm soát quyền nội dung.

## Khởi động / dừng worker trên PC (thủ công)

Chạy PowerShell trong repo trên PC **khi muốn giữ lịch quét 04:00 Asia/Tokyo**; cửa sổ launcher phải tiếp tục mở đến giờ quét. Không cài Windows service, không tạo Task Scheduler và **không chạy worker thứ hai**.

```powershell
./scripts/start-vps-worker.ps1
# Ở một PowerShell khác, dừng CHỈ worker/tunnel có PID do script quản lý:
./scripts/stop-vps-worker.ps1
```

Script dùng SSH key Hermes **đã nạp vào Windows ssh-agent** và strict host checking; không đọc hoặc hiển thị private key. Nếu agent chưa có key, owner tự chạy `ssh-add "$env:USERPROFILE\.ssh\oracle_20260624"` trong terminal cá nhân và nhập passphrase tại đó. `MITA_VPS_DATABASE_URL` được lưu **DPAPI chỉ tài khoản Windows này giải mã được** ở `.agents/runtime/mita-vps-database-url.dpapi` (gitignored). Script từ chối tunnel lạ chiếm 15432 và kiểm tra thật `SELECT 1` trên VPS trước khi chạy worker.

**Cảnh báo:** nếu PC tắt/ngủ/SSH mất lúc 04:00 JST thì lần quét đó **không được tự chạy bù**. Khi Amazon trả HTTP 403/429/CAPTCHA hoặc yêu cầu xác minh, worker ghi `needs_human`/dừng theo quy tắc hiện tại; không dùng Neo để vượt kiểm soát. Worker không chạy trên VPS.

## Admin an toàn trên PC

Từ PC, khi không có tiến trình dùng cổng 3100, mở tunnel riêng (terminal giữ chạy):

```powershell
ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes `
  -L 127.0.0.1:3100:127.0.0.1:3100 ubuntu@217.142.225.255
```

Mở **`http://127.0.0.1:3100/admin/login`** trên **chính PC**. Truy cập login qua tunnel đã được kiểm chứng HTTP 200; session chưa xác thực trả 401. Caddy public không forward Admin. Không thay đổi `trustProxy`, không allow Origin tùy ý. Port local 3100 phải được giữ đúng vì API hiện xác minh Origin `127.0.0.1:3100` khi ghi Admin.

## Kiểm tra production và xử lý sự cố

Tại PowerShell PC:

```powershell
curl.exe -I https://mitajapanshop.duckdns.org/
curl.exe -I https://ekaiwa.duckdns.org/
node scripts/test-vps-smoke.mjs --live-dns --check-http-redirect --requests-per-stage 100
node --test scripts/test-vps-selftest.mjs
# Chỉ dùng khi thật sự cần đặt lại A record VPS; script từ chối tự phát hiện IP PC:
./scripts/duckdns.ps1 -Ip 217.142.225.255
```

Kiểm tra VPS qua helper `/skills/hermes-vps` hoặc SSH `ubuntu@217.142.225.255`:

```bash
systemctl is-active caddy ekaiwa mita-web mita-api postgresql@16-main
systemctl --user is-active hermes-gateway.service
free -m; vmstat 1 3
ss -tln | grep -E ':(3100|4100|5432|443)[[:space:]]'
sudo -n journalctl -u mita-web.service -n 30 --no-pager
sudo -n journalctl -u mita-api.service -n 30 --no-pager
sudo -n caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo -n -u postgres psql -d mita -X -c 'SELECT rights_status,count(*) FROM products GROUP BY 1;'
```

Caddy **site Mita** là `/etc/caddy/mita.caddy`, được import vào `/etc/caddy/Caddyfile` hiện phục vụ E-KAIWA. Catch-all cổng 443 trả 421 cho Host giả, không cho phép chui qua Admin. Khi chỉnh file phải `caddy validate` rồi `systemctl reload caddy`, thử lại **cả hai tên miền**; không ghi đè site E-KAIWA. Chạy song song Next/API mới dưới release `/opt/mita/releases/<release-id>/`, chỉ chuyển symlink `/opt/mita/current` sau khi build và smoke test thành công. Web artifact nên build trên Ubuntu Linux x64 với Node>=22.12 như `deploy/mita/build-web-release.sh`; không dùng Windows `node_modules` để chạy trên VPS. Bản đầu đã được smoke-test với Next standalone code build trên PC và `npm ci --omit=dev` trên Linux.

Để giảm RAM, **build frontend và backend trước khi upload**; không chạy `next build` trên Hermes 1 GiB. Backend build `cd backend; npm run build`, web bundle `npm run build:release:linux` trên Linux runner. Release app API ở `/opt/mita/current/api/dist/server.js`; JS build runtime không cần `tsx` trên VPS. Không tự nâng Node hệ thống hoặc restart Hermes Gateway.

## Nghiệm thu ngày 27/10/2026

- Public DNS A về `217.142.225.255`; HTTPS certificate hợp lệ (curl `ssl_verify_result=0`), trang chủ, danh mục, API trả 200; Admin và checkout 404. **BrowserOS Neo MCP** mở thực tế trang chủ và `/san-pham` qua HTTPS thành công.
- Live public QA **63/63 PASS** (HTTPS redirect, quyền content, forged Host, private routes, E-KAIWA trong/ngoài tải). Thử lại **100 request mỗi mức 1/5/10/19 khách đồng thời** trên HTTPS thật, p95 mức 19 = **401 ms**, 0 lỗi; kiểm thử E-KAIWA trước/trong/sau đều PASS. Canary nội bộ 100 request mỗi mức: p95 mức 19 = 1175 ms, 0 lỗi; OOM=0, snapshot `vmstat` swap-in/out=0.
- PostgreSQL migrated bằng **direct transaction** từ PC: 122 `products` (`local_test_only`), 371 `price_observations`, 4 `sync_runs`, 3 `orders` (mô phỏng), 4 `order_items`, 1 `admin_accounts`; các bảng được đối chiếu số hàng trước commit, không làm thay đổi DB nguồn. Worker PC và SSH tunnel hoạt động với PostgreSQL VPS.
- Chạy đủ **29/29 backend tests**, 9/9 QA selftests, frontend typecheck, backend build. Node18 hệ thống và E-KAIWA không thay đổi.

## Không backup, giới hạn hiện tại

Theo quyết định owner: **không lập lịch hoặc tạo backup**; không có khả năng khôi phục dữ liệu mới nếu VPS/đĩa/DB hỏng. Thư mục dữ liệu local cũ vẫn còn sau migration nhưng **không đồng bộ** và **không phải backup** của production. Không chạy `migrate-vps.ps1 -Apply` lần thứ hai: đây chỉ là tiện ích chuyển ban đầu và từ chối bảng target đã có dữ liệu.

Checkout vẫn đóng và danh mục hiện rỗng vì quyền nội dung chưa verified. Lịch scrape chỉ chạy khi worker PC và SSH tunnel đang được bật thủ công; lần quét lúc 04:00 JST tiếp theo **chưa được chứng minh thành công**, phải kiểm tra `sync_runs` sau thời điểm đó. Việc chạy tải 19 người trong vài vòng không chứng minh chắc chắn độ ổn định 24/7; cần theo dõi lâu dài RAM/swap/OOM, PostgreSQL connection và E-KAIWA.
