# ADR 0009 — Admin tối giản cho một chủ cửa hàng

**Ngày:** 27/10/2026 (JST)
**Trạng thái:** `proposed` — chờ owner xác nhận, **chưa phải quyết định đã chốt**.
**Liên quan:** `.agents/plan/04_mita_minimal_admin_grill_with_docs_plan.md`, ADR 0001–0008.

## Bối cảnh

Mita đã có website bán hàng thử nghiệm, catalog và đơn hàng mô phỏng; chưa có trang quản trị. Owner mới quản lý website nên cần thấy rõ tình trạng và xử lý một số thao tác cơ bản, không cần dashboard của sàn thương mại điện tử.

## Quyết định đề xuất

- Một giao diện `/admin` **chung Next.js với website hiện tại** và `/api/admin/*` trên backend Fastify đang có; PostgreSQL hiện tại lưu dữ liệu và lịch sử. Không lập dự án hay dịch vụ thứ hai, không Docker.
- **Một tài khoản owner** ở phiên bản đầu. Đăng nhập bằng mật khẩu hash và session cookie; mọi route/API quản trị đều xác thực tại server. Có logout, rate limit, bảo vệ CSRF và nhật ký thay đổi quan trọng.
- Chỉ **4 trang**: `Tổng quan`, `Sản phẩm`, `Đơn hàng`, `Cấu hình`.
- Tổng quan chỉ có hai số chính (số đơn mô phỏng 7 ngày, số sản phẩm đang hiển thị), tình trạng đồng bộ Amazon và 5 đơn mới nhất. Không biểu đồ, không tài chính giả.
- Trang Đơn hàng **chỉ xem** ở giai đoạn checkout mô phỏng. Không bấm được “Đã thu tiền”, “Giao hàng”, “Hoàn tiền” khi chưa có nghiệp vụ/cổng thanh toán thật.
- Admin không sở hữu hay điều khiển trực tiếp tiến trình scraping; chỉ gửi yêu cầu nhập/sửa trạng thái dữ liệu qua backend, không tạo trình duyệt khi mở trang.

## Lý do và đánh đổi

- **Ưu:** ít màn, ít khái niệm, tái dùng một codebase/DB; có thể mở rộng từng màn khi kinh doanh thật.
- **Nhược:** chưa hỗ trợ nhiều nhân viên và phân quyền; chưa có báo cáo thực thu hay luồng xử lý đơn thanh toán.
- **Không chọn:** Admin framework nhiều module, microservice, hệ quản trị riêng, BI dashboard nhiều biểu đồ hoặc RBAC trước khi thật sự có nhu cầu.

## Điều kiện bắt buộc khi thực hiện

- Kiểm thử từ chối API nếu thiếu session, session hết hạn/đăng xuất, rate-limit mật khẩu sai, CSRF, leak PII khách hàng.
- Bảo vệ Admin không chỉ bằng frontend redirect; giữ HTTPS và cookie Secure khi triển khai internet.
- Dữ liệu đồng bộ phải báo theo `sync_runs` thực tế; lịch `04:00 JST` vẫn cần một vòng kiểm thử vận hành riêng.
- Thay đổi giao diện và báo cáo **không** tự cho phép xuất bản nội dung Amazon khi chưa xác minh quyền sử dụng.

## Chưa chốt

Owner chưa xác nhận cách thêm sản phẩm: nhập URL/ASIN Amazon hay tạo hàng thủ công ngoài Amazon. Việc này thuộc ADR 0010; không xây UI thao tác nhập trước khi quyết định.
