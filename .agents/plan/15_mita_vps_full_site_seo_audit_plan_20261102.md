# Mita Japan — Kế hoạch audit SEO production: toàn site + Top 20 sản phẩm/danh mục

**Ngày lập:** 2026-11-02 (JST)  
**Trạng thái khi lập kế hoạch (02/11):** PLAN ONLY — chưa thực hiện audit tại thời điểm viết. Đã chốt 7 lựa chọn Grill Me ngày 02/11/2026.  
**Cập nhật hậu thực hiện (06/11):** Audit production ngày 02/11 đã được thực hiện; xem `reports/seo/20261102_production/production-seo-audit-20261102.md` và `findings.csv`. Các phần kế hoạch bên dưới được giữ làm đặc tả lịch sử, không thay thế kết quả kiểm tra thực tế.

**Đích duy nhất:** `https://mitajapanshop.duckdns.org/` đang phục vụ thực tế trên VPS Hermes.  
**Phối hợp:** Chat On Steroids chủ trì; Codex CLI `gpt-6.1-sol`, reasoning `medium`, phản biện và phân tích; BrowserOS Neo MCP sử dụng có chọn lọc khi thực hiện.  
**Tham chiếu phương pháp:** https://github.com/AgriciDaniel/claude-seo (checklist tham khảo, không chạy plugin Claude Code trong Codex).

## 0. Mục tiêu, phạm vi, giới hạn

Mục tiêu là kiểm tra SEO kỹ thuật của **các trang chung trên website production**, kết hợp kiểm tra **Top 20 nhóm/card sản phẩm có số lượt đánh giá (`ratingsCount`) cao nhất trong MỖI danh mục** về SEO kỹ thuật trang sản phẩm, nội dung, khả năng Google hiểu/index, schema và mobile. Đo PageSpeed/Lighthouse chuyên sâu cho **3–5 sản phẩm đại diện trong Top 20 mỗi danh mục**. Kết quả cuối là danh sách lỗi có bằng chứng và cách kiểm tra lại. Đây là audit theo mẫu Top 20 cho sản phẩm, không cam kết quét mọi trang sản phẩm của kho hàng.

