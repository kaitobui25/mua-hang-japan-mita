# ADR 0012 — Translator tên độc lập, 05:00 JST

**Trạng thái:** Accepted — owner chọn Q1 A, Q2 chỉ tên, Q3 không dịch lại, Q4 bỏ lượt khi PC tắt (28/10/2026). Thay thế phần lịch dịch tự động ở ADR 0011 và README cũ.

- Amazon worker giữ lịch 04:00 JST; không có trigger dịch từ sync, import, CAPTCHA, startup hay hết 30 giây.
- Translator chạy trong **tiến trình Windows riêng**, với pg-boss queue `translation.names.daily` lúc **05:00 Asia/Tokyo**. Bỏ lượt khi tiến trình chưa khởi động đúng giờ; không chạy bù. Có lệnh dịch thủ công rõ ràng.
- Mỗi lượt dịch mọi tên ASIN chưa thành công theo batch tối đa 5, đến khi hết tên, quota miễn phí (giữ 2 request), hoặc provider không khả dụng. ASIN thất bại được thử lại ngày sau; khóa PostgreSQL ngăn dùng quota song song.
- Một khi tên Việt của ASIN được lưu với `status='success'`, không tự dịch lại dù tên/chi tiết nguồn thay đổi. Catalog tiếp tục hiển thị tên Việt đó. Dịch mô tả nằm ngoài phạm vi translator mới và sẽ dùng model khác trong công việc sau; các bản dịch mô tả lịch sử giữ nguyên, chỉ hiển thị khi nội dung nguồn còn khớp.
- Hai tiến trình có PID/log riêng qua `scripts/start-local.ps1`, dừng được bởi `scripts/stop-local.ps1`.

**Đánh đổi được owner chấp nhận:** tên đã dịch có thể không còn phản ánh phiên bản Amazon mới; cần quy trình cập nhật thủ công riêng nếu thay đổi quyết định sau này.
