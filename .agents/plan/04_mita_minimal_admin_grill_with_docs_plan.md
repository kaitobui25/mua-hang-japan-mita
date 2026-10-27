# Mita Japan — Grill with Docs: Admin tối giản

**Ngày:** 27/10/2026 (JST)
**Trạng thái:** `draft / Q1 accepted / awaiting Q2` — Q1 đã được owner chốt; các phần còn lại vẫn là đề xuất, chưa triển khai code.
**Ưu tiên:** chủ cửa hàng chưa quen quản trị website, cần giao diện dễ hiểu, ít thao tác, không thêm tính năng chỉ vì các website khác có.
**Căn cứ:** `GLOSSARY.md`, ADR 0001–0008, `docs/adr/0009-minimal-owner-admin.md`, `docs/adr/0010-admin-catalog-and-pricing-rules.md`, code backend/frontend hiện tại. Không dùng Docker.

## 1. Những gì đang có và chưa có

- Có website Next.js, Fastify API, PostgreSQL và bảng `products`, `categories`, `orders`, `order_items`, `sync_runs`, `sync_errors`, `price_observations`.
- Đã có tìm kiếm, ASIN, biến thể khi nguồn có bằng chứng, catalog đồng bộ từ Amazon, giá tham khảo JPY và công thức VND.
- Giá JPY→VND hiện lấy từ biến môi trường (`FX_JPY_TO_VND` mặc định 190; `SERVICE_FEE_PERCENT` mặc định 12), cần chuyển cấu hình vận hành vào DB khi xây Admin; không thay đổi đơn cũ.
- Đơn hiện chỉ có `simulation_created`: **chưa thu tiền, chưa mua trên Amazon, chưa có doanh thu hoặc lợi nhuận thật**.
- **Chưa có đăng nhập, Admin UI, API quản trị, trạng thái ẩn sản phẩm và thao tác nhập thêm ASIN theo yêu cầu**.
- Có cấu hình worker 04:00 `Asia/Tokyo`; **chưa xác minh được lịch tự chạy đủ độ tin cậy**. Admin chỉ hiển thị trạng thái ghi nhận thực tế, không ghi “đồng bộ thành công” theo lịch đặt trước.

## 2. Nguyên tắc thiết kế (đề xuất)

1. **Một người quản trị (owner) ở MVP**; không tạo vai trò kế toán/kho/nhân viên hoặc màn phân quyền.
2. **Bốn mục menu cố định:** `Tổng quan`, `Sản phẩm`, `Đơn hàng`, `Cấu hình`.
3. **Một việc chính trên mỗi màn**; nút `Lưu`, `Thêm`, `Ẩn/Hiện` chỉ xuất hiện ở vị trí cần thiết. Tránh bảng nhiều cột, popup liên tiếp, biểu đồ không phục vụ quyết định.
4. **Không xóa vật lý sản phẩm** vì sẽ bị scraper nhập lại, và còn liên quan lịch sử đơn. “Xóa khỏi cửa hàng” = **Ẩn** (có thể khôi phục); ingestion không được tự bật lại.
5. **Không sửa giá Amazon bằng tay** như thể giá nguồn đã được xác minh. Chỉ quản lý tỷ giá/phụ phí, còn giá JPY/timestamp đến từ observation hợp lệ.
6. **Không gọi thống kê đơn mô phỏng là doanh thu thực thu**; không hiển thị trạng thái “đã thanh toán” nếu chưa có cổng thanh toán và xác nhận giao dịch.
7. Không đưa Admin ra internet, không public quyền hình ảnh/nội dung Amazon trước khi xác minh quyền sử dụng và điều kiện bán/nhập khẩu.

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
- Bảng ngắn tối đa 5 **đơn mô phỏng mới nhất**: thời gian, mã đơn, tên, giá trị hàng (VND), xem chi tiết.
- Không cần biểu đồ doanh thu, tỷ lệ chuyển đổi, khách mới, biểu đồ nguồn traffic trong MVP.

