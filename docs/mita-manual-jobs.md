# Mita Japan: chạy các job buổi sáng bằng tay (Windows PC)

Mở `run-mita-jobs.bat` ở root repository bằng nhấp đúp. Menu cho chọn đúng
một trong ba job: Amazon (04:00 JST), dịch tên bằng engine đang cấu hình
(05:00 JST), hoặc dịch chi tiết bằng GGUF local (05:15 JST).

Nếu chọn Amazon, chọn một trong bốn chế độ:

1. **Ảnh** — quét số ASIN giới hạn, ưu tiên sản phẩm thiếu ảnh chất lượng;
   chỉ cập nhật URL gallery và cover có bằng chứng từ Amazon. Ảnh nhỏ không
   được nâng cấp bằng cách tự đoán hoặc sửa URL.
2. **Giá** — chỉ ghi giá JPY mới khi có bằng chứng trang sản phẩm khớp ASIN;
   nếu trang không có giá hợp lệ, giữ giá cũ và báo lý do.
3. **Kiểm tra còn trên Amazon** — đọc trang hiện tại của ASIN, báo `present`,
   `not_found_http_404`, hoặc không xác minh được; **không xóa hoặc ẩn** sản
   phẩm khi Amazon trả 404, 403, CAPTCHA hoặc timeout. Hết hàng khác với xóa SP.
4. **Full** — cùng luồng khám phá listing + cập nhật detail như job Amazon
   04:00, có giới hạn 200 ASIN riêng cho mỗi danh mục. Không tự đẩy VPS.

Các chế độ 1–3 hỏi giới hạn 1–300 ASIN (mặc định 20); chế độ 4 giữ nguyên
ngân sách của job 04:00. Job dịch tên và GGUF cũng cho chọn giới hạn.
Sau khi chọn, nhập chính xác `CHAY` mới bắt đầu. Đóng hộp thoại/nhấn `0`
trước khi xác nhận không chạy worker. Không chạy job thử để kiểm tra menu.

Job chỉ sử dụng PostgreSQL local `127.0.0.1:5433/postgres`, không tạo
VPS sync, migration hoặc deploy. Các advisory lock hiện có ngăn chạy trùng;
Amazon vẫn tôn trọng source cooldown, CAPTCHA, 403/429 và Retry-After.
Không tự retry một kết quả không rõ sau lỗi kết nối. Nhật ký và JSON báo cáo
riêng từng lượt ở `.agents/runtime/manual-jobs/` (không commit).

Báo cáo phân biệt số ASIN được chọn/đã thử/thành công/thất bại/chưa thử, lỗi
nguồn và lý do theo ASIN. GGUF đo riêng các **slot văn bản** được dịch và số
ASIN có slot thành công/lỗi; không diễn giải slot như số sản phẩm hoàn thành.
Không có kết quả có bằng chứng thì hiện `unresolved`, không tự coi exit 0
là thành công.

Riêng Amazon **Full chạy tay**, terminal và JSON `result.categoryBreakdown` còn
hiển thị từng danh mục: `newProducts` (ASIN thêm mới),
`existingProducts` (ASIN cũ lưu thành công), và trong nhóm ASIN cũ có
`nameChanged`, `priceChanged`, `imagesChanged`. Ba chỉ số thay đổi
được so sánh **giá trị trước/sau khi lưu** trong transaction local:
tên gốc Amazon, giá JPY và danh sách URL gallery theo thứ tự. Một ASIN có
thể góp vào nhiều chỉ số; ghi lại cùng giá trị không tính là đổi.
Báo cáo cũ không có `categoryBreakdown` thì hiển thị chưa có dữ liệu,
không tự điền số 0. Chỉ thống kê lần chạy phát sinh từ sau cập nhật này.

`AMAZON_GALLERY_PILOT_DATE=verified` là mặc định mới trong
`scripts/mita-supervisor.mjs`; `scripts/start-mita-supervisor.ps1` thiết lập
rõ `verified` để không lấy lại ngày pilot cũ của shell.
Supervisor và Amazon worker **đang chạy từ trước khi sửa** vẫn giữ môi trường
của tiến trình cũ. Việc kích hoạt cấu hình trong tiến trình cũ đòi hỏi
khởi động lại Supervisor có kiểm tra lock/owner và được phép; không chạy bù
job 04:00 đã lỡ. Không chạy trực tiếp `mita-supervisor.mjs` bằng một shell có
biến pilot cũ; nên dùng launcher quản lý chính thức.
