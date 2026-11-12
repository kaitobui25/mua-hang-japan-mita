# Báo cáo SEO audit — Mita Japan production

**Ngày kiểm tra:** 02/11/2026 (Asia/Tokyo)  
**Website:** https://mitajapanshop.duckdns.org/  
**VPS:** Hermes, release xác minh bằng SSH chỉ đọc `v0.4-5794a6887377` (`5794a68873770008ebc97fe0e08c49f552ad6ce8`).  
**Trạng thái:** audit read-only, **chưa sửa code, VPS, database, GSC hoặc deploy**.  
**Công cụ:** HTTP/PowerShell (giới hạn tốc độ), BrowserOS Neo MCP, Hallmark (đánh giá thiết kế hiện hữu), Codex CLI `gpt-6.1-sol` / `medium` (phản biện).  
**Khách hàng SEO ưu tiên:** người mua tại Việt Nam tìm sản phẩm Nhật bằng tiếng Việt.

## 1. Phạm vi và kết quả chính

| Chỉ số | Kết quả có bằng chứng |
|---|---:|
| Danh mục hiện công khai | 2 |
| Card theo API production: thực phẩm bổ sung / thực phẩm cho bé | 62 / 96 |
| Mẫu Top20 theo `ratingsCount` giảm dần | 20 / 20 card, tổng 40 |
| Sản phẩm thiếu `ratingsCount` trong 40 mẫu | 0 |
| Sản phẩm chưa đặt được nhưng vẫn giữ trong Top20 | 1 (`B084MCDYF6`) |
| URL sitemap duy nhất | 840 (832 URL sản phẩm, 8 trang chung) |
| URL đã kiểm tra HTTP/HTML | 51 (11 URL chung, 40 sản phẩm) |
| HTTP 200 / 307 / 4xx hoặc 5xx | 50 / 1 / 0 |
| URL có JSON-LD, Microdata `itemscope`/`itemtype`, Open Graph hoặc Twitter tags | 0/51 mẫu HTML |
| URL sản phẩm có `robots` index, follow | 40/40 |
| Kiểm tra DOM mobile 390px | 40/40 sản phẩm |
| Tràn ngang / ảnh hỏng trong mẫu mobile | 0 / 0 |
| Tiêu đề H1 cao hơn 200px ở mobile | 16/40 (cao nhất 462px) |
| Lượt kiểm tra timing qua BrowserOS | 6 sản phẩm, 3/danh mục |
| PageSpeed Insights/Lighthouse | **Chưa đo được:** PSI API trả 429 quota exceeded |
| Google Search Console | **Chưa có kết nối**, không có số liệu indexed/traffic thực tế |

**Quy tắc chọn:** truy vấn catalog công khai trên **production** với `sort=reviews` (`ratingsCount`, không phải `writtenReviewCount`); nhóm/card là một sản phẩm; tính cả sản phẩm công khai nhưng không đặt được; đồng hạng phá bằng ASIN đại diện tăng dần; bỏ giá trị thiếu, không tự điền vị trí. Hai danh mục có đủ 20 card đạt điều kiện. Dữ liệu ratings trong cả 40 mẫu có cờ `stale=true` (cũ hơn 24 giờ theo hệ thống). Có thể đổi theo thời điểm; CSV lưu ASIN/rank và timestamp nguồn.

**Độ bao phủ:** không GET 832 URL sản phẩm trong sitemap; không suy rộng tỷ lệ lỗi từ Top20 sang toàn bộ kho. Các trạng thái tìm kiếm/lọc/phân trang chỉ được kiểm tra mẫu giới hạn. Không kiểm tra dữ liệu riêng tư hoặc thực hiện đặt hàng.

## 2. Các phát hiện cần ưu tiên

### P0 — Không ghi nhận sự cố có bằng chứng đủ mức P0

Trong 51 URL được kiểm tra không có 4xx/5xx; các dịch vụ đã kiểm tra đều hoạt động. Điều này không chứng minh toàn bộ site không có vấn đề P0 ngoài phạm vi mẫu.

### P1 — Cần xử lý trước

**SEO-P1-01 — ASIN chuyển sang biến thể có nhãn hương vị khác.**