### Màn B — Sản phẩm (`/admin/san-pham`)

- Ô tìm theo **ASIN hoặc tên**; một bộ lọc danh mục và một bộ lọc `Đang hiện / Đang ẩn`.
- Bảng 5–6 cột: Ảnh nhỏ, Tên/ASIN, Danh mục, Giá VND tham khảo, Trạng thái, `Ẩn` / `Hiện lại`.
- **Ẩn** có xác nhận ngắn; **Hiện lại** chỉ khôi phục khả năng hiển thị, **không** bỏ qua kiểm tra giá quá 24 giờ hoặc điều kiện được phép bán.
- **Thêm sản phẩm (Q1 đã chốt: A)**: owner dán **URL sản phẩm Amazon.co.jp hoặc ASIN**, chọn một trong hai danh mục hiện có, rồi bấm `Thêm`. Backend chuẩn hóa URL và ASIN, đưa yêu cầu vào hàng đợi nhập; giao diện chỉ báo `Đã tiếp nhận yêu cầu` thay vì `Đã thêm thành công` khi chưa có kết quả. Worker đọc dữ liệu nguồn và upsert theo ASIN sau khi kiểm tra đủ trường bắt buộc; trạng thái hiển thị là `pending`, `running`, `succeeded`, `failed` hoặc `needs_human`. **Chưa có collector chi tiết ASIN riêng trong code**, cần triển khai adapter chuyên biệt và kiểm thử, không tạo sản phẩm giả khi nguồn lỗi.
- ASIN đã tồn tại: mở sản phẩm tương ứng; yêu cầu trùng đang chạy: hiện trạng thái cũ thay vì tạo công việc thứ hai. Không cho nhập tay tên, ảnh hay giá để tránh mâu thuẫn với nguồn Amazon.
- Sản phẩm từ sync hằng ngày và từ thao tác “Thêm” sử dụng cùng kho products, không tạo kho dữ liệu khác.
- Không cần chỉnh từng mô tả, ảnh, SEO, tồn kho thủ công, sản phẩm khuyến mại hoặc nhập CSV trong MVP.

### Màn C — Đơn hàng (`/admin/don-hang`)

- Bảng đơn mô phỏng, mặc định mới nhất: mã, ngày, người nhận, số mặt hàng, **tiền hàng mô phỏng** (VND), trạng thái `simulation_created`.
- Tìm mã đơn hoặc số điện thoại; xem chi tiết gồm tên, điện thoại, email (nếu có), địa chỉ, các ASIN/số lượng, snapshot giá VND/JPY, phí vận chuyển **ước tính thu sau**, thời điểm tạo.
- **Giai đoạn đầu chỉ xem**: không nút “Đã thanh toán”, “Giao hàng”, “Hoàn tiền”, “Xóa đơn”. Khi xây thanh toán thật sẽ thiết kế quy trình riêng dựa trên ADR 0003, 0007, 0008 và bằng chứng giao dịch.
- Không gửi SMS/email tự động, không xuất Excel, không tích hợp vận chuyển trong MVP.

### Màn D — Cấu hình (`/admin/cau-hinh`)

