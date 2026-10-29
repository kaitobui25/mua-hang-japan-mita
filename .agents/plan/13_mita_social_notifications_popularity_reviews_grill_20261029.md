# Mita Japan — Grill with Docs: thông báo đơn, độ phổ biến Amazon, cửa sổ Windows và review

**Ngày lập:** 2026-10-29 JST
**Trạng thái:** GRILL 2/2 — các quyết định sản phẩm đã được owner trả lời ngày 2026-10-29 JST. Chỉ chốt đặc tả, không triển khai code, migration, worker, deploy hoặc thay đổi dữ liệu.
**Phạm vi:** Mita Japan; tôn trọng các quyết định trước về checkout thật, Admin owner-only, source access, không tự backup và không đụng E-KAIWA. Những yêu cầu mới có thể sửa quyết định cũ sau khi owner xác nhận.

## Yêu cầu gốc cần giữ nguyên

1. Kết nối nhắn tin Zalo và Facebook; thông báo khi có người đặt hàng.
2. Một cửa sổ trên Windows nền đen có các tab tương tự Admin.
3. Hiển thị 100 sản phẩm Amazon bán nhiều nhất, có ít nhất 2 lượt khách mua và bình luận trong năm hiện tại.
4. Danh mục cho sắp xếp theo lượng mua và số bình luận giảm dần; mặc định theo lượng mua giảm dần.
5. Trang chi tiết có link sản phẩm Amazon gốc, hàng 5 ngôi sao nhỏ và số review Amazon trong ngoặc.
6. Một trang review khách hàng, có ba ảnh mẫu hội thoại cảm ơn trên Facebook.
7. Gom toàn bộ câu hỏi trong một lượt; Grill tối đa hai lượt chat. Hiện tại chỉ lập kế hoạch, không sửa code; không can thiệp các file đang thay đổi.

## Quyết định owner cuối cùng (29/10/2026, thay thế câu hỏi và lựa chọn nháp ở dưới)

| Mục | Quyết định mới, giữ nguyên ý owner |
| --- | --- |
| Q1 | Có **chat hai chiều với khách**, dùng link mở Zalo cá nhân và Fanpage Facebook hiện hữu để owner trao đổi; không yêu cầu inbox hợp nhất hoặc Meta App. |
| Q2 | Thông báo đơn mới cho **owner và nhân viên**. Hiện chưa chốt địa chỉ nhận hoặc provider push cho nhân viên. |
| Q3 | Phát sự kiện sau khi khách **nhấn Đặt hàng và backend lưu đơn thật thành công**, với họ tên, SĐT, địa chỉ hợp lệ. Không coi đây là thanh toán thành công. |
| Q4 | Đã có tài khoản liên hệ. Zalo là link `https://zalo.me/<số thật>` (ví dụ người dùng đưa ra là chưa hoàn chỉnh); Facebook dùng Fanpage sẵn có để khách tự nhắn. **Không dùng Meta App** trong phạm vi này. |
| Q5 | Gửi thông báo lỗi vào log, có fallback và cảnh báo Admin; khách có thể tự gõ bất kỳ nội dung chat nào. Không hạn chế nội dung hội thoại khách bằng mẫu đơn. |
| Q6 | App GUI Windows riêng, **nền đen/chữ trắng giống terminal**, có tab và thao tác được, **double-click khởi động**; dùng cùng dữ liệu API/DB với Admin theo hai chiều, cập nhật có kiểm soát xung đột. |
| Q7 | **100 sản phẩm cho mỗi danh mục hiện có** (2 danh mục), nguồn Amazon.co.jp; không mở danh mục mới. |
| Q8 | Một sản phẩm đủ điều kiện nếu có **ít nhất 2 bài review Verified Purchase được đăng trong năm hiện tại**; nếu không có 2 review verified thì chấp nhận **2 review thường trong cùng năm**. Không dùng rating sao đơn thuần thay cho bài review. |
| Q9–Q10 | **Bỏ toàn bộ yêu cầu số lượng mua**. Sắp xếp danh mục mặc định và Top 100 theo **số lượt review giảm dần**; có lựa chọn sort tương ứng trên UI. |
| Q11 | Làm mới một lượt/ngày theo giới hạn nguồn; nếu bị từ chối giữ **last-known + observed_at**, ghi trạng thái stale. |
| Q12 | Link bình thường tới sản phẩm Amazon Japan gốc, luôn hiện khi ASIN hợp lệ; không dùng affiliate bắt buộc. |
| Q13 | Hiển thị **hình 5 sao theo điểm thực** và số lượt Amazon review/rating cạnh tên ở card catalog và gần tiêu đề chi tiết, theo bố cục Amazon; lấy lại từ dữ liệu có căn cứ nếu đã tồn tại. |
| Q14 | Trang review ảnh dạng **carousel ngang, luôn tối đa 3 ảnh trong viewport**, ảnh giữa nổi, hai ảnh bên mờ; người dùng có thể di chuột/hover hoặc điều khiển qua trái/phải. Ảnh từ thư mục owner quản lý; ảnh mới hợp lệ xuất hiện trên web sau khi đồng bộ file. |
| Q15 | Owner sẽ cung cấp ảnh thật sau; hiện tạo thư mục và 3 ảnh mẫu để kiểm tra giao diện. Ảnh mẫu có nhãn `MINH HỌA – HƯ CẤU` để không thành chứng thực mua hàng giả. |
| Bổ sung | Tên OpenRouter dịch **rút gọn chỉ giữ phần chính**, giảm font hiển thị; những thành phần bị lược lưu thành các đoạn/tag có provenance, hiện ở **cuối thông tin sản phẩm chữ nhỏ, nghiêng** và được **tìm kiếm theo cả tên gốc, tên ngắn, tag**. |

