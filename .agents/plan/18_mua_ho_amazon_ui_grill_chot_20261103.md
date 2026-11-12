# Mita Japan — Chốt Grill Me UI mua hộ Amazon (03/11/2026)

**Trạng thái:** Đặc tả giao diện và kế hoạch triển khai đã chốt 6 lựa chọn ngày 03/11/2026. Đây là tài liệu kế hoạch, chưa phải lệnh sửa code/migrate/deploy. Yêu cầu trực tiếp mới nhất ưu tiên; các quy tắc nghiệp vụ trước đó trong `.agents/plan/14_mua_ho_amazon_grill_20261030.md` vẫn có hiệu lực nếu không xung đột. Backend Amazon đã có trong commit `0f193f2` và đã test local bằng mock/disposable DB; chưa xác minh nguồn Amazon thật và mặc định tắt `AMAZON_QUOTES_ENABLED`.

## 1. Sáu lựa chọn cuối cùng

1. **1A — Cùng trang:** Nhập link Amazon.co.jp hoặc ASIN -> tra báo giá -> thay vùng kết quả trên `/mua-ho-amazon` bằng **giao diện chi tiết sản phẩm như trang Mita**, không điều hướng sang `/san-pham/[id]`. Link từ ô tìm kiếm homepage tới `/mua-ho-amazon?input=...` phải khởi động tra báo giá (không buộc nhấn submit lần hai); trường hợp nhập tại trang Amazon dùng submit bình thường; hạn chế yêu cầu tra trùng.
2. **2A — Ảnh:** Dùng ảnh chính và gallery thumbnail khi có dữ liệu Amazon được phép sử dụng/xác minh được; nếu thiếu ảnh, dùng placeholder hiện có của Mita. Không dùng ảnh catalog theo ASIN để tự lấp dữ liệu thiếu.
3. **3B — Dữ liệu sản phẩm:** Hiện tên, thương hiệu (nếu có), mô tả, đặc điểm, thành phần, công dụng/cách dùng, lưu ý, thông số, điểm sao, tổng số đánh giá và nội dung đánh giá nếu **thực sự có nguồn được xác minh và quyền hiển thị**. Mục không có dữ liệu ẩn hoặc ghi rõ chưa có dữ liệu; không suy đoán hoặc tự tạo. Giữ nguyên giá trị nguồn với mã, thương hiệu, số liệu, đơn vị, seller, variant. Không nhầm đánh giá Amazon với điểm đánh giá Mita.
4. **4A — Phiên bản:** Chỉ phiên bản/offer được xác minh cho đúng URL/ASIN đầu vào; không tự chuyển variant; không hiển thị selector phiên bản khác. Chọn số lượng cần lấy quote tương ứng, không dùng giá/điều kiện của số lượng cũ.
5. **5B — Dịch Google miễn phí:** Không dùng Google Cloud Translation API yêu cầu bật billing, không dùng endpoint miễn phí không chính thức, proxy, CAPTCHA bypass hoặc scraper dịch. Hiển thị nội dung gốc trong trang chi tiết; có nút do người dùng bấm `Dịch bằng Google` mở giao diện Google Translate miễn phí cho văn bản/trang nguồn nếu có thể. Có `Xem nguyên văn`. **Không cam kết tiếng Việt tự động ngay bên trong Mita** với ràng buộc này. Khi Google Dịch không khả dụng, giữ nguyên dữ liệu nguồn và hướng dẫn người dùng. Không gửi dữ liệu khách hàng/đơn hàng đến Google.
6. **6A — Nguồn:** Có nút phụ `Xem sản phẩm gốc trên Amazon` (HTTPS amazon.co.jp đúng ASIN, tab mới, rel=noopener noreferrer). Không có liên kết sang sản phẩm catalog Mita, kể cả breadcrumb/CTA/SEO canonical; không import ngầm sang bảng catalog.

