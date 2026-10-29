# Ảnh phản hồi Mita Japan

Trang `/danh-gia` **tự đọc các ảnh đặt trong `public/reviews/` trên máy chủ đang chạy** ở mỗi lượt truy cập. Chỉ cần thêm/xóa file ảnh hợp lệ trong thư mục, không cần sửa manifest hay build lại trang. Ảnh mới được liệt kê trong carousel ở lượt truy cập tiếp theo; hiện không có cơ chế cập nhật một tab đã mở mà không tải lại.

**Chỉ đặt ảnh đã được chủ cửa hàng duyệt công bố, có sự đồng ý của khách và đã che tên, avatar, số điện thoại, đường dẫn profile và thông tin riêng tư.** Việc thêm file đồng nghĩa chọn công bố file đó. Bộ quét kiểm tra tính hợp lệ kỹ thuật, **không thể kiểm chứng quyền sử dụng hoặc tự che thông tin cá nhân**. Mọi file nằm trong `public/reviews/` có thể truy cập trực tiếp qua URL, kể cả khi không xuất hiện trong carousel. Khi cần thu hồi, xóa ngay ảnh khỏi thư mục công khai và xử lý cache/CDN nếu có.

Ảnh được nhận khi có đuôi `.png`, `.jpg`, `.jpeg` hoặc `.webp`, tên file hợp lệ (tối đa 180 ký tự trước phần mở rộng, có thể dùng chữ Việt, khoảng trắng, số, dấu `-`, `_`), dung lượng từ 12 byte đến 8 MiB và chữ ký đầu file đúng định dạng. File symlink, thư mục, file giả đuôi ảnh và tệp lỗi không được liệt kê. Để giới hạn thời gian đọc thư mục, mỗi lượt hiển thị tối đa 120 ảnh hợp lệ trong 300 ứng viên đầu tiên theo tên. Nếu cần hơn, tổ chức chia thư viện trước khi tăng giới hạn.

Ba ảnh `review-demo-01.png` đến `review-demo-03.png` là **hội thoại giả lập 100%**, không phải feedback Facebook thật. Mọi file đặt tên `review-demo-<số>.png/.jpg/.jpeg/.webp` đều được đánh dấu **MINH HỌA – HƯ CẤU**. Không đặt ảnh thật với tiền tố này; ảnh thật được đưa lên trước ảnh demo trong carousel.

## Đưa ảnh từ Windows lên VPS

Thư mục `public/reviews/` trên Windows **không tự đồng bộ** với VPS. Nếu đang xem website từ VPS, ảnh chỉ xuất hiện sau khi đã chuyển vào thư mục `web/public/reviews/` của **release đang phục vụ web** (theo `deploy/mita/README.md`, thư mục release có dạng `/opt/mita/releases/<id>/web/public/`). Có thể dùng công cụ SFTP/WinSCP với tài khoản SSH được cấu hình sẵn; cần xác định đúng release đang chạy. Không có thông tin tài khoản hay đường dẫn release hiện hành được cài cứng ở đây.

1. Trên Windows, kiểm tra quyền công bố và che thông tin riêng tư; chỉ chọn file hợp lệ tối đa 8 MiB.
2. Chuyển file vào khu vực tạm **bên ngoài thư mục công khai** trên VPS, sau đó chuyển/đổi tên nguyên tử vào `web/public/reviews/` khi tải xong, để người truy cập không thấy file đang tải dở.
3. Tải lại `/danh-gia` để kiểm tra. Muốn ẩn ảnh, xóa file tương ứng trên VPS. Khi phát hành release mới, đảm bảo ảnh được đồng bộ vào thư mục `public/reviews/` của release mới.

Hiện chưa có đồng bộ Windows → VPS tự động. Phần gallery này chỉ tự nhận diện ảnh **đã ở cùng thư mục trên máy chủ đang chạy**; nếu muốn thao tác thêm ảnh trên Windows và xuất hiện ngay trên VPS, cần cấu hình một quy trình đồng bộ riêng có giới hạn file, kiểm tra, lịch chạy và thông tin SSH được chủ cửa hàng cung cấp.
