# Mita Japan — Grill with Docs: Admin tối giản

**Ngày:** 27/10/2026 (JST)
**Trạng thái:** `Grill hoàn tất / Q1–Q11 accepted / sẵn sàng lập trình theo mốc` — toàn bộ 11 câu đã được owner chốt; đây là tài liệu thiết kế, **chưa triển khai code Admin**. Không mở thêm vòng Grill khi chưa có yêu cầu mới.
**Ưu tiên:** chủ cửa hàng chưa quen quản trị website, cần giao diện dễ hiểu, ít thao tác, không thêm tính năng chỉ vì các website khác có.
**Căn cứ:** `GLOSSARY.md`, ADR 0001–0008, `docs/adr/0009-minimal-owner-admin.md`, `docs/adr/0010-admin-catalog-and-pricing-rules.md`, code backend/frontend hiện tại. Không dùng Docker.

## 1. Những gì đang có và chưa có

- Có website Next.js, Fastify API, PostgreSQL và bảng `products`, `categories`, `orders`, `order_items`, `sync_runs`, `sync_errors`, `price_observations`.
- Đã có tìm kiếm, ASIN, biến thể khi nguồn có bằng chứng, catalog đồng bộ từ Amazon, giá tham khảo JPY và công thức VND.
- Giá JPY→VND hiện lấy từ biến môi trường (`FX_JPY_TO_VND` mặc định 190; `SERVICE_FEE_PERCENT` mặc định 12), cần chuyển cấu hình vận hành vào DB khi xây Admin; không thay đổi đơn cũ.
- Đơn hiện chỉ có `simulation_created`: **chưa thu tiền, chưa mua trên Amazon, chưa có doanh thu hoặc lợi nhuận thật**.
- **Chưa có đăng nhập, Admin UI, API quản trị, trạng thái ẩn sản phẩm và thao tác nhập thêm ASIN theo yêu cầu**.
- Có cấu hình worker 04:00 `Asia/Tokyo`; **chưa xác minh việc chạy đúng lịch**. **Q10 = A:** chỉ chạy thủ công, nên 04:00 chỉ có thể quét khi máy và worker đã bật. Admin chỉ hiển thị `sync_runs` thực tế, không ghi “đồng bộ thành công” theo lịch đặt trước.

## 2. Nguyên tắc thiết kế Admin MVP đã chốt

1. **Q3 — ĐÃ CHỐT: một tài khoản chủ cửa hàng duy nhất trong Admin MVP**; không tạo tính năng thêm nhân viên, quản lý nhiều tài khoản hoặc màn phân quyền.
2. **Bốn mục menu cố định:** `Tổng quan`, `Sản phẩm`, `Đơn hàng`, `Cấu hình`.
3. **Một việc chính trên mỗi màn**; nút `Lưu`, `Thêm`, `Ẩn/Hiện` chỉ xuất hiện ở vị trí cần thiết. Tránh bảng nhiều cột, popup liên tiếp, biểu đồ không phục vụ quyết định.
4. **Q6 — ĐÃ CHỐT (A):** thao tác “Xóa khỏi cửa hàng” **chỉ ẩn sản phẩm**, không xóa vật lý ASIN hoặc lịch sử giá/đơn. Có thể `Hiện lại`; mọi lần đồng bộ hoặc nhập ASIN không được tự bỏ ẩn.
5. **Không sửa giá Amazon bằng tay** như thể giá nguồn đã được xác minh. Chỉ quản lý tỷ giá/phụ phí, còn giá JPY/timestamp đến từ observation hợp lệ.
6. **Không gọi thống kê đơn mô phỏng là doanh thu thực thu**; không hiển thị trạng thái “đã thanh toán” nếu chưa có cổng thanh toán và xác nhận giao dịch.
7. **Q9 — ĐÃ CHỐT (A): Admin MVP chỉ được truy cập qua localhost trên chính máy chạy dự án**, không triển khai ra internet, không cho phép truy cập từ điện thoại/máy khác qua LAN và không mở port backend/DB. Giới hạn truy cập không thay thế đăng nhập owner. Không công khai quyền hình ảnh/nội dung Amazon trước khi xác minh quyền sử dụng và điều kiện bán/nhập khẩu.
8. **Q10 — ĐÃ CHỐT (A):** owner chủ động chạy/dừng website, backend và worker tại máy Windows khi cần; không thêm Windows service, Task Scheduler hay cơ chế khởi chạy cùng hệ điều hành trong MVP.
9. **Q11 — ĐÃ CHỐT (A):** khởi tạo **một** tài khoản owner bằng **lệnh thiết lập tại máy local**; không xây trang đăng ký/thiết lập lần đầu.

