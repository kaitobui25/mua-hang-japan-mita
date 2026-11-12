# 07 — Mita Japan: khắc phục Workers API, đưa bản tính năng vào app và sửa giao diện WinForms (02/11/2026)

> **Nhật ký lịch sử, không phải trạng thái runtime vĩnh viễn.** Khi tiếp tục, phải kiểm tra lại code/Git, API, PostgreSQL, Supervisor, tiến trình Desktop và `AGENTS.md` trước thao tác. Thông tin dưới đây ghi nhận đúng phạm vi đã thực hiện trong session; không suy ra đã kiểm thử Owner thực tế hoặc đã cập nhật VPS.

## 1. Yêu cầu người dùng và thay đổi phạm vi

1. Người dùng cung cấp màn Workers báo `completed`, cập nhật `2026-11-01T20:00:29.521Z`, lịch JST 05:00, đường dẫn bốn nhật ký, và cảnh báo **“API Workers chưa sẵn sàng: mọi thao tác ghi bị khóa”**; ban đầu yêu cầu **chỉ điều tra, không sửa code**.
2. Sau kết luận điều tra, người dùng đổi yêu cầu thành **“tao không cần biết mày làm sao. tao cần app chạy được”**, qua connector Chat On Steroids Core `mana-phong`. Từ đó cho phép tiến hành sửa/tích hợp để app hoạt động; bước kiểm tra ban đầu không còn là giới hạn `chỉ đọc` cho các bước sau.
3. Người dùng gửi ảnh thật của tab Workers (giao diện có JSON thô `nextRun`, `logPath`, `nextActions`, đường dẫn dài, nút bị cắt chữ), yêu cầu **`/hallmark fix giao diện`**. Thực hiện redesign tab Workers WinForms, không thay logic worker hoặc VPS.
4. Cuối session: yêu cầu tổng hợp và ghi vào `.agents/chatgtplog` (tài liệu này).

## 2. Điều tra lỗi `completed` và API Workers

- Repository Windows chính: `C:\phong\AI\web\mita-japan\mua-hang-japan-mita`; workdir connector `/ai/web/mita-japan/mua-hang-japan-mita`.
- Trước tích hợp, `main` ở `c41642d` chỉ chứa UI Workers, chưa có `GET /api/admin/workers`, `PUT /api/admin/workers/settings`, `POST /api/admin/workers/run`; backend hoàn chỉnh ở nhánh `feat/mita-workers-control`, HEAD `d91febe`. Kiểm tra API sống: `/api/health` HTTP **200**, `/api/admin/workers` HTTP **404**. Do đó UI đọc snapshot nhưng không thể lấy chỉ số/setting xác thực và chủ động khóa ghi.
- Log `names.out.log` cho lượt 05:00 JST 02/11: **0 tên cập nhật, 0 lỗi tên**; concise titles `{ saved: 0, deferred: 1 }`, `Name translation finished: { translated: 0, failed: 0, skipped: 0, paused: false }`. `completed` có nghĩa lượt chạy đã kết thúc, **không** phải đã dịch thêm sản phẩm.
- Snapshot ngày 02/11 JST: Amazon `skipped` khoảng 04:06; tên `completed` khoảng 05:00; chi tiết `completed` khoảng 06:10; VPS sync `partial`. Đồng bộ có `SYNC_COMMIT_OK` với gallery còn partial; không được gán `partial` là thất bại toàn bộ.
- Bản ghi snapshot không xác minh tiến trình đang sống; số liệu phải lấy từ DB. Khi chưa đủ bằng chứng, ghi `unknown`, không bịa số lượng.

## 3. Tích hợp tính năng Workers vào app chính

