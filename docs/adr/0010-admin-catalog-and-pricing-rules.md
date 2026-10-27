# ADR 0010 — Quản lý hiển thị sản phẩm và tỷ giá qua Admin

**Ghi chú triển khai 27/10/2026:** Cờ ẩn, hàng đợi ASIN, policy giá nguyên tử và audit đã được triển khai trong app hiện có; xem [hướng dẫn vận hành](../admin-local.md). Bản quyết định bên dưới được giữ làm lịch sử thiết kế.

**Ngày:** 27/10/2026 (JST)
**Trạng thái:** `accepted (thiết kế; chưa triển khai code)` — Q1, Q4–Q6 và các quyết định liên quan Q2–Q3, Q7–Q11 đã chốt ngày 27/10/2026; xem ADR 0009.
**Liên quan:** ADR 0002, 0003, 0006, 0007; `.agents/plan/04_mita_minimal_admin_grill_with_docs_plan.md`.

## Bối cảnh

Sản phẩm Mita hiện được tự động upsert từ Amazon theo ASIN; nếu xóa một hàng trong DB, lần quét sau có thể nhập lại. Giá VND đang tính từ JPY và hai biến env, còn order có snapshot tỷ giá và tiền hàng lúc tạo. Chủ cửa hàng cần chỉnh tỷ giá và quyết định hàng nào được thấy nhưng không muốn bảng điều khiển phức tạp.

## Quy tắc thiết kế đã chốt

1. **Q6 — ĐÃ CHỐT (A): “Xóa khỏi cửa hàng” = Ẩn**, có nút `Hiện lại`; không hard-delete ASIN có lịch sử giá/đơn. Trạng thái ẩn admin độc lập trạng thái giá và điều kiện bán; **mọi lần sync và thao tác nhập lại ASIN đều không được tự bỏ ẩn**. Catalog, endpoint chi tiết công khai và checkout phải kiểm tra trạng thái ẩn tại server, không chỉ lọc giao diện. Ẩn không hủy bản ghi, lịch sử hoặc snapshot đơn; hiện lại vẫn chịu kiểm tra giá 24 giờ, quyền nội dung và điều kiện bán; ghi audit mỗi lần ẩn/hiện.
2. **“Thêm hàng” — owner đã chọn A (27/10/2026):** dán ASIN hoặc URL Amazon.co.jp và chọn một trong hai danh mục, đưa vào hàng đợi riêng để backend thu thập/xác minh. Chỉ nhận URL HTTPS Amazon Japan có ASIN, trích ASIN và dựng URL chuẩn phía server, không fetch tùy ý URL user gửi. Đã có ASIN thì hiện bản ghi cũ; yêu cầu trùng đang xử lý thì hiện trạng thái cũ. Chỉ thông báo `Đã tiếp nhận` khi enqueue, còn `succeeded` chỉ khi xác minh nguồn và upsert thành công. Nguồn từ chối hoặc cần CAPTCHA thì ghi `needs_human`, không vượt chặn. **Không có chức năng nhập tên/ảnh/giá thủ công.** Bộ thu thập theo từng ASIN chưa tồn tại, phải được xây trước khi nút này vận hành.
3. **Không nhập giá nguồn JPY bằng tay rồi đánh dấu là giá Amazon hợp lệ.** Giá nguồn/timestamp phải do quan sát hợp lệ cung cấp, stale quá 24 giờ không checkout; quyền tái hiển thị và điều kiện bán vẫn cần xác minh.
4. **Q4 + Q5 đã chốt:** chủ cửa hàng nhập **tỷ giá VND/JPY** và có thể chỉnh **phụ phí dịch vụ (%)** trong cùng màn `Cấu hình`, bấm đúng **một nút `Lưu thay đổi`**. Không lấy tỷ giá từ nguồn bên ngoài. Hai thông số khởi tạo từ cấu hình đang có (mặc định 190 VND/JPY và 12%) và được lưu **nguyên tử** trong một `PricingPolicy` version mới với thời điểm và audit. Backend kiểm tra giá trị hợp lệ, hiển thị phép tính thử và xác nhận trước khi lưu; không có hai phiên bản lẻ hoặc hai nút Lưu. Catalog và checkout dùng chung hàm pricing, không nhân bản công thức ở frontend.
5. Khi lưu bất kỳ thông số nào, **giá hiển thị và các đơn mới** được tính theo cùng version của policy mới; đơn đã tạo giữ snapshot `orders.fx_jpy_to_vnd`, `orders.service_fee_percent` và `order_items.unit_price_vnd`. Không tính lại đơn lịch sử, kể cả khi phụ phí giảm hoặc tăng.
6. Tính phí vận chuyển **ước tính riêng** theo category như hiện tại; không gom vào tỷ giá và không tuyên bố phí thực tế đã chốt.