- **Chỉ audit production**: hostname trên, các HTTP response công khai và thông tin read-only về dịch vụ/tài nguyên VPS Hermes khi được phép. Không audit môi trường local, local PostgreSQL, worker Windows hoặc máy phát triển.
- **Không sửa trạng thái trong đợt audit**: không sửa code, Caddy, DNS, dữ liệu, sitemap, robots, Search Console; không deploy, migration, restart, đăng nhập Admin, gửi đơn hàng, POST checkout, chạy sync hay Amazon scrape.
- **Phân biệt phát hiện thật và giả thuyết**. Các file repo/runbook chỉ giúp lập checklist, không chứng minh revision đang chạy. Trong các tài liệu lịch sử, checkout từng bị chặn nhưng release 0.4 đã mở gửi đơn `pending_confirmation` chưa thu tiền: phải xác minh chính sách live trong audit sau này, không suy diễn từ runbook cũ.
- **Giữ quyết định của owner**: trang công khai/sản phẩm phải có thể được xem xét index; Admin vẫn riêng tư. Giỏ hàng, thanh toán, lọc, tìm kiếm và phân trang là các nhóm cần **đề xuất chính sách index**, không tự đổi thành noindex trước khi owner quyết định.
- **Phạm vi đã rút gọn theo yêu cầu 02/11/2026:** kiểm tra các trang chung (trang chủ, danh mục, danh sách sản phẩm, hướng dẫn mua hàng, đánh giá, giỏ hàng, thanh toán và các dạng phân trang/query đại diện), cộng với **Top 20 nhóm/card sản phẩm theo `ratingsCount` ở mỗi danh mục**. Không chạy kiểm tra HTTP từng sản phẩm ngoài Top 20. `robots.txt`/`sitemap.xml` vẫn có thể kiểm tra cấu trúc và kiểm kê URL dạng offline mà không tải HTML của toàn bộ ASIN. Mọi kết luận và số liệu bao phủ ghi rõ là **Top 20/danh mục**.
- **Đã chốt cách xếp Top 20 (Grill Me 1B, 2A, 3A, 4A):** xếp số lượt đánh giá `ratingsCount` **giảm dần**; mỗi **nhóm/card** tính một sản phẩm dù có nhiều biến thể; chọn từ **toàn bộ sản phẩm đang công khai**, kể cả chưa đặt được; bỏ nhóm không có `ratingsCount`, nếu đồng hạng phân định bằng **ASIN đại diện tăng dần**, không vượt 20, chấp nhận ít hơn 20 nếu thiếu sản phẩm đủ dữ liệu. Không dùng điểm sao trung bình hoặc `writtenReviewCount` thay thế, không áp điều kiện danh sách Top100. **Không tự cộng ratings của các ASIN cùng nhóm**; dùng `ratingsCount` của ASIN đại diện được chọn theo quy tắc sắp xếp của catalog production đã xác minh tại lúc audit. Không tự đặt ngưỡng số lượt đánh giá tối thiểu hoặc giới hạn độ cũ; nếu metric cũ thì đánh dấu chất lượng dữ liệu.
- **Chốt thị trường (Grill Me 7A):** ưu tiên khách hàng **tại Việt Nam**, tìm mua hàng Nhật **bằng tiếng Việt**; đối chiếu tên, nội dung, từ khóa và ý định tìm kiếm theo thị trường này. Không tự thay đổi nội dung website.
- **Đơn vị mẫu và redirect:** lưu category, group key/card, ASIN đại diện, URL ban đầu, số `ratingsCount`, rank và thời điểm chọn. Cố định mẫu trong một đợt audit; URL được chọn chuyển hướng sang một ASIN khác thì kiểm tra đích cuối để đánh giá đúng hành vi, ghi riêng redirect và canonical, không coi đó là sản phẩm thứ 21 hoặc mở toàn bộ biến thể. Nếu một trang được chọn lỗi, giữ trong danh sách và báo lỗi, không tự thay bằng hạng 21.
- Không lấy dữ liệu khách, đơn hàng, credential, session, token, SQL mật, log chưa lọc hoặc thông tin riêng tư vào báo cáo.

## 1. Công cụ khi được phép thực hiện

| Công cụ | Vai trò | Phạm vi bắt buộc |
|---|---|---|
| Chat On Steroids | Điều phối các bước, ghi nhận bằng chứng, kiểm tra độc lập, tổng hợp kết luận | Quyền đọc tối thiểu |
| Codex CLI `gpt-6.1-sol`, `medium` | Đánh giá kỹ thuật SEO, phân nhóm bất thường, phản biện kết luận và ưu tiên | Không tự chạy crawler hay sửa code |
| HTTP GET/HEAD client bên ngoài VPS | Kiểm kê và crawl HTML có giới hạn, thống kê trạng thái/header/metadata | Chỉ host Mita, không theo link ra Amazon/E-KAIWA |
| BrowserOS Neo MCP (`/using-browseros-neo-mcp`) | So sánh HTML nguồn với DOM sau render, mobile, điều hướng, variant, ảnh, accessibility | Kiểm tra mobile **mọi nhóm trong Top 20/danh mục** và trang chung; không submit form |
| SSH vào Hermes (read-only) | Xác minh release, Caddy và trạng thái `mita-web`, `mita-api`, `postgresql`, RAM/swap; quan sát ảnh hưởng E-KAIWA | Chỉ lệnh đọc, log lọc/ẩn dữ liệu riêng; không điều khiển service |
| PageSpeed Insights / Lighthouse bên ngoài VPS | Đo chuyên sâu **3–5 sản phẩm trong Top 20 mỗi danh mục**, tách lab/CrUX field | Chạy tuần tự, cùng một số trang chung đại diện nếu ngân sách cho phép; mọi lần gọi tính vào ngân sách request |
| Google Search Console (GSC) / Bing Webmaster Tools | Indexing thật, Google-selected canonical, sitemap status, truy vấn/tìm kiếm | **Thêm GSC nếu kết nối/quyền đọc có sẵn**; không có thì đánh dấu chưa kiểm chứng, không chặn audit; Bing tùy chọn |

