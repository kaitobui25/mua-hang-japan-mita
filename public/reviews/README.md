# Thư mục ảnh review Mita Japan (bản thiết kế)

- Ba file `review-demo-01.png`, `review-demo-02.png`, `review-demo-03.png` là **ảnh hội thoại giả lập 100%**, có nhãn mẫu ngay trong ảnh. Không phải feedback thật từ Facebook.
- Chủ shop có thể thêm ảnh thật vào thư mục này sau khi có quyền công bố và đã che tên, avatar, số điện thoại, đường dẫn profile hoặc thông tin riêng tư.
- **Hiện chưa có carousel, trình quét file hay đồng bộ ảnh Windows → VPS.** Thêm file ở đây lúc này chưa tự tạo review trên website đang chạy; tính năng sẽ được xây ở giai đoạn implement.
- Thiết kế dự kiến: chỉ đọc PNG/JPEG/WebP đã kiểm tra; không đọc README, symlink hoặc file tuỳ ý; manifest/đồng bộ có log và không ghi đè dữ liệu ảnh chưa được duyệt.
- Khi có ảnh thật, ảnh demo phải được hiển thị có ghi chú `Minh họa` hoặc được thay thế/ẩn; không trộn ảnh giả vào danh sách lời chứng thực có thật.