## 3. Sitemap và màn hình đề xuất

```
/admin/login         (đăng nhập owner)
/admin               Tổng quan
/admin/san-pham      Sản phẩm
/admin/don-hang      Đơn hàng
/admin/cau-hinh      Cấu hình
```

**Gợi ý bố cục desktop** (không phải code):

```
┌──────────────────┬───────────────────────────────────────────────┐
│ mita japan       │ Tổng quan                                     │
│                  │                                               │
│ Tổng quan        │ Đơn mô phỏng (7 ngày)   Sản phẩm đang hiện    │
│ Sản phẩm         │ 14                       122                 │
│ Đơn hàng         │                                               │
│ Cấu hình         │ Đồng bộ Amazon: partial, cập nhật 02:22 JST    │
│                  │                                               │
│ Đăng xuất        │ Đơn mới nhất: mã | ngày | tiền hàng mô phỏng  │
└──────────────────┴───────────────────────────────────────────────┘
```

Số trong mockup **chỉ minh họa bố cục**, tuyệt đối không hardcode vào ứng dụng hoặc tự xưng là số thực tế.

### Màn A — Tổng quan (`/admin`)

**Nhìn 10 giây hiểu tình trạng:**

- Thẻ 1: **Đơn mô phỏng 7 ngày** (đếm `orders`, không đồng nghĩa doanh thu).
- Thẻ 2: **Số sản phẩm đang hiển thị** (không đếm bản ẩn; ghi rõ các sản phẩm chưa đủ điều kiện checkout vẫn có thể hiển thị).
- Một dòng: lần đồng bộ Amazon gần nhất (`success`/`partial`/`failed`/`needs_human`, số lỗi, thời điểm thực tế), có liên kết `Xem lỗi` nếu cần; khi worker chưa chạy thì nói rõ `Chưa có lần chạy xác nhận`.
- **Q7 — ĐÃ CHỐT (A):** Tổng quan **chỉ đọc và hiển thị kết quả đồng bộ Amazon tự động hằng ngày**, không có nút `Đồng bộ Amazon ngay`, không API admin kích hoạt quét toàn bộ danh mục. Cần cho biết lần chạy gần nhất, thời điểm thực tế, trạng thái, số sản phẩm và số lỗi; có thể xem lỗi ở ngay khu vực Tổng quan, không tạo trang điều khiển scraper riêng.
- **Q8 — ĐÃ CHỐT (A):** chỉ cảnh báo lỗi đồng bộ **trong màn Tổng quan**, không gửi email, SMS, push notification hay cấu hình dịch vụ gửi thông báo. Khi `failed`, `partial`, `needs_human` hoặc bỏ lỡ lần chạy theo lịch, hiển thị thông báo nổi bật với trạng thái, thời điểm thực tế, số lỗi và nguyên nhân ghi nhận được; có thể xem chi tiết lỗi tại Admin. Không coi `partial` là thành công hoàn toàn.
- Nếu không có lần chạy trong thời gian dự kiến, hiển thị `Chưa có kết quả đồng bộ theo lịch` hoặc `Chưa xác minh lịch chạy`; không giả trạng thái thành công và không gọi nguồn Amazon lúc tải Admin. **Cảnh báo chỉ xuất hiện khi chủ cửa hàng mở Admin** — không chủ động báo từ xa.
- **Ảnh hưởng Q10:** khi máy tắt hoặc worker chưa chạy lúc 04:00 JST, không có lượt đồng bộ được xác nhận; Tổng quan thể hiện thiếu lượt chạy thay vì coi cron đã thành công. Không tự khởi động worker hoặc chạy quét bù chỉ vì owner mở Admin.
- Bảng ngắn tối đa 5 **đơn mô phỏng mới nhất**: thời gian, mã đơn, tên, giá trị hàng (VND), xem chi tiết.
- Không cần biểu đồ doanh thu, tỷ lệ chuyển đổi, khách mới, biểu đồ nguồn traffic trong MVP.