**Không cài hoặc chạy** `claude-seo`, Chromium, Python crawler, Lighthouse hay bất kỳ audit agent nào trên VPS. Các lệnh `/seo ...` là lệnh Claude Code, không phải lệnh Codex CLI. Chỉ kế thừa phân loại audit và phương pháp; tránh chế độ parallel/full-auto của plugin khi giới hạn tải chưa được kiểm soát.

## 2. Ngân sách truy vấn và cổng dừng để bảo vệ VPS

Hermes theo tài liệu là VPS khoảng 1 GiB RAM dùng chung với E-KAIWA, Hermes Gateway và tác vụ khác; việc tạo sitemap động có thể truy vấn nhiều sản phẩm qua API. Thông số sau là **giới hạn khởi đầu đề xuất**, phải được chấp thuận và đo lại trên production, **không phải bằng chứng về sức chịu tải hiện tại**.

| Thông số | Mặc định đề xuất |
|---|---|
| Nguồn phát | PC/công cụ ngoài VPS, không chạy crawler trên VPS |
| Host allowlist | `https://mitajapanshop.duckdns.org` duy nhất |
| Method | GET/HEAD đọc công khai, không POST/PUT/PATCH/DELETE |
| Concurrency | 1 request HTTP cùng lúc; không chạy browser/Lighthouse song song với crawler |
| Tốc độ | Không nhanh hơn 1 request / 5 giây; chờ thêm nếu phản hồi chậm |
| Pilot | Tối đa 10 request ban đầu, gồm robots và 1 lần sitemap khi đã xác nhận chấp nhận tải |
| Theo lô | Tối đa 100 request/lô rồi đánh giá dịch vụ trước lô tiếp theo |
| Timeout | 10 giây/request; không tự retry gây lặp vô hạn |
| Redirect | Tối đa 3 hop; nếu chuyển ra ngoài host thì ghi nhận và dừng |
| HTML | Chỉ lấy body HTML cần thiết, đặt giới hạn bytes; không tải toàn bộ gallery/JS/CSS trong crawler cơ bản |
| Trình duyệt | Mẫu giới hạn, quan sát mọi request con khi đánh giá tổng tải |
| Thời điểm | Chọn khung ít người dùng, tránh các kỳ đồng bộ và tác vụ VPS bận; không mặc định 04:00–05:15 JST là giờ an toàn |

**Dừng ngay và đánh giá lại** nếu phát sinh HTTP 429/503, lỗi 5xx hoặc timeout lặp lại, tốc độ phản hồi tăng bất thường so với baseline, cảnh báo OOM, swap I/O kéo dài, RAM khả dụng giảm xuống mức do operator thống nhất, hoặc E-KAIWA/Mita bị ảnh hưởng. Không tăng tải để thử lại, không tự restart. Các phép đo tình trạng E-KAIWA ưu tiên quan sát bằng read-only VPS; mọi kiểm tra HTTP trực tiếp vào hostname E-KAIWA cần phê duyệt riêng.

Tổng số URL/request sẽ xác định sau khi lựa chọn Top 20 theo từng danh mục và kiểm kê trang chung. Không gọi một đợt quét đủ N trang cho đến khi pilot đạt và ngân sách tổng đã được duyệt. Mỗi URL được khử trùng lặp; phản hồi lưu trong báo cáo kiểm thử, tái sử dụng cho nhiều check để tránh request thừa.

## 3. Các pha thực hiện sau khi được duyệt

### Pha A — Chốt phạm vi, chính sách SEO và baseline (cổng 1)

