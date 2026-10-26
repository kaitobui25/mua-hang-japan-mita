# 01 — Tổng hợp phiên chat: ZenMarket, Amazon Japan và catalog Mita Japan

**Thời điểm:** 26–27/10/2026 (JST). **Mục tiêu cuối:** Xây backend **nhanh, gọn, nhẹ**, để khách mở danh mục **Thực phẩm chức năng** trên Mita Japan là thấy sản phẩm hiện có trên Amazon.co.jp; đồng bộ dữ liệu **1 lần/ngày**, ưu tiên **miễn phí**, không dùng API của 4 nhà cung cấp trả phí/chính thức đã thảo luận.

## 1. Khảo sát ZenMarket — kết quả thực nghiệm

- BrowserOS neo khảo sát trang Amazon của ZenMarket: `/en/search.aspx?browse=17`; tìm `Sony WH-1000XM5` ra 20 sản phẩm, URL có `q`, `p=1`, `stores=17`, `browse=17`.
- Màu **Black**: ASIN `B09Z2QYYD1`, giá kết quả tìm kiếm **¥41.304**, giá trang chi tiết **¥39.800**; màu **Silver**: ASIN `B09Z2S9FSX`, giá chi tiết **¥34.300**. Chọn biến thể dẫn tới **ASIN/trang mới**, không chỉ đổi nhãn màu. Nguyên nhân chênh lệch giá giữa list/detail **chưa xác định**.
- Dán `https://www.amazon.co.jp/dp/B09Z2QYYD1` vào ZenMarket → chuyển đến trang sản phẩm nội bộ với `shop=amazon&itemCode=B09Z2QYYD1`. Thử đổi JPY → USD thành công; tỷ giá và giá thay đổi theo từng phiên nên không dùng số quan sát làm giá cố định.
- Ở lượt khảo sát đầu, chỉ có DOM/Resource Timing; thao tác **GET replay** tới `/en/search.aspx?stream=1` trả HTML nhưng **không phải request tìm kiếm gốc**.

## 2. DevTools Network/CDP — đã làm rõ

- Dùng phiên Chrome sạch, bật **`Network.enable` và `Network.setCacheDisabled(true)` trước navigation**; event log được giữ qua điều hướng bằng CDP listener. **Không xác nhận trạng thái các checkbox `Preserve log`/`Disable cache` trong DevTools UI**.
- Ghi được request tìm kiếm **thực**: `POST https://zenmarket.jp/en/search.aspx?stream=1`, request `application/json`, response **`200 text/event-stream` (SSE)**.
- JSON tìm kiếm gồm `stores:[17]`, `query:"Sony WH-1000XM5"`, `page:1`, `pageSize:20` và các filter. SSE lần lượt có `store-result` trạng thái `QUEUED`, `HAS_DATA` (mảng `products`), và `search-complete` (`totalFound`). Initiator: `startSSESearch()` → `initSearchEngine()` trong `cross-site-searchv2.js`.
- Ý nghĩa: **POST JSON** để gửi từ khóa/bộ lọc; **SSE** để server ZenMarket đẩy kết quả/trạng thái về theo luồng. **Không chứng minh** backend ZenMarket lấy dữ liệu Amazon từ API nào, cache thế nào, hay giá có real-time hay không.
- Đã lưu HAR **dựng từ CDP và khử dữ liệu nhạy cảm** (153 request first-party) + JSON payload/initiator/SSE schema; **không phải HAR export nguyên văn từ DevTools UI**, không lưu cookie/token/raw SSE. Chrome sạch gặp **HTTP 403 security verification** khi mở detail, vì vậy chưa bắt được POST/payload gốc lúc đổi biến thể; không vượt chặn.

## 3. Phương án catalog Amazon Japan

**Kiến trúc tối giản được thống nhất về hướng triển khai:** `Nguồn sản phẩm → tác vụ đồng bộ hàng ngày (cron) → SQLite/PostgreSQL → GET /api/catalog?category=supplements&page=1&limit=24 → Frontend`. Tập trung **100–300 ASIN ban đầu**, có thể nâng lên **200–500 sản phẩm**; không cần SSE, Redis, Elasticsearch, microservices hay gọi Amazon mỗi khi khách mở trang.

