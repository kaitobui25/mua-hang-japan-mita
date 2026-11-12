# Mita Japan — GSC & Sitemap tự động (Windows)

**Chỉ cần nhấp đúp `gsc-monitor.bat` ở root.** Không có menu, không phải bấm chọn hay đăng nhập lại cho mỗi lần chạy. Trong lúc chạy, terminal hiển thị tiến độ từng mục. Sau khi kiểm tra, terminal hiển thị **báo cáo tiếng Việt dễ đọc**: trạng thái sitemap Google, lần đọc gần nhất, trang phát hiện, crawl/Googlebot, DNS/server, HTTP/XML, API và **Last crawl riêng trang chủ**; cuối cùng có **Kết luận** và **Việc nên làm**. Cửa sổ **không tự đóng**: nhấn **Enter** khi đã đọc xong.

Yêu cầu máy Windows đã có Python 3 và `curl.exe` (không cần cài pip). **BrowserOS Neo MCP** tại `http://127.0.0.1:9010/mcp` cần đang hoạt động với profile Google đã đăng nhập và có quyền đọc Search Console của property `https://mitajapanshop.duckdns.org/`. Công cụ **không tự đăng nhập, submit sitemap, đổi GSC, sửa website, DB, VPS, worker hoặc deploy**.

## 6 bước tự chạy

1. **GSC → Sitemaps:** BrowserOS Neo mở trang đọc-only và lấy đúng dòng `/sitemap.xml`: `Status`, `Last read`, `Discovered pages`. `Last read` trống được ghi là chưa biết; `0` discovered không chứng minh sitemap trống.
2. **GSC → Crawl stats:** BrowserOS Neo đọc tổng lượt crawl, thời gian đáp ứng trung bình do Google ghi nhận và tỉ lệ các nhóm HTTP đang hiện trên báo cáo (ví dụ 200/404/5xx). Đây là lịch sử Googlebot, **không phải** kết quả GET từ máy Windows.
3. **GSC → Host status:** BrowserOS Neo đọc DNS resolution, Server connectivity, robots.txt fetch. `Acceptable fail rate` là nguyên văn trạng thái trong GSC, **không đồng nghĩa 0 lỗi**. Báo cáo không cung cấp số lượt DNS/server lỗi chính xác thì hiển thị không rõ.
4. **Sitemap HTTP/XML:** GET công khai URL `https://mitajapanshop.duckdns.org/sitemap.xml`, kiểm tra status, XML hợp lệ, số mục, thời gian đến header/tổng tải. Cảnh báo lỗi DNS/TLS/timeout/HTTP/HTML thay XML/redirect khác origin, hoặc tải **>=5 giây**. Phép đo này **không chứng minh Google fetch thành công**.
5. **GSC API (read-only):** Nếu đã có OAuth Desktop token mã hóa DPAPI hoặc biến môi trường `MITA_GSC_ACCESS_TOKEN`, tự gọi **GET-only** Sitemaps API, so sánh `lastDownloaded`, `isPending`, `errors`, `warnings` và submitted count với lần đọc thành công trước; nếu chưa có thì **`SKIP`**, không tự mở OAuth/đòi đăng nhập. API không có đầy đủ `Status`/`Discovered pages` như giao diện GSC.
6. **URL Inspection API — trang chủ:** Dùng cùng OAuth read-only để truy vấn bản trang chủ **đang ở Google Index**, lấy `lastCrawlTime`, `verdict` và trạng thái fetch/index. Google yêu cầu **POST JSON** tới `urlInspection/index:inspect` cho truy vấn **chỉ đọc** này; không gọi nút `Request indexing` và không thay đổi dữ liệu Google. So sánh lần crawl gần nhất với mốc commit bổ sung WebSite metadata `343235f` (**06/11/2026 10:53 JST**) và cảnh báo nếu trang chủ chưa được crawl lại sau mốc đó, hoặc đã quá **7 ngày** chưa crawl. Mốc và ngưỡng là tiêu chí theo dõi, không phải bằng chứng Google đã đổi tên site. Không có `lastCrawlTime` hoặc lỗi API được ghi **CHƯA RÕ**. Lần crawl thay đổi được ghi log; monitor không tự chạy lại ngoài lịch.

Khi một phần GSC đổi bố cục, chưa tải xong, yêu cầu đăng nhập hoặc không đúng property, công cụ trả **`UNKNOWN`**, không tự bịa dữ liệu. BrowserOS chỉ dùng các công cụ `tabs` và `navigate` cho ba trang GSC đã biết; chỉ đóng tab công cụ tự tạo. Không click bất cứ nút Submit, Remove, Save hay điều khiển ghi nào.

## Dùng trong terminal

```bat
gsc-monitor.bat                         REM Mặc định tự chạy đủ 6 phần, KHÔNG menu
gsc-monitor.bat --all                   REM Tương đương, dùng được trong script
gsc-monitor.bat --watch --interval-minutes 30   REM Theo dõi liên tục khi cửa sổ mở
gsc-monitor.bat --http                  REM Chỉ kiểm tra HTTP/XML
gsc-monitor.bat --api                   REM Sitemaps API + URL Inspection (read-only)
gsc-monitor.bat --inspect               REM Chỉ kiểm tra Last crawl trang chủ
gsc-monitor.bat --inspect --max-crawl-age-days 14  REM Ngưỡng cảnh báo 14 ngày
gsc-monitor.bat --help
```