1. Xác nhận owner cho phép **kiểm tra read-only production**, khung giờ, trần request, người giám sát, nơi lưu và thời gian giữ bằng chứng.
2. Qua phương pháp read-only được phép: xác minh release hash đang chạy, routing Caddy cho Mita, tình trạng `mita-web`, `mita-api`, DB, RAM/swap/CPU, các chỉ báo E-KAIWA.
3. Chốt ma trận *intended indexability*: trang chủ, danh mục, sản phẩm, review, hướng dẫn, giỏ, checkout, pagination, search/sort/filter. Admin và API nhạy cảm luôn ngoài phạm vi crawl.
4. Xác định nguồn danh sách danh mục và Top 20: ưu tiên API/catalog public theo `sort=reviews` (trong mã tham chiếu, đây là thứ tự theo số lượng `ratingsCount`), kiểm chứng cách gom nhóm/sắp xếp **ở release production**; khi thiếu dữ liệu xác minh thì dùng một truy vấn PostgreSQL **chỉ đọc trên VPS, chỉ trả định danh nhóm/ASIN + `ratingsCount` công khai** nếu được phép. Không truy vấn bảng khách/đơn hàng, không chọn dựa trên danh sách cũ.

**Đầu ra:** baseline trạng thái, revision, chính sách index dự kiến và ngân sách đã duyệt. Nếu chưa xác nhận tình trạng VPS, dừng trước khi crawl.

### Pha B — Kiểm kê trang chung và xác lập Top 20 mỗi danh mục (cổng 2)

1. Đọc `robots.txt`; nếu cổng an toàn đạt, tải `sitemap.xml` **một lần** và parse offline, hỗ trợ sitemap index nếu có.
2. Thu thập các URL trang chung từ homepage, menu/footer, danh mục, danh sách sản phẩm, pagination đại diện, hướng dẫn, đánh giá, giỏ và thanh toán. Không theo outbound link, không thực hiện tìm kiếm Amazon.
3. Lấy danh sách danh mục **thực tế** trên production. Với mỗi danh mục, lấy các **nhóm/card đang công khai**, kể cả không đặt được; dựa vào ASIN đại diện từng card để chọn `ratingsCount` cao nhất **giảm dần**; loại nhóm không có `ratingsCount`, đồng hạng phá bằng **ASIN đại diện A–Z**, cắt tối đa **20 nhóm**, có thể ít hơn 20. Không lấy điều kiện `top-reviews`/Top100 vì đó là metric số bài viết và điều kiện khác.
4. Phân biệt **nhóm card sản phẩm** với **ASIN biến thể**; không tự cộng số rating trong nhóm hoặc mở thêm trang biến thể. Kiểm chứng nhóm/card và ASIN đại diện trên production, ghi rank, count, thời điểm dữ liệu, nhãn stale (nếu có), nguồn chọn; cố định tập mẫu khi bắt đầu kiểm tra. URL chuyển sang một sibling được ghi thành một bước redirect trong slot ban đầu, không mở rộng mẫu.
5. Hợp nhất URL trang chung, Top 20 từng danh mục, canonical/redirect trong chính mẫu; phân loại trang chung và sản phẩm. XML sitemap được parse offline để kiểm tra URL/host/schema, trùng lặp và quy tắc cấu trúc, nhưng **không GET mọi ASIN ngoài mẫu**.

**Đầu ra:** `url-inventory.csv` gồm `url, source, family, category, group_key, representative_asin, ratings_count, rank, observed_at, final_url, intended_index, sitemap_present, note`; các trang chung và danh sách Top 20 mỗi danh mục có thể kiểm chứng. Báo rõ nhóm ít hơn 20 do thiếu `ratingsCount`, số link redirects; ghi riêng URL sitemap chỉ được kiểm tra offline, không gọi chúng là đã được kiểm tra HTML.

### Pha C — Crawl kỹ thuật các trang chung và Top 20/danh mục (cổng 3)

Sau khi pilot 10 request đạt và operator xác nhận VPS ổn định, crawl lần lượt **các trang chung + Top 20 của từng danh mục** trong inventory theo ngân sách, không mở rộng sang sản phẩm còn lại chỉ vì chúng xuất hiện trong sitemap.