**Bằng chứng giới hạn dịch:** Google xác nhận Website Translator Widget ngừng được hỗ trợ từ 01/10/2026 (https://developers.google.com/search/blog/2020/05/google-translates-website-translator); Cloud Translation yêu cầu Cloud project + billing + credentials (https://docs.cloud.google.com/translate/docs/setup); Google Translate giao diện website cho phép dịch nội dung/trang trên một số thiết bị/khu vực (https://support.google.com/translate/answer/2534559). Không suy ra có official free API cho tích hợp dịch trực tiếp.

## 2. Bố cục giao diện chi tiết

- **Điểm vào:** Giữ form tìm URL/ASIN và khả năng nhập lại link trên trang Mua hộ Amazon; trạng thái loading có skeleton của detail, lỗi/throttled/blocked có thông báo và thử lại an toàn. Form homepage vẫn tự phân loại từ khóa -> catalog Mita; URL/ASIN -> luồng Amazon độc lập.
- **Breadcrumb:** `Trang chủ / Mua hộ Amazon / [ASIN]`, không tới `/san-pham` hoặc danh mục Mita.
- **Desktop:** Bên trái ảnh lớn + thumbnails nguồn; bên phải nhãn `Mua hộ Amazon Japan`, tên nguồn/Google dịch khi người dùng chọn, seller, variant, ASIN, rating/count nếu có, giá VND nổi bật, giá JPY nguồn, số lượng, thời hạn quote, ETA Amazon và Việt Nam, phí vận chuyển chưa xác định, xác nhận điều kiện và nút `Thêm vào giỏ`; nút xem Amazon là CTA phụ.
- **Mobile:** Một cột, ảnh trước thông tin, controls 44x44px+, label rõ ràng, chữ không tràn, CTA dễ thao tác, focus-visible, loading và lỗi đọc được bằng screen reader; hạn chế CLS và tải ảnh lớn.
- **Phần dưới:** `Thông tin sản phẩm` dùng cấu trúc hiện có (mô tả/đặc điểm/thành phần/cách dùng/lưu ý/thông số), `Đánh giá từ Amazon` chỉ khi có nguồn đáng tin cậy và điều kiện hiển thị phù hợp. Không có nội dung -> không dựng thẻ trống; nếu nhiều dữ liệu, có nút mở rộng.
- **Ưu tiên tính thật:** Không hiển thị ảnh giả, rating 0/5 hoặc phí 0đ như thể được xác minh. Nếu thiếu seller/offer/free-shipping evidence thì không cho đặt theo chính sách nghiệp vụ, dù vẫn có thể có thông tin sản phẩm để xem.

## 3. Những quy tắc nghiệp vụ phải giữ nguyên

- VPS tra **offer Amazon công khai không đăng nhập**, mua một lần, không Prime/coupon có điều kiện, phải xác minh **miễn phí giao tiêu chuẩn nội địa Nhật** cho đúng offer + số lượng; CAPTCHA/403/429/cooldown phải fail closed, không dùng cookie hay BrowserOS PC trong production.
- Giá nguồn JPY, giá bán VND đã gồm phụ phí Mita; phí về Việt Nam **riêng và chưa xác định**, không giả là 0đ. Amazon ETA thường nếu có, ETA tới nhà VN là ngày Amazon + N **ngày lịch** (Admin mặc định 7, cấu hình 0–90), giữ nguyên nguồn và snapshot; thiếu ETA vẫn đặt được với cảnh báo/xác nhận.
- Mỗi quote hợp lệ **15 phút**, snapshot server là thẩm quyền giá, seller/variant/qty. Đơn gửi thành công trong hạn giữ giá hàng; Mita chịu giá nguồn tăng sau đó. Hết hạn tại checkout phải refresh, so sánh điều khoản cũ/mới và khách xác nhận thay đổi trước khi gửi.
- Giỏ Mita hỗ trợ Amazon quote cùng catalog nhưng giữ tách biệt từng nguồn; không đổi quote thành catalog item. Checkout idempotent và xác nhận phí vận chuyển riêng sau khi Admin đề xuất, khách chấp nhận chính xác khoản phí trước khi áp dụng/thu.
- Không thay đổi API order snapshot, định giá, rules nguồn hay persistence như một hệ quả phụ của việc thiết kế giao diện.

## 4. Tình trạng code và những thay đổi dự kiến

- `src/components/catalog/product-detail.tsx`: có bố cục 2 cột, ProductImage/gallery, giá, variant, số lượng, CTA, metadata. **Không dùng nguyên component** vì bên trong fetch catalog, tự đổi URL `/san-pham`, canonical catalog và `add(catalog)`.
- `src/components/catalog/product-information.tsx` và `src/components/ui/product-image.tsx`: ưu tiên tái sử dụng hoặc tách phần render thuần, không kéo logic catalog sang Amazon.
- `src/components/amazon/amazon-quote-view.tsx`: hiện là form + bảng quote; đổi vùng sau khi tra thành detail layout mới, giữ các cảnh báo/consent.
- `backend/src/amazon-quote-source.ts`: hiện lấy title, seller, variant, price, ETA và **một ảnh**; chưa có thư viện ảnh, full description/specs, rating, review. Chỉ mở rộng parser dữ liệu tùy chọn trên **cùng nguồn đã được phép truy cập**, bảo toàn guards; thiếu field phụ không được làm sai báo giá hoặc tạo dữ liệu giả.
- `backend/src/amazon-quotes.ts`, `src/lib/amazon-quotes.ts`, `src/types/amazon-quote.ts`: bổ sung DTO display-only tùy chọn (ảnh, mô tả, điểm sao/count, reviews nếu được phép), validation và provenance; tách các điều khoản quote/checkout bất biến khỏi thông tin trình bày.
- `src/app/globals.css`: tái sử dụng Garden tokens và detail style, chỉ thêm CSS phạm vi trang Amazon; không redesign toàn website.

## 5. Kế hoạch triển khai theo thứ tự

1. **P0 — Xác minh nguồn và quyền sử dụng:** Kiểm tra thực tế HTML Amazon không đăng nhập trên vài ASIN đại diện về ảnh/gallery, detail, ratings/reviews và khả năng dùng thương mại; thử với guard, không vượt chặn. Chốt danh sách trường có thể lấy an toàn và hợp lệ. Nếu không có chứng cứ thì bỏ field đó, không điền giả. Kiểm tra nút Google Translate miễn phí ở trình duyệt thực tế; nếu không dịch được, không mô tả tính năng là dịch tự động.
2. **P1 — Backend bổ sung metadata:** Tách parser tùy chọn từ parser offer; thiết kế `display` data shape tối thiểu có provenance; giới hạn ảnh/nội dung/kích thước, sanitize text/url, không fetch từng ảnh/review bằng request riêng nếu chưa có cho phép. Giữ hành vi fail closed của giá và shipping. Test parser với fixture có/không đủ dữ liệu.
3. **P2 — UI chi tiết giống Mita:** Dùng gallery, ProductInformation, QuantitySelector, price/ETA/shipping/consent hiện có; auto quote từ homepage URL, xử lý nhập lại và loading/error; sửa breadcrumb/source link; không redirect/canonical sang catalog. Test desktop và mobile theo Garden.
4. **P3 — Google Dịch miễn phí và rating/reviews:** Nút `Dịch bằng Google` chỉ theo hành động khách, bản gốc luôn sẵn; không gây gửi PII. Render sao/count/review đúng dữ liệu thật, không dùng badge đánh giá catalog hay tự tạo nhận xét; nguồn/điều kiện sử dụng phải rõ.
5. **P4 — Nghiệm thu:** Frontend TypeScript, backend typecheck + test dùng disposable DB, E2E BrowserOS Neo từ homepage paste URL -> detail -> add quote -> cart -> checkout/refresh/consent; kiểm tra lỗi Google, thiếu ảnh/nội dung/rating, expired quote, block, ETA thiếu, accessibility mobile/keyboard. Test live Amazon riêng với mock E2E; chỉ xem xét release sau approval backup/migration/schema/source compliance. Không push/deploy/chạy migration active DB trong kế hoạch này.

## 6. Tiêu chí nghiệm thu UI trọng yếu

- Nhập link/ASIN hợp lệ ở trang Amazon hoặc homepage thì vào **detail mua hộ trên `/mua-ho-amazon`**, không tới catalog Mita; không yêu cầu submit lần hai từ homepage.
- Đúng layout/spacing/components như detail Mita; có ảnh/gallery khi xác minh, placeholder khi không; có phần thông tin và rating/reviews chỉ khi có chứng cứ phù hợp.
- Đúng một phiên bản từ URL, đúng seller/offer/qty, giá và các điều khoản server; thay quantity phải quote lại; cảnh báo và xác nhận có thể đọc được trên mobile.
- Nút xem Amazon mở đúng trang nguồn. Nút Google Dịch miễn phí mở công cụ công khai (nếu dịch khả dụng); khi không khả dụng vẫn xem nguyên văn, **không tuyên bố đã dịch tiếng Việt trong Mita**.
- Không có liên kết hoặc chuyển hướng `/san-pham/...` cho quote Amazon, không có dữ liệu catalog tự điền. Checkout/quote guard giữ nguyên kiểm thử.

**Điểm chưa bảo đảm:** Tính khả thi của metadata Amazon thực tế, quyền sử dụng ảnh/reviews trên website thương mại, và khả năng dịch trực tiếp **trong** Mita bằng Google miễn phí. Không tuyên bố hoàn tất ba điểm này trước khi có bằng chứng.
