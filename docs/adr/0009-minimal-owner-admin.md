# ADR 0009 — Admin tối giản cho một chủ cửa hàng

**Ghi chú triển khai 27/10/2026:** Admin local đã được triển khai theo quyết định bên dưới; xem [hướng dẫn vận hành](../admin-local.md). Các mô tả “chưa triển khai” trong bản quyết định gốc ghi lại thời điểm chốt thiết kế.

**Ngày:** 27/10/2026 (JST)
**Trạng thái:** `accepted (thiết kế Admin MVP; chưa triển khai code)` — Q1–Q11 đã được owner chốt ngày 27/10/2026; tài liệu được thông qua, chưa phải tính năng đang chạy.
**Liên quan:** `.agents/plan/04_mita_minimal_admin_grill_with_docs_plan.md`, ADR 0001–0008.

## Bối cảnh

Mita đã có website bán hàng thử nghiệm, catalog và đơn hàng mô phỏng; chưa có trang quản trị. Owner mới quản lý website nên cần thấy rõ tình trạng và xử lý một số thao tác cơ bản, không cần dashboard của sàn thương mại điện tử.

## Quyết định thiết kế đã chốt

- Một giao diện `/admin` **chung Next.js với website hiện tại** và `/api/admin/*` trên backend Fastify đang có; PostgreSQL hiện tại lưu dữ liệu và lịch sử. Không lập dự án hay dịch vụ thứ hai, không Docker.
- **Q3 đã chốt (A): một tài khoản owner duy nhất** trong Admin MVP. Không tạo màn thêm/xóa tài khoản, tài khoản nhân viên hay phân quyền nhiều cấp. Đăng nhập bằng mật khẩu hash và session cookie; mọi route/API quản trị đều xác thực tại server. Có logout, rate limit, bảo vệ CSRF và nhật ký thay đổi quan trọng.
- **Q11 đã chốt (A):** tạo owner lần đầu bằng lệnh setup chạy trên máy local, yêu cầu nhập mật khẩu kín và hash tại backend; không có trang web đăng ký/setup Admin, không mật khẩu mặc định hay mật khẩu trong Git. Lệnh không được tạo owner trùng; khôi phục/reset qua quy trình local có kiểm soát.
- Chỉ **4 trang**: `Tổng quan`, `Sản phẩm`, `Đơn hàng`, `Cấu hình`.
- Tổng quan chỉ có hai số chính (số đơn mô phỏng 7 ngày, số sản phẩm đang hiển thị), tình trạng đồng bộ Amazon và 5 đơn mới nhất. Không biểu đồ, không tài chính giả.
- **Q7 + Q8 đã chốt (A): chỉ hiển thị trạng thái và cảnh báo đồng bộ Amazon tự động trên Tổng quan**, không có nút `Đồng bộ Amazon ngay`, endpoint quét toàn bộ, email, SMS hay push notification. Trạng thái dựa trên `sync_runs` / `sync_errors` thực tế; lỗi một phần, thất bại, cần can thiệp hoặc bỏ lỡ lịch phải được báo rõ ngay trong Admin. Khi không mở Admin, không có cảnh báo chủ động. Chức năng thêm một ASIN theo Q1 là tác vụ riêng, không phải quét toàn bộ.
- **Q10 đã chốt (A):** website, backend và worker được bật/dừng **thủ công** ở Windows khi cần; không thiết lập tự chạy cùng Windows. Lịch worker 04:00 JST chỉ thực thi nếu máy và worker đang chạy; nếu bỏ lỡ lịch thì cảnh báo thiếu `sync_run`, không tự khởi động/bù hoặc giả thành công.
- **Q2 đã chốt (A): Trang Đơn hàng chỉ xem** danh sách/chi tiết đơn mô phỏng, **không cập nhật ghi chú hoặc trạng thái nội bộ**. Không có thao tác “Đã thu tiền”, “Giao hàng”, “Hoàn tiền”, “Xóa đơn” khi chưa có nghiệp vụ/cổng thanh toán thật.
- Admin không sở hữu hay điều khiển trực tiếp tiến trình scraping; chỉ gửi yêu cầu nhập/sửa trạng thái dữ liệu qua backend, không tạo trình duyệt khi mở trang.

