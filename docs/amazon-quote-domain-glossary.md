# Mita Japan — Từ điển miền mua hộ Amazon Japan

**Trạng thái:** Accepted — định nghĩa nghiệp vụ ngày 04/11/2026, không phải chứng nhận code đã hoàn thiện.
**Tham chiếu:** `docs/adr/0019-amazon-paste-product-experience.md`, `docs/mita-domain-glossary.md`, `backend/docs/amazon-quotes.md`.

## Thực thể và ngữ nghĩa

| Thuật ngữ | Ý nghĩa và bất biến |
| --- | --- |
| Amazon purchase intent | Ý định khách tra/mua hộ từ URL/ASIN, số lượng; chưa phải quote hoặc đơn hàng. **Khái niệm nghiệp vụ**, không mặc nhiên thêm bảng DB. |
| Accepted Amazon input | ASIN 10 ký tự hoặc URL HTTPS `amazon.co.jp`/`www.amazon.co.jp` với đường dẫn sản phẩm; chấp nhận `/slug/dp/ASIN?tracking` dài theo ADR 0019. Không chấp nhận host mạo danh, HTTP, userinfo, port lạ hay short link chưa hỗ trợ. |
| ASIN extracted | Định danh 10 ký tự lấy từ đúng đường dẫn sản phẩm. Chỉ chứng minh URL đúng cú pháp; **không** chứng minh đã truy cập trang hoặc sản phẩm tồn tại. |
| Canonical source URL | `https://www.amazon.co.jp/dp/<ASIN>` không chứa slug/tracking; dùng để mở trang nguồn, không chứng minh quote hay quyền nội dung. |
| Source observation | Dữ liệu thực từ lần truy cập Amazon hợp lệ, gắn ASIN, nguồn, thời điểm, điều kiện và trạng thái; không dùng thông tin giả hoặc từ ASIN khác. |
| Source preview | Tên/giá tham khảo hay metadata nhìn được từ nguồn nhưng **chưa đủ** điều kiện offer; chỉ hiển thị nếu có quyền thích hợp, không cho thêm giỏ. |
| Cached catalog preview | Thông tin đã lưu ở catalog Mita; **không được dùng để lấp tên/ảnh/giá trên trang mua hộ Amazon** theo Q6 = B. Việc catalog Mita tiếp tục lưu dữ liệu riêng không bị ảnh hưởng. |
| Product metadata | Tên/thương hiệu, ảnh/gallery, mô tả, thành phần, cách dùng, thông số, đánh giá và ETA có provenance; nội dung vắng hoặc không có quyền công bố phải ẩn hay dùng placeholder thích hợp. |
| Display permission | Quyền xuất bản đã được backend xét duyệt theo **từng trường** và có tham chiếu chứng cứ; khả năng parse HTML hoặc tự tạo reference không xác nhận quyền thương mại. |
| Selected offer | Đúng ASIN, phiên bản, người bán, số lượng, giá **mua một lần**, tồn kho và giao tiêu chuẩn miễn phí Nhật **không cần Prime**; không trộn bằng chứng giữa các offer. |
| Verified quote | Snapshot server của offer đã xác minh, chính sách giá VND và điều kiện giao, có `observedAt`/`expiresAt`; tồn tại **15 phút**. Cho phép thêm giỏ khi đủ điều kiện; metadata trang trí không bắt buộc. |
| Product detail state | Kết quả `recognized_input`, `source_preview`, `verified_quote` hoặc lỗi nguồn; các mức bằng chứng khác nhau, không tự nâng từ preview thành quote. |
| Quote cart line | Dòng giỏ từ quote, riêng với dòng catalog cùng ASIN; thay số lượng/quote hết hạn cần tra lại và xác nhận thay đổi. |
| Amazon public delivery ETA | Ngày/khoảng ngày **giao thường** từ nguồn đúng offer, có thể thiếu; không xác nhận giao Osaka khi chưa có bằng chứng. |
| Vietnam delivery estimate | Ngày Amazon cộng N **ngày lịch** Admin cấu hình (mặc định 7, 0–90); là ước tính Mita, không phải cam kết. Thiếu ETA Amazon => không tạo ETA Việt Nam giả. |
| Vietnam shipping pending | Phí vận chuyển Nhật → tận nhà VN chưa xác định: `null` **khác** `0`. Đề xuất riêng sau và chỉ áp dụng/thu khi khách xác nhận. |
| Order submission | Khách gửi đơn được backend nhận hợp lệ, khóa snapshot giá hàng trong thời hạn quote; **không** có nghĩa Mita đã mua hàng từ Amazon. |
| Amazon purchase | Thao tác Mita mua thực tế tại Amazon; tách với đơn khách gửi, có rủi ro giá tăng Mita chịu theo chính sách. |
| Source gate | Khóa/cooldown toàn nguồn khi bị CAPTCHA, HTTP 403/429 hoặc giới hạn truy cập, có phạm vi DB/process rõ ràng. Không bỏ qua chỉ vì khách thử lại. |
| Retry eligibility | **Mốc sớm nhất được phép xem xét** tiếp tục truy cập theo trạng thái đáng tin; không phải giờ hết chặn hoặc cam kết dữ liệu sẽ đọc được. Nếu thiếu mốc đáng tin thì ghi chưa xác định. |
| Scheduled re-entry | Kiểm tra nguồn theo cửa sổ lịch/claim với guard hợp lệ và audit; chỉ bằng chứng thành công thực mới có thể mở khóa. Đồng bộ an toàn nếu có nhiều DB/process. **Chưa xác nhận đã có cho quote runtime**. |
| Support contact | Zalo/Messenger hiện có để khách tự liên hệ khi cần; không đồng nghĩa đã tạo request, đội hỗ trợ đã xử lý hay có queue mới. |