- Kiểm tra backend ở `127.0.0.1:4000` đang dùng `tsx watch`, Supervisor `127.0.0.1:19978` tự theo dõi code worker; local PostgreSQL `127.0.0.1:5433/postgres`, role `mita_local`, dung lượng tại preflight **26 MB**. Phát hiện chưa có schema `codex_name_runs` và `worker_control_settings`; advisory lock worker kiểm tra không bận.
- Trước migrate, tạo backup custom PostgreSQL **`.agents/runtime/mita-workers-before-live-20261102-160339.dump`** (private/ignored), **2.027.140 byte**, SHA-256 `0264A3157308A81456631E02A746BF3DD648975B5CC1181C774A1CE2ECF7B2A0`. **Khôi phục thử thành công vào DB tạm**, kiểm tra có **832 products**, sau đó dọn DB tạm (exit 0).
- Áp dụng **hai SQL additive** riêng trên local DB trong transaction: `backend/src/db/codex-names.sql` và `backend/src/db/workers-control.sql`, kiểm tra `to_regclass` và bản ghi settings `id=1` đều hợp lệ. Không chạy migration tổng và **không migrate VPS**. Default được xác minh: engine `openrouter`, giờ JST Amazon `04:00`, tên `05:00`, chi tiết `05:15`.
- Merge `feat/mita-workers-control` vào `main`; chỉ có conflict tài liệu `docs/mita-desktop.md`, đã gộp nội dung giữ đầy đủ quyền Owner/cảnh báo. Merge commit **`4b72917 Merge branch 'feat/mita-workers-control'`**.
- Sau merge, backend tự nạp code; `/api/admin/workers` chuyển từ HTTP **404** thành **401 khi không đăng nhập** (endpoint tồn tại, bảo vệ phiên). Gọi read-only `workerOverview()` trên DB thật thành công, cho ra: **832/832** sản phẩm có tên Việt theo tiêu chí API, **5.178/12.701** mục/slot chi tiết có bản dịch; Amazon `skipped`, names và detail `completed`, sync `partial`. Đây là **coverage toàn bộ DB**, không phải sản lượng lượt 05:00; cũng không chứng minh chất lượng ngữ nghĩa.
- Supervisor cũ được xác thực PID, không có lock bận, yêu cầu cooperative stop bằng `.agents/runtime/mita-supervisor.stop`, chờ xác nhận cổng đóng, khởi động lại bằng `scripts/start-mita-supervisor.ps1`. Supervisor mới PID **46316** (tại thời điểm kiểm tra), tự khởi động ba worker, không restart PostgreSQL/gateway hay thực hiện VPS sync thủ công.
- Kiểm tra giao thức Supervisor `Status` OK; `RunWorker` **không có cookie Owner** bị từ chối `Owner session cookie required.` (không phát động worker). Backend typecheck và static test OK; `npm test --prefix backend` trên DB disposable **243/243 PASS**, exit 0. Không chạy thủ công có xác thực Owner thật.

## 4. `/hallmark`: sửa giao diện tab Workers WinForms

**Ảnh lỗi người dùng cung cấp:** giao diện đen, phần trên lặp hai tiêu đề `Workers`; trạng thái `skipped/completed/partial` nguyên tiếng Anh; raw JSON `nextRun`, `logPath`, `nextActions`; danh sách các đường dẫn C:\ dài chiếm màn hình; các input và nút `Lưu lịch và engine` chen nhau và bị cắt chữ.

Đã chỉnh hẹp phạm vi UI, giữ API, lịch, quyền Owner và logic an toàn:

- `scripts/mita-desktop-workers.ps1`: bố cục mới native WinForms, palette tập trung, cột trái 4 worker trạng thái tiếng Việt và coverage, cột phải số liệu tổng/tiến độ, lần cập nhật, lịch chạy kế tiếp **JST** và thông tin kết quả. Định dạng timestamp chuyển từ UTC ISO sang JST dễ đọc.
- Không còn đổ thẳng raw JSON và đường dẫn log tuyệt đối lên trang chính. Chỉ hiển thị đường dẫn log tương đối gọn, nội dung có ích, kết quả Codex, cảnh báo ASIN giới hạn hiển thị. `completed` vẫn phân biệt với số tên dịch mới, không suy ra tiến trình đang sống.
- Form điều khiển ba trường **Engine dịch tên / Giờ chạy JST / Số SP chạy tay** và hai nút **Lưu thay đổi / Chạy ngay** có đủ diện tích. Sync chỉ qua tab **Cổng** và không mở nút chạy/lưu tại Workers. Khi `Staff`, mất CSRF, chưa có API hoặc đang pending, nút bị khóa. Refresh xóa số liệu API đã cũ trước khi lấy lại, tránh enable nhầm.
- Ở cửa sổ nhỏ, vùng chi tiết và form điều khiển cùng cuộn; cửa sổ rộng/trung bình giữ form cố định bên dưới. Thanh tiến độ màu chủ đạo do Panel WinForms vẽ thay `ProgressBar` mặc định; không tự coi số chưa xác định là 0% hoàn tất.
- `scripts/mita-desktop.ps1`: bỏ nhãn `Workers` trùng do layout shell thêm vào trước đó; giữ các tab khác không đổi.
- `scripts/test-mita-desktop-workers-window.ps1`: smoke test GUI WinForms thật, **synthetic screen data** và `DrawToBitmap`; **không gửi login, PUT/POST API, chạy worker hoặc sync**. Chụp ảnh ignored/private trong `.agents/runtime/workers-ui-{wide,medium,minimum,sync}.png`. Test đã qua 4 trường hợp `1850×768` (Amazon), `1366×768` (Tên), `900×600` (Chi tiết), `1100×700` (Sync); xác minh không chồng/cắt controls, hỗ trợ cuộn và khóa write theo trạng thái Owner/Staff/CSRF/API.
- `scripts/test-mita-desktop-workers-static.ps1` PASS (PowerShell 5.1 parser + UTF-8 BOM), `scripts/test-mita-desktop-ports-static.ps1` PASS, `git diff --check` PASS. Hallmark dựa trên nguyên tắc thiết kế và kiểm tra WinForms; **không tuyên bố CSS sloplint đạt** vì target là native PowerShell/WinForms, không phải web/CSS.
- UI đã commit vào `main` bằng **`5248476 fix(desktop): redesign Workers status and controls`**, gồm đúng 3 file UI và GUI smoke test mới. Không push/deploy.