- URL: https://mitajapanshop.duckdns.org/san-pham/B084MCDYF6
- Bằng chứng: HTTP **307**, đầu trang nguồn ghi whey GronG **Standard Cocoa Flavor**. BrowserOS đi đến `https://mitajapanshop.duckdns.org/san-pham/B07N8H8WRB`, H1 đích chứa **“Không Hương Vị”**. ASIN ban đầu vẫn có trong sitemap.
- Rủi ro: người tìm sản phẩm vị cacao hoặc Google theo URL nguồn có thể gặp URL/biến thể khác hương vị. Bằng chứng chưa chứng minh sản phẩm vật lý đổi vị.
- Đề nghị: kiểm tra logic chọn sibling khi ASIN chưa đặt được; giữ danh tính biến thể và thông báo trạng thái đúng. Kiểm tra lại redirect, canonical và sitemap sau sửa, **không sửa âm thầm trong audit**.

**SEO-P1-02 — Nội dung thực phẩm, đặc biệt thực phẩm trẻ em, có lỗi dịch có khả năng gây hiểu sai.**

- `https://mitajapanshop.duckdns.org/san-pham/B0DN65R7G2`: meta description chứa câu tiếng Anh **“Ingredients are only made of scalp, red dice and water”**; không phải mô tả thành phần đáng tin.
- `https://mitajapanshop.duckdns.org/san-pham/B08FTTQKYF`: meta description tiếng Việt chứa **“Sử dụng máy xay sữa”**, cần xác minh với nguồn; không suy diễn đây là hướng dẫn chính xác.
- `https://mitajapanshop.duckdns.org/san-pham/B0C6X64277`: title/H1 chứa **“Cổ Trang 7 Loại Vitamin”**, mô tả còn xen tiếng Anh.
- Đề nghị: biên tập thủ công các phần tên, thành phần, hướng dẫn, độ tuổi và quy cách **dựa trên dữ liệu nguồn có quyền sử dụng**; ưu tiên thực phẩm cho trẻ, không tự viết lại công dụng.

### P2 — Ưu tiên SEO kỹ thuật, nội dung và cấu trúc

**SEO-P2-01 — Thiếu dữ liệu có cấu trúc.** Cả 51 HTML mẫu không có JSON-LD, Microdata `itemscope`/`itemtype`/`itemprop`. Đánh giá khả năng thêm `Product`, `Offer`, `BreadcrumbList`, `Organization` phù hợp với mô hình mua hộ, giá VND và trạng thái thật; chỉ dùng số rating Amazon nếu quyền công bố và quy định hiển thị phù hợp. Thiếu schema không đồng nghĩa Google không index.

**SEO-P2-02 — Thiếu Open Graph/Twitter metadata.** Không thấy `og:title`, `og:image`, `twitter:*` trên 51 HTML mẫu. Đề xuất dữ liệu chia sẻ URL theo từng trang, lấy ảnh/sự thật hợp lệ.

**SEO-P2-03 — Meta description chung.** 10/11 URL trang chung được kiểm tra có cùng mô tả “Sản phẩm Nhật Bản cho sức khỏe và bữa ăn của bé...”, gồm trang chủ, danh mục, giỏ và checkout. Tạo mô tả riêng có ích cho trang danh mục và hướng dẫn mua, không nhồi từ khóa.

**SEO-P2-04 — Title/H1 chưa nhất quán với tìm kiếm tiếng Việt.** Ví dụ `B06Y69FKT2`, `B0B9G4QR1M`, `B09BD5G8XQ` có title nhiều tiếng Anh; `B08F63WK3Z` có tên sản phẩm dài liệt kê hàng loạt vị; `B00C1BZAOW` chỉ có meta description “Túi retort”. Ưu tiên tên rõ thương hiệu–loại sản phẩm–quy cách, có bản dịch chính xác.

