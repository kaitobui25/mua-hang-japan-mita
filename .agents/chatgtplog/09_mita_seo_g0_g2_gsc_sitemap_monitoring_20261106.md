# 09 — Mita Japan: tổng kết G0–G2 SEO và điều tra theo dõi lỗi GSC sitemap (06/11/2026)

> **Nhật ký lịch sử, không phải trạng thái hiện tại vĩnh viễn.** Mốc kiểm tra GSC và production trong session là **05/11/2026 JST**; tài liệu ghi **06/11/2026 JST**. Trước hành động tiếp theo phải kiểm tra lại Git, production, GSC và `AGENTS.md`. Không xem tài liệu này là quyền deploy, sửa VPS/GSC hoặc tạo giám sát tự động.

## 1. Yêu cầu và phạm vi

- Bối cảnh từ phiên triển khai SEO trước đó: người dùng đã cho phép thực hiện **G0–G2** cho Mita Japan trên **local** qua Chat On Steroids Core `mana-phong`, phối hợp Codex CLI, tôn trọng Hallmark Garden và các hành vi mua hàng đã duyệt. Chưa cho phép push/deploy production.
- Yêu cầu tiếp theo, **chỉ tìm hiểu, không sửa code**: `Google Search Console hiện vẫn báo Couldn't fetch cho sitemap` và hỏi có cách nào **theo dõi từ nay trở đi**.
- Yêu cầu cuối: **tóm tắt session và lưu vào `.agents/chatgtplog`** (tài liệu này).
- Repo: `/ai/web/mita-japan/mua-hang-japan-mita`; website: `https://mitajapanshop.duckdns.org/`; GSC property chính xác: `https://mitajapanshop.duckdns.org/`.

## 2. Bối cảnh G0–G2 đã hoàn thành ở local trước khi theo dõi GSC

- `312a764 Optimize public ASIN sitemap inventory` (**G1**): thêm endpoint `GET /api/catalog/asins` chỉ lấy ASIN công khai dựa trên policy hiện hành; sitemap dùng một lần lấy inventory nhẹ thay cho chuỗi gọi chi tiết sản phẩm, xác thực đầy đủ inventory, không nuốt lỗi thành sitemap thiếu/rỗng, thêm `/mua-ho-amazon`.
- `515c337 Improve SEO landing and crawlable catalog links` (**G2**): phân trang bằng link crawlable, canonical page 2+ hợp lệ, sản phẩm nổi bật SSR trên trang chủ, H1 chứa Mita Japan, landing mua hộ Amazon có hướng dẫn/canonical, liên kết footer, giữ Garden và logic quote/checkout.
- Kiểm chứng **local ở phiên trước**: backend test **337 passed**, frontend TypeScript/lint và backend typecheck pass; API ASIN công khai **832**; sitemap local **841 URL duy nhất**, bao gồm **832 URL sản phẩm**; thử một số trang danh mục, page 2, canonical, out-of-range; BrowserOS Neo đã kiểm tra **5 ASIN** và viewport **390 px**. Chụp ảnh browser bị CDP timeout, vì vậy **chưa xác nhận pixel-level bằng screenshot**.
- Git `main` tại thời điểm ghi log: **`515c337`** (ngay sau `312a764`); tracked worktree sạch. Các untracked có trước được giữ lại. **Không có push/deploy** cho G0–G2 theo thông tin đã xác minh; không được lấy số local để mô tả production.

## 3. Điều tra GSC theo yêu cầu chỉ đọc (05/11/2026)

### Trạng thái GSC được ghi nhận

- Trong kiểm tra GSC bằng BrowserOS Neo ở phiên trước: sitemap `/sitemap.xml` vẫn **`Type: Unknown`**, **`Status: Couldn't fetch`**, **`Last read` trống**, **`Discovered pages: 0`**; trang ghi ngày gửi **02/11/2026**.
- Trước đó URL Inspection Live Test ngày 02/11 từng đọc được sitemap, nhưng **không có log request Googlebot đủ tin cậy** để biết tại sao báo lỗi. Không được kết luận Google timeout hay lỗi code là nguyên nhân đã chứng minh.

### Kiểm tra production chỉ đọc từ máy local

Lệnh dùng: `curl.exe -L -sS --max-time 25 -o NUL -w ... https://mitajapanshop.duckdns.org/sitemap.xml`, và tương tự cho `robots.txt`.