## Chuyển trạng thái

1. **Đầu vào trang mua hộ:** `nhập/dán → bấm nút hoặc Enter → validate → recognized_input | invalid_input`. Tại homepage, URL hợp lệ được chuyển đến trang mua hộ và khởi động tra như quyết định trước.
2. **Thông tin nguồn:** `recognized_input → source_reading → source_preview | verified_quote | blocked/cooldown | unavailable`. Chỉ khi nguồn thật được phép mới có nội dung mới; tên catalog đã lưu không được render để lấp trường thiếu.
3. **Giỏ/quote:** `verified_quote → cart → checkout_server_check → order`; nếu hết hạn thì `refresh → customer_confirm_new_terms` trước checkout; thất bại giữ dòng giỏ nhưng không cấp quyền đặt bằng quote cũ.
4. **Phí vận chuyển:** `unknown → proposal → customer_confirmed → final`; không ép unknown thành giá 0.
5. **Nguồn bị chặn:** `blocked → retry_eligible_time → scheduled_reentry → verified_success_or_still_blocked`. Trôi qua mốc thời gian **không** tự thực hiện re-entry.

## Bất biến và lựa chọn triển khai

- Mục tiêu đợt này là **thông tin sản phẩm + quote VND + thêm giỏ**. Các nhóm thông tin **ưu tiên** A/B/D/E không thay thế điều kiện seller/variant/giá bắt buộc để quote.
- Thiếu ảnh, mô tả, review **không cấm** quote nếu đủ offer và shipping; ảnh không được phép dùng thì hiển thị placeholder. Thiếu giá/seller/bằng chứng giao Nhật miễn phí **cấm** quote và giỏ.
- Q3 chỉ xác nhận **URL dài Amazon có slug `/dp/ASIN` và query** cùng input cũ; hỗ trợ short link/share text là **chưa chọn**.
- Q5 = A (hiện ASIN/lỗi/URL khi bị chặn); Q9 = A chỉ xác nhận kênh liên hệ **sẵn có**. Không tạo hàng đợi hỗ trợ mới.
- Q10 = B yêu cầu hiển thị thời điểm sớm nhất **nếu biết đáng tin**, ghi rõ không bảo đảm. Không thay source guard hoặc lịch retry vì mục đích UI.
- Q11 = A ưu tiên Windows local, Q12 = A nghiệm thu qua các trường hợp trong ADR 0019; không coi unit fixture là chứng cứ quote Amazon live.
- Quy tắc giá khóa 15 phút, phí VN sau và xác nhận, không nhập quote vào catalog, Google Dịch do khách bấm và các guard đọc nguồn kế thừa hai plan cũ.

## Những điểm chưa được chứng minh

Khả năng Scrapling đọc Amazon live sau gate; xác minh đúng one-time offer và miễn phí giao Nhật cho nhiều ASIN; giấy phép tái hiển thị ảnh/mô tả/rating; lịch phục hồi an toàn cho quote DB; hành vi frontend theo Q6 và Q10 **chưa được sửa** chỉ bởi việc chốt tài liệu. Không hứa dữ liệu mới, giá hay ngày giao nếu chưa có bằng chứng từ source.