**SEO-P2-05 — Khám phá phân trang dựa vào button.** HTML `/san-pham?sort=reviews&page=2` có `<nav class="pagination">` với các **button “Trang trước / Trang sau”**, không có `href` sang trang 2/3 trong HTML. Trang 2 dùng canonical trang danh sách gốc. Kiểm tra chính sách cho phân trang thực (khác filter/sort), cung cấp liên kết crawlable nơi phù hợp; **sitemap đã giúp khám phá ASIN, nên chưa thể nói Google không tìm thấy toàn bộ sản phẩm**.

**SEO-P2-06 — Canonical trang chung chưa đồng đều.** Chưa thấy `<link rel="canonical">` trên `/`, `/danh-gia`, `/cach-mua-hang`, `/gio-hang`, `/thanh-toan`. Thiếu canonical tự thân không nhất thiết là lỗi indexing; đề xuất riêng cho các trang nội dung cần xuất hiện trên Google. **Giỏ và checkout đang `index, follow` và có trong sitemap**, cần owner xét chính sách SEO trước khi tự đề xuất `noindex`.

**SEO-P2-07 — Sitemap chứa URL có redirect trong mẫu.** `B084MCDYF6` nằm trong sitemap nhưng trả 307 khi truy cập. Nên đối chiếu toàn bộ mục sitemap với URL/canonical đích bằng **cách kiểm kê an toàn trong lần audit mở rộng**, tránh tự kết luận cả 832 ASIN bị ảnh hưởng. Một lượt lấy sitemap mất khoảng 9,5 giây do có thể gây tải nội bộ.

### P3 — Cải thiện UX và độ tin cậy

**SEO-P3-01 — H1 dài trên mobile.** 16/40 mẫu có H1 cao hơn 200px; `B08F63WK3Z` cao **462px** ở viewport 390px. Hallmark review screenshot cho thấy sản phẩm có H1 dài làm thông tin mua hàng bị đẩy xuống sâu. Ưu tiên rút gọn tên **phần hiển thị**, giữ đủ facts trong mô tả/chi tiết và SEO metadata theo chính sách owner.

**SEO-P3-02 — Mục tiêu bấm có vùng hiển thị thấp.** DOM đo 4 liên kết dưới 36px chiều cao ở mỗi trang, chủ yếu breadcrumbs và liên kết nguồn Amazon. Đây là **cảnh báo cần kiểm tra touch box thực tế**, chưa có bằng chứng accessibility thất bại toàn diện. Không coi các nút CTA chính là lỗi.

**SEO-P3-03 — Dữ liệu lượt đánh giá cũ.** 40/40 `amazon.stale=true` (theo API), cần giám sát tuổi và quyền công bố, nhưng không coi cờ stale là lỗi Core Web Vitals hoặc indexing.

## 3. Hallmark / BrowserOS Neo — Đánh giá thiết kế hiện hữu

- Screenshot production mobile: `mobile-home.png`, `mobile-long-title.png` (trang sản phẩm `B0C6X64277`).
- Trang chủ ở 390px có H1, thông điệp và nút “Khám phá sản phẩm” trong màn hình đầu tiên; không thấy tràn ngang. Điều này đáp ứng yêu cầu nhận diện mục tiêu chính, chưa phải chứng nhận toàn bộ Hallmark gates.
- Trang sản phẩm đặt ảnh chính trước H1; với các H1 dài khoảng 300px trở lên, người dùng phải cuộn xa mới đến thông tin mua. Ưu tiên thứ bậc thông tin và rút gọn nhãn thay vì redesign toàn bộ.
- 40/40 sản phẩm đã kiểm tra DOM mobile, không tràn ngang (`scrollWidth=390`) hay ảnh hoàn tất tải nhưng lỗi (`naturalWidth=0`). Không kiểm tra bằng thiết bị vật lý, từng breakpoint hay toàn bộ trạng thái tương tác. **Hallmark chỉ đánh giá, không sửa UI**.

## 4. Hiệu năng và dữ liệu Google

**PageSpeed Insights:** yêu cầu đo mobile được Google API từ chối HTTP **429**, thông báo hạn mức `Queries per day` đã hết. Dừng, không retry, không khai báo Lighthouse/CWV pass. **GSC:** không có connector đã kết nối, không xác minh được Google-indexed URL, traffic, Google-selected canonical hoặc CTR.

