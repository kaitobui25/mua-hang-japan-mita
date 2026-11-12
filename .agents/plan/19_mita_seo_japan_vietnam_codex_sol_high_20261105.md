# Mita Japan — Kế hoạch SEO Việt Nam/Nhật Bản (Codex GPT-6.1 Sol · High)

**Ngày lập:** 05/11/2026 JST  
**Repository HEAD được đánh giá:** `33ada65`  
**Phạm vi:** Lập kế hoạch, kiểm chứng và so sánh; chưa triển khai code, cấu hình, cơ sở dữ liệu hoặc Search Console.

## 1. Mục tiêu và sự thật đã kiểm chứng

- Mục tiêu tìm thấy website `https://mitajapanshop.duckdns.org/` với `mita japan`, `mitajapan`, `mitajapanshop` và những truy vấn mua hộ Amazon Nhật tại Việt Nam và Nhật. Không hứa trang 1 hoặc thời hạn xếp hạng.
- Trang chủ đã được Google lập chỉ mục. Trong thử nghiệm Google Nhật (`gl=jp&hl=ja&pws=0`), `mitajapanshop` có kết quả trang chủ ở trang 1; `mita japan` chưa được thấy ở hai trang đầu trong các phép thử. Đây là kết quả của cấu hình truy vấn, không áp dụng cho tất cả người dùng.
- GSC Sitemaps hiện `Unknown / Couldn't fetch`, chưa ghi nhận URL được khám phá. Google URL Inspection Live Test 02/11 từng fetch sitemap thành công. XML đối chứng có **840 URL duy nhất (832 sản phẩm)**, trả HTTP 200, phản hồi khoảng 7–9 giây. **Không có chứng cứ Google thực sự bị timeout**. Caddy Mita chưa cấu hình access log có thể đối chiếu yêu cầu Googlebot.
- `src/app/sitemap.ts` sử dụng `force-dynamic`, gọi catalog và nhiều chi tiết sản phẩm qua API, có thể thất bại khi một yêu cầu lỗi. `/mua-ho-amazon` đang **không có** trong sitemap.
- SEO title trang chủ **đã có** `mita japan`; H1 chỉ chứa khẩu hiệu. Header **đã liên kết** `/mua-ho-amazon`. Trang Amazon có form/metadata nhưng ít nội dung giải thích dịch vụ trong HTML ban đầu. `FeaturedProducts` tải danh sách sau hydration, nên HTML ban đầu thiếu liên kết đến bốn sản phẩm nổi bật.
- Website đang phục vụ chủ yếu nội dung tiếng Việt, hiển thị VND và thông tin vận chuyển tới Việt Nam. Không suy diễn đã hỗ trợ giao hàng nội địa Nhật.

## 2. Các quyết định chủ website phải được giữ nguyên

- `docs/mita-ux-seo-20261030.md`: **giữ Hallmark Garden**, không redesign; các trang công khai được phép index theo quyết định đã duyệt; Admin noindex.
- **Catalog Mita:** Khi ASIN được yêu cầu không mua được mà có sibling hợp lệ, website hiện tự chuyển URL sang sibling, ưu tiên giữ kích cỡ. **Đây là hành vi chủ website đã duyệt**, không tự đảo ngược. Có rủi ro khác biệt hương vị; đề xuất rà lại chính sách khi chủ website muốn thay đổi. Chỉ sửa canonical/sitemap sao cho đúng URL đích trong khi chờ quyết định.
- **Mua hộ Amazon:** Không được tự đổi biến thể/offer của ASIN hoặc URL Amazon do khách nhập, theo `.agents/plan/18_mua_ho_amazon_ui_grill_chot_20261103.md`. Hai luồng catalog và mua hộ Amazon là khác nhau.
- Không tự đổi `index/noindex` của giỏ hàng, thanh toán hay trang công khai khác khi chưa có quyết định mới; không bịa chứng nhận kinh doanh, địa chỉ, giao hàng, review, giá hoặc dữ liệu sản phẩm.

## 3. Kế hoạch triển khai tối thiểu theo thứ tự

### G0 — Chốt chứng cứ trước khi sửa (ưu tiên ngay)

1. Ghi baseline GSC: property chính xác, Sitemaps chi tiết, Crawl Stats, URL Inspection các URL `/`, `/mua-ho-amazon` và mẫu ASIN; phân biệt tình trạng index với xếp hạng. Lưu ngày, quốc gia, query, URL. Không lặp resubmit chỉ để đổi trạng thái.
2. Khi được chủ website cho phép chỉnh cấu hình VPS, cấu hình **access log Mita có kiểm soát** để quan sát `/sitemap.xml`: status, elapsed, upstream, timestamp, lọc thông tin riêng tư; không tác động E-KAIWA. Xác minh Googlebot thật bằng nguồn Google đáng tin cậy trước khi quy kết request.
3. Chốt tập URL được phép trong sitemap: home, catalog/danh mục, hướng dẫn, đánh giá, Amazon service, ASIN công khai; tôn trọng quyết định hiện hành về giỏ và checkout, tránh redirect không cần thiết và URL truy vấn quote cá nhân.