### Màn B — Sản phẩm (`/admin/san-pham`)

- Ô tìm theo **ASIN hoặc tên**; một bộ lọc danh mục và một bộ lọc `Đang hiện / Đang ẩn`.
- Bảng 5–6 cột: Ảnh nhỏ, Tên/ASIN, Danh mục, Giá VND tham khảo, Trạng thái, `Ẩn` / `Hiện lại`.
- **Q6 đã chốt:** `Ẩn` có xác nhận ngắn; giữ bản ghi, giá lịch sử và tham chiếu từ đơn; xóa khỏi kết quả catalog công khai và chặn checkout tại API (kể cả khi khách biết ASIN). Không tự bỏ ẩn sau sync, kể cả khi owner nhập lại ASIN đã có.
- **Hiện lại** chỉ gỡ cờ ẩn thủ công; **không** bỏ qua quyền sử dụng nội dung, điều kiện bán, hàng còn hay giá quá 24 giờ. Ghi audit thời gian và tài khoản owner cho cả hai thao tác.
- **Thêm sản phẩm (Q1 đã chốt: A)**: owner dán **URL sản phẩm Amazon.co.jp hoặc ASIN**, chọn một trong hai danh mục hiện có, rồi bấm `Thêm`. Backend chuẩn hóa URL và ASIN, đưa yêu cầu vào hàng đợi nhập; giao diện chỉ báo `Đã tiếp nhận yêu cầu` thay vì `Đã thêm thành công` khi chưa có kết quả. Worker đọc dữ liệu nguồn và upsert theo ASIN sau khi kiểm tra đủ trường bắt buộc; trạng thái hiển thị là `pending`, `running`, `succeeded`, `failed` hoặc `needs_human`. **Chưa có collector chi tiết ASIN riêng trong code**, cần triển khai adapter chuyên biệt và kiểm thử, không tạo sản phẩm giả khi nguồn lỗi.
- ASIN đã tồn tại: mở sản phẩm tương ứng; yêu cầu trùng đang chạy: hiện trạng thái cũ thay vì tạo công việc thứ hai. Không cho nhập tay tên, ảnh hay giá để tránh mâu thuẫn với nguồn Amazon.
- Sản phẩm từ sync hằng ngày và từ thao tác “Thêm” sử dụng cùng kho products, không tạo kho dữ liệu khác.
- **Ảnh hưởng Q10:** yêu cầu nhập ASIN đã lưu có thể ở `pending` khi worker không chạy; giao diện không báo thành công trước khi worker thực sự xác minh/lưu. Không kích hoạt quét toàn danh mục bằng nút Admin.
- Không cần chỉnh từng mô tả, ảnh, SEO, tồn kho thủ công, sản phẩm khuyến mại hoặc nhập CSV trong MVP.

### Màn C — Đơn hàng (`/admin/don-hang`)

- **Q2 — ĐÃ CHỐT (A): chỉ xem đơn hàng mô phỏng.** Không có chức năng cập nhật trạng thái xử lý hoặc ghi chú nội bộ ở MVP.
- Bảng đơn mô phỏng, mặc định mới nhất: mã, ngày, người nhận, số mặt hàng, **tiền hàng mô phỏng** (VND), trạng thái `simulation_created`.
- Tìm mã đơn hoặc số điện thoại; xem chi tiết gồm tên, điện thoại, email (nếu có), địa chỉ, các ASIN/số lượng, snapshot giá VND/JPY, phí vận chuyển **ước tính thu sau**, thời điểm tạo.
- **Chỉ xem theo Q2:** không nút sửa trạng thái, thêm ghi chú, “Đã thanh toán”, “Giao hàng”, “Hoàn tiền” hoặc “Xóa đơn”. Khi xây thanh toán thật sẽ thiết kế quy trình riêng dựa trên ADR 0003, 0007, 0008 và bằng chứng giao dịch.
- Không gửi SMS/email tự động, không xuất Excel, không tích hợp vận chuyển trong MVP.

### Màn D — Cấu hình (`/admin/cau-hinh`)