| Nhóm kiểm tra trên mọi URL được phép | Trường/bằng chứng |
|---|---|
| HTTP | status, content-type, thời gian, độ lớn HTML, chain redirect tối đa 3 hop |
| Indexability | robots.txt applicability, robots meta, X-Robots-Tag, final canonical |
| SEO metadata | title, description, `html lang`, H1, headings, Open Graph/Twitter tags nếu có |
| Sitemap | URL có trong XML, self/other canonical, 3xx/4xx/5xx, trùng và URL lạ |
| HTML visibility | Nội dung có trong HTML trả về, link `<a href>`, link hỏng cùng host, breadcrumb |
| Duplicate | title/meta/H1 trùng, canonical clusters, thin/empty/soft-404 candidates |
| Product | identity ASIN, redirect biến thể, thông tin hiển thị sơ bộ, dạng structured-data nếu có |

Những URL đã chuyển hướng vẫn được đếm và ghi final URL riêng; **không coi 200 sau redirect là 200 trực tiếp**. Chỉ cần GET HTML với parser, không tải toàn bộ ảnh/JS cho tất cả ASIN. Mỗi đợt tối đa 100 request và báo cáo trạng thái trước khi tiếp tục. Nếu hết ngân sách hoặc server không ổn định: ghi rõ phần trăm URL đã kiểm tra, không tuyên bố full-site hoàn thành.

**Đầu ra:** `http-seo-matrix.csv`, `redirect-canonical-map.csv`, `sitemap-exceptions.csv`, các nhóm lỗi có số URL và ví dụ xác minh được, cùng ghi chú giới hạn mẫu **Top 20/danh mục**.

### Pha D — Audit nội dung, liên kết và BrowserOS Neo cho Top 20/danh mục

Kiểm tra các trang chung và **tất cả nhóm/card được chọn (tối đa 20/danh mục)** về title/nội dung/ảnh/đường dẫn/SEO mobile. Dùng BrowserOS Neo để xem mobile **mọi sản phẩm trong tập Top 20**, ưu tiên kiểm tra chi tiết các trạng thái đặt được/không đặt được, nhóm nhiều biến thể, sản phẩm đơn, tên dịch dài/ngắn; không chọn thêm sản phẩm ngoài Top 20 chỉ để đủ loại trạng thái.

- So sánh `view-source`/HTML ban đầu với DOM sau JS; kiểm tra nội dung quan trọng có hiển thị cho crawler và link thực là `<a href>`.
- So sánh cấu trúc desktop/mobile, menu, pagination, filter, breadcrumbs, chọn biến thể; phát hiện layout shift, ảnh thumbnail bị phóng, alt text trống, font và liên kết khó dùng.
- Đánh giá với **khách hàng Việt Nam tìm mua hàng Nhật bằng tiếng Việt**: tên tiếng Việt và từ khóa/ngữ cảnh mua hàng, lỗi dịch/số lượng/dung lượng, mô tả trùng nhau giữa biến thể, nội dung nghèo, nguồn thông tin, cảnh báo thực phẩm/sức khỏe chỉ dựa trên dữ liệu có bằng chứng.
- Kiểm tra minh bạch mua hộ: đơn cần xác nhận, chưa thu tiền tự động, điều kiện thanh toán, phí vận chuyển, đổi trả, liên hệ và thông tin shop. Không thực hiện thêm giỏ hoặc gửi form.
- Rà liên kết: depth từ trang chủ, link tới từng ASIN public, danh mục sâu, pagination `?page`, tham số search/sort/filter. Query vô hạn chỉ kiểm tra ma trận đại diện, không quét tổ hợp toàn phần.

**Đầu ra:** screenshot và ghi chú cho các trang mẫu (không chứa dữ liệu khách), nội dung và link graph issues kèm số URL bị ảnh hưởng. Không mặc định Google index mọi URL chỉ vì BrowserOS nhìn thấy.

### Pha E — Google SEO, structured data và ecommerce trên Top 20/danh mục