**Thay thế có giới hạn:** BrowserOS/Chrome thu Navigation Timing cho **6 sản phẩm** (3/danh mục) trên trình duyệt chạy từ PC, không throttle, không phải Lighthouse; các giá trị hiện ghi nhận:

- **TTFB phía trình duyệt:** từ **40 đến 232 ms** trong sáu lượt đo.
- **Load event:** từ **234 đến 495 ms**; phản ánh điều kiện trình duyệt/mạng của thời điểm thử, không phải tốc độ mobile thực tế tại Việt Nam.
- **LCP:** không có giá trị xác thực (`lcpBufferedMs` trống). **INP:** không đo. CLS từ observer buffered là 0 trong lượt đo nhưng không đủ điều kiện để tuyên bố CWV đạt.

Khi có PageSpeed/CrUX/GSC, đo lại 3–5 sản phẩm/danh mục (ưu tiên cùng 6 URL) và phân biệt Lab với field p75 LCP/INP/CLS. Không gửi tiếp tới API đang báo quota exceeded trong đợt này.

## 5. Rủi ro cho VPS và giới hạn

- Hermes có 954 MiB RAM, dùng chung với E-KAIWA. Baseline đầu: **239 MiB khả dụng**, swap **677 MiB**. Các lần quan sát giữa đợt HTTP/browser cho thấy khoảng **203–253 MiB khả dụng**, các dịch vụ `caddy`, `mita-web`, `mita-api`, `ekaiwa` và PostgreSQL hoạt động. Không ghi nhận lỗi 5xx trong các URL mẫu.
- Collector tuần tự khoảng **1 GET mỗi ≥5 giây**; sitemap chỉ lấy một lần; browser không chạy đồng thời với HTML collector; không có login/Admin, checkout POST, sync, Amazon scrape, DB write hay sửa service.
- Dữ liệu SEO của **Top20/card/danh mục**, không phải phép đo mọi ASIN. Sitemap chứa 832 ASIN nhưng chỉ kiểm tra HTTP 40 URL Top20; 11 URL còn lại là trang chung và trạng thái pagination đại diện.
- Cần phân biệt **lỗi do HTML production xác nhận**, **kiểm tra DOM mobile**, **đề xuất kỹ thuật**, **số liệu GSC/PSI chưa có**. Không tự đưa khách hàng, đơn hàng hoặc dữ liệu nhạy cảm vào báo cáo.

## 6. Đề xuất thứ tự xử lý (không sửa trong đợt audit)

1. **P1**: rà redirect ASIN đổi hương vị và lỗi biên dịch về thực phẩm trẻ em. Kiểm tra URL/vị/trạng thái thực tế và quyền dữ liệu.
2. **P2**: bổ sung dữ liệu có cấu trúc đúng mô hình mua hộ, OG, title/description tiếng Việt, canonical trang nội dung; xử lý discoverability phân trang và URL redirect trong sitemap.
3. **P3**: rút gọn tên hiển thị trên mobile, tăng vùng bấm của breadcrumb khi cần, giám sát tuổi dữ liệu rating.
4. **Đo bổ sung**: sau khi PSI/GSC có thể truy cập, kiểm tra Google-indexed URL, truy vấn Việt Nam và CWV; ưu tiên những URL đã kiểm tra để so sánh.

## 7. Chứng cứ, file kết quả

| File trong cùng thư mục báo cáo | Ý nghĩa |
|---|---|
| `categories.json`, `category_supplements.json`, `category_baby.json` | Response catalog production công khai |
| `top20_supplements.csv`, `top20_baby.csv` | Top20/rating/ASIN/canCheckout/stale theo danh mục |
| `robots.txt`, `sitemap.xml` | Response SEO cấp site |
| `http-seo-matrix.csv`, `html/*.html` | Status và HTML của 51 URL |
| `mobile-batch-0.csv` ... `mobile-batch-7.csv` | BrowserOS mobile 40 sản phẩm |
| `mobile-home.png`, `mobile-long-title.png` | Screenshot phục vụ Hallmark audit |
| `browser-perf-*.csv` | Timing sáu sản phẩm; **không phải kết quả PSI/CWV** |
| `findings.csv` | Issue register để xử lý theo ưu tiên |

