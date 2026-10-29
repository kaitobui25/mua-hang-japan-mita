# ADR 0016 — Thông tin sản phẩm có cấu trúc, dễ đọc và trung thành nguồn

**Ngày:** 29/10/2026 JST. **Trạng thái:** Accepted (thiết kế; chưa thay UI).

## Bối cảnh

HTML Amazon có đoạn, tiêu đề, bullet và nhấn mạnh, nhưng Python parser hiện nối text(node.stripped_strings) thành chuỗi, làm mất rich formatting. Database và API chỉ có features/ingredients/usage/cautions string[] và specs key/value. Frontend đã có headings và list HTML, nhưng từng string có thể quá dài, thiếu đoạn và nhấn mạnh; field description riêng không có trong API.

## Quyết định

1. Trình bày theo mục: **Đặc điểm nổi bật, Thành phần, Cách sử dụng, Lưu ý, Thông số**. Mỗi mục có bố cục, bullet/paragraph hợp lý, nhấn mạnh từ khóa nguồn có căn cứ, icon cố định tiết chế; phần quá dài có thể thu gọn nhưng không ẩn vĩnh viễn cảnh báo.
2. Data contract bổ sung **semantic blocks** có type và text leaves được escape/sanitize: paragraph, bullet, strong/emphasis, key/value; tiếp tục hỗ trợ string[] legacy. Không render HTML Amazon thô, không dùng eval, không dựng claims/health benefit mới bằng AI.
3. Các khối văn bản dịch phải liên kết source snapshot/ASIN/slot tương ứng, giữ nguyên thứ tự; **giá trị specs** và thông số/yêu cầu sử dụng nguyên vẹn. Phần dịch đã có chỉ là text; migration có thể giữ original fallback thay vì giả định có metadata markup.
4. Frontend responsive/keyboard/screenreader/A11Y; heading không làm rối trang, accordion có aria và luôn có thể đọc warnings. Kiểm thử trên sản phẩm có detail ngắn và dài, biến thể, desktop/mobile.

## Bổ sung sau Codex CLI architecture review

- Mỗi block/leaf cần **ID ổn định** qua reorder, source_hash và provenance để mapping translation không bị lệch do slot index cũ. Schema/API/sync phải truyền semantic metadata đầy đủ; có version/fallback cho những sản phẩm chỉ có string[] cũ.
- Test đổi thứ tự block, specs key sau dịch bị trùng, giữ specs values byte-for-byte; kiểm thử end-to-end Python parser → PostgreSQL → daily sync → API DuckDNS → React với HTML fixture thực tế.

## Hệ quả và nghiệm thu

- Nếu HTML nguồn không có strong/emphasis thì không tự tạo nội dung mới; chỉ nhấn mạnh cấu trúc có căn cứ hoặc nhãn mục cố định.
- Nội dung nguồn cũ đã flatten không thể khôi phục rich formatting đầy đủ nếu không thu thập lại; không phát sinh live crawl ngoài lịch/permission.
- Nghiệm thu tối thiểu 5 ASIN DuckDNS: đoạn ngắn hơn và phân mục có thể đọc được, không mất các thông tin nguyên gốc quan trọng, không thêm claims, không biến đổi lượng/nguyên liệu/cảnh báo; public API và storefront tương thích khi một số sản phẩm chưa có block metadata.