1. Đọc JSON-LD/RDFa/Microdata thực tế từ trang chung và **Top 20/danh mục**; kiểm tra `Organization`, `WebSite`, `BreadcrumbList`, `Product`, `Offer` nếu hợp lệ với mô hình mua hộ.
2. Dùng Rich Results Test/Schema Validator **trên mẫu đã được phép**; đối chiếu dữ liệu có trong HTML với giá VND, tình trạng đặt hàng, seller, variant, source-observed availability, chính sách giá/ship/return.
3. Phân biệt đánh giá Amazon, ảnh minh họa và đánh giá thực của Mita; không đề xuất tự nhận review/rating hoặc tạo số liệu/schema giả.
4. Kiểm tra schema chỉ khi chính sách quyền công bố và dữ liệu nguồn đáp ứng. Không coi schema hợp lệ là bảo đảm Google cấp rich result.
5. Kiểm tra OG thumbnail, hình ảnh chính, `alt`, dimensions và responsive images theo mẫu; tôn trọng quyền sử dụng ảnh Amazon.

**Đầu ra:** bảng schema coverage, tính hợp lệ, mismatch với nội dung thực và các yêu cầu dữ liệu cần owner quyết định.

### Pha F — Mobile và hiệu năng cho Top 20/danh mục, không stress test

- Kiểm tra **tất cả nhóm/card trong Top 20 của mỗi danh mục** về mobile và các dấu hiệu hiệu năng quan sát được (HTML/assets/ảnh, rendering, thao tác chính) cùng các trang chung. Chọn **3–5 sản phẩm đại diện từ Top 20 của từng danh mục** để đo sâu Lighthouse/PSI (ví dụ trang nhiều ảnh, biến thể phức tạp, nội dung dài, trường hợp tải chậm). Không chạy 20 lượt lab cho mọi sản phẩm; chỉ đo tuần tự, không nhiều browser song song.
- Ghi URL, timestamp, thiết bị, tool, mạng giả lập, release, LCP/CLS/INP khi có CrUX field data, TTFB và những vấn đề network/image/JS. Không suy ra INP thực từ lab nếu thiếu field data.
- Đánh giá ngưỡng Google tại p75: **LCP ≤2,5s; INP ≤200ms; CLS ≤0,1**, phân biệt lab và field. Nếu CrUX không có dữ liệu thì ghi `unknown`, không coi là pass/fail.
- Không kết luận sức chịu tải của VPS chỉ từ điểm Lighthouse. So sánh với baseline VPS và E-KAIWA, dừng nếu có dấu hiệu bất ổn.

**Đầu ra:** bảng metrics theo template và danh sách tác nhân gây chậm có bằng chứng; không gán một điểm tổng cho toàn bộ ASIN từ vài mẫu.

### Pha G — Google indexing cho Top 20/danh mục, Bing/GEO tùy chọn

- **Grill Me 6B:** nếu kết nối/quyền read-only GSC dùng được thì bổ sung index/canonical/query/performance của **Top 20 sản phẩm mỗi danh mục** cùng các trang chung; sitemap reports và crawl stats được xem ở mức website. Nếu sử dụng URL Inspection, tuân thủ quota và giới hạn gọi.
- Nếu không kết nối được GSC: **tiếp tục audit**, đánh dấu `not assessed` cho indexed status / Google-selected canonical / số liệu tìm kiếm và chỉ kết luận về **khả năng index từ bằng chứng kỹ thuật**. Không yêu cầu đăng nhập hay cấp mật khẩu để hoàn thành audit cơ bản.
- Đối chiếu truy vấn tiếng Việt và khả năng hiển thị đối với **khách hàng tại Việt Nam**; nếu có dữ liệu GSC, tách quốc gia Việt Nam và thiết bị phù hợp, tránh gộp thị trường Nhật vào kết luận chính.
- Bing Webmaster Tools, search-intent content, FAQ hợp lệ, nội dung đáng tin và GEO/AEO là **ưu tiên phụ**, đánh giá bằng ví dụ thực, không tự tạo `llms.txt` hoặc lấy điểm AI citation giả định.
- Không submit sitemap, request indexing hoặc chỉnh tài khoản/cấu hình tìm kiếm trong audit.

