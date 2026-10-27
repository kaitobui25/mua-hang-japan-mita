# 06 — Mita Japan: Hermes VPS + PostgreSQL trên VPS, collector ở PC (Grill Me)

**Ngày:** 2026-10-27 (JST)

**Trạng thái:** `deployed_and_verified` — owner đã cho phép triển khai trong lượt tiếp theo, đã chạy trên Hermes 27/10/2026; dữ liệu public chỉ đọc và catalog đang trống do chưa verified. Xem `docs/hermes-vps-runbook.md`.

**Yêu cầu ban đầu của vòng Grill Me:** nghiên cứu PostgreSQL ít RAM, clean code, dễ bảo trì/nâng cấp, tối ưu hiệu năng. **Giai đoạn nghiên cứu trước không chỉnh code/VPS; user sau đó đã yêu cầu triển khai thật bằng nhóm 5 người.**

**Quyết định owner ngày 27/10/2026 (không hỏi lại):** Q1 **A: giữ VPS 1 GiB, nếu không đạt thử tải thì dừng**; Q2 **không backup** (không có lịch sao lưu, bản sao ngoài VPS hay bước tạo bản sao lưu trong rollout); Q3 **A: SSH tunnel khởi động thủ công cùng worker**; Q4 **A: dưới 20 người truy cập đồng thời**. Các quyết định trước vẫn có hiệu lực: worker quét Amazon tại PC lúc 04:00 JST khi được bật; Admin không public; giai đoạn đầu public read-only và không công bố dữ liệu chưa được xác minh quyền.

## 1. Ràng buộc đã biết — không hỏi lại

- VPS Hermes `ubuntu@217.142.225.255`, Ubuntu 24.04, 2 vCPU, ~954 MiB RAM, 4 GiB swap, ~21 GiB đĩa còn trống; tại thời điểm khảo sát `MemAvailable ~315 MiB`. Caddy phục vụ `ekaiwa.duckdns.org` → Python `127.0.0.1:7860`; Hermes Gateway, E-KAIWA và các bot/trading cron đang chạy. **Không được ảnh hưởng các workload này**.
- VPS có Node `v18.19.1`; Mita backend chứa `pg-boss@^12.6.0` cần Node >=22.12; cài runtime Node 22 **riêng cho Mita**, không nâng đè `/usr/bin/node` đang được E-KAIWA dùng.
- PC Windows có PostgreSQL local `127.0.0.1:5433`, BrowserOS Neo `127.0.0.1:9010/mcp` và worker Amazon; ưu tiên HTTP, Neo fallback vì lỗi parse/JS, không dùng để vượt CAPTCHA/403/429. Hai danh mục, <=200 ASIN/danh mục/lần quét, 04:00 Asia/Tokyo khi PC/worker bật; không bù khi PC tắt. Dữ liệu hiện có 122 dòng `local_test_only`, không được tự công bố.
- Giữ `mitajapanshop.duckdns.org` cho website; không mở inbound DB/Neo trên PC hoặc VPS; không đặt Amazon scraper trên VPS. Admin trước đây yêu cầu chỉ qua localhost; rollout public đang chỉ đọc, checkout công khai bị chặn.
- Mục tiêu **một DB PostgreSQL trên Hermes**, ứng dụng web/API đọc/ghi DB loopback tại VPS và collector PC đi vào DB qua **SSH local port forwarding**, không có database đồng bộ thứ hai hay Redis.
- Owner **không muốn backup**. Đây là chấp nhận rủi ro mất vĩnh viễn dữ liệu catalog, giá, cấu hình, phiên owner, lịch sử đồng bộ và đặc biệt là đơn hàng nếu VPS/đĩa hoặc migration lỗi. Cơ chế WAL, transaction và autovacuum bảo vệ nhất quán vận hành nhưng **không thay thế backup**; rollback code không khôi phục được dữ liệu đã mất. Không tự thêm backup dưới tên gọi khác.

## 2. Kiến trúc mục tiêu

```text
Khách HTTPS → mitajapanshop.duckdns.org → 217.142.225.255 → Caddy :443
                                                                └→ Mita Next.js 127.0.0.1:3100
                                                                       └→ Mita Fastify 127.0.0.1:4100
                                                                              └→ PostgreSQL 127.0.0.1:5432
                                                                            (database riêng mita, role giới hạn)

PC Windows (khi được chủ máy bật):
  Amazon HTTP → nếu parse cần bổ sung → BrowserOS Neo tại PC → Mita worker
                                                              └→ PostgreSQL qua SSH -L 15432:127.0.0.1:5432
                                                              └→ pg-boss schedule / import queue dùng CÙNG DB

E-KAIWA: ekaiwa.duckdns.org → Caddy → 127.0.0.1:7860 (giữ nguyên)
```