**Phản biện độc lập:** Codex CLI GPT-6.1 Sol / medium đã rà số liệu trong CSV và nhận diện các vấn đề dịch thuật, redirect, metadata cũng như giới hạn thống kê. Quyết định về `noindex` giỏ/checkout, thay đổi biến thể và việc triển khai đều để owner phê duyệt, **không tự thực hiện**.

## 8. Bổ sung ngày 02/11/2026 — Đã kết nối GSC sau audit

Đây là cập nhật sau khi hoàn thành audit, **không sửa lại nhận định về dữ liệu GSC chưa có tại thời điểm chạy audit**.

- Google Search Console: đã tạo URL-prefix property `https://mitajapanshop.duckdns.org/` cho tài khoản Google do owner chỉ định (`nothink1315`), Google xác nhận **Ownership verified**.
- Phương pháp sở hữu: tệp xác minh HTML công khai `google9f4ef18a410618a7.html`; cấu hình **Mita-only** `/etc/caddy/mita.caddy` thêm handler tệp riêng, được validate rồi reload. Sao lưu trước sửa tại `/etc/caddy/mita.caddy.backup-before-gsc-20261102`. Tệp nằm tại `/var/lib/mita-google-verification/`; HTTP 200 và nội dung xác minh đúng. Phải **giữ handler/tệp này** để Google kiểm tra lại quyền sở hữu về sau.
- Đã gửi `sitemap.xml` qua GSC, Google báo **Sitemap submitted successfully**. Tuy nhiên **trạng thái sitemap trong GSC lúc kiểm tra là `Couldn't fetch`**, type `Unknown`, discovered 0. Đây **chưa phải thành công xử lý sitemap** và cần kiểm tra lại khi Google đọc xong; không tự kết luận đã được index.
- Đối chứng trực tiếp từ PC sau khi GSC báo trên: `GET https://mitajapanshop.duckdns.org/sitemap.xml` = **HTTP 200**, `Content-Type: application/xml`, XML hợp lệ **840 URL**, thời gian phản hồi khoảng **9,2 giây**. Trạng thái GSC có thể do xử lý chưa hoàn tất hoặc giới hạn của Google; cần kiểm tra lại nếu tiếp tục `Couldn't fetch`. Không quét lại mọi sản phẩm chỉ vì lỗi sitemap mới xuất hiện.
- Windsor.ai: đã đăng nhập bằng tài khoản Google trên, cấp OAuth Google scope `webmasters.readonly` và chọn đúng property URL-prefix; kết nối nguồn Search Console hiển thị **1 account selected**.
- ChatGPT: đã cài/bật plugin **W. Google Search Console** với tài khoản Windsor.ai Primary. Trong cuộc trò chuyện kiểm tra độc lập qua plugin, connector `searchconsole` trả về **1 property** chính xác. Truy vấn clicks/impressions 7 ngày **API status `done`**, **0 bản ghi**, không thấy lỗi. Số 0 lúc này nghĩa là chưa có dữ liệu trả về, **không phải chứng minh lưu lượng tìm kiếm bằng 0**.
- Windsor.ai hiển thị trạng thái **Trial**, quyền dùng thử đến **02/12/2026**. Không đăng ký thanh toán/gói trả phí.
- Sau thay đổi: kiểm tra cuối trên VPS, `caddy`, `mita-web`, `mita-api`, `ekaiwa`, PostgreSQL đều **active**, Caddyfile **Valid configuration**, khoảng 229 MiB RAM khả dụng. Không sửa ứng dụng, cơ sở dữ liệu hoặc thực hiện deploy.

**Việc còn chờ bên Google:** xác nhận GSC đọc sitemap thành công và dữ liệu lập chỉ mục/truy vấn bắt đầu xuất hiện. Không thể bảo đảm hoàn thành các bước xử lý bất đồng bộ này ngay trong ngày tạo property.

## 9. Đối chứng bổ sung trong GSC và Codex (02/11/2026)