**Đầu ra:** phụ lục Search Console/AI Search nếu được phép; nếu thiếu nguồn, ghi rõ `not assessed`.

### Pha H — Báo cáo, phản biện Codex và nghiệm thu

1. Dồn lỗi giống nhau theo root cause/template; gắn URL ảnh hưởng, số lượng, bằng chứng production, mức tin cậy, hậu quả SEO, đề xuất sửa, cách nghiệm thu và phụ thuộc.
2. Codex CLI 6.1 Sol medium **phản biện read-only**: kiểm tra suy diễn, nhầm canonical/redirect, thực tế ecommerce, chính sách owner và rủi ro sửa; Chat On Steroids quyết định kết luận cuối.
3. Phân ưu tiên:
   - **P0:** lỗi công bố riêng tư/quyền hoặc indexability nghiêm trọng diện rộng, 5xx hàng loạt, sitemap không tạo được/tải phá dịch vụ.
   - **P1:** URL canonical/redirect/sitemap sai diện rộng, sản phẩm quan trọng không crawl được, nội dung chính thiếu từ HTML.
   - **P2:** metadata, nội dung, structured data, internal link, mobile/performance có tác động xác minh được.
   - **P3:** bổ sung social metadata, E-E-A-T/GEO/AEO, cơ hội tối ưu không cấp bách.
4. Xuất báo cáo dự kiến dưới `reports/seo/` khi audit được cho phép: `production-seo-audit-YYYYMMDD.md`, `url-inventory.csv`, `http-seo-matrix.csv`, `redirect-canonical-map.csv`, `findings.csv` và ảnh/bằng chứng đã lọc. Không xuất dữ liệu customer, log thô, secrets.

## 4. Tiêu chí hoàn thành audit

| Tiêu chí | Kiểm tra hoàn thành |
|---|---|
| Inventory | Đã kiểm kê các trang chung và **tối đa 20 nhóm/card theo `ratingsCount` mỗi danh mục**, có bảng xếp hạng/ASIN đại diện; thiếu rating thì ghi lý do có thể ít hơn 20; sitemap đánh giá cấu trúc riêng |
| Technical | Mỗi URL **trang chung/Top 20 nhóm** có kết quả GET/HTML hoặc lý do không kiểm tra được, không suy rộng kết luận sang sản phẩm ngoài Top 20 |
| Template | Mỗi loại trang chung và **từng sản phẩm được chọn** có kiểm tra SEO và mobile; 3–5 sản phẩm/danh mục được đo PSI/Lighthouse sâu hoặc nêu lý do không đo được |
| Variant & sitemap | Có bảng đối chiếu ASIN được chọn, redirect, final canonical, sitemap và internal links; không yêu cầu crawl mọi ASIN |
| Tính an toàn | Không ghi trạng thái hoặc tạo đơn; không ảnh hưởng E-KAIWA; không vượt ngân sách đã duyệt |
| Bằng chứng | Mỗi lỗi có URL + cách tái hiện + mốc thời gian + trạng thái live; giả thuyết được ghi riêng |
| Báo cáo | Có P0–P3, tác động, chi phí sửa tương đối, cách kiểm tra lại và phần chưa xác minh; nhận định từ khóa/nội dung hướng đến người mua tại Việt Nam; GSC có thì bổ sung, không có thì ghi rõ |

Audit hoàn thành **không đồng nghĩa** Google đã index, traffic tăng hoặc lỗi đã được sửa. Mọi sửa code, migration, cấu hình VPS, kết nối Search Console, submit sitemap, triển khai và re-audit sau sửa là công việc **riêng** cần được phê duyệt theo phạm vi cụ thể.

## 5. Quyết định cần chốt trước khi bấm chạy audit