| Chỉ tiêu | Snapshot 05/11/2026 |
| --- | --- |
| `GET /sitemap.xml` | **HTTP 200** |
| Content-Type | **`application/xml`** |
| Thời gian toàn bộ request | **9,348051 giây** |
| Dung lượng tải | **65.576 bytes** |
| `GET /robots.txt` | **HTTP 200**; **0,101203 giây** |

**Diễn giải:** sitemap truy cập được từ máy kiểm tra, song thời gian tải khoảng 9,35 giây cần theo dõi. **HTTP 200 không chứng minh Google đã fetch thành công**; cũng không đủ bằng chứng khẳng định 9,35 giây là nguyên nhân lỗi.

### Kiểm tra connector Google Search Console qua Windsor.ai

- Connector `searchconsole` **đang kết nối** property `https://mitajapanshop.duckdns.org/`.
- Đọc schema có các field sitemap như `path`, `last_downloaded`, `last_submitted`, `submitted`, `errors`, `warnings`, `is_sitemaps_index`.
- Kết quả đọc khoảng **01–03/11/2026** chỉ có các dòng `path: null`, `last_downloaded: null`, `last_submitted: null`, `submitted: 0`, `errors: 0`, `warnings: 0`; truy vấn dải rộng cũng thiếu path và timestamps.
- **Không dùng `submitted: 0`/`errors: 0` ở dữ liệu thiếu này để kết luận sitemap thực sự có 0 URL, không lỗi, hoặc GSC đã đổi sang Success.** Trong trạng thái hiện tại, connector này **chưa cung cấp bằng chứng đáng tin cậy cho theo dõi status sitemap tự động**.

## 4. Phương án theo dõi đã tư vấn — CHƯA thiết lập

1. **GSC → Indexing → Sitemaps, mỗi ngày**: lưu `Status`, `Last read`, `Discovered pages` cùng ngày giờ; đối chiếu khi chuyển `Couldn't fetch` → `Success`.
2. **GSC → Settings → Crawl stats, 2–3 ngày/lần**: kiểm tra host availability, DNS, server error và thời gian phản hồi Googlebot; không đồng nhất thống kê crawl toàn site với việc Google đã đọc sitemap.
3. **HTTP monitor `/sitemap.xml` 15–60 phút/lần** (chỉ là đề xuất): theo dõi response code, content type, dung lượng, latency để phát hiện lỗi ngắt quãng; riêng monitor này không biết GSC `Success`.
4. **Google Search Console Sitemaps API read-only** có thể là hướng lấy trạng thái/`lastDownloaded` để cảnh báo, **nếu được xác thực và kiểm chứng dữ liệu thật**. Windsor hiện tại chưa đáp ứng yêu cầu; tránh tạo cảnh báo dựa trên `null`.
5. Sau khi **được người dùng cho phép deploy G0–G2 lên production**: đo sitemap production lần nữa, kiểm tra GSC và cân nhắc gửi lại sitemap một lần nếu phù hợp. Đừng nhầm mã đã commit ở local với production đã cập nhật.

**Không thực hiện trong lượt theo dõi:** chỉnh code/DB/VPS/Caddy, thêm access logs, push/deploy, submit lại sitemap, tạo task định kỳ hoặc lịch nhắc. Tất cả là **đề xuất**, không phải tác vụ đang chạy ngầm.

## 5. Trạng thái kết thúc và bước tiếp theo

- **Đã xác nhận:** production sitemap trả 200 nhưng ~9,35 giây; GSC trước đó vẫn `Unknown / Couldn't fetch`; kết nối Search Console qua Windsor tồn tại nhưng dữ liệu sitemap không đủ dùng.
- **Chưa biết:** lỗi thực sự phía Google, có request Googlebot nào thất bại, Google sẽ tự đọc thành công khi nào, và liệu bản G0–G2 sau deploy có giải quyết được trạng thái này hay không.
- **Nếu được yêu cầu tiếp tục điều tra chỉ đọc:** kiểm tra lại trạng thái mới nhất trong GSC, so sánh bảng lịch sử theo ngày, đo HTTP tối thiểu, đọc Crawl stats; không tự sửa VPS để bật access log khi chưa được phép.
- **Nếu người dùng yêu cầu tự động theo dõi:** cần thống nhất tín hiệu cảnh báo (HTTP/latency và/hoặc trạng thái GSC), xác minh nguồn GSC API, rồi mới lập lịch; không thông báo tự động đã được tạo khi chưa tạo thật.
- File log này được tạo theo yêu cầu ghi nhật ký. **Không commit/push** vì người dùng chỉ yêu cầu ghi file.