## 5. Runtime cuối session và các giới hạn xác minh

- Sau thời gian test GUI, backend `4000` không còn listen. `scripts/mita-backend-control.ps1 -Action Status` báo `stopped`; đã khởi động lại **bằng chính helper quản lý**: `-Action Start -Mode Dev -SessionId workers-ui-20261102`, trả `State=ready`, `Started=True`; `/api/health` HTTP **200**, `/api/admin/workers` HTTP **401 không có phiên**. Lần kiểm tra gần nhất cổng `4000` PID **40572**, cổng `19978` PID **46316**, DB `5433` PID **35080**. PID và trạng thái chỉ là snapshot cần kiểm tra lại khi tiếp tục.
- Có cửa sổ Desktop đang mở PID **51952**, khởi động **16:38:11 JST**, trước lần chỉnh file UI cuối lúc **16:39:51 JST**. **Cửa sổ đó phải được đóng và mở lại** qua `scripts/start-mita-desktop.bat` để tải code/UI mới. Không tự kill phiên Desktop hiện có (tránh mất trạng thái đăng nhập).
- **Chưa thực hiện E2E Owner đăng nhập thật, thao tác Save hoặc Run** bằng token Owner đang hoạt động; smoke dùng dữ liệu mô phỏng. Không khẳng định số 832/832 đánh giá được chất lượng dịch, hoặc `completed` chứng minh job đã dịch thêm.
- Không thực hiện VPS migration, tunnel, sync thủ công, force replay, git push hay release production. Nếu dự định bật revision-aware VPS title sync, phải kiểm tra VPS schema cần `name_revision`, `name_generation`, `name_model` và bước migration riêng với phê duyệt/backup theo `AGENTS.md`.
- Những file untracked đã có từ trước **được giữ nguyên**: `.agents/chatgtplog/06_mita_codex_translation_scale_seo_p2_audit_tong_hop_20261102.md`, `.agents/plan/14_mua_ho_amazon_grill_20261030.md`, `15_mita_vps_full_site_seo_audit_plan_20261102.md`, `17_mita_desktop_workers_grill_20261102.md`, `reports/`. File 06 này không được tự add/commit trong session.

## 6. Hướng tiếp tục chính xác

- Mở lại app Desktop để xác minh UI mới trên cửa sổ đang dùng; đăng nhập Owner do người dùng thực hiện, kiểm tra endpoint Workers xác thực và tính năng cấu hình/khóa quyền. Khi có thao tác ghi thật, dùng xác nhận của app và không chạy worker lúc có lock/sync.
- Nếu có lỗi mới: xem đúng nguồn hiện tại (`/api/health`, Owner API, Supervisor, `workerOverview` DB, lịch JST) và phân biệt snapshot, coverage DB, last run, process-live; không lặp kết luận cũ một cách máy móc.
- Bản ghi này chỉ là tài liệu tổng kết, **không cấp thêm quyền** deploy/migrate/force sync. Mọi thay đổi trạng thái cần kiểm tra `AGENTS.md` và phép của người dùng.
