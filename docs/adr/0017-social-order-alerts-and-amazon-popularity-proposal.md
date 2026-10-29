# ADR 0017 — Chat liên hệ, thông báo đơn, Amazon reviews và thư viện ảnh review

**Ngày:** 2026-10-29 JST. **Trạng thái:** Accepted về ý định sản phẩm (Grill 2/2); **chưa triển khai code**. Các tích hợp phụ thuộc provider còn ở dạng chờ xác minh.

## Bối cảnh

Owner yêu cầu nút chat Zalo cá nhân và Fanpage Facebook, thông báo đơn cho owner/nhân viên, cửa sổ Windows độc lập nền đen tab giống terminal, top 100 Amazon.co.jp **mỗi danh mục hiện tại**, sort theo **review count** và trang review ảnh tự lấy từ folder. Bỏ hoàn toàn tiêu chí và sort theo số lượng mua hàng trước đây.

## Quyết định được chốt

1. Khách dùng nút `Liên hệ Zalo` mở link cá nhân do owner cung cấp, và `Nhắn tin Facebook` mở Fanpage, người bán trả lời trong app gốc. Không yêu cầu Meta App hoặc inbox chat nội bộ Mita.
2. Đơn `pending_confirmation` được lưu thành công sau khi đã nhận tên, SĐT và địa chỉ tạo một event `order_placed` (không có nghĩa đã thanh toán). Admin/Windows GUI thông báo owner và người có quyền; event bền, retry có giới hạn, lỗi lưu log + fallback. Kênh Zalo cá nhân/Fanpage link không tự có quyền push thông báo đơn; nếu đòi push ra Zalo/Facebook thì cần giải pháp provider được cấp phép, quyết định về bên nhận còn mở.
3. Desktop GUI Windows khởi chạy bằng double-click, nền đen chữ trắng, có tabs status/order/product/log và thao tác Admin; dùng chung backend/API/DB, version và audit. Không mở Admin VPS ra public, không tạo DB thứ hai, không dừng worker nếu đóng cửa sổ.
4. Mỗi danh mục trong 2 danh mục hiện có có thể có một tập **tối đa 100 ASIN**, đủ điều kiện **ít nhất 2 review Verified Purchase có ngày đăng trong năm hiện tại JST**, nếu không đủ thì dùng **2 review thường cùng năm**. Nếu không có chứng cứ số/ngày/nhãn thì ghi unknown và không tự nhận sản phẩm đủ. Ngày năm hiện tại tự đổi vào 01/01 JST.
5. **Không thu thập hoặc sắp xếp theo số lượng mua**. Sort mặc định catalog và top list theo **số lượt review giảm dần**, xử lý null sau cùng, tie-break bền. Số rating và số bài review là hai đại lượng khác nhau; chỉ số nào được dùng phải được ghi đúng nhãn và nguồn. Sort và phép lọc phải thực hiện ở backend trước khi phân trang.
6. Refresh mỗi ngày khi được phép; nguồn từ chối giữ last-known snapshot có timestamp, ghi trạng thái stale; không làm mới timestamp giá hoặc lách cooldown.
7. Trang chi tiết có URL Amazon chuẩn từ ASIN đã chọn, liên kết thông thường; cạnh tiêu đề và trên card có thanh 5 sao thể hiện **đúng điểm trung bình** và số đánh giá thực trong ngoặc. Nếu không có nguồn hợp lệ/giấy phép thì không tạo rating giả, vẫn cho link gốc.
8. Trang phản hồi Mita dùng ảnh từ thư mục owner quản lý, carousel ngang 3 ảnh trong viewport khi đủ ảnh, ảnh giữa nhấn mạnh, hai bên giảm opacity; điều khiển chuột, bàn phím, swipe/mobile và reduced-motion. Ảnh thêm vào folder chỉ public sau kiểm tra và đồng bộ an toàn tới VPS. Ba ảnh mẫu phải luôn có nhãn hư cấu ở ngay trong ảnh và trang; không tính vào số review khách thật. Ảnh thật sau này cần sự đồng ý của người gửi, redaction và cơ chế ẩn.

## Giới hạn kỹ thuật và yêu cầu nghiệm thu

- Zalo personal link/Facebook Fanpage link cho chat hai chiều **không phải** quyền API tự gửi tin báo đơn cho người khác. Nếu không có API phù hợp, thực hiện thông báo Admin/GUI + log và công bố trạng thái push chưa khả dụng. Không tuyên bố gửi thành công.
- Bộ collector hiện chưa cho thấy review evidence có `posted_at` và `verified_purchase` ở DB; cần nguồn được phép cung cấp trước khi lọc 2 review trong năm. Không làm giả top 100 khi chỉ có dữ liệu rating tổng.
- Ảnh local chưa tự xuất hiện trên web VPS: cần đồng bộ file an toàn, chỉ cho ảnh đã kiểm tra format/MIME, size, chống path traversal và lộ dữ liệu khách.
- 100 là **trần tối đa** mỗi danh mục cho đến khi có đủ bằng chứng; thiếu dữ liệu thì hiển thị ít hơn và báo lý do tại Admin.
- Theo thiết kế mặc định, đủ điều kiện dựa trên ≥2 bài có ngày trong năm; sort theo tổng **written reviews** toàn thời gian có nguồn, không dùng `rating count` khi nó khác written reviews. Lấy 100 hàng đầu từ tập đủ điều kiện trong hai danh mục hiện tại; không gom các số review chung parent vào nhiều biến thể. Hết ngày 31/12 JST, chứng cứ năm cũ không tự làm sản phẩm đủ điều kiện của năm mới.
- Chưa chốt kênh **push ngoài app** cho nhân viên, và chưa chốt họ có tài khoản/thao tác trong Admin/Windows GUI hay chỉ được thông báo. Mặc định chỉ owner thao tác và alert nội bộ; hai thay đổi này phải được xác nhận trước khi code phân quyền hoặc tự gửi tin.
- Test: checkout thật một lần nhận đúng một event, loại bỏ QA/simulation; lỗi gửi không hủy order; UI desktop/Admin nhìn cùng record version; sắp xếp backend trước phân trang; năm JST rollover; verified fallback; carousel 0/1/2/3/4+ ảnh; bằng chứng ảnh và quyền thu hồi.

## Quan hệ với ADR trước

- Nếu bật thông báo chủ động, quyết định mới **bổ sung/thay phần 'Admin chỉ cảnh báo nội bộ' tại ADR 0009–0010 Q8** trong phạm vi thông báo đặt đơn.
- Chỉ cập nhật các hành vi đã được owner xác nhận; giữ nguyên order snapshot, role owner, daily schedule, chống source blocking và checkout.
- Không biến điều kiện mới thành lý do xóa sản phẩm cũ thiếu BSR/review khi chưa có chính sách rõ ràng.
- ADR 0018 điều chỉnh chính sách tên OpenRouter ngắn và phần bị lược có thể tìm kiếm.
