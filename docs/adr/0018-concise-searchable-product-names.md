# ADR 0018 — Tên sản phẩm tiếng Việt ngắn, phần lược giữ trong thông tin và tìm kiếm

**Ngày:** 2026-10-29 JST. **Trạng thái:** Accepted (quyết định chủ cửa hàng; chưa triển khai code).

## Vấn đề

Tên Amazon Japan dịch qua OpenRouter đang dài và cỡ chữ nổi bật quá mức ở card/trang chi tiết. Người mua cần thấy tên cốt lõi nhanh hơn, nhưng nội dung nguồn bị lược vẫn phải tìm kiếm được và đọc tại cuối thông tin sản phẩm.

## Quyết định

1. Translator OpenRouter free trả JSON có cấu trúc `asin`, `shortNameVi`, `omittedSegments` thay vì chỉ một tên dài. Tên ngắn ưu tiên brand, loại sản phẩm, thuộc tính nhận diện quan trọng; giữ dung lượng/quy cách/số lượng/phiên bản cần để phân biệt biến thể. Không tự thêm công dụng hay tự đổi đơn vị, con số, mã; không sử dụng API trả phí.
2. Mỗi segment bị gọt cần source excerpt, nội dung tiếng Việt tương ứng nếu dịch được, `source_hash`, mapping/position và metadata model/validation để đối chiếu; **không lấy 'tag' do LLM bịa ra**. Nếu không xác định nguồn hoặc làm mất dữ liệu an toàn quan trọng, giữ tên đầy đủ và ghi warning. Giữ toàn bộ tên Amazon nguyên gốc bất biến.
3. Hiện `shortNameVi` ở card và tiêu đề chi tiết với CSS nhỏ và responsive. Cuối phần **Thông tin sản phẩm** có mục 'Thông tin bổ sung từ tên gốc' bằng chữ nhỏ/nghiêng, hiển thị đủ các segment; phần cảnh báo/liều lượng quan trọng không được chôn ở cuối hoặc thu gọn.
4. Search PostgreSQL phải tìm từ khóa trên: **tên ngắn Việt, tên nguồn Amazon, bản tên Việt đầy đủ cũ nếu có, các segment còn lại (nguyên ngữ và bản dịch), brand, ASIN**. Tiếng Nhật/Anh/VN được chuẩn hóa; trùng dữ liệu không gây lặp kết quả; dùng index thích hợp, sort và pagination ở server.
5. Không rewrite tên trong đơn hàng cũ hoặc order snapshots; không xóa bản dịch đã success. Reprocess catalog có checkpoint/quota của model miễn phí, CAS theo `source_hash`, validation trước publish và kế hoạch backfill những tên lịch sử.
6. Không thay đổi policy warning hiện hữu của ADR 0013 (semantic toggle OFF mặc định, structural gate luôn bật). Validation omission là cổng riêng về tính đầy đủ dữ liệu nguồn; bất cứ thành phần không thể chứng minh đều phải nằm trong source full và fallback.

## Kiểm thử

- Brand, định lượng, số viên, liều lượng, dạng sản phẩm, child ASIN/variant và mã model không bị mất nghĩa; không rút gọn quá mức thành tiêu đề dễ gây nhầm.
- Dịch thất bại vẫn hiện tên nguồn; những phần còn lại hiện ở cuối và tìm thấy bằng search; từ khóa bị bỏ khỏi title vẫn tìm ra đúng ASIN.
- Một từ khóa trong name full/segment không sinh hai bản ghi; title ngắn có source_hash cũ không ghi đè snapshot mới.
- Kiểm tra hiển thị card/detail mobile, A11Y, search API, đơn hàng lịch sử và việc sync lên DuckDNS.
