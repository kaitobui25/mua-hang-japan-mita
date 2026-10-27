# Mita Japan — Admin MVP: Grill, triển khai, khởi chạy (27/10/2026)

## Quyết định đã chốt (Q1–Q11)
- **Q1 A:** Thêm sản phẩm bằng ASIN/link Amazon.co.jp, tạo job nhập **một ASIN**; không nhập thủ công tùy ý.
- **Q2 A:** Chỉ xem đơn `simulation_created`; không sửa trạng thái, thanh toán, vận chuyển.
- **Q3 A:** Một tài khoản owner, xác thực Admin phía server; không RBAC/nhân viên.
- **Q4 A + Q5 B:** Owner tự nhập tỷ giá JPY→VND và phụ phí %, **lưu cùng một lần**; lưu phiên bản chính sách, đơn cũ giữ snapshot. Mặc định seed 190 VND/JPY và 12%, có thể thay.
- **Q6 A:** Xóa nghĩa là ẩn/hiện lại (soft-hide); sync/reimport không tự bỏ ẩn.
- **Q7 A:** Chỉ xem trạng thái sync Amazon tự động; không có nút quét toàn danh mục.
- **Q8 A:** Chỉ cảnh báo failed/partial/needs_human/bỏ lỡ lịch trên Tổng quan; không email/SMS/push.
- **Q9 A:** Admin **localhost-only**, không mở LAN/internet.
- **Q10 A:** Chạy frontend/backend/worker **thủ công** trên Windows, không auto-start. Sync 04:00 Asia/Tokyo chỉ chạy khi máy và worker đang bật; không quét bù lúc bật lại.
- **Q11 A:** Tạo một owner qua **CLI local nhập mật khẩu kín**, không trang setup web.
- Owner yêu cầu **hỏi mọi câu còn lại trong một lượt** và **không commit Git từng câu Q&A**. Grill kết thúc đủ 11/11.

## Triển khai bằng Codex CLI
- User yêu cầu `/implement` + `/codex-cli-control`, dùng **gpt-6.1-sol, reasoning low**, clean code, dễ bảo trì/nâng cấp, tối ưu hiệu năng.
- Đã xây Admin trong ứng dụng **Next.js 15 + Fastify + PostgreSQL 18**, không tạo dự án riêng:
  1. **Tổng quan** `/admin`: thống kê đơn mô phỏng, sản phẩm, lịch sử/cảnh báo sync.
  2. **Sản phẩm** `/admin/san-pham`: tìm/lọc, ẩn/hiện, enqueue nhập ASIN/link Amazon, trạng thái job; chống SSRF/duplicate, dừng ở 403/429/CAPTCHA.
  3. **Đơn hàng** `/admin/don-hang`: danh sách/chi tiết chỉ đọc.
  4. **Cấu hình** `/admin/cau-hinh`: tỷ giá và phụ phí lưu nguyên tử, version/audit, đơn cũ không đổi.
- Auth: CLI setup/reset, scrypt hash, session cookie HttpOnly/SameSite, CSRF/Origin, giới hạn login, backend enforce loopback; worker và public catalog/checkout tôn trọng cờ ẩn.
- Code commit trên branch `main`: **`57ae2e0 feat(admin): implement local owner dashboard MVP`**, 60 file. **Bốn tài liệu Grill vẫn modified, chưa commit**: `.agents/plan/04_mita_minimal_admin_grill_with_docs_plan.md`, `GLOSSARY.md`, `docs/adr/0009-minimal-owner-admin.md`, `docs/adr/0010-admin-catalog-and-pricing-rules.md`. Không commit Q&A trong lượt tổng hợp này.
- Hướng dẫn: `docs/admin-local.md`; báo cáo kiểm thử: `docs/admin-verification.md`.

## Kiểm thử và hạn chế
- **29/29 backend tests PASS** từ terminal ngoài sandbox; backend typecheck, frontend TypeScript/lint, `git diff --check` PASS. Codex review không thấy lỗi bắt buộc sửa.
- Codex báo production build cách ly, HTTP smoke (Admin + storefront), migration lặp lại và backup/restore DB riêng đều PASS. Build thông thường từng xung đột với Next dev đang dùng `.next`; **chưa QA trực quan bằng browser sau đăng nhập**.
- Chưa xác minh quét ASIN thực tế khi Amazon thay đổi markup/chặn truy cập; không bảo đảm đồng bộ nếu máy/worker tắt. Dữ liệu Amazon `local_test_only`, cần xác minh quyền sử dụng trước khi công khai.

## Khởi động và BrowserOS Neo (phiên cuối)
- User yêu cầu restart hệ thống, mở cửa sổ **`npm run admin:setup`** để tự nhập mật khẩu, và mở Admin bằng **BrowserOS Neo MCP `http://127.0.0.1:9010/mcp`**.
- Đã dừng đúng các tiến trình Mita cũ, chạy `./scripts/start-local.ps1`: PostgreSQL **5433**, API **4000**, web **3000**, worker được khởi chạy; API health và `/admin/login` HTTP 200.
- Đã mở terminal local tương tác để owner tự nhập mật khẩu. Sau đó kiểm tra DB thấy **1 owner**; không đọc/lưu/chia sẻ mật khẩu.
- Đã kết nối BrowserOS Neo MCP, mở **tab 2** tại `http://127.0.0.1:3000/admin/login`; snapshot xác nhận form mật khẩu và nút Đăng nhập. **Chưa xác nhận đăng nhập thành công hoặc màn Tổng quan**, cần người dùng tự nhập mật khẩu trong Neo.
- Ở lượt tổng hợp này, cổng **3000, 4000, 5433, 9010** vẫn đang LISTENING (không khẳng định worker vẫn hoạt động nếu chưa kiểm tra PID riêng).

## Nếu tiếp tục
- Dùng **BrowserOS Neo** tab Admin đang mở để người dùng tự đăng nhập và QA UI/luồng Admin sau login (không yêu cầu gửi mật khẩu trong chat).
- Nếu cần kiểm tra worker/sync, đọc logs `.agents/runtime/` và DB `sync_runs/sync_errors`; không suy đoán lần quét 04:00 đã chạy.
- Giữ nguyên bốn docs Grill chưa commit cho đến khi owner có chỉ đạo khác.