### Giải thích phạm vi khi triển khai

- **Chat khách ↔ người bán:** nút mở Zalo cá nhân/Facebook Fanpage từ site; nội dung tin do khách chủ động nhập, người bán trả lời trong chính các ứng dụng đó. Deep link không đồng nghĩa API cho phép ứng dụng tự đọc hoặc tự gửi tin qua tài khoản cá nhân.
- **Thông báo hệ thống:** đơn thực sau DB commit sinh event bền và hiển thị ngay ở Admin/Windows GUI (đỏ badge + thông báo hệ điều hành khi có quyền). Fallback lỗi là Admin + nhật ký riêng và có retry bounded nếu sau này có provider đủ điều kiện. Tự động **gửi tin tới owner và nhân viên qua Zalo cá nhân/Facebook** chưa được chứng minh khả thi nếu không có API/ứng dụng được cấp quyền; đây là giới hạn cần owner xác nhận rõ, không giả là đã gửi.
- **Nhanh và đồng bộ hai chiều:** desktop và Admin dùng **một PostgreSQL/API duy nhất** (cơ chế auth phù hợp từng client), refresh và invalidation theo event/poll, optimistic version/audit khi ghi. App không lưu một database thứ hai. Đóng cửa sổ không dừng supervisor đang chạy.
- **Năm hiện tại:** tính `Asia/Tokyo` từ 01/01 đến thời điểm quan sát trong năm đó (2026 hiện tại); rollover sang 2027 tự đổi kỳ. Verified Purchase là thuộc tính của **từng review có ngày**, không phải ước lượng từ tổng sao. Fallback sang 2 review thường **cùng năm** nếu không đủ hai verified. Không có đủ bằng chứng thì ghi `unverified/unknown`, chỉ hiển thị tối đa số ASIN đủ điều kiện thực có; không tự bù cho đủ 100.
- **Review count để sort:** chỉ số có timestamp ở mức ASIN/biến thể; khi dữ liệu chứng minh được chỉ có số `ratings` thì nhãn phải là `lượt đánh giá sao`, không gọi là số bài bình luận. Ưu tiên số **bài review thực** nếu nguồn có, và không tổng hợp hai loại như một đại lượng. Khi chỉ xác minh 2 bài theo năm nhưng tổng chỉ số chưa có thì không bịa số lượng để xếp hạng.
- **Mặc định chi tiết để thiết kế:** dùng tổng số **bài review bằng chữ toàn thời gian** làm khóa sắp xếp, còn `2 review có ngày trong năm` chỉ làm bộ lọc. Xét tập ASIN có bằng chứng trong từng danh mục rồi chọn 100 số review cao nhất. Khi review count chưa đủ tin cậy thì loại khỏi xếp hạng có xác nhận, không tráo bằng tổng rating sao; ASIN có nhiều biến thể không tự cộng review parent vào tất cả child. Đây là giả định triển khai có thể đổi trước code.
- **Rollover:** ảnh hưởng đến bộ lọc year-qualified; snapshot 2026 không tự chứng minh eligibility 2027 khi chuyển ngày 01/01/2027 JST.
- **Review image folder:** bản nháp dùng `public/reviews/` với PNG demo; để **ảnh thêm vào folder tự xuất hiện trên VPS mà không deploy code** sẽ cần cơ chế đồng bộ/upload + chỉ mục file, kiểm tra MIME/kích thước, giữ quyền riêng tư và cache invalidation. Chỉ folder local thì chưa đủ.
- **Tên sản phẩm:** API trả `short_vi_name` để làm tiêu đề, `source_name` bất biến, `title_extra_segments` chứa nội dung đã bỏ (bản gốc và bản Việt nếu có, hash/provenance) để render đoạn cuối và tìm kiếm. Model trả JSON có cấu trúc, validation chống mất định lượng/brand/model/ASIN và claims; không tự xóa tên success đang dùng hoặc ghi đè order snapshot. Khi không chắc giữ bản tên đủ và báo warning. Target typography 1–2 dòng ở card, tiêu đề gọn trên detail, nhưng thông số trọng yếu vẫn phải thấy.

