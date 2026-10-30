# Nhân viên chỉ xem Admin Mita Japan

Tài khoản **owner** vẫn đăng nhập bằng tên `owner` (hoặc bỏ trống tên
ở desktop) và mật khẩu đã thiết lập. Nhân viên có username, mật khẩu riêng
và role `staff`, không dùng chung mật khẩu owner. Chỉ đăng nhập localhost
hoặc Admin VPS qua SSH tunnel; không mở `/api/admin` ra Internet.

Sau migration database được phê duyệt, từ terminal tin cậy tại thư mục `backend`:

```powershell
npm run admin:staff:add -- nv_a
npm run admin:staff:reset -- nv_a
npm run admin:staff:disable -- nv_a
```

Các lệnh yêu cầu nhập kín mật khẩu/câu xác nhận ở terminal; không truyền
mật khẩu qua command line. Tên tài khoản từ 3–32 ký tự thường/số/_/-,
bắt đầu bằng chữ, khác `owner`. Reset mở lại tài khoản và thu hồi phiên cũ;
disable thu hồi phiên và ngăn đăng nhập mới.

Nhân viên được xem dữ liệu Admin và thông báo, nhưng không có quyền thay đổi
đơn, sản phẩm, giá, cấu hình, yêu cầu nhập, hoặc **đánh dấu đã xem**. Backend
kiểm soát quyền ghi; việc ẩn nút trên giao diện không phải biện pháp bảo mật.
Trạng thái Đã xem chung được lưu tại nguồn của sự kiện (local hoặc VPS).

Thông báo chứa tên khách và tiền hàng VND, chưa bao gồm phí vận chuyển.
Không ghi các trường khách hàng hoặc bearer secret vào log. Khi VPS offline,
unread từ VPS là **không xác định**. Chỉ kích hoạt relay khi đã xác minh
TLS, bearer token và Caddy route; không dùng mật khẩu owner làm relay token.
