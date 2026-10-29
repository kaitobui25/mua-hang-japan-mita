# Mita Japan — chốt phạm vi UI/SEO (30/10/2026)

Nguồn: chủ website trả lời một lượt Grill with Docs, đối chiếu live DuckDNS qua BrowserOS Neo và code từ production `d54b85d`.

## Các quyết định

- **Không thiết kế lại website.** Giữ nguyên Garden, chỉ sửa các thành phần được yêu cầu.
- Dropdown `<select>` native dùng nền, viền, typography, focus và kích thước thống nhất với các token Garden; bao gồm storefront và Admin.
- Mở trực tiếp ASIN chưa đặt được nhưng có sibling đặt được: chọn sibling hợp lệ, ưu tiên giữ kích cỡ, chuyển URL đến ASIN thực. Vẫn hiện phiên bản không đặt được trong danh sách lựa chọn với trạng thái rõ; backend tiếp tục kiểm tra `canCheckout` theo ASIN.
- Không thay đổi nút thêm giỏ trên card nhóm: câu hỏi về hành vi card chưa được chủ website quyết định.
- Header desktop/mobile có Đánh giá khách hàng; Cách mua hàng nằm ở footer; giữ liên kết Đánh giá ở footer. Header desktop có kính lúp cạnh giỏ, bấm mở SearchForm hiện có.
- Chỉ cải thiện chuyển động **thư viện ảnh đánh giá khách hàng**; gallery ảnh sản phẩm giữ hành vi cũ. Ảnh minh họa vẫn ghi rõ là mô phỏng.
- Index tất cả trang công khai/sản phẩm Mita. Admin tiếp tục `noindex`. Trang sản phẩm có title/description/canonical theo dữ liệu; chi tiết và danh mục có dữ liệu render từ server; sitemap/robots công khai. Ảnh chính sản phẩm được ưu tiên tải.
- Không chỉnh nội dung dịch, nguồn Amazon, dữ liệu ratings, logic checkout, quyền hiện sản phẩm hoặc chế độ Strict Top100.
- Sau khi sửa: kiểm thử bằng BrowserOS Neo MCP (ít nhất 5 ASIN), kiểm thử code, rồi deploy DuckDNS qua CI `[deploy]`.

## Bằng chứng kiểm thử trước deploy

- B084MCDYF6: sản phẩm Cocoa 1kg không đặt được nhưng nhóm có biến thể khác đặt được; bản thử nghiệm tự chọn Natural 1kg (`B07N8H8WRB`). Server `307` từ B084MCDYF6 sang B07N8H8WRB và URL đích trả `200`.
- BrowserOS Neo trên bản thử nghiệm đã mở 5 ASIN: `B084MCDYF6`, `B07BZ9NR18`, `B08FTSH6KP`, `B08F63WK3Z`, `B087JZ84K7`; các trang có tiêu đề sản phẩm, CTA và liên kết Đánh giá trên header.
- Mục Đánh giá có 3 ảnh mô phỏng với nút/chấm điều hướng; thư viện vẫn cần nghiệm thu chuyển động cảm nhận bằng Neo trên bản release.
- TypeScript frontend và build đã biên dịch; build Windows dùng junction `node_modules` có cảnh báo đóng gói standalone symlink `EPERM` nhưng exit code 0; CI Linux sẽ làm phép kiểm tra release độc lập.

## Giới hạn

- Trạng thái `availability` chỉ là tình trạng hàng quan sát từ nguồn, không phải số lượng kho vật lý.
- Google có quyền quyết định có thực sự lập chỉ mục hay không; metadata và robots chỉ cho phép thu thập.
- Việc bật index không tự chứng nhận quyền sử dụng ảnh hoặc nội dung của bên thứ ba.