### Hai điểm xác nhận trước implement (không mở thêm phiên Grill lớn)

1. **Thông báo ngoài ứng dụng:** với Zalo cá nhân + Facebook Fanpage chỉ có đường dẫn chat, không thể đảm bảo **gửi tự động** cho owner/nhân viên trên điện thoại bằng API. Mặc định thiết kế thông báo ngay trong Admin/GUI + log/fallback nội bộ; nếu owner muốn push qua Zalo/Facebook tự động thì phải chấp thuận một kênh/API chính thức khác.
2. **Quyền nhân viên:** trước đây Admin chỉ có một owner. Mặc định chỉ owner có quyền thao tác GUI và Admin; nhân viên chỉ là đối tượng nhận cảnh báo qua các client đã được phân quyền. Muốn nhân viên tự mở app/đổi đơn thì phải thiết kế tài khoản và role riêng.

Các câu hỏi còn lại được giải quyết bằng nguyên tắc dễ kiểm chứng bên trên; không cần thêm một phiên Grill 15 câu nữa.

### Những chỗ code hiện hữu đã xác minh (read-only)

- `src/components/catalog/product-detail.tsx` chưa có phần hiện sao/review/link source; `product-card.tsx` cũng chưa có sao; `src/types/catalog.ts` và `backend/src/catalog.ts` chưa expose rating/review thành trường; mặc dù `sourceUrl` đã có trong API.
- `backend/src/catalog.ts` hiện sort mặc định theo `last_seen_at DESC`, frontend `catalog-view.tsx` là `newest`; search SQL chỉ tìm original name, brand, ASIN, translated name.
- `backend/src/translation/openrouter.ts` prompt giữ toàn bộ numbers/units; `jobs.ts` có cap 3 attempts và không ghi đè tên đã success; thay đổi sang tên ngắn và extras phải có quy tắc backfill/review riêng.
- Parser Python hiện lấy tên/ảnh/giá/detail; không thấy pipeline xác thực **ngày và Verified Purchase của từng review**. Trước khi thiết kế DB phải kiểm tra snapshot thực lưu và quyền thu thập dữ liệu. Không ép Amazon worker crawl ngoài lịch hay vượt chặn.