- **Q4 — ĐÃ CHỐT (A):** chủ cửa hàng nhập **tỷ giá tính giá bán (VND/JPY)** thủ công và nhấn `Lưu`; mặc định khi khởi tạo cấu hình từ giá trị hiện có là `190`. Không tích hợp dịch vụ tỷ giá bên ngoài, tự cập nhật hoặc lịch làm mới tỷ giá trong Admin MVP.
- **Q5 — ĐÃ CHỐT (B):** chủ cửa hàng được chỉnh **phụ phí dịch vụ (%)** ngay bên dưới tỷ giá JPY/VND, trong cùng màn Cấu hình. Hai trường được lưu bằng **một nút `Lưu thay đổi`**, không có nút lưu riêng.
- Hiển thị phép tính thử từ 1.000 JPY: `round(1000 × 190 × 1.12 / 1000) × 1000 = 213.000 VND` với cấu hình mặc định.
- `Lưu thay đổi` kiểm tra cả hai số hợp lệ (tỷ giá VND/JPY > 0, phụ phí là tỷ lệ phần trăm hợp lệ không âm, có giới hạn an toàn phía server); hiển thị xác nhận **cả tỷ giá và phụ phí trước/sau** cùng giá thử. Lưu **đồng thời** hai giá trị và tăng version `PricingPolicy` trong một transaction, không được lưu nửa chừng.
- Chỉ áp dụng policy mới cho **giá catalog và checkout mới**; không tính lại đơn đã tạo. Ghi audit thời gian/người sửa và giá trị cũ/mới của cả hai trường.
- Dữ liệu cấu hình chuyển từ env mặc định sang bản ghi PostgreSQL duy nhất, dùng **cùng một hàm pricing** cho API catalog, sản phẩm và checkout. Lấy snapshot **cùng một version** của cả hai tham số lúc checkout, không trộn tỷ giá mới với phụ phí cũ.
- Không có tích hợp tỷ giá thời gian thực, đổi tỷ giá tự động hoặc thay đổi phí vận chuyển theo từng mặt hàng.

## 4. Domain modeling: danh từ, trạng thái, quan hệ

**Có sẵn, tiếp tục dùng:**

| Domain object | Khóa | Vai trò |
| --- | --- | --- |
| `Product` | ASIN | Sản phẩm Amazon theo category, giá quan sát và tình trạng bán |
| `Category` | slug | Hai danh mục đầu tiên; chứa phí vận chuyển ước tính |
| `PriceObservation` | ID / ASIN+time | Giá nguồn JPY + thời gian; không tự ý sửa timestamp |
| `Order` / `OrderItem` | UUID / order+ASIN | Đơn mô phỏng và các dòng snapshot, có thể truy vấn nhưng không giả giao dịch |
| `SyncRun` / `SyncError` | ID | Lịch sử chạy thật, lỗi nguồn và tình trạng cần can thiệp |

**Chỉ bổ sung khi triển khai các màn tương ứng:**

| Domain object | Tối thiểu cần có | Bất biến quan trọng |
| --- | --- | --- |
| `AdminAccount` / `AdminSession` | **Q3 + Q11:** một tài khoản owner duy nhất được khởi tạo qua lệnh local, mật khẩu hash và phiên đăng nhập có hạn | Không có form đăng ký/thiết lập owner trên web; không lưu mật khẩu dạng rõ; mọi admin mutation xác thực phía backend |
| `ProductVisibility` | `products.admin_hidden_at` nullable (+ lý do nếu cần) | Q6 đã chốt: worker và job nhập ASIN không được bỏ ẩn; sản phẩm ẩn không xuất hiện trong catalog/detail công khai và checkout không chấp nhận ASIN ẩn |
| `CatalogImportRequest` | ID, category, ASIN, state, created_at, error | Q1 đã chốt: chỉ nhập từ Amazon URL/ASIN; một ASIN hợp lệ, trạng thái pending/running/succeeded/failed/needs_human; không xác nhận thành công trước khi nguồn đủ dữ liệu |
| `PricingPolicy` | Bản ghi cấu hình đang hoạt động, version, **tỷ giá VND/JPY theo Q4 và phụ phí dịch vụ theo Q5, cả hai sửa được**, updated_at | Một lần bấm `Lưu` tạo một version nguyên tử cho cả hai thông số; thay đổi giá chỉ cho đơn mới, snapshot đơn giữ nguyên; không tự lấy tỷ giá |
| `AdminAuditEvent` | Actor, action, object, before/after hữu ích, timestamp | Ghi thay đổi giá, ẩn/hiện và yêu cầu nhập; không lưu password/secret |