**Đạt:** biết cái gì là lỗi HTTP/crawl đã quan sát, cái gì là GSC pending; có bảng quy tắc URL và trạng thái chủ website duyệt. Nếu chưa có request log lịch sử thì ghi rõ không thể suy ra nguyên nhân cũ.

### G1 — Sửa nguồn sitemap, không dựng thêm hệ thống phức tạp (P1 kỹ thuật)

- `src/app/sitemap.ts`, `src/lib/server-catalog.ts`, `backend/src/catalog.ts` và endpoint đọc công khai liên quan: thay bước `catalog nhóm -> gọi detail từng nhóm -> lấy siblings` bằng **danh sách ASIN public tối giản**, dùng đúng điều kiện công bố/ẩn hiện và chính sách ASIN; cân nhắc kết quả khác nhau giữa một URL truy cập được và một URL phải redirect.
- Cân nhắc cache/snapshot XML chỉ **nếu phép đo sau tối ưu cho thấy cần**. Không tự tạo worker/scheduler mới hoặc tăng concurrency/timeout thay cho điều tra.
- Không trả XML rỗng hoặc thiếu sản phẩm với HTTP 200 khi API lỗi. Bổ sung `/mua-ho-amazon` sau khi landing đáp ứng nội dung tối thiểu. Giữ Google verification handler độc lập.
- Test giả lập API lỗi, thiếu ASIN, biến thể, sản phẩm ẩn, thay đổi policy công bố; so sánh toàn bộ ASIN public dự kiến với sitemap. Đo TTFB ở quy mô thực, không crawl song song làm nặng VPS.

**Đạt:** sitemap hợp lệ, trả HTTP 200 ổn định, không hydrate chi tiết từng nhóm, không rò rỉ ASIN ẩn, không mất variant public, không tạo sitemap rỗng thành công. `Success` trong GSC được theo dõi như **điều kiện bên ngoài**, không thể bảo đảm chỉ bằng test code.

### G2 — Sửa tính khám phá và nội dung landing (P1)

- `src/components/catalog/catalog-view.tsx`, `src/app/(store)/san-pham/page.tsx` và trang danh mục: dùng link `<a href>` cho phân trang thay vì chỉ có button, tạo canonical đúng cho trang 2+ có nội dung riêng. Kiểm tra search/sort và trang out-of-range theo chính sách, không để vô hạn URL rỗng được index.
- `src/components/catalog/featured-products.tsx`, `src/app/(store)/page.tsx`: đưa 4 link sản phẩm nổi bật vào HTML render từ server nếu phù hợp tải VPS và fallback, giữ nguyên card Garden.
- `src/app/layout.tsx`, `src/app/(store)/page.tsx`: H1/mô tả thân thiện với cả người đọc lẫn Google, nêu **Mita Japan** và hoạt động thật. Giữ khẩu hiệu “Chăm chút từng điều nhỏ” ở cấp phụ, không spam từ khóa hay đổi concept giao diện.
- `src/app/(store)/mua-ho-amazon/page.tsx`, `src/components/amazon/amazon-quote-view.tsx`: bổ sung giới thiệu dịch vụ, cách nhập URL/ASIN, báo giá, phí, thời hạn, giao về Việt Nam, điều kiện chưa xác minh, link hướng dẫn. Nội dung public phải hiện từ HTML ban đầu mà **không gọi báo giá Amazon**; giữ auto-quote hợp lệ khi người dùng nhập link. Thêm canonical về landing gốc khi truy cập query `input` nếu phù hợp policy.
- `src/components/layout/footer.tsx`: cân nhắc một link “Mua hộ Amazon Nhật” có ích, **không bổ sung lại ở header** vì đã có.

**Đạt:** HTML không cần JS có trang chủ/link sản phẩm và nội dung Amazon hữu ích; trạng thái search/quote, thanh toán và hoạt động mobile không thay đổi. Đánh giá H1 trên 390px, keyboard/focus, CTA và đúng thông tin vận chuyển.

### G3 — Tính chính xác sản phẩm và metadata (P1/P2)

- `src/lib/preferred-variant.ts`, `src/app/(store)/san-pham/[id]/page.tsx`, product detail: **không đổi quy tắc tự chọn sibling đã duyệt** khi chưa được chủ website duyệt lại; rà trường hợp đổi hương vị và bảo đảm URL cuối, H1, ảnh, kích thước, giá, canonical đồng nhất. Nếu quyết định thay quy tắc, cần plan riêng và test cả server/client/backend.
- Ưu tiên sửa mô tả sai về **thành phần, độ tuổi, cách dùng, cảnh báo** từ nguồn đã được xác minh, đặc biệt nhóm thực phẩm trẻ em. Cơ chế lịch sử chỉnh tên đã tồn tại: dùng lại; không giả định workflow sửa tên cũng sửa được nguyên liệu/hướng dẫn.
- Metadata: mô tả sản phẩm theo dữ liệu đúng nguồn, title dễ đọc và không mất thông tin variant, canonical theo URL thực; category descriptions riêng. Sau đó bổ sung `WebSite`/`Organization` và breadcrumb JSON-LD với dữ liệu xác thực; Product/Offer và ratings chỉ khi đủ điều kiện và phù hợp chính sách quyền dữ liệu.
- Có thể thêm OG/social metadata trong cùng đợt thay metadata; không gọi đây là biện pháp chính giúp rank.