## Phân biệt dữ liệu quan trọng

| Khái niệm | Ý nghĩa | Có thể khẳng định từ nguồn hiện tại? |
| --- | --- | --- |
| Amazon Best Sellers Rank (BSR) | Vị trí tương đối trong danh mục và thời điểm quan sát | Có thể nếu nguồn hợp lệ cho phép; không tương đương số đơn |
| Amazon monthly bought badge | Chỉ báo lượng mua ước tính theo tháng nếu xuất hiện | Không phải số bán chính xác hay số mua từ đầu năm |
| Amazon rating average | Điểm sao trung bình của sản phẩm | Chỉ hiển thị khi có nguồn/giấy phép phù hợp |
| Amazon review count | Tổng số rating/review được hiển thị tại thời điểm quan sát, cần xác định nhãn chính xác | Không đồng nghĩa số bình luận viết trong năm |
| Amazon review 2026 | Bình luận được đăng trong năm 2026 JST, có thể kèm verified purchase | Không chứng minh tổng số đơn bán 2026 |
| Mita order count | Đơn thật trên Mita, có quy tắc loại QA/cancel/duplicate | Không thể gọi là lượt bán trên Amazon |

**Nguồn pháp lý/kỹ thuật cần kiểm tra trước triển khai:** chính sách Amazon Associates Nhật (trong một số trường hợp cấm sử dụng star ratings/reviews khi thiếu link được cấp qua Creators API); dữ liệu BSR không cung cấp exact annual purchases; Zalo OA OpenAPI/ZBS Template Message yêu cầu quyền và có thể có phí; Facebook Messenger Page API giới hạn loại người nhận/cửa sổ trao đổi. Không tự vượt CAPTCHA/403 hoặc tự phát sinh đánh giá giả.

## Câu hỏi lịch sử của phiên Grill 1 (đã được owner trả lời ở bảng trên)

1. Phạm vi Zalo/Facebook: chat hai chiều với khách, thông báo cho owner, hay cả hai?
2. Người nhận thông báo: chỉ owner hay thêm nhân viên/khách; kênh nào bắt buộc?
3. Mốc phát sự kiện đặt hàng: ngay khi ghi đơn pending_confirmation, khi owner xác nhận, hay cả hai?
4. Tài khoản/điều kiện: đã có Zalo OA, Facebook Page, Meta App hay cần chuẩn bị; có chấp nhận chi phí tin nhắn nếu nhà cung cấp yêu cầu?
5. Khi kênh nhắn tin lỗi: chỉ lưu Admin, hay thêm fallback được phép? Nội dung tin có bao gồm thông tin khách nhạy cảm hay chỉ mã đơn/tổng tiền?
6. Cửa sổ Windows: app desktop GUI riêng / wrapper nhúng Admin / console tối; chỉ hiển thị hay được thao tác; khởi động theo Windows, auth và phân quyền.
7. Top 100: 100 tổng hay 100 mỗi danh mục; danh mục hiện có hay bổ sung; phạm vi Amazon.co.jp.
8. 'Ít nhất 2 lượt khách mua và bình luận trong năm hiện tại': 2 đơn + 2 bình luận riêng, hay 2 review Verified Purchase đăng năm 2026, hay chỉ ít nhất 2 reviews tổng; yêu cầu chứng cứ.
9. Nếu không có exact annual units sold trên Amazon: dùng BSR/nhãn ước lượng mua tháng, dùng số đơn Mita, hay chỉ hiển thị khi xác thực đủ; cách diễn đạt public phải đúng.
10. Sắp xếp mặc định: mua Amazon (nếu đủ dữ liệu), BSR tăng dần, hoặc đơn Mita; lựa chọn riêng cho số bình luận và xử lý sản phẩm thiếu dữ liệu.
11. Xếp hạng và rating làm mới theo lịch nào; khi nguồn từ chối thì giữ last-known + timestamp hay ẩn số liệu thiếu căn cứ.
12. Link Amazon gốc: luôn hiển thị cho ASIN hợp lệ, dạng link thông thường hay affiliate nếu được phép.
13. Sao và số review Amazon: nguồn được cấp phép/Creators API hay link ra trang Amazon nếu không thể hiển thị hợp lệ; có yêu cầu phân biệt ratings với written reviews?
14. Trang review Mita: chỉ hiển thị ảnh được khách đồng ý, ai duyệt và cách ẩn/thu hồi?
15. Ba ảnh hội thoại: chỉ dùng demo có nhãn rõ ràng 'Hội thoại giả lập / Mẫu minh họa', hay sẽ thay bằng screenshot thật được xin phép trước khi public?

