# ADR 0009 — Admin tối giản cho một chủ cửa hàng

**Ngày:** 27/10/2026 (JST)
**Trạng thái:** `proposed / Q2 + Q3 + Q7 + Q8 accepted` — đơn chỉ đọc, một tài khoản owner, sync chỉ đọc và cảnh báo lỗi chỉ trong Admin đã chốt ngày 27/10/2026. Phạm vi truy cập từ xa đang chờ Q9.
**Liên quan:** `.agents/plan/04_mita_minimal_admin_grill_with_docs_plan.md`, ADR 0001–0008.

## Bối cảnh

Mita đã có website bán hàng thử nghiệm, catalog và đơn hàng mô phỏng; chưa có trang quản trị. Owner mới quản lý website nên cần thấy rõ tình trạng và xử lý một số thao tác cơ bản, không cần dashboard của sàn thương mại điện tử.

## Quyết định đề xuất

- Một giao diện `/admin` **chung Next.js với website hiện tại** và `/api/admin/*` trên backend Fastify đang có; PostgreSQL hiện tại lưu dữ liệu và lịch sử. Không lập dự án hay dịch vụ thứ hai, không Docker.
- **Q3 đã chốt (A): một tài khoản owner duy nhất** trong Admin MVP. Không tạo màn thêm/xóa tài khoản, tài khoản nhân viên hay phân quyền nhiều cấp. Đăng nhập bằng mật khẩu hash và session cookie; mọi route/API quản trị đều xác thực tại server. Có logout, rate limit, bảo vệ CSRF và nhật ký thay đổi quan trọng.
- Chỉ **4 trang**: `Tổng quan`, `Sản phẩm`, `Đơn hàng`, `Cấu hình`.
- Tổng quan chỉ có hai số chính (số đơn mô phỏng 7 ngày, số sản phẩm đang hiển thị), tình trạng đồng bộ Amazon và 5 đơn mới nhất. Không biểu đồ, không tài chính giả.
- **Q7 + Q8 đã chốt (A): chỉ hiển thị trạng thái và cảnh báo đồng bộ Amazon tự động trên Tổng quan**, không có nút `Đồng bộ Amazon ngay`, endpoint quét toàn bộ, email, SMS hay push notification. Trạng thái dựa trên `sync_runs` / `sync_errors` thực tế; lỗi một phần, thất bại, cần can thiệp hoặc bỏ lỡ lịch phải được báo rõ ngay trong Admin. Khi không mở Admin, không có cảnh báo chủ động. Chức năng thêm một ASIN theo Q1 là tác vụ riêng, không phải quét toàn bộ.
- **Q2 đã chốt (A): Trang Đơn hàng chỉ xem** danh sách/chi tiết đơn mô phỏng, **không cập nhật ghi chú hoặc trạng thái nội bộ**. Không có thao tác “Đã thu tiền”, “Giao hàng”, “Hoàn tiền”, “Xóa đơn” khi chưa có nghiệp vụ/cổng thanh toán thật.
- Admin không sở hữu hay điều khiển trực tiếp tiến trình scraping; chỉ gửi yêu cầu nhập/sửa trạng thái dữ liệu qua backend, không tạo trình duyệt khi mở trang.

## Lý do và đánh đổi

- **Ưu:** ít màn, ít khái niệm, tái dùng một codebase/DB; có thể mở rộng từng màn khi kinh doanh thật.
- **Nhược:** chưa hỗ trợ nhiều nhân viên và phân quyền; chưa có báo cáo thực thu hay luồng xử lý đơn thanh toán.
- **Không chọn:** Admin framework nhiều module, microservice, hệ quản trị riêng, BI dashboard nhiều biểu đồ hoặc RBAC trước khi thật sự có nhu cầu.

## Điều kiện bắt buộc khi thực hiện

- Kiểm thử từ chối API nếu thiếu session, session hết hạn/đăng xuất, rate-limit mật khẩu sai, CSRF, leak PII khách hàng.
- Tài khoản owner phải được tạo qua bước thiết lập an toàn, không có username/password mặc định công khai hoặc lưu plaintext trong repository. Cần cách khôi phục quyền truy cập an toàn nhưng không cần tính năng quản lý nhân viên.
- Bảo vệ Admin không chỉ bằng frontend redirect; giữ HTTPS và cookie Secure khi triển khai internet.
- **Q9 chưa chốt:** phát triển hiện tại chỉ dùng localhost; nếu owner cần mở Admin từ xa qua internet phải thiết kế đường truy cập an toàn cho cả Next.js và Fastify, không mở trực tiếp backend/DB ra ngoài.
- Dữ liệu đồng bộ phải báo theo `sync_runs` thực tế; lịch `04:00 JST` vẫn cần một vòng kiểm thử vận hành riêng.
- Thay đổi giao diện và báo cáo **không** tự cho phép xuất bản nội dung Amazon khi chưa xác minh quyền sử dụng.

## Chưa chốt

Owner đã chốt **Q1 = A, thêm sản phẩm bằng link/ASIN Amazon**, **Q4 = A, tự nhập tỷ giá VND/JPY**, **Q5 = B, sửa phụ phí cùng tỷ giá bằng một nút Lưu**, **Q6 = A, ẩn sản phẩm thay vì xóa và không bị sync tự bỏ ẩn** (ADR 0010), cùng **Q2 = A, chỉ xem đơn mô phỏng**, **Q3 = A, một tài khoản owner duy nhất**, **Q7 = A, chỉ xem kết quả đồng bộ tự động** và **Q8 = A, chỉ cảnh báo lỗi đồng bộ trong Admin, không email** (ADR này). **Q9 còn mở:** Admin chỉ truy cập localhost hay cho phép truy cập từ xa qua internet?