Một codebase, tách riêng `api`, `web`, `worker` thành các điểm chạy phù hợp; tránh nhân bản domain logic. **Không chạy worker/scraper trong VPS** và không tạo lịch pg-boss thứ hai trên VPS. Nếu SSH rớt, worker phải fail closed, nhận biết trạng thái DB không kết nối, không ghi dữ liệu sai hoặc đánh dấu job thành công giả.

## 3. PostgreSQL ít RAM — preset KHỞI ĐIỂM, chưa áp dụng

Khuyến nghị bắt đầu với PostgreSQL **16** theo kho Ubuntu 24.04 (xác nhận package thực tế trước khi cài; PostgreSQL hiện chưa cài). Thử nghiệm cụ thể trước khi chấp nhận production:

| Hạng mục | Giá trị khởi điểm | Ý định / điều kiện chỉnh |
| --- | --- | --- |
| `listen_addresses` | `'127.0.0.1'` | Không mở cổng 5432 ra public/LAN; chỉ ssh -L và dịch vụ local |
| `shared_buffers` | `32MB` (đo rồi thử `64MB`) | VPS <1 GiB và dùng chung E-KAIWA, không áp dụng máy chuyên DB 25% RAM máy |
| `max_connections` | `20` | Phải đo pool đồng thời: Fastify, pg-boss remote, migration, admin, kết nối dự phòng; không ép quá thấp gây lỗi |
| `work_mem` | `1MB` | Tính theo mỗi phép sort/hash trên mỗi connection; tăng theo EXPLAIN và temp spill nếu đủ RAM |
| `maintenance_work_mem` | `32MB` | Hạn chế peak VACUUM/index/migration |
| `autovacuum_work_mem` | `16MB` | Giới hạn RAM mỗi autovacuum worker |
| `autovacuum_max_workers` | `1` | Giảm áp lực đồng thời khi DB nhỏ; **không tắt autovacuum** |
| `max_parallel_workers_per_gather` | `0` | Không tạo query worker cho những query catalog nhỏ |
| `max_parallel_workers` | `0` | Tránh tiến trình parallel query thêm trên 2 vCPU |
| `jit` | `off` | Tránh overhead compile cho workload truy vấn ngắn |
| `effective_cache_size` | `128MB` | Chỉ là ước lượng cache cho planner, không cấp phát RAM |
| `max_wal_size` | `256MB–512MB` (đo WAL thực tế) | Giới hạn tăng trưởng WAL, tránh checkpoint quá dày; không vô hiệu durability |
| `fsync`, `full_page_writes`, `synchronous_commit` | Giữ mặc định an toàn | **Không** đánh đổi tính toàn vẹn DB để tiết kiệm RAM |

Ngoài PostgreSQL: code `backend/src/db/pool.ts` hiện đặt `pg.Pool max=10`; instance `pg-boss` cũng mặc định pool `max=10`, vượt quá phù hợp với `max_connections=20` khi thêm API, worker và migration. Khi được phép triển khai, cấu hình **pool qua env với giới hạn rõ**, ví dụ Fastify=3–4, pg-boss ở PC=2–3, và dự phòng vài connection, kiểm nghiệm `pg_stat_activity`. Không thêm PgBouncer ngay khi chỉ hai tiến trình; thêm khi số client thực tế chứng minh cần.

**Điểm chặn tài nguyên:** Next.js + Fastify + PostgreSQL cùng với E-KAIWA/Hermes trên RAM 954 MiB có thể không đáp ứng yêu cầu. Trước production phải dựng thử bản build trên VPS, đo `MemAvailable`, swap in/out, RSS/process, OOM counters, E-KAIWA latency/health, pg query p95 trong idle và burst; đo sau 24 giờ nếu có thể. Kịch bản phục vụ **dưới 20 khách đồng thời**, chạy thử lần lượt 1 / 5 / 10 / 19 concurrent clients và để ít dư địa cho kết nối phụ; đo cả warm/cold reads và biến cố mất SSH/PC offline. Không đưa live nếu kích hoạt swap liên tục, OOM, timeout hàng loạt hoặc làm E-KAIWA xuống chất lượng. **Nếu không đạt với 1 GiB, dừng rollout và báo kết quả; không tự nâng VPS, không tắt Hermes/E-KAIWA để đạt benchmark.**