## Domain model sau quyết định (thiết kế, chưa tạo bảng)

- **OrderNotificationEvent:** order_id, event_type, emitted_at, recipient/channel, idempotency key.
- **NotificationDelivery:** provider, delivery state, attempt, last_error_safe, retry_after, provider_message_id (private); không chứa credential/PII trong log.
- **CatalogPopularitySnapshot:** ASIN, metric_kind, observed_value/rank, source_url/source_kind, observed_at, valid_until, year_scope; không pha lẫn Amazon và Mita metrics.
- **AmazonRatingSnapshot:** ASIN, average stars, rating count, written_review_count nếu có, observed_at, provenance, publication_rights.
- **CustomerTestimonial:** owner-approved source, media reference, customer consent, redaction status, published_at, revoked_at, is_demo; sample/demo không tạo bằng chứng mua hàng thật.
- **DesktopOperationsSurface:** giao diện riêng cho owner trên Windows, dùng authentication và API Mita hiện hữu.
- **AmazonReviewEvidence:** asin, review_id/source_id (nếu được phép), posted_at, verified_purchase, evidence_status, observed_at, source_ref, content rights. Tính qualifying-year counts từ từng bằng chứng thực.
- **ProductTitleSummary:** asin, source_hash, source_name, short_vi_name, omitted_segments[] (source + translated + identity), validation/issues, model, version; search bao gồm cả toàn bộ phần lược.
- **ReviewGalleryAsset:** file_id, filename, checksum, format, local/remote sync state, is_demo, consent/reference, publish_at, hidden_at; file mới chỉ công bố khi hợp lệ và owner có quyền.

## Phụ thuộc và thứ tự triển khai sau Grill (đề xuất)

1. Chốt ý nghĩa số liệu + quyền truy cập nguồn trước, vì quyết định cấu trúc bảng và cách hiển thị.
2. Thiết kế event thông báo tách khỏi transaction checkout; thất bại kênh không hủy đơn; chỉ gửi một lần cho mỗi order-event-channel.
3. Sử dụng catalog API/DB có sẵn cho sort/pagination, không xếp hạng client-side trên một trang 12 sản phẩm.
4. Windows surface dùng lại API/Admin hiện hữu nếu owner đồng ý; không mở Admin public.
5. Trang review chỉ công bố bằng chứng thật có đồng ý; mẫu sinh ra phải luôn nhận diện là minh họa.
6. Kiểm tra unit/integration, QA API và UI, kiểm chứng provider bằng credential hợp lệ, sau đó mới cân nhắc deploy nếu owner cho phép.

## Tình trạng thực hiện

- Đã đọc plan 12, ADR 0013–0016, 5 chatgptlog và code read-only.
- Đã nhờ Codex CLI rà soát riêng phiên 1 và tiếp tục rà soát câu trả lời trong phiên 2.
- Owner đã trả lời 15 câu và bổ sung yêu cầu tên gọn. Chưa chạy bất cứ kết nối Zalo/Facebook/Amazon nào, chưa sửa source code.
