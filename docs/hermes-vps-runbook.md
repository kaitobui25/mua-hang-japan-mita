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
  → worker Node/TypeScript + Python Scrapling/BeautifulSoup
  → SSH outbound 22             127.0.0.1:15432 → VPS:127.0.0.1:5432

E-KAIWA giữ nguyên: ekaiwa.duckdns.org → Caddy → 127.0.0.1:7860
```

Trên VPS: Ubuntu 24.04, **giữ VPS 1 GiB RAM**, Node `v22.23.4` riêng ở `/opt/mita/node22/bin/node`; `/usr/bin/node` của hệ thống vẫn `v18.19.1`. PostgreSQL 16 (cluster `16/main`) chỉ listen `127.0.0.1:5432`, preset `shared_buffers=32MB`, `max_connections=20`, `work_mem=1MB`, autovacuum 1 worker, `jit=off`. Config nằm tại `/etc/postgresql/16/main/conf.d/90-mita-lowmem.conf`. **Không mở 3100/4100/5432/9010 ra internet.**

`mita-web.service` giới hạn memory 256 MiB và Node heap 192 MiB; `mita-api.service` giới hạn 180 MiB và heap 128 MiB. PostgreSQL và hai dịch vụ Next/Fastify cùng chia sẻ RAM với E-KAIWA, Hermes Gateway và cron trading; nếu OOM, swap I/O liên tục hoặc các dịch vụ cũ chậm đi thì **dừng Mita trước**, không nâng VPS hoặc dừng E-KAIWA trái yêu cầu owner.

Website là **public read-only**: Caddy chỉ cho API đọc catalog, chặn `/admin`, `/api/admin`, `/thanh-toan`, các API riêng, POST checkout; backend vẫn tắt checkout. Admin chỉ mở qua SSH về localhost. **Owner đã thay đổi chính sách công bố ngày 27/10/2026:** mục Admin → Cấu hình → **Ẩn sản phẩm local_test_only**, mặc định **OFF** (công bố `local_test_only` và `verified`); **ON** chỉ công bố `verified`. Trường `rights_status` trong `products` **không bị sửa**. Nhóm `unverified` và sản phẩm `admin_hidden_at IS NOT NULL` luôn bị ẩn. Việc OFF không chứng minh quyền sử dụng ảnh/nội dung Amazon.

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

Ở **Admin → Cấu hình**, switch *Ẩn sản phẩm local_test_only* lưu tức thì vào bảng singleton `catalog_settings` trong PostgreSQL VPS (có version kiểm soát sửa đồng thời và `admin_audit_events`). **OFF (mặc định)** hiện dữ liệu Amazon đã quét trên site; **ON** ẩn sản phẩm này, không xóa dữ liệu. Không cần restart khi đổi switch. Chỉ dùng Admin qua tunnel và phải đăng nhập owner. Không thay đổi `PUBLIC_READ_ONLY=1`: checkout luôn bị chặn.

## Kiểm tra production và xử lý sự cố

Tại PowerShell PC:

```powershell
curl.exe -I https://mitajapanshop.duckdns.org/
curl.exe -I https://ekaiwa.duckdns.org/
node scripts/test-vps-smoke.mjs --live-dns --allow-local-test-only --check-http-redirect --requests-per-stage 100
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
sudo -n -u postgres psql -d mita -X -c 'SELECT version,hide_local_test_only FROM catalog_settings WHERE id=1;'
```

Caddy **site Mita** là `/etc/caddy/mita.caddy`, được import vào `/etc/caddy/Caddyfile` hiện phục vụ E-KAIWA. Catch-all cổng 443 trả 421 cho Host giả, không cho phép chui qua Admin. Khi chỉnh file phải `caddy validate` rồi `systemctl reload caddy`, thử lại **cả hai tên miền**; không ghi đè site E-KAIWA. Chạy song song Next/API mới dưới release `/opt/mita/releases/<release-id>/`, chỉ chuyển symlink `/opt/mita/current` sau khi build và smoke test thành công. Web artifact nên build trên Ubuntu Linux x64 với Node>=22.12 như `deploy/mita/build-web-release.sh`; không dùng Windows `node_modules` để chạy trên VPS. Bản đầu đã được smoke-test với Next standalone code build trên PC và `npm ci --omit=dev` trên Linux.

Để giảm RAM, **build frontend và backend trước khi upload**; không chạy `next build` trên Hermes 1 GiB. Backend build `cd backend; npm run build`, web bundle `npm run build:release:linux` trên Linux runner. Release app API ở `/opt/mita/current/api/dist/server.js`; JS build runtime không cần `tsx` trên VPS. Không tự nâng Node hệ thống hoặc restart Hermes Gateway.

## Nghiệm thu ngày 27/10/2026

- Public DNS A về `217.142.225.255`; HTTPS certificate hợp lệ (curl `ssl_verify_result=0`), trang chủ, danh mục, API trả 200; Admin và checkout 404. **BrowserOS Neo MCP** mở thực tế trang chủ và `/san-pham` qua HTTPS thành công.
- Live public QA **63/63 PASS** (HTTPS redirect, quyền content, forged Host, private routes, E-KAIWA trong/ngoài tải). Thử lại **100 request mỗi mức 1/5/10/19 khách đồng thời** trên HTTPS thật, p95 mức 19 = **401 ms**, 0 lỗi; kiểm thử E-KAIWA trước/trong/sau đều PASS. Canary nội bộ 100 request mỗi mức: p95 mức 19 = 1175 ms, 0 lỗi; OOM=0, snapshot `vmstat` swap-in/out=0.
- PostgreSQL migrated bằng **direct transaction** từ PC: 122 `products` (`local_test_only`), 371 `price_observations`, 4 `sync_runs`, 3 `orders` (mô phỏng), 4 `order_items`, 1 `admin_accounts`; các bảng được đối chiếu số hàng trước commit, không làm thay đổi DB nguồn. Worker PC và SSH tunnel hoạt động với PostgreSQL VPS.
- Chạy đủ **29/29 backend tests**, 9/9 QA selftests, frontend typecheck, backend build. Node18 hệ thống và E-KAIWA không thay đổi.

## Cập nhật catalog switch ngày 27/10/2026

- Đã tạo release `/opt/mita/releases/20261027-localtest-toggle` và chuyển `/opt/mita/current` đến release này. PostgreSQL được bổ sung bảng `catalog_settings` (owner `mita_app`, `version=1`, `hide_local_test_only=false`), **không sửa `rights_status` của 122 hàng hiện có** và không backup.
- Public API `/api/catalog` đã trả **122 sản phẩm** khi OFF (hiện tất cả là `local_test_only`); checkout vẫn `canCheckout=false`. Admin/checkout public vẫn 404; TLS và E-KAIWA hoạt động. **65/65 public QA PASS**, benchmark 100 request/tầng 1/5/10/19 khách, p95 mức 19 **399ms**, lỗi 0; 30/30 backend tests và 10/10 QA selftests PASS.
- Trường hợp ON, chạy QA mặc định (chỉ `verified`); trường hợp OFF, thêm `--allow-local-test-only`. Đây là công tắc công bố nội dung, **không phải xác minh bản quyền**. Nguồn/ảnh/mô tả Amazon phải đáp ứng quyền sử dụng và điều khoản tương ứng; không tự đổi status thành `verified`.

## Không backup, giới hạn hiện tại

### CI/CD bằng commit `[deploy]` (thiết lập từ 27/10/2026)

Mô tả sử dụng và giao thức SSH giới hạn quyền xem `deploy/mita/ci-deploy.md`. `release.json` là nguồn version hiển thị cuối footer; hiện là `0.3`. Chỉ khi push lên `main` với **HEAD commit message chứa `[deploy]`** thì GitHub Actions mới test/build artifact Linux x64 và đẩy xuống VPS. Commit khác không thay đổi VPS; không có commit tự động đưa cờ về 0. `workflow_dispatch` chỉ build để thử nghiệm. Hệ thống CI **không chạy migration DB tự động**, không đụng E-KAIWA hoặc Caddy. Trước khi dùng production, phải xác minh chạy build-only thành công, đăng ký key CI giới hạn bằng forced SSH command và thêm đúng ba repo secrets; nếu không có secrets thì job deploy sẽ thất bại an toàn.

Ngày 27/10/2026: thử GitHub Actions build-only thành công trên Ubuntu và chuyển thủ công **chính artifact đó** qua forced SSH gate để nghiệm thu receiver, public footer hiện `v0.3`. **Cả ba GitHub secrets `MITA_DEPLOY_SSH_KEY`, `MITA_DEPLOY_HOST`, `MITA_DEPLOY_KNOWN_HOSTS` đã được xác nhận tồn tại lúc 18:02 JST.** Kiểm tra deploy thực tế từ GitHub Actions ở từng workflow run; có secret chưa đồng nghĩa có thể bảo đảm deploy thành công.

**Nghiệm thu deploy tự động:** commit `eca2fa1bfa9d` có `[deploy]` được push lên `main`, GitHub Actions run [40478008591](https://github.com/kaitobui25/mua-hang-japan-mita/actions/runs/40478008591) hoàn thành **success** sau 1 phút 59 giây, bao gồm bước SSH deploy. VPS `/opt/mita/current` trỏ đến `/opt/mita/releases/v0.3-eca2fa1bfa9d`, `release-info.json` ghi đúng commit và version `0.3`; Mita/E-KAIWA HTTP 200, API khỏe, catalog 122 sản phẩm, Admin/checkout public giữ chặn như receiver kiểm tra. Commit tài liệu sau nghiệm thu không có `[deploy]` để tránh redeploy không cần thiết.


Theo quyết định owner: **không lập lịch hoặc tạo backup**; không có khả năng khôi phục dữ liệu mới nếu VPS/đĩa/DB hỏng. Thư mục dữ liệu local cũ vẫn còn sau migration nhưng **không đồng bộ** và **không phải backup** của production. Không chạy `migrate-vps.ps1 -Apply` lần thứ hai: đây chỉ là tiện ích chuyển ban đầu và từ chối bảng target đã có dữ liệu.

Checkout vẫn đóng. Catalog hiện có 122 sản phẩm công khai do owner chủ động chọn OFF; trạng thái quyền vẫn `local_test_only`. Lịch scrape chỉ chạy khi worker PC và SSH tunnel đang được bật thủ công; lần quét lúc 04:00 JST tiếp theo **chưa được chứng minh thành công**, phải kiểm tra `sync_runs` sau thời điểm đó. Việc chạy tải 19 người trong vài vòng không chứng minh chắc chắn độ ổn định 24/7; cần theo dõi lâu dài RAM/swap/OOM, PostgreSQL connection và E-KAIWA.

### Scrapling adapter prerequisite

Before starting the PC tunnel worker, run `scripts/setup-scrapling.ps1`, then `scripts/check-scrapling.ps1`. Collection uses the repo virtualenv (Scrapling 0.5 + BeautifulSoup 4.15.0), with no Python DB credentials. BrowserOS Neo is no longer a collection dependency; the owner can explicitly open a blocked page for manual verification. Existing Amazon blocks are never cleared by setup/startup. See `backend-architecture.md` for limits, offline tests and the full-gallery schema upgrade. This collector remains Windows PC only; no VPS collector deployment.