Nguồn chính: PostgreSQL 16 Resource Consumption `https://www.postgresql.org/docs/16/runtime-config-resource.html`; PG16 Connections `https://www.postgresql.org/docs/16/runtime-config-connection.html`; PG16 Authentication `https://www.postgresql.org/docs/16/auth-pg-hba-conf.html`; pg-boss `https://github.com/timgit/pg-boss` (Node >=22.12, PG >=13) và constructor docs (pool mặc định 10).

## 4. Kế hoạch triển khai sau khi owner duyệt — KHÔNG chạy trong lượt nghiên cứu

### P0 — Audit read-only và chuẩn bị bản build

1. Chụp baseline 5–15 phút của Hermes (`free`, `vmstat`, `ps`, swap, journal, Caddy/E-KAIWA/Python/Hermes latency), tác vụ trading, dung lượng và inode; xác nhận SSH/host key và quyền sudo không tương tác. Kiểm kê cấu hình Caddy và port/unit hiện hữu bằng khảo sát read-only. **Không tạo bản sao lưu**.
2. Kiểm tra PostgreSQL 16 và Node >=22 tương thích trước khi cài; chuẩn bị Node runtime riêng của Mita và build trên **PC/CI**, không `npm run build` trên VPS 1 GiB. Chỉ upload các file runtime (Next standalone + static/public; backend JS đã compile) với phiên bản và checksum.
3. Giai đoạn này **không tạo backup hoặc thử restore từ backup**. Thiết kế chuyển dữ liệu lần đầu bằng một lần truyền trực tiếp từ DB local sang DB mới trên VPS (luồng xuất/nhập một lần, không lưu file dump và không tạo lịch đồng bộ), nếu cần mang theo 122 sản phẩm, owner và lịch sử hiện hữu. Đối chiếu số hàng và khóa sau truyền; **không xóa/reset DB local trong cutover**. Định rõ rủi ro: dữ liệu mới phát sinh sau khi chuyển sang DB VPS không có bản backup.

### P1 — Thiết lập DB nhỏ, migration không phá dữ liệu

1. Chỉ sau phê duyệt và khi baseline cho phép, cài PostgreSQL 16, chỉ bind `127.0.0.1`, `pg_hba.conf` dùng `scram-sha-256`, role/database `mita` tách khỏi `postgres`, role phục vụ app và ingest có quyền tối thiểu, file secret chmod 0600. Không mở security list/iptables cổng 5432.
2. Dùng preset ít RAM ở mục 3; migrate vào DB riêng, kiểm tra số lượng bảng/index, constraints, pg-boss schema, `pg_stat_activity`, memory; không vô hiệu `autovacuum`, `fsync` hay WAL durability.
3. Khi được cho phép ở giai đoạn triển khai, chuyển dữ liệu **một lần** từ local sang database VPS qua kênh SSH an toàn, không tạo/giữ bản dump backup. Đối chiếu các bảng, `sync_runs`, audit, giá, quyền `local_test_only`, owner và số đơn; đảm bảo `rights_status` không tự nâng thành `verified`. Chỉ thực hiện migration tiến hóa, không DROP/TRUNCATE hay sửa dữ liệu phá hủy vì **không có đường khôi phục từ backup**.

### P2 — Đường kết nối PC → VPS và worker đúng vị trí

1. Dùng SSH **outbound** từ PC: ví dụ `ssh -N -L 127.0.0.1:15432:127.0.0.1:5432 ubuntu@217.142.225.255` (key đã có; không đọc/chuyển key). **Khởi động thủ công cùng worker**, với kiểm tra kết nối trước khi chạy, PID/health và thao tác dừng theo đúng các tiến trình thuộc Mita; reconnect có kiểm soát trong phiên chạy, **không** cài auto-start Windows, Scheduled Task hay daemon luôn chạy. Bảo vệ kết nối/password, không để public DB. Không chạm cổng router nhà.
2. Cấu hình `DATABASE_URL` của worker PC tới port SSH localhost 15432; BrowserOS Neo vẫn localhost 9010; phân tách `worker` khỏi server/API/Next; chỉ PC giữ cron `0 4 * * * Asia/Tokyo` và xử lý import. Không chạy worker kép.
3. Kiểm thử mất kết nối giữa transaction, retry idempotent, duplicate ASIN, queue stuck 5 phút, PC ngủ trước 04:00, parse_error/403/429/CAPTCHA; tránh job catch-up trái chính sách đã chốt.