- Hai trường số: **Tỷ giá tính giá bán (VND/JPY)**, mặc định `190`; **Phụ phí dịch vụ (%)**, mặc định `12` (có thể đặt trong khu vực “Nâng cao” đóng sẵn nếu muốn chỉ một trường trước mắt).
- Hiển thị phép tính thử từ 1.000 JPY: `round(1000 × 190 × 1.12 / 1000) × 1000 = 213.000 VND` với cấu hình mặc định.
- `Lưu thay đổi` yêu cầu xác nhận ảnh hưởng **đến giá catalog/checkout mới**, không thay số tiền đơn đã tạo; lưu thời điểm/người sửa.
- Dữ liệu cấu hình chuyển từ env mặc định sang bản ghi PostgreSQL duy nhất, dùng **cùng một hàm pricing** cho API catalog, sản phẩm và checkout. Lấy snapshot cùng chính sách tại checkout (không trộn giá từ hai phiên bản).
- Mặc định không có tích hợp tỷ giá thời gian thực hay thay đổi phí vận chuyển theo từng mặt hàng.

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
| `AdminAccount` / `AdminSession` | Một owner + hash mật khẩu, phiên đăng nhập có hạn | Không lưu mật khẩu dạng rõ; mọi admin mutation xác thực phía backend |
| `ProductVisibility` | `products.admin_hidden_at` nullable (+ lý do nếu cần) | Worker không bỏ ẩn; checkout không chấp nhận sản phẩm đang ẩn |
| `CatalogImportRequest` | ID, category, ASIN, state, created_at, error | Q1 đã chốt: chỉ nhập từ Amazon URL/ASIN; một ASIN hợp lệ, trạng thái pending/running/succeeded/failed/needs_human; không xác nhận thành công trước khi nguồn đủ dữ liệu |
| `PricingPolicy` | Bản ghi cấu hình đang hoạt động, version, tỷ giá, phụ phí, updated_at | Giới hạn hợp lệ, thay đổi giá chỉ cho đơn mới; snapshot đơn giữ nguyên |
| `AdminAuditEvent` | Actor, action, object, before/after hữu ích, timestamp | Ghi thay đổi giá, ẩn/hiện và yêu cầu nhập; không lưu password/secret |

**Các chuyển trạng thái cần có:**

- Sản phẩm về hiển thị: `visible ↔ hidden_by_admin` độc lập với `sale_status=ready/pending_review` và `price_fresh/stale`. `visible` **không** có nghĩa `allowed_to_checkout`.
- Yêu cầu thêm ASIN: `pending → running → succeeded | failed | needs_human`; trùng ASIN thì thông báo đã tồn tại/đang xử lý, không tạo bản nhân đôi.
- Đồng bộ: chỉ đọc trạng thái thật từ `sync_runs`; chưa thêm nút điều khiển lịch/chạy thủ công trong MVP để tránh thao tác rủi ro.
- Đơn: giai đoạn này `simulation_created` chỉ đọc; không dựng trạng thái đã trả tiền.
- Chính sách giá: `v1 → v2` khi owner lưu; `Order` giữ snapshot giá/tỷ giá/phụ phí của thời điểm tạo.

## 5. Bảo mật tối thiểu nhưng bắt buộc

- Mật khẩu owner có hash an toàn (Argon2id/scrypt tùy thư viện triển khai); **không** hardcode mật khẩu/token vào Git.
- Cookie phiên `HttpOnly`, `SameSite`, `Secure` khi dùng HTTPS; hết hạn/đăng xuất có hiệu lực; rate-limit login; CSRF/Origin check với thao tác ghi.
- Tất cả `/api/admin/*` và các route `/admin/*` nhạy cảm phải kiểm tra phiên ở server; không chỉ ẩn menu bằng JavaScript. Không đưa DB admin ra frontend.
- Chống ID/ASIN/URL không hợp lệ: chỉ nhận ASIN 10 ký tự hoặc URL HTTPS trỏ tới `amazon.co.jp` / `www.amazon.co.jp` với đường dẫn sản phẩm có ASIN; trích xuất ASIN rồi dựng URL `https://www.amazon.co.jp/dp/{ASIN}` phía server, **không fetch trực tiếp URL đầu vào** (SSRF, redirect sang host khác).
- Giới hạn nhập/chạy job, có nhật ký thay đổi, error state rõ; không bypass Amazon 403/429/CAPTCHA.
- Môi trường local loopback; trước khi mở internet cần HTTPS, backup DB, xử lý quyền dữ liệu Amazon, rà soát bảo mật và chính sách riêng tư.

## 6. Lộ trình triển khai theo các mốc nhỏ