- **Google URL Inspection — Live test** đối với `https://mitajapanshop.duckdns.org/sitemap.xml` tại 10:10 giờ Nhật: `URL is available to Google`, `Crawl allowed? Yes`, **`Page fetch: Successful`**, `Page can be indexed`. Google Inspection Tool dùng smartphone. Điều này xác nhận một lượt **Google thực sự lấy URL sitemap thành công**, nhưng chưa phải báo cáo Sitemaps parser xử lý thành công 840 URL.
- Bên ngoài: một lần `curl` gắn User-Agent `Googlebot` trả **HTTP 200**, **0 redirect**, TLS xác minh hợp lệ; **TTFB khoảng 7,73 giây**, tổng **7,75 giây**, tải 65.576 byte. Đây là UA giả lập, không đại diện Googlebot thật. `robots.txt` trả HTTP 200 trong ~0,08 giây; không tìm thấy bản ghi DNS AAAA. Thời gian phản hồi sitemap dài đáng tối ưu riêng, nhưng chưa chứng minh timeout tại Google.
- GSC đã nhận **một lần gửi lại `sitemap.xml` sau live test** và báo `Sitemap submitted successfully`. Sau thao tác, GSC Sitemaps **vẫn hiện `Unknown / Couldn't fetch`, Last read trống, discovered 0**. Google có thể cần thời gian hoặc có lỗi cụ thể chưa hiển thị; tuyệt đối chưa gắn nhãn `Success`.
- GSC phần **Manual actions: No issues detected** và **Security issues: No issues detected**.
- Codex CLI GPT-6.1 Sol, medium, phản biện độc lập: chưa có căn cứ sửa production. Khuyên kiểm tra lại báo cáo sau khi Google có thời gian xử lý; nếu status thất bại kéo dài thì xác minh lỗi và tình trạng tải rồi mới thay đổi hoặc gửi lại, không gửi lặp/xóa sitemap ngay.
- VPS sau kiểm tra: `caddy`, `mita-web`, `mita-api`, `ekaiwa`, `postgresql@16-main` vẫn `active`, RAM khả dụng khoảng 223 MiB; không phát hiện cảnh báo sitemap/upstream được ghi vào journald thuộc hai unit web/caddy trong cửa sổ kiểm tra (không có nghĩa access log đầy đủ). **Không có thay đổi VPS trong lượt đối chứng này.**

**Kết luận:** Kết nối Google Search Console + Windsor.ai đã hoạt động và truy vấn read-only thành công; Google có thể fetch URL sitemap ở chế độ live. **Chỉ còn trạng thái xử lý sitemap Sitemaps report chưa đạt `Success` và dữ liệu GSC mới tạo chưa sẵn có**. Hai việc này phụ thuộc Google, không thể xác nhận đã xong khi báo cáo còn `Couldn't fetch`.

## 10. Đối chứng khi tiếp tục phiên (02/11/2026)

- Đọc lại `findings.csv` trong workspace: có đúng **12 phát hiện** (2 P1, 7 P2, 3 P3), trong đó `SEO-P3-02` vẫn ở trạng thái `needs_confirmation`; chưa thực hiện sửa SEO.
- Mở **tab mới** của BrowserOS Neo tới báo cáo **GSC → Sitemaps** cho đúng URL-prefix property Mita, không chỉ dựa vào tab cũ. Kết quả vẫn là `/sitemap.xml`: **Type `Unknown`**, **Status `Couldn't fetch`**, **Last read trống**, **Discovered pages `0`**. Mở trang chi tiết sitemap chưa thấy nguyên nhân cụ thể hiển thị trong phần nội dung truy cập được.
- Lượt Google URL Inspection live test lúc 10:10 JST trong mục 9 vẫn chỉ chứng minh Google fetch được URL ở phép thử trực tiếp; **không thay thế trạng thái xử lý sitemap**. Không gửi lại, xóa sitemap hoặc sửa production trong lượt đối chứng này.
- Các file đầu ra mở rộng trong plan (`url-inventory.csv`, `redirect-canonical-map.csv`, `sitemap-exceptions.csv`, `performance-lighthouse.csv`) **chưa có**. Không chạy lại crawler hay cố vượt hạn mức PSI 429.