**Các chuyển trạng thái cần có:**

- Sản phẩm về hiển thị (Q6 đã chốt): `visible ↔ hidden_by_admin` **chỉ do thao tác owner thay đổi**, độc lập với `sale_status=ready/pending_review` và `price_fresh/stale`. `visible` **không** có nghĩa `allowed_to_checkout`. Tái đồng bộ có thể làm mới giá khi ẩn nhưng không thay đổi cờ ẩn; không DELETE bản ghi.
- Yêu cầu thêm ASIN: `pending → running → succeeded | failed | needs_human`; trùng ASIN thì thông báo đã tồn tại/đang xử lý, không tạo bản nhân đôi.
- Đồng bộ (Q7 + Q8 + Q10): Admin **chỉ đọc** `sync_runs` và `sync_errors` để hiển thị trạng thái/cảnh báo tại Tổng quan; không gửi email, gọi scraper hay tạo job quét toàn danh mục theo yêu cầu. Worker có lịch 04:00 JST **chỉ thực hiện khi được khởi chạy thủ công và còn hoạt động**; cần kiểm thử lịch thực tế khi worker chạy, xử lý trạng thái thiếu lịch khi worker/máy tắt, không khẳng định tự chạy sau restart. Luồng nhập một ASIN theo Q1 là chức năng riêng.
- Đơn (Q2 đã chốt): `simulation_created` **chỉ đọc toàn bộ**; không tạo API cập nhật ghi chú/trạng thái và không dựng trạng thái đã trả tiền.
- Chính sách giá (Q4 + Q5): owner chỉnh một hoặc cả hai giá trị rồi bấm `Lưu thay đổi`, `v1 → v2` một lần; `Order` giữ snapshot giá/tỷ giá/phụ phí thuộc cùng policy version tại thời điểm tạo.

## 5. Bảo mật tối thiểu nhưng bắt buộc

- Mật khẩu owner có hash an toàn (Argon2id/scrypt tùy thư viện triển khai); **không** hardcode mật khẩu/token vào Git.
- **Q3 + Q11 đã chốt:** tạo một owner bằng lệnh setup chạy cục bộ với nhập mật khẩu kín (không truyền mật khẩu qua tham số lệnh, không ghi vào log, source hoặc Git), hash mật khẩu an toàn và lưu tại backend/DB. Nếu đã có owner, lệnh không được tạo người thứ hai hoặc ghi đè tùy tiện; cần hướng dẫn khôi phục/reset qua quy trình local có kiểm soát, không có UI thiết lập hay quản lý user.
- Cookie phiên `HttpOnly`, `SameSite`, `Secure` khi dùng HTTPS; hết hạn/đăng xuất có hiệu lực; rate-limit login; CSRF/Origin check với thao tác ghi.
- Tất cả `/api/admin/*` và các route `/admin/*` nhạy cảm phải kiểm tra phiên ở server; không chỉ ẩn menu bằng JavaScript. Không đưa DB admin ra frontend.
- Chống ID/ASIN/URL không hợp lệ: chỉ nhận ASIN 10 ký tự hoặc URL HTTPS trỏ tới `amazon.co.jp` / `www.amazon.co.jp` với đường dẫn sản phẩm có ASIN; trích xuất ASIN rồi dựng URL `https://www.amazon.co.jp/dp/{ASIN}` phía server, **không fetch trực tiếp URL đầu vào** (SSRF, redirect sang host khác).
- Giới hạn nhập/chạy job, có nhật ký thay đổi, error state rõ; không bypass Amazon 403/429/CAPTCHA.
- **Q9 đã chốt (A): chỉ bind Next.js Admin và API Fastify phục vụ Admin vào `127.0.0.1` / loopback trên máy chạy dự án**; không cấu hình port forward, public hosting, VPN/LAN remote hay mở DB ra mạng trong MVP. Vẫn yêu cầu session owner, CSRF, rate limit và kiểm soát quyền phía server. Nếu sau này đổi sang truy cập internet phải có quyết định và rà soát HTTPS/bảo mật mới.

## 6. Lộ trình triển khai theo các mốc nhỏ