### P3 — Đóng gói web và đưa lên Hermes không làm hỏng E-KAIWA

1. Bảo toàn `/usr/bin/node` đang phục vụ E-KAIWA (Node 18). Dùng Node22 riêng qua đường dẫn tuyệt đối trong **systemd Mita**; static assets và JS builds do PC/CI tạo ra, pin lockfile. Nên có release thư mục riêng, symlink `current` đổi atomically để rollback phiên bản.
2. Start riêng `mita-api.service` + `mita-web.service` với systemd user riêng/chạy hạn chế quyền, loopback (ví dụ 4100/3100), restart policy và memory accounting; chưa công khai DNS. Fastify chạy JS đã build thay vì TS compiler runtime, Next sử dụng standalone output nếu validation cho phép.
3. Caddy thêm site thứ hai `mitajapanshop.duckdns.org` mà **không thay đổi hành vi route `ekaiwa.duckdns.org`**. Proxy chỉ API catalog `GET/HEAD`, chặn `/admin`, `/api/admin`, `/api/health`, `/api/sync-status`, `/thanh-toan`, `POST /api/checkout`; kiểm thử Host/Origin/path escapes và security headers. Chưa mở checkout public.
4. Admin vẫn chỉ localhost. Nếu truy cập owner từ PC qua SSH forward tới web VPS: đảm bảo Next Host check và Fastify `validOrigin` phù hợp port local tunnel; port local `3300` không tự được chấp nhận theo code hiện tại (origin chỉ `WEB_PORT` hoặc `API_PORT`), phải có kế hoạch cấu hình origin **cụ thể, không nới allow-any**. Mọi truy cập Admin từ internet vẫn bị Caddy chặn.

### P4 — Canary, DNS, vận hành không backup

1. Smoke-test VPS qua hostname/Host mapping nhưng chưa đổi DNS public: trang chủ, catalog GET, chi tiết, admin blocked, checkout blocked; kiểm thử dữ liệu quyền, rate limit, tiêu thụ RAM, restart systemd, Caddy reload/validate. Chạy workload hỗn hợp 1/5/10/19 concurrent clients, kiểm thử E-KAIWA song song, lấy p95, swap I/O, OOM và postgres connection saturation. Nếu 19 clients ảnh hưởng E-KAIWA hoặc vượt ngưỡng RAM thì **STOP, không chuyển DNS**.
2. **Dừng DuckDNS updater `mitajapanshop` đang chạy trên PC trước khi đổi IP**; DuckDNS ghi A record mới cố định `217.142.225.255` riêng cho `mitajapanshop` (không đụng `ekaiwa`). Sau DNS propagation, kiểm tra Let's Encrypt cert, DNS, HTTP status thực tế qua BrowserOS Neo và mạng ngoài.
3. **Không cài backup, không đặt lịch dump, không thử restore từ backup** theo lựa chọn owner. Theo dõi free RAM/swap/OOM, DB connections, WAL/storage, worker lost tunnel, sync last success và độ trễ catalog. Không để log lộ đơn hàng/token/credential. Khi hết dung lượng, hỏng disk hoặc mất DB phải báo rõ **có thể mất dữ liệu vĩnh viễn**.
4. Rollback sự cố ứng dụng: DNS Mita về trang maintenance/đường public trước đó nếu còn dùng được, revert symlink release về code tương thích với schema, hoặc dừng site Mita riêng; **không có database rollback/restore**, không thực hiện migration phá schema/dữ liệu khi chưa có phương án an toàn và quyền riêng. Nếu database hỏng, dừng thay vì tự reset schema/owner/catalog. Giữ nguyên E-KAIWA.

## 5. Cổng kiểm nghiệm (must-pass)

- E-KAIWA/Hermes healthy trước–trong–sau; không tự dừng, nâng Node hệ thống hoặc restart unrelated services.
- Không DB port 5432 public, không Amazon HTTP request bắt nguồn từ IP Hermes, không Neo MCP internet, SSH tunnel từ Windows có auth kiểm chứng.
- DB 1 nguồn duy nhất và các transaction/queue đúng; so sánh dữ liệu trước/sau lần chuyển đầu tiên, không mất/hạ quyền owner/đơn/catalog trong migration bình thường. **Không có backup và không có nghiệm thu restore** theo quyết định owner; rủi ro mất dữ liệu khi VPS hỏng được chấp nhận có ý thức.
- Khi collector PC offline, catalog vẫn đọc được từ VPS, không tự refresh giả; hoạt động lại không tạo duplicate/catch-up trái quy tắc.
- Giữ cứng RAM 1 GiB; chạy thử 1/5/10/19 kết nối đồng thời và tải nền thực, không có sustained swap-in/out hoặc OOM ảnh hưởng dịch vụ khác. Nếu không đạt, **dừng rollout**, không nâng gói VPS hay tắt dịch vụ Hermes/E-KAIWA.
- Public chỉ dữ liệu `verified` và API read-only; các hành vi Admin được chặn từ internet.