| Mốc | Việc xây | Kiểm tra nghiệm thu |
| --- | --- | --- |
| **A. Đăng nhập + khung Admin** | Login owner, session, middleware API, sidebar 4 mục, logout | Không đăng nhập mở `/admin`/`/api/admin` bị từ chối; thử sai password rate-limited |
| **B. Xem dữ liệu thật** | Dashboard + danh sách/chi tiết đơn mô phỏng và danh sách sản phẩm chỉ đọc | Số liệu khớp SQL; không hiển thị doanh thu thật; thông tin đơn chỉ admin xem |
| **C. Quản lý catalog** | Ẩn/hiện bền qua sync, thêm ASIN Amazon bằng job riêng (Q1 đã chốt), nhật ký lỗi | Hidden không lọt catalog/checkout; cập nhật tự động không bật lại; trùng ASIN không tạo job trùng; lỗi import không tạo hàng giả |
| **D. Chính sách giá** | Tỷ giá/phụ phí PostgreSQL, preview, audit, checkout snapshot nhất quán | Đổi tỷ giá đổi giá mới, không đổi đơn cũ; input sai bị chặn; checkout vẫn khóa giá stale |
| **E. Hoàn thiện** | Tests tích hợp, accessibility cơ bản, backup/restore dev, hướng dẫn sử dụng một trang | Build/lint/test pass; thao tác nghiệp vụ tối thiểu; kiểm tra localhost sau restart |

**Điều kiện ngoài phạm vi:** xác minh pg-boss chạy 04:00 và khởi động lại cùng Windows là luồng vận hành riêng, phải làm trước khi coi Admin là công cụ giám sát tự động đáng tin cậy. Không ngầm coi scheduler đã xong.

## 7. Không làm trong bản Admin đầu tiên

Không dashboard nhiều biểu đồ, CRM, tồn kho Nhật, thanh toán/refund, phân quyền nhân viên, voucher, push notification, quảng cáo, xuất nhập Excel, chỉnh ảnh, sửa giá nguồn, tracking, chatbot, tích hợp tỷ giá trực tiếp, UI điều khiển cron hay bảng điều khiển scraper nâng cao.

## 8. Điều kiện quyết định / câu hỏi Grill

- **Q1 — ĐÃ CHỐT ngày 27/10/2026:** **A — Dán link/ASIN Amazon để hệ thống nhập tự động**. Không triển khai form tự nhập tên/ảnh/giá trong Admin MVP. Lưu ý: đây là quyết định thiết kế, không phải xác nhận tính năng đã chạy.
- **Q2 — Đang hỏi owner:** Khi xem đơn hàng, muốn **A. chỉ xem đơn mô phỏng** (ít nút, khuyến nghị khi chưa có thanh toán thật) hay **B. thêm ghi chú/trạng thái xử lý nội bộ thủ công** (ví dụ `Chưa xem`/`Đã liên hệ`, tuyệt đối không `Đã thanh toán`)? Nếu chọn B, cần bảng trạng thái nội bộ và audit tối giản, không tự thay đổi bằng chứng thanh toán.
- **Giả định có thể thay đổi:** một owner duy nhất, không nhân viên; tỷ giá tự điền thủ công, không lấy live; đơn hàng chỉ xem ở giai đoạn mô phỏng.
- **Để vòng Grill tiếp theo:** chốt Q2 trước; nếu cần mới hỏi nhu cầu nhiều người quản trị. Không cần 15–20 câu hỏi một lần.

## 9. Tiêu chí “đủ tốt để sử dụng”

Owner đăng nhập, mở 4 mục và làm được bốn việc trong ít bước: kiểm tra tình hình, ẩn/hiện sản phẩm, đọc chi tiết một đơn mô phỏng, đổi tỷ giá với preview. Không có thao tác có vẻ đã thanh toán/mua hàng khi hệ thống mới chỉ mô phỏng. Thay đổi phải an toàn, truy vết được và không bị scraper ghi đè ngoài ý muốn.