**Đạt:** test URL/ASIN direct-load, redirect, reload, catalog group, canonical và factual fields; metadata/JSON-LD khớp giao diện và nguồn. Không làm thay đổi nguồn, lịch sử dịch hay điều kiện checkout.

### G4 — Đo kết quả và Nhật Bản (liên tục sau khi triển khai)

- GSC Performance lọc **Japan** và **Vietnam**, lần lượt `mitajapanshop`, `mita japan`, `mitajapan`, cụm dịch vụ Amazon và landing page; tách impressions, CTR, vị trí, index status.
- Tăng tín hiệu thương hiệu thật từ các kênh Mita chính thức, cộng đồng phù hợp; không mua link/spam hoặc tạo địa chỉ Nhật giả.
- Nếu phục vụ **người Việt tại Nhật**, giữ tiếng Việt và giải thích dịch vụ hỗ trợ thật. Nếu có khách **dùng tiếng Nhật**, chỉ làm trang `/ja/` thử nghiệm khi xác nhận hỗ trợ giao dịch/ngôn ngữ; triển khai URL dịch riêng, self-canonical và `hreflang` đối ứng cho các trang tương đương. Không dịch cả 832 URL sản phẩm ngay.

**Đạt:** có số liệu chia theo quốc gia, URL và thời gian; không dùng vài SERP snapshot để cam kết trang 1.

## 4. So với kế hoạch 5 bước trước

| Kế hoạch trước | Điều chỉnh của Codex Sol High + UI/UX Pro Max + Hallmark |
| --- | --- |
| 1. Sửa sitemap | **Chèn G0 xác định nguyên nhân**, kiểm kê chính sách index trước; ưu tiên API danh sách ASIN nhẹ thay vì xây snapshot/worker ngay. |
| 2. SEO tên thương hiệu trang chủ | Giữ title vốn đã có `mita japan`; điều chỉnh H1/copy gọn trong **Hallmark Garden**; bổ sung link sản phẩm SSR. |
| 3. SEO trang Amazon | Header đã có link; trọng tâm mới là **landing nội dung HTML thật**, canonical query và không kích hoạt quote khi crawler đọc nội dung. |
| 4. SEO sản phẩm | Tách **quyết định variant đã duyệt** khỏi lỗi URL/SEO, thêm sửa nội dung thực phẩm sai, title revision hiện có và phân trang crawlable. |
| 5. Theo dõi thứ hạng | Cần giữ nguyên, nhưng xác định **Nhật là vị trí của người dùng** chứ không tự động là mục tiêu tiếng Nhật; Google xử lý sitemap và Google rank là hai mục tiêu khác nhau. |

## 5. Thiết kế, kiểm chứng và phát hành

- **Hallmark / UI/UX Pro Max:** giữ `designs/02-family/tokens.css`, `base.css`, `src/app/globals.css`, Garden layout/nav/CTA/form states, focus-visible, reduced motion và responsive. Không tự sinh theme, đổi font/màu, chèn hình giả hoặc bằng chứng khách hàng giả. Audit mobile danh sách sản phẩm tên dài trước khi rút gọn: không được mất flavor, số lượng, quy cách.
- **Kiểm thử trước triển khai:** lint/typecheck frontend, backend typecheck nếu có thay đổi, unit/fixtures cho sitemap và variant/pagination/metadata; backend test chỉ qua runner DB disposable đã xác minh. Xác thực schema live **chỉ đọc** trước khi ship code phụ thuộc DB, theo `AGENTS.md`.
- **Phát hành:** review diff, kiểm tra local rồi kiểm tra stage/live trong phạm vi chủ website duyệt; không đụng E-KAIWA/DB/worker. Chỉ sử dụng push `[deploy]` khi được cho phép riêng. Giữ phương án rollback về release trước và đối chiếu HTTPS, robots, sitemap, ASIN, Amazon flow.
- **Phụ thuộc quyết định:** (a) Có đổi hành vi chuyển sibling catalog không? Mặc định **không**; (b) có đổi index giỏ/checkout không? Mặc định **không**; (c) có phục vụ khách Nhật tiếng Nhật và giao nội địa Nhật không? **Chưa xác minh**, không triển khai `/ja/` lúc này.

**Trạng thái tại thời điểm lập plan:** chỉ lập tài liệu; chưa thay đổi logic website, môi trường hay GSC. Phải kiểm tra lại Git, live schema và Search Console ở đầu mỗi đợt thực thi.