| Mốc | Việc xây | Kiểm tra nghiệm thu |
| --- | --- | --- |
| **A. Đăng nhập + khung Admin** | CLI local khởi tạo một owner theo Q11; login/session, middleware API, sidebar 4 mục, logout; giữ truy cập loopback theo Q9 | Setup không tạo owner thứ hai/không lộ mật khẩu; thiếu session bị chặn tại `/admin`/`/api/admin`; thử sai password rate-limited; không có màn quản lý user |
| **B. Xem dữ liệu thật** | Dashboard + danh sách/chi tiết đơn mô phỏng **chỉ đọc theo Q2**, danh sách sản phẩm, kết quả sync theo Q7 và **cảnh báo trong Tổng quan theo Q8** | Số liệu khớp SQL; API đơn hàng/sync không mutation; lỗi `failed`/`partial`/`needs_human` và thiếu lượt chạy 04:00 khi worker tắt được báo; không gửi email và không coi lịch đã chạy khi chưa có `sync_run` |
| **C. Quản lý catalog** | Ẩn/hiện thay vì xóa theo Q6, bền qua sync và thêm lại ASIN; thêm ASIN Amazon bằng job riêng (Q1 đã chốt), nhật ký lỗi | Hidden không lọt catalog/detail công khai/checkout; cập nhật tự động và import không bật lại; lịch sử giữ nguyên; trùng ASIN không tạo job trùng; lỗi import không tạo hàng giả |
| **D. Chính sách giá** | **Hai trường tỷ giá VND/JPY và phụ phí (%) đều chỉnh được theo Q4 + Q5**, một nút `Lưu thay đổi`, một policy version PostgreSQL, preview và audit | Một lần lưu cập nhật đồng thời cả hai; dữ liệu sai bị từ chối; checkout lấy cùng version; đơn cũ giữ nguyên; giá stale vẫn bị khóa |
| **E. Hoàn thiện** | Tests tích hợp, accessibility cơ bản, backup/restore dev; hướng dẫn 1 trang để chủ động chạy/dừng frontend, backend, worker và dùng CLI owner theo Q10/Q11 | Build/lint/test pass; chỉ loopback; sau khởi động lại Windows không tự chạy; thử worker đang chạy lúc 04:00 JST và trường hợp bỏ lỡ lịch; không dựng Windows service hay web setup |

**Điều kiện vận hành Q10:** thứ tự thao tác thủ công dự kiến là bật PostgreSQL (nếu chưa chạy), backend, worker, frontend; phải kiểm tra lại lệnh chạy thực tế khi triển khai. Nếu muốn đồng bộ lúc 04:00 JST, máy và worker cần tiếp tục hoạt động đến thời điểm đó. **Không bảo đảm quét hằng ngày khi chưa chạy worker**, không tự chạy bù khi mở Admin. Tự khởi động cùng Windows **không thuộc MVP**. Chỉ kiểm chứng scheduler đúng giờ khi worker đang hoạt động, không suy đoán thành công.

**Các điều kiện cần xác minh khi triển khai, không phải câu hỏi Grill mới:** collector một ASIN riêng chưa có; scheduler/worker cần kiểm thử; quyền sử dụng nội dung Amazon và điều kiện bán/nhập khẩu cần được kiểm tra; backup/restore DB và bảo mật setup owner phải được kiểm thử. Các việc này không có nghĩa Admin đã được xây.

## 7. Không làm trong bản Admin đầu tiên

Không dashboard nhiều biểu đồ, CRM, tồn kho Nhật, thanh toán/refund, phân quyền nhân viên, voucher, push notification, quảng cáo, xuất nhập Excel, chỉnh ảnh, sửa giá nguồn, tracking, chatbot, tích hợp tỷ giá trực tiếp, UI điều khiển cron hay bảng điều khiển scraper nâng cao.

## 8. Điều kiện quyết định / câu hỏi Grill