## 6. Grill Me đã chốt — không mở thêm vòng hỏi

| Câu | Quyết định của owner | Ảnh hưởng đến plan |
| --- | --- | --- |
| Q1 | **A — VPS 1 GiB, không đạt thử tải thì dừng** | Chặn cutover khi vượt ngân sách RAM / E-KAIWA suy giảm; không đề xuất tự nâng tài nguyên |
| Q2 | **Không backup** | Bỏ tất cả bước tạo backup, lịch backup, restore-test. Rủi ro mất dữ liệu không thể khôi phục được ghi rõ; giữ migration không phá dữ liệu |
| Q3 | **A — SSH tunnel mở thủ công cùng worker** | Không chạy tunnel nền vĩnh viễn; preflight/postflight và dừng đúng tiến trình của Mita |
| Q4 | **A — dưới 20 người truy cập đồng thời** | Benchmark mục tiêu 1 / 5 / 10 / 19 clients; bảo đảm không ảnh hưởng dịch vụ sẵn có |

Tiếp tục giữ các ràng buộc cũ: SSH-only Admin từ PC, worker chỉ khi PC bật, 04:00 JST không catch-up, catalog public `verified` và read-only cho tới khi có quyết định triển khai nghiệp vụ mới. **Grill Me đã hoàn tất và phương án này đã được triển khai khi owner cấp quyền trong lượt tiếp theo.**

## 7. Kết quả triển khai thực tế — 27/10/2026 JST

- **5 luồng:** prime trực tiếp VPS/cutover, 2 Chat On Steroids subagents (Next release/QA), 2 Codex CLI (worker+SSH và audit độc lập). File triển khai/runbook: `docs/hermes-vps-runbook.md`.
- **Database:** PostgreSQL 16 `mita` nghe loopback `5432`, 32MB shared_buffers, 1MB work_mem, 20 connections; đã import từ local 122 sản phẩm, 371 lịch sử giá, 3 đơn mô phỏng, 1 owner, 4 sync runs qua SSH mà không tạo backup; không reset database local.
- **Runtime:** Node riêng `/opt/mita/node22` v22.23.4, `/usr/bin/node` giữ v18.19.1. `mita-web.service` Next standalone loopback 3100, `mita-api.service` Fastify compiled JS loopback 4100; PostgreSQL, Caddy, E-KAIWA và Hermes Gateway hoạt động.
- **Public:** `mitajapanshop.duckdns.org` A → `217.142.225.255`, Caddy trên Hermes có site Mita riêng và Host catch-all 421; HTTPS TLS hợp lệ; trang chủ, catalog, categories HTTP 200; private Admin/checkout 404; E-KAIWA HTTP 200. BrowserOS Neo thực sự mở trang chủ và `/san-pham`.
- **QA:** public 63/63 PASS, forged Host chặn, 19 clients × 100 requests p95 **401ms** lỗi 0; staging 19 clients × 100 requests p95 1175ms lỗi 0, oom_kill=0 và mẫu swap-in/out 0; E-KAIWA kiểm tra trước/trong/sau tải PASS. Backend 29/29 test, QA 9/9, typecheck và build PASS. Giới hạn 1 GiB không bị thay đổi. Caddy preview test 8089 đã dừng sau nghiệm thu.
- **PC collector:** SSH `127.0.0.1:15432` và worker `daily` đã khởi chạy thủ công, credential DPAPI gitignored; không mở port router, không host BrowserOS Neo trên VPS. Worker khi PC offline không quét và không bù lịch. Chưa có dữ liệu `verified`: public 0 sản phẩm, không tự hợp thức hóa Amazon content.
- **Không backup** đúng theo owner. Không có rollback database bằng snapshot; mất dữ liệu VPS có thể là vĩnh viễn. Cần theo dõi tải thực/cron 04:00 JST lâu dài, không coi thử tải ngắn là bảo đảm vận hành liên tục.