## Ranh giới và hậu quả

- Thêm các thuộc tính/bảng tối thiểu cho `AdminVisibility`, `CatalogImportRequest`, `PricingPolicy`, `AdminAuditEvent`; tái dùng `products`, `price_observations`, `orders`, `sync_runs` có sẵn.
- Cần migration an toàn cho dữ liệu cũ và một lần chuyển biến cấu hình env → record DB với giá khởi tạo đúng mặc định đang dùng, có rollback/backup.
- Cần sửa các API công khai và checkout thống nhất: cả hidden và điều kiện bán được kiểm tra ở backend; frontend chỉ phản ánh kết quả.
- Không xây điều chỉnh giá riêng theo ASIN, giá giảm, kho tồn, live FX, CSV, voucher, báo cáo lợi nhuận, quyền nhiều nhân viên trong phiên bản đầu.

## Quyết định đã chốt — Grill kết thúc

**Q1 — ACCEPTED:** Phương án A (Amazon link/ASIN). Không xây phương án B trong MVP.

**Q2 — ACCEPTED (xem ADR 0009):** Chỉ xem danh sách và chi tiết đơn mô phỏng, không có ghi chú hoặc API cập nhật trạng thái đơn ở Admin MVP.

**Q3 — ACCEPTED (xem ADR 0009):** Chỉ một tài khoản owner trong Admin MVP, không hỗ trợ tài khoản nhân viên hoặc phân quyền nhiều cấp.

**Q4 — ACCEPTED:** Phương án A. Owner nhập tỷ giá VND/JPY thủ công, xem thử giá VND rồi nhấn `Lưu thay đổi` cùng phụ phí. Backend kiểm tra số hợp lệ và dương, lưu thay đổi kèm lịch sử, chỉ ảnh hưởng giá bán/checkout mới; giá và tỷ giá của đơn đã tạo không thay đổi. Không gọi API tỷ giá ngoài, không tự cập nhật.

**Q5 — ACCEPTED:** Phương án B. Phụ phí dịch vụ mặc định 12% là **trường có thể chỉnh** trong cùng màn hình với tỷ giá; cả hai được lưu bằng **một nút** và một `PricingPolicy` version. Phụ phí không phải phí vận chuyển quốc tế.

**Q6 — ACCEPTED:** Phương án A — ẩn/hiện lại thay vì xóa vĩnh viễn. Chỉ owner chủ động thay đổi cờ ẩn; đồng bộ nguồn/nhập lại ASIN không tự đổi trạng thái này. Giữ nguyên lịch sử giá và dữ liệu đơn.

**Q7 — ACCEPTED (xem ADR 0009):** Admin chỉ đọc trạng thái đồng bộ tự động theo lịch; không có nút `Đồng bộ Amazon ngay` hoặc API kích hoạt quét toàn bộ. Yêu cầu nhập ASIN đơn lẻ theo Q1 vẫn hoạt động độc lập.

**Q8 — ACCEPTED (xem ADR 0009):** Chỉ hiển thị cảnh báo lỗi/partial/needs_human/bỏ lỡ lịch tại Tổng quan Admin; không gửi email hoặc thông báo chủ động. Dữ liệu lỗi phải được lấy từ lịch sử chạy thực tế.

**Q9 — ACCEPTED (xem ADR 0009):** Admin chỉ truy cập qua localhost trên máy phát triển; không triển khai internet/LAN hoặc mở port backend/DB.

**Q10 — ACCEPTED (xem ADR 0009):** Website/backend/worker khởi chạy thủ công; job ASIN có thể chờ `pending` khi worker tắt; lịch 04:00 JST không thể được xác nhận nếu worker không chạy.

**Q11 — ACCEPTED (xem ADR 0009):** Chỉ một owner khởi tạo bằng lệnh local an toàn; không form setup web hoặc mật khẩu mặc định.

**Grill hoàn tất:** Q1–Q11 đã chốt; tài liệu chưa được commit theo yêu cầu và chưa có code Admin triển khai.