- **Q1 — ĐÃ CHỐT ngày 27/10/2026:** **A — Dán link/ASIN Amazon để hệ thống nhập tự động**. Không triển khai form tự nhập tên/ảnh/giá trong Admin MVP. Lưu ý: đây là quyết định thiết kế, không phải xác nhận tính năng đã chạy.
- **Q2 — ĐÃ CHỐT ngày 27/10/2026:** **A — chỉ xem danh sách và chi tiết đơn mô phỏng**, không cập nhật trạng thái/ghi chú. Đơn không thể được đánh dấu đã thanh toán trong Admin MVP.
- **Q3 — ĐÃ CHỐT ngày 27/10/2026:** **A — một tài khoản chủ cửa hàng duy nhất**; không có tài khoản nhân viên, không có quản lý user hay RBAC trong Admin MVP. Việc thay đổi mật khẩu/khôi phục quyền truy cập cần quy trình thiết lập an toàn, không hardcode credentials.
- **Q4 — ĐÃ CHỐT ngày 27/10/2026:** **A — owner tự nhập tỷ giá VND/JPY và nhấn Lưu trong Admin**; không tự đồng bộ qua API. Giá sản phẩm/đơn mới dùng tỷ giá vừa lưu; đơn cũ giữ nguyên snapshot. Đây là tỷ giá tính giá bán Mita, không phải tỷ giá ngân hàng bắt buộc.
- **Q5 — ĐÃ CHỐT ngày 27/10/2026:** **B — cho phép sửa phụ phí dịch vụ (%) cùng tỷ giá JPY/VND, chỉ một nút `Lưu thay đổi`**. Mặc định hiện tại là 12%; các đơn cũ không thay đổi. Phụ phí dịch vụ **khác** phí vận chuyển ước tính thu sau.
- **Q6 — ĐÃ CHỐT ngày 27/10/2026:** **A — “Xóa” = Ẩn và có thể Hiện lại**, không hard-delete sản phẩm, giữ lịch sử; đồng bộ Amazon và thao tác thêm ASIN **không được tự gỡ cờ ẩn**. Trạng thái ẩn chặn catalog công khai và checkout ở backend.
- **Q7 — ĐÃ CHỐT ngày 27/10/2026:** **A — chỉ xem tình trạng đồng bộ Amazon tự động hằng ngày trong Admin**, không thêm nút `Đồng bộ Amazon ngay` hoặc API khởi động quét toàn danh mục từ Admin. Lần chạy/giờ chạy phải dựa trên `sync_runs` thực tế; cần xác minh lịch worker riêng trước khi coi số liệu đáng tin.
- **Q8 — ĐÃ CHỐT ngày 27/10/2026:** **A — chỉ cảnh báo lỗi đồng bộ Amazon ngay trong trang Tổng quan Admin**, không gửi email hoặc thông báo chủ động. Thể hiện rõ trạng thái lỗi/một phần/cần can thiệp/bỏ lỡ lịch, thời điểm và số lỗi; không cố vượt CAPTCHA hoặc 403/429.
- **Q9 — ĐÃ CHỐT ngày 27/10/2026:** **A — Admin chỉ truy cập từ chính máy phát triển qua localhost**, không mở truy cập từ xa qua internet/LAN. Vẫn sử dụng đăng nhập bảo mật một owner theo Q3.
- **Q10 — ĐÃ CHỐT ngày 27/10/2026:** **A — chạy website/backend/worker thủ công khi cần**, không khởi động tự động cùng Windows. Worker không chạy vào 04:00 JST thì không có kết quả sync được xác nhận; Admin phải cảnh báo thiếu lịch thay vì nói đã thành công.
- **Q11 — ĐÃ CHỐT ngày 27/10/2026:** **A — thiết lập mật khẩu cho một owner bằng lệnh setup an toàn trên localhost/máy local**, không xây trang thiết lập tài khoản lần đầu. Không hardcode hoặc commit mật khẩu.
- **Grill Admin kết thúc:** **11/11 câu đã được owner trả lời**, không còn câu hỏi quyết định đang mở. Bước tiếp theo (chỉ khi được giao) là triển khai code theo A → E. Theo yêu cầu owner, **không commit Git chỉ để ghi câu hỏi/trả lời**; thay đổi tài liệu hiện giữ trong working tree.

## 9. Tiêu chí “đủ tốt để sử dụng”

Owner đăng nhập, mở 4 mục và làm được bốn việc trong ít bước: kiểm tra tình hình, ẩn/hiện sản phẩm, đọc chi tiết một đơn mô phỏng, đổi tỷ giá với preview. Không có thao tác có vẻ đã thanh toán/mua hàng khi hệ thống mới chỉ mô phỏng. Thay đổi phải an toàn, truy vết được và không bị scraper ghi đè ngoài ý muốn.