**Quy tắc đóng cửa sổ:** khi nhấp đúp hoặc chạy `gsc-monitor.bat` không tham số, script chờ **Enter** mới thoát, kể cả khi có cảnh báo. Khi dùng `--all`, `--api`, `--http` và các tham số khác, chương trình trả về exit code ngay để không làm treo các script tự động. Nhật ký vẫn lưu bình thường.

`--watch` chạy foreground, không tạo lịch nền/Task Scheduler; dừng bằng Ctrl+C. Chu kỳ hợp lệ 5–1440 phút. Mỗi lần hoàn thành có trạng thái `OK`, `WARN`, `SKIP`, `UNKNOWN`. Exit code `0` = các phần bắt buộc đã kiểm tra và không phát hiện vấn đề, `2` = có cảnh báo thực tế (ví dụ GSC `Couldn't fetch`, Last crawl cũ hoặc HTTP chậm), `1` = ít nhất một phần bắt buộc không kiểm tra được. Nếu thiếu OAuth/token, phần Sitemaps API được bỏ qua nhưng **Last crawl không thể xác minh** và kết luận tổng thể là `CHƯA KIỂM TRA ĐỦ`. Đặt `--max-crawl-age-days N` với N >= 1 để điều chỉnh ngưỡng; mặc định 7.

**Log/snapshot** nằm trong `.agents/runtime/gsc-monitor/history.jsonl` và `state.json` (private/ignored); so sánh các lần thành công, giữ bản tốt nhất khi GSC/API tạm lỗi. URL Inspection lưu bản tóm tắt với `source=gsc-url-inspection`, `lastCrawlTime`, `status` và cảnh báo; không ghi dữ liệu HTML hay response body. Log không chứa token, email account, cookie, ảnh chụp hay nội dung trang thô. Không có thông báo đẩy hoặc chạy ngầm khi đóng terminal.

## Tùy chọn kết nối GSC API một lần (không bắt buộc)

Vì BrowserOS Neo đã đọc được ba báo cáo GSC, bạn **không cần API** cho ba báo cáo UI đó. Nhưng để theo dõi `Last crawl` trang chủ tự động, cần OAuth read-only cho URL Inspection API (token đã kết nối dùng lại được). Nếu chưa có OAuth, chủ tài khoản cần cấp quyền một lần:

1. Trong [Google Cloud Console](https://console.cloud.google.com/), tạo/chọn project, bật Google Search Console API; cấu hình OAuth consent rồi tạo Client loại **Desktop app**.
2. Lưu file JSON tại `REPO\.agents\runtime\gsc-monitor\oauth-client.json`; đây là vị trí private được Git ignore. Không chia sẻ JSON/token hoặc đưa vào Git.
3. Chạy **riêng một lần** `gsc-monitor.bat --login` và chấp nhận scope **`https://www.googleapis.com/auth/webmasters.readonly`** trên tài khoản Google có quyền property Mita Japan. Token được mã hóa bằng Windows DPAPI (`oauth-refresh.dpapi`), chỉ đọc được bởi Windows user hiện tại.
4. Từ các lần nhấp đúp `.bat` sau đó, công cụ tự sử dụng token còn hợp lệ; token hết hạn/thu hồi thì phần API báo không dùng được, **không bật trình duyệt đăng nhập lại** trong luồng tự động. Có thể thay bằng một access token read-only cấp sẵn trong biến môi trường `MITA_GSC_ACCESS_TOKEN` (ngắn hạn).

**Giới hạn:** OAuth `--login` lần đầu là luồng cấp quyền Google có tương tác tự nguyện, nằm ngoài 6 kiểm tra tự động; không dùng nó trong chạy thường. Các báo cáo UI dùng BrowserOS Neo. Sitemaps API chỉ dùng GET; URL Inspection API bắt buộc POST để truy vấn trạng thái Google Index; OAuth trao đổi/refresh token cũng dùng POST. Không có lệnh gửi yêu cầu lập chỉ mục. Google có thể crawl lại mà vẫn lựa chọn tên website khác "Mita Japan".

## Kiểm thử offline

```powershell
python scripts/test-mita-gsc-monitor.py -q
python scripts/test-mita-gsc-neo.py -q
python -m py_compile scripts/mita-gsc-monitor.py scripts/mita_gsc_neo.py
```

Nguồn: [Sitemaps API](https://developers.google.com/webmaster-tools/v1/sitemaps), [Sitemaps report](https://support.google.com/webmasters/answer/7451001), [Crawl stats](https://support.google.com/webmasters/answer/9679690), [URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect), [IndexStatusInspectionResult](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult), [Google OAuth desktop](https://developers.google.com/identity/protocols/oauth2/native-app).