- **Bốn nguồn đã tìm hiểu nhưng người dùng muốn KHÔNG dùng:** DataForSEO (truy vấn Amazon theo keyword), Keepa (category/bestseller/ASIN, hỗ trợ JP), Amazon Creators API (chính thức nhưng điều khoản affiliate và cache Offers ~1 giờ, không mặc nhiên cho website mua hộ checkout riêng), Rainforest/Traject Data (API thu phí).
- **Các cách miễn phí đã thảo luận:**
  1. **Catalog ASIN tự quản + SQLite/CSV**: chọn ASIN thủ công, lưu tên/ảnh/nội dung **có quyền sử dụng**, hiển thị tức thì, nhập/cập nhật mỗi ngày. **Khuyến nghị cho MVP có UI riêng**; không tự bảo đảm tồn kho/giá hàng ngày.
  2. **Google Programmable Search Engine** giới hạn site `amazon.co.jp`: nhúng kết quả tìm kiếm Google miễn phí theo điều kiện sản phẩm, nhưng không phải API catalog JSON tự lưu tùy ý, không bảo đảm sản phẩm còn hàng; UI/ads theo Google.
  3. **RSS bestseller Amazon không chính thức**: có thể thử nghiệm, song độ ổn định, nguồn và quyền tái hiển thị chưa được xác minh.
  4. **Tự scrape Amazon bằng Playwright/Python**: khả thi về kỹ thuật nhưng dễ bị chặn, có rủi ro điều khoản và bản quyền; **không khuyến nghị production**, không bypass CAPTCHA/403.
- **Không dùng endpoint nội bộ ZenMarket làm nguồn dữ liệu thương mại.** Không tự coi SP-API là API mở cho catalog mua hộ; quyền sử dụng dữ liệu/ảnh/giá Amazon phải được xác minh riêng. Giá/tồn kho đồng bộ một ngày/lần chỉ nên là **tham khảo**, cần kiểm tra lại trước báo giá/mua hộ.

## 4. Định hướng triển khai khi bắt đầu code

- Dùng Node.js + SQLite nếu chưa có database; bảng `catalog_products` tối thiểu: `asin` (unique), `source_url`, `name`, `category_slug`, `image_url` (nếu có quyền), `price_jpy` (nullable), `price_observed_at`, `last_sync_at`, `status`, `data_provider`; thêm bảng `sync_runs` để theo dõi lỗi.
- API đề xuất: `GET /api/catalog?category=supplements&page=1&limit=24`, `GET /api/catalog/products/:asin`; đồng bộ qua job nội bộ 1 lần/ngày. Dedupe theo ASIN, lọc đúng nhóm thực phẩm chức năng, có `lastUpdatedAt`, giữ snapshot gần nhất khi job lỗi.
- Phân loại theo vitamin, dầu cá/DHA/EPA, men vi sinh, khoáng chất, collagen...; kiểm tra thuốc/hàng hạn chế và không dùng tuyên bố điều trị thiếu căn cứ.
- **Vấn đề chưa giải quyết:** Muốn **tự động 100%, miễn phí, cập nhật hàng đang bán + ảnh + giá + tồn kho mỗi ngày** mà vẫn ổn định và được phép lưu/hiển thị trên website mua hộ thì **chưa tìm được nguồn đáp ứng đầy đủ**. Chốt phạm vi MVP: **catalog tự quản** hay **nhúng Google Search**, và chính sách giá/ảnh trước khi triển khai.

## 5. Tài liệu/bằng chứng đã tạo trong dự án

- [`zenmarket-investigation.md`](../../../analysis/zenmarket-investigation.md) — UI, ASIN/giá, biến thể, URL import, các giới hạn.
- [`zenmarket-api-map.md`](../../../analysis/zenmarket-api-map.md) — request map, POST/SSE và bằng chứng frontend.
- [`devtools-network/README.md`](../../../analysis/devtools-network/README.md) — CDP procedure, 403, cách làm sạch HAR.
- [`devtools-network/stream-evidence.sanitized.json`](../../../analysis/devtools-network/stream-evidence.sanitized.json) — request POST/SSE và initiator đã lọc.
- [`devtools-network/network.sanitized.har`](../../../analysis/devtools-network/network.sanitized.har) — HAR CDP sanitized.
- [`amazon-provider-design.md`](../../../analysis/amazon-provider-design.md) — interface/provider, bảo đảm giá, chính sách nguồn.
- [`amazon-jp-supplement-catalog-options.md`](../../../analysis/amazon-jp-supplement-catalog-options.md) — so sánh nguồn và kiến trúc catalog đồng bộ ngày.

**Trạng thái:** Mới **khảo sát + tài liệu**, chưa code backend catalog, chưa có nguồn dữ liệu miễn phí tự động được xác minh quyền sử dụng.