## Lý do và đánh đổi

- **Ưu:** ít màn, ít khái niệm, tái dùng một codebase/DB; có thể mở rộng từng màn khi kinh doanh thật.
- **Nhược:** chưa hỗ trợ nhiều nhân viên và phân quyền; chưa có báo cáo thực thu hay luồng xử lý đơn thanh toán; đồng bộ không chạy nếu worker chưa được bật đúng thời điểm.
- **Không chọn:** Admin framework nhiều module, microservice, hệ quản trị riêng, BI dashboard nhiều biểu đồ hoặc RBAC trước khi thật sự có nhu cầu.

## Điều kiện bắt buộc khi thực hiện

- Kiểm thử từ chối API nếu thiếu session, session hết hạn/đăng xuất, rate-limit mật khẩu sai, CSRF, leak PII khách hàng.
- Tài khoản owner tạo bằng lệnh CLI local (Q11) dùng input mật khẩu kín, không nhận mật khẩu trên command line, không ghi vào log/repository; hash an toàn trong DB, chặn tạo owner thứ hai, có hướng dẫn reset local được bảo vệ; không xây trang setup web.
- Bảo vệ Admin không chỉ bằng frontend redirect; giữ HTTPS và cookie Secure khi triển khai internet.
- **Q9 đã chốt (A):** Admin MVP chỉ truy cập qua `localhost` / `127.0.0.1` của máy chạy dự án; Next.js Admin và Fastify API phục vụ Admin phải giữ trên loopback. Không triển khai internet/LAN, không mở trực tiếp backend/PostgreSQL. Dù local vẫn yêu cầu xác thực một owner và bảo vệ phiên. Mọi mở rộng truy cập từ xa là quyết định khác, ngoài MVP.
- Dữ liệu đồng bộ phải báo theo `sync_runs` thực tế; lịch `04:00 JST` vẫn cần kiểm thử **khi worker được bật thủ công và chạy xuyên qua giờ lịch**. Sau restart Windows các tiến trình không tự chạy theo Q10; không được gọi đó là lỗi cấu hình hay tự bật dịch vụ nền. Nếu không có run, hiển thị chưa xác nhận/bỏ lỡ.
- Thay đổi giao diện và báo cáo **không** tự cho phép xuất bản nội dung Amazon khi chưa xác minh quyền sử dụng.

## Quyết định đã chốt — Grill kết thúc

Owner đã chốt **Q1 = A, thêm sản phẩm bằng link/ASIN Amazon**, **Q4 = A, tự nhập tỷ giá VND/JPY**, **Q5 = B, sửa phụ phí cùng tỷ giá bằng một nút Lưu**, **Q6 = A, ẩn sản phẩm thay vì xóa và không bị sync tự bỏ ẩn** (ADR 0010), cùng **Q2 = A, chỉ xem đơn mô phỏng**, **Q3 = A, một tài khoản owner duy nhất**, **Q7 = A, chỉ xem kết quả đồng bộ tự động**, **Q8 = A, chỉ cảnh báo trong Admin, không email**, và **Q9 = A, chỉ localhost** (ADR này).

**Q10 = A:** Chạy website/backend/worker thủ công khi cần; không Windows auto-start. Đồng bộ 04:00 JST chỉ có thể diễn ra khi worker đang chạy.

**Q11 = A:** Khởi tạo owner bằng lệnh setup local bảo mật; không xây trang web setup.

**Kết luận:** 11/11 câu Grill đã chốt; không còn câu hỏi quyết định Admin MVP đang mở. Code Admin chưa triển khai. Kế hoạch xây dựng theo mốc A–E tại plan 04; **không commit Git sau câu hỏi/trả lời** theo yêu cầu owner.
