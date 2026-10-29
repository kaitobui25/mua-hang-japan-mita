# Thuật ngữ nháp cho Grill mới — Mita Japan

**Trạng thái:** Đã nhận định nghĩa nghiệp vụ trong Grill 2/2; file là bổ sung độc lập trước khi gộp vào `GLOSSARY.md`. Chưa sửa code.

**Thông báo đơn hàng:** Tin báo cho chủ cửa hàng hoặc người nhận được chỉ định sau một sự kiện đơn hàng có thật đã lưu vào PostgreSQL. Không đồng nghĩa xác nhận đã thanh toán.

**Tin nhắn khách hàng:** Cuộc hội thoại khách gửi qua Zalo/Facebook tới tài khoản doanh nghiệp, tách biệt luồng notification ra cho owner.

**Lượt mua Amazon:** Chỉ số do Amazon hoặc nguồn được phép cung cấp cùng kỳ quan sát; chưa xác nhận có số đơn chính xác theo năm. Không được suy từ thứ hạng bán chạy.

**Thứ hạng Amazon (BSR):** Vị trí tương đối của ASIN trong danh mục Amazon tại thời điểm quan sát; số hạng nhỏ hơn biểu thị vị trí cao hơn, nhưng không chỉ ra số đơn.

**Lượt mua Mita:** Số đơn thực tế qua checkout Mita theo quy tắc tính đã định; không phải doanh số Amazon.

**Đánh giá sao Amazon:** Điểm trung bình sao; không cùng đại lượng với số bài bình luận bằng chữ.

**Lượt đánh giá Amazon:** Số lượng ratings/reviews với nhãn được chứng minh chính xác từ nguồn. Không tự gọi tổng đánh giá mọi năm là số bình luận năm 2026.

**Ảnh hội thoại minh họa:** Hình dựng nhằm thử bố cục và văn phong, có nhãn demo rõ ràng; không phải bằng chứng khách thật đã mua.

**Lời chứng thực đã được phép:** Nhận xét/ảnh thật có nguồn, sự đồng ý sử dụng công khai, đã làm mờ dữ liệu riêng tư và có cách thu hồi.

**Nút chat Zalo/Facebook:** Liên kết mở hội thoại khách với số Zalo cá nhân hoặc Fanpage, khách tự gửi, nhân viên trả lời trong app gốc. Không phải thông báo máy gửi tự động.

**Thông báo nội bộ sau đặt hàng:** Sự kiện phát khi checkout lưu đơn thật thành công, đơn ở trạng thái chưa thanh toán; hiển thị cho owner và người nhận được cấp quyền ở Admin/Windows GUI. Mỗi event có idempotency; gửi ra Zalo/Facebook phụ thuộc API/quyền riêng.

**Top 100 theo danh mục:** Tối đa 100 sản phẩm đủ bằng chứng trong mỗi danh mục hiện có, chọn theo review count giảm dần. Không dùng số lượt mua/BSR; nếu nguồn chỉ có ít hơn 100 sản phẩm được chứng minh thì hiển thị ít hơn.

**Review hợp lệ theo năm:** Bài bình luận có ngày đăng thuộc năm hiện tại Asia/Tokyo; ưu tiên ít nhất 2 bài có nhãn Verified Purchase, nếu không đủ thì chấp nhận ít nhất 2 bài bình luận thường trong năm. Không suy từ tổng số rating.

**Tổng lượt review:** Count bài bình luận văn bản có nguồn và thời điểm quan sát; độc lập với count lượt chấm sao. Chỉ dùng tên này cho đúng đại lượng.

**Số lượt chấm sao (rating count):** Số người đã đánh giá bằng sao do Amazon công bố; có thể khác số bài bình luận. Nhãn và sort phải phản ánh loại số liệu thực có.

**Tên tiếng Việt rút gọn:** Tên dễ đọc phục vụ card/detail, được tạo từ tên nguồn với brand và đặc tính phân biệt cần thiết, không tự viết công dụng.

**Phần tên được lược:** Các mảnh từ tên Amazon gốc không hiển thị trong tiêu đề ngắn, được giữ cùng nguồn/bản dịch ở cuối thông tin sản phẩm và trong chỉ mục tìm kiếm.

**Bộ ảnh review từ thư mục:** Tập ảnh owner đặt vào thư mục kiểm soát, được xác minh định dạng và đồng bộ đến web. Ảnh demo có watermark, ảnh thật cần quyền đăng; file được lưu local không mặc nhiên đã public trên VPS.
