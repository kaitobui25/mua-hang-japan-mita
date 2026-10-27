# ADR 0011 — Bổ sung ảnh, bản dịch, mô tả và thuộc tính biến thể

**Trạng thái:** Accepted — owner chốt Q1–Q9 và cập nhật Q1 sang OpenRouter ngày 27/10/2026; xem `.agents/plan/07_mita_product_detail_enrichment_grill_plan.md`.

## Bối cảnh

Catalog hiện lưu một tên gốc và một ảnh URL cho mỗi ASIN; detail API chưa có bộ ảnh, mô tả đầy đủ, bản dịch tiếng Việt hoặc selectors thuộc tính. Trang hiện chỉ nhóm sibling khi quan sát được `parentAsin`/`sourceProductId`; giỏ đã ghi nhận ASIN riêng. Worker nguồn hoạt động trên Windows và VPS đọc PostgreSQL qua các API hiện hành.

## Quyết định

- **Ảnh:** tối đa 5 ảnh **thật** mỗi ASIN, ưu tiên high-res từ detail; chỉ lưu URL nguồn, **không cache file trên VPS** (Q7 A).
- **Dịch:** worker PC gọi **OpenRouter API** theo thứ tự 5 model free: `google/gemma-4-31b-it:free` → `nvidia/nemotron-3-ultra-550b-a55b:free` → `google/gemma-4-26b-a4b-it:free` → `thinkingmachines/inkling-small:free` → `nvidia/nemotron-3.5-lightning:free`. Khi model lỗi, timeout, limit hoặc JSON sai, thử model kế tiếp; không tự dùng model trả phí. **Không kiểm duyệt thủ công** (Q2); **không cho sửa bản dịch bằng Admin** (Q9 B). Chỉ gửi văn bản sản phẩm, không gửi thông tin khách hàng/khóa. Mọi nội dung nguồn được giữ riêng để đối chiếu, không tự thêm thông tin thiếu nguồn.
- **Tên hiển thị:** chỉ một tên, ưu tiên cách diễn đạt **tiếng Việt**, từ thiếu tương đương tiếng Việt mới dùng **tiếng Anh**, thiếu cả tiếng Anh mới để **tiếng Nhật**. Không thêm dòng tên Nhật thứ hai trên giao diện; vẫn lưu tên gốc và tìm kiếm được bằng tên gốc (Q3).
- **Thu thập:** lấy lại dữ liệu chi tiết **mỗi ngày** khi worker PC chạy, cap **200 ASIN duy nhất mỗi danh mục mỗi lượt**, bao gồm ASIN con (Q4 B, Q5 A). Quá cap được trì hoãn và ghi nhận; không được ngầm lấy quá giới hạn.
- **Biến thể:** chỉ gộp theo mã quan hệ xác minh được từ nguồn; ASIN con unique. Khi chọn biến thể, ảnh/giá/mô tả/availability và giỏ/đơn theo đúng ASIN; không cho Admin đoán/liên kết nhóm (Q6 A).
- **Mô tả:** chỉ lấy thông tin có cấu trúc: đặc điểm, thành phần, cách dùng, thông số, lưu ý/cảnh báo, thuộc tính; không thu trọn layout A+ (Q8 A).

## Hệ quả và ràng buộc

- OpenRouter free models là **dịch vụ từ xa**, có quota/rate limit và có thể bị đổi/tắt. PC đã có `OPENROUTER_API_KEY` (chỉ xác minh tồn tại); cần thử API thật. Inkling Small free có điều kiện dành cho agentic harness, phải tôn trọng và bỏ qua khi không được phép. Không chứa key trong Git, log hoặc prompt. Dịch lỗi/rate-limited phải giữ catalog hoạt động bằng nội dung gốc/fallback.
- **Không có duyệt thủ công** không đồng nghĩa AI được sáng tác: kết quả dịch phải đạt kiểm tra kỹ thuật, số liệu, định lượng, thương hiệu, mã sản phẩm và không tạo công dụng/khuyến cáo mới. Nguồn gốc và nội dung gốc lưu trong DB để đối chiếu.
- Chi tiết và giá chỉ được đánh dấu mới khi thu thập thành công; mất nguồn không xóa snapshot tốt. 403/429/CAPTCHA dừng theo quy tắc hiện có, không dùng BrowserOS Neo để vượt chặn.
- Quyền ảnh/văn bản Amazon vẫn là `local_test_only` trừ khi được xác minh độc lập. Không đổi public read-only, catalog visibility toggle, phân quyền Admin, checkout hoặc quyền DB.
- Dữ liệu ảnh vẫn được tải trực tiếp qua URL Amazon trong trình duyệt; ảnh nguồn có thể bị đổi URL, chặn hotlink hoặc thiếu độ phân giải. Không tự giả ảnh thay thế.
- Migration PostgreSQL mới phải additive/idempotent và thực hiện riêng trước commit `[deploy]`; VPS 1 GiB và E-KAIWA vẫn phải được kiểm thử. Không thêm backup theo quyết định owner hiện hành; rollback code không rollback DB.

## Thiết kế thực hiện

Tách worker thu thập detail hằng ngày và job dịch nền; thêm bảng `product_images`, `product_details`, `product_translations` liên kết qua ASIN; giữ `products.name` và `image_url` để tương thích. API hiển thị một tên theo quy tắc Việt → Anh → Nhật, gallery 5 URL, thông tin có cấu trúc và lựa chọn từng biến thể có thật. Thứ tự thực hiện: migration/API contract → ingestion → OpenRouter translation 5-model fallback → giao diện → QA/deploy. Chi tiết nghiệm thu ở plan 07.