1. Owner phê duyệt **khung giờ, ngân sách crawler** (pilot 10, 1 request/5 giây, từng lô tối đa 100, stop conditions), người giám sát VPS và nơi lưu bằng chứng.
2. **Đã chốt tiêu chí sản phẩm:** `ratingsCount` giảm dần, nhóm/card (mỗi nhóm một slot), mọi sản phẩm đang công khai kể cả không đặt được, bỏ nhóm thiếu `ratingsCount`, đồng hạng theo ASIN đại diện A–Z, tối đa 20/danh mục. Quyền **SSH chỉ đọc/đọc danh sách public từ production** nếu API không cung cấp ranking đúng tiêu chí được xác định lúc chuẩn bị thực thi.
3. Owner xác nhận **chính sách index** cho cart/checkout và các URL pagination/filter/search, phù hợp quyết định index toàn bộ trang công khai và giới hạn nội dung cần công bố.
4. **Đã chốt GSC và hiệu năng:** chỉ bổ sung **GSC read-only nếu kết nối được**, không bắt buộc và không cần mật khẩu/token trong chat; **mobile tất cả nhóm trong Top 20**, đo **3–5 sản phẩm/danh mục** bằng PSI/Lighthouse. Mục tiêu tìm kiếm ưu tiên **người mua tại Việt Nam bằng tiếng Việt**.
5. Mọi phép kiểm tra Google PSI hoặc third-party validator có chủ động tải trang live được tính vào ngân sách và phải được cho phép trong audit.

## 6. Tài liệu tham khảo

- Claude SEO: https://github.com/AgriciDaniel/claude-seo
- Google ecommerce navigation: https://developers.google.com/search/docs/specialty/ecommerce/help-google-understand-your-ecommerce-site-structure
- Google pagination: https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading
- Google ecommerce URL structure: https://developers.google.com/search/docs/specialty/ecommerce/designing-a-url-structure
- Google canonical: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google sitemap: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
- Google product markup: https://developers.google.com/search/docs/appearance/structured-data/product
- Google PageSpeed: https://developers.google.com/speed/docs/insights/v5/about

**Kết luận tại thời điểm lập kế hoạch:** chưa thực hiện audit khi tài liệu này được viết ngày 02/11. Kết luận này là lịch sử và đã được cập nhật bằng chứng bên dưới.

## Cập nhật sau audit — đối chiếu đến 06/11/2026

- **Đã thực hiện audit production:** kiểm tra 51 URL (11 trang chung và Top 20 nhóm/card ở mỗi trong 2 danh mục); kết quả HTTP 50×200 và 1×307, không thấy 4xx/5xx trong mẫu. Báo cáo và CSV nằm tại `reports/seo/20261102_production/`.
- **12 phát hiện tại ngày audit:** 2 P1, 7 P2, 3 P3 trong `findings.csv`; đáng chú ý là redirect khác hương vị và lỗi dịch nội dung thực phẩm trẻ em. Đây là kết quả 02/11, không chứng nhận mọi lỗi còn tồn tại ở HEAD 06/11.
- **Giới hạn chưa hoàn tất:** PageSpeed Insights trả 429 nên không có kết luận Lighthouse/CWV; Google Search Console được kết nối sau audit nhưng Sitemaps vẫn `Unknown / Couldn't fetch` khi kiểm tra lịch sử. URL Inspection Live Test fetch thành công không có nghĩa Sitemaps đã `Success`.
- **Code thay đổi sau audit:** `312a764` (G1 sitemap/ASIN), `515c337` (G2 phân trang/landing), `343235f` (metadata Mita Japan/WebSite). Đây là bằng chứng đã sửa một phần code SEO, không chứng minh toàn bộ 12 phát hiện được khắc phục hay đã re-audit thành công.
- **Còn cần làm:** kiểm tra lại các phát hiện sau release, nhất là variant/canonical, tên và thành phần thực phẩm, metadata trang, rating stale, và đo PSI/GSC khi có dữ liệu. Không tự đổi chính sách `index/noindex` của giỏ/checkout hoặc sửa dữ liệu không có nguồn.
