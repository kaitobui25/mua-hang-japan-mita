# Mita Japan — Kế hoạch build frontend theo thiết kế 02 Garden

**Ngày:** 27/10/2026  
**Trạng thái:** Kế hoạch triển khai; chưa tạo ứng dụng frontend  
**Mục tiêu:** Website mua hộ hàng Nhật dành cho khách Việt, bắt đầu với thực phẩm bổ sung và sản phẩm mẹ & bé; dễ tìm, dễ hiểu, dùng nhanh trên điện thoại và mở rộng được danh mục về sau.

## 1. Quyết định đã chốt

- **Giao diện:** Phương án số 2, **Garden**, người dùng đã chọn. Giữ nền kem ấm, chữ xanh lá đậm, ảnh sản phẩm lớn, đường phân cách mảnh, khoảng trắng thoáng. Không đổi sang phong cách khác khi build.
- **Ngôn ngữ:** Tiếng Việt trước; giữ tên Nhật ở phần chi tiết/metadata nếu có dữ liệu xác thực. Không tự tạo lời chứng thực, số lượng khách hoặc cam kết giao hàng.
- **Hành động chính:** `Khám phá sản phẩm` → `Thêm vào yêu cầu` → `Yêu cầu báo giá`. Chưa làm thanh toán tự động trong MVP.
- **Nguồn hàng:** Catalog tự quản/được duyệt để hiển thị nhanh; dự kiến cập nhật một lần/ngày ở backend. Frontend chỉ đọc catalog, không gọi trực tiếp Amazon/ZenMarket.
- **Giá và tồn kho:** Chưa xác minh thì hiển thị `Giá cần xác nhận` và không gắn nhãn còn hàng. Giá có nguồn hợp lệ phải đi cùng thời điểm cập nhật; báo giá được xác minh lại trước khi khách đồng ý.

**Tham chiếu đã có** (đường dẫn tính từ thư mục gốc `mua-hang-japan-mita/`):

- `designs/02-family/tokens.css`: màu, font, spacing, kích thước và motion.
- `designs/02-family/base.css`: reset, container, typography, focus, responsive.
- `designs/assets/`: ảnh sản phẩm mẫu và `shop.js` của prototype cũ; dùng tham khảo/demo nội bộ, không mặc nhiên có quyền công bố thương mại.
- `../analysis/amazon-provider-design.md`: trạng thái giá, ASIN/biến thể, yêu cầu báo giá.
- `.agents/chatgtplog/01_zenmarket_amazon_catalog_tong_hop.md`: hướng catalog nhỏ, cache DB và đồng bộ hằng ngày.
- Ảnh chụp mẫu **02 Garden** đã được duyệt trong cuộc trò chuyện: trang chủ và danh mục ở desktop/mobile. Hiện những ảnh này **chưa lưu trong repo**; mô tả ở mục 2 là chuẩn triển khai cho tới khi đưa ảnh tham chiếu vào dự án.

## 2. Bản thiết kế Hallmark cần giữ

**Hallmark v2.0.0, theme Garden, genre editorial, job: buy.** Phong cách người dùng đã chọn là tiêu chuẩn cao nhất; áp dụng các yêu cầu về màu, font, focus, motion và chất lượng từ Hallmark.

| Thành phần | Đặc tả thực thi |
| --- | --- |
| Top bar | Một dải xanh đậm ngắn, chỉ dùng thông tin chính xác. Trong demo ghi rõ sản phẩm/giá minh họa; bản thật không mang nội dung demo. |
| Header desktop | Wordmark chữ `mita japan` dạng text cho đến khi có logo chính thức; menu `Thực phẩm bổ sung`, `Mẹ & bé`, `Chăm sóc cá nhân`, `Danh mục khác`; ô tìm kiếm và nút `Yêu cầu (n)`. |
| Header mobile | Wordmark, số yêu cầu; ô tìm kiếm nguyên hàng dưới header, luôn dễ chạm. |
| Hero trang chủ | **Chữ bên trái, hình sản phẩm bên phải**, nền kem; tiêu đề `Chăm chút từng điều nhỏ.`; mô tả `Đồ dùng Nhật cho sức khỏe và những năm đầu của bé.`; CTA chính `Khám phá sản phẩm`, CTA phụ `Chọn theo danh mục`. |
| Khám phá | Khối `Chọn theo từng thành viên` dẫn đến nhóm sản phẩm; sau đó là danh mục và sản phẩm gợi ý từ dữ liệu thật. |
| Trang danh mục | Tiêu đề `Từ Nhật, cho những điều gần gũi.`; sidebar danh mục ở desktop; số kết quả, sắp xếp và lưới sản phẩm. |
| Product card | Ảnh vừa khung, thương hiệu, tên, nhãn nguồn/giá phù hợp trạng thái, nút `Thêm vào yêu cầu`; yêu thích chỉ là tiện ích phụ. |
| Mobile catalog | 2 cột sản phẩm ở khoảng 375px nếu chữ/nút đủ rộng; bộ lọc mở dưới dạng sheet/drawer; dưới màn hình có navigation `Trang chủ`, `Tìm kiếm`, `Danh mục`, `Yêu cầu`. |
| Footer | Thông tin mua hộ, cách yêu cầu báo giá và các liên kết chính sách **khi đã có nội dung thực**. |

**Design tokens khóa lại:** nền `--color-paper`, chữ `--color-ink`, CTA `--color-accent` từ `tokens.css`; tiêu đề **Vollkorn 600**, nội dung **Hanken Grotesk 400/500**. `Newsreader` chỉ tải khi dùng caption ảnh. Giữ font fallback, `font-display: swap`, hairline, bán kính 4px, không đổ bóng dày, không dùng gradient màu hoặc hiệu ứng chuyển động trang trí. Mọi màu và font được gọi qua token.

**Bố cục:** container tối đa `1440px`, gutter hiện có `64px` desktop, `24px` tablet, `16px` mobile; hero không che khuất tiêu đề, mô tả và CTA ở **1280×800**. Không tràn ngang từ 320px trở lên. Hình hero cần ảnh thật/ảnh được phép sử dụng; hình hộp sản phẩm dựng trong screenshot chỉ là placeholder của bản chọn thiết kế, không phải sản phẩm xác thực.

## 3. Phạm vi và các trang của MVP

| Route | Nội dung | Đầu ra người dùng |
| --- | --- | --- |
| `/` | Trang chủ Garden: hero, lối vào danh mục, gợi ý sản phẩm, hướng dẫn mua hộ ngắn | Tìm đến món hàng trong 1–2 thao tác |
| `/san-pham` | Toàn bộ catalog, tìm kiếm, bộ lọc, sắp xếp, phân trang | Duyệt nhanh và tìm được sản phẩm |
| `/danh-muc/[slug]` | Catalog đã lọc theo nhóm, dùng lại giao diện `/san-pham` | URL riêng để chia sẻ/SEO từng danh mục |
| `/san-pham/[id]` | Ảnh, tên, thương hiệu, mã ASIN/URL nguồn nếu có, biến thể, mô tả, trạng thái giá, số lượng | Xem đủ thông tin trước khi yêu cầu |
| `/yeu-cau` | Danh sách sản phẩm/link Amazon, số lượng, thông tin liên hệ và trạng thái gửi | Chuẩn bị hoặc gửi yêu cầu báo giá khi API sẵn sàng |
| `/cach-mua-hang` | Giải thích bước chọn hàng, kiểm giá, xác nhận báo giá | Hiểu rõ mua hộ và các khoản phí trước khi quyết định |

**Ngoài MVP:** tài khoản khách hàng, thanh toán, mã giảm giá, đánh giá/điểm sao, live chat, đa ngôn ngữ, quản trị, đồng bộ Amazon, tracking đơn và tự động tính phí. Chỉ mở những chức năng này khi backend/nghiệp vụ có thật.

### Luồng khách hàng cần chạy được

1. **Từ danh mục:** Mở trang → chọn `Thực phẩm bổ sung` hoặc `Mẹ & bé` → lọc/tìm → mở chi tiết → chọn biến thể/số lượng → thêm vào giỏ yêu cầu.
2. **Từ tìm kiếm:** Gõ tiếng Việt hoặc tên thương hiệu/ASIN → Enter/chọn kết quả → trạng thái loading, rỗng hoặc lỗi được giải thích rõ; từ khóa và bộ lọc tồn tại trên URL để tải lại/chia sẻ.
3. **Từ link Amazon:** Dán URL Amazon.co.jp → kiểm định dạng ở frontend → gửi backend giải quyết ASIN → cho vào danh sách yêu cầu khi backend xác nhận. Không fetch URL tùy ý từ trình duyệt.
4. **Từ giỏ yêu cầu:** Xem/sửa số lượng, loại bỏ sản phẩm, điền liên hệ khi API đã sẵn sàng → gọi tạo yêu cầu → chỉ báo thành công **sau khi server trả về ID**. Nếu chưa có backend, hiển thị chế độ demo rõ ràng và tắt nút gửi thật.

## 4. Kiến trúc frontend tối giản

**Đề xuất stack:** Next.js (App Router) + React + TypeScript + CSS hiện có. Lý do: render/SEO cho trang danh mục và chi tiết, có route động; thành phần tương tác chỉ dùng client-side khi cần. **Không thêm** Tailwind, thư viện UI lớn, state manager hoặc search engine trong bước đầu. Chọn phiên bản ổn định tại lúc tạo project và commit lockfile.

```text
mua-hang-japan-mita/
├── designs/02-family/                 # nguồn theme đã chốt, giữ nguyên
│   ├── tokens.css
│   └── base.css
├── designs/assets/                    # tài sản mẫu, chỉ dùng khi đủ quyền
├── src/
│   ├── app/
│   │   ├── layout.tsx                  # fonts, CSS, header, footer
│   │   ├── globals.css                 # CSS theo component/layout; import theme cũ
│   │   ├── page.tsx                    # home
│   │   ├── san-pham/page.tsx
│   │   ├── san-pham/[id]/page.tsx
│   │   ├── danh-muc/[slug]/page.tsx
│   │   ├── yeu-cau/page.tsx
│   │   └── cach-mua-hang/page.tsx
│   ├── components/
│   │   ├── layout/                      # Header, Search, BottomNav, Footer
│   │   ├── catalog/                     # CategoryNav, ProductGrid/Card, Filters
│   │   └── request/                     # RequestList, Quantity, QuoteForm
│   ├── lib/
│   │   ├── catalog.ts                  # đọc catalog demo hoặc REST API
│   │   ├── request.ts                  # gọi quote API khi có backend
│   │   └── format.ts                   # định dạng text, ngày, giá có xác minh
│   ├── types/catalog.ts
│   └── data/demo-products.ts           # dữ liệu giả có nhãn DEMO, chỉ dùng dev
├── public/images/                     # ảnh đã được duyệt quyền sử dụng
└── .agents/plan/02_garden_frontend_build_plan.md
```

**Quy tắc triển khai:** Dùng lại trực tiếp token và base Garden làm single source of truth; bổ sung CSS bố cục trong `globals.css` hoặc CSS module khi thực sự cần. Trạng thái bộ lọc, từ khóa, trang và sort nằm trong query string; giỏ yêu cầu đơn giản lưu ở `localStorage` (chỉ ID/ASIN, biến thể, số lượng, không ghi giá như cam kết). Không phụ thuộc backend khi dựng UI tĩnh, nhưng không giả thành công khi chưa có API.

### Hợp đồng dữ liệu phía frontend

```ts
type CatalogProduct = {
  id: string;
  asin?: string;
  sourceUrl?: string;
  name: string;
  brand?: string;
  categorySlug: string;
  imageUrl?: string;           // chỉ ảnh có quyền hiển thị
  status: 'ready' | 'pending_review' | 'unavailable';
  priceJpy?: number | null;    // không tự đưa vào UI khi thiếu xác minh
  priceObservedAt?: string;
  priceVerifiedAt?: string;
  priceSourceId?: string;
  priceVerification?: 'unverified' | 'staff_verified' | 'source_verified' | 'expired';
  lastUpdatedAt?: string;
  availability?: 'in_stock' | 'out_of_stock' | 'unknown' | 'requires_verification';
  variants?: { id: string; asin?: string; label: string }[];
};

type RequestItem = {
  productId?: string;
  sourceUrl?: string;
  asin?: string;
  variantAsin?: string;
  quantity: number;
};
```

**API cần cho giai đoạn kết nối** (từ tài liệu backend, chưa tồn tại):

- `GET /api/catalog?category=...&q=...&page=1&limit=24&sort=...` → `items`, `total`, `page`, `lastUpdatedAt`; backend cần thống nhất hỗ trợ `q` và `sort` vì tài liệu cũ mới mô tả category/page.
- `GET /api/catalog/products/:asin` → chi tiết, biến thể và provenance; nếu item chưa có ASIN thì dùng `id` nội bộ, cần thống nhất endpoint trước khi kết nối.
- `POST /api/amazon/resolve-url` → ASIN hoặc `pending_review`.
- `POST /api/amazon/quotes` → `quoteId`, `status`; chỉ dùng khi backend vận hành.

Ở MVP, danh mục có thể hiển thị dữ liệu seed **được phép dùng** dù API chưa sẵn sàng. `lastUpdatedAt` mô tả thời điểm cập nhật catalog, **không phải** bằng chứng hàng còn bán. Giá/tình trạng chưa chắc chắn phải giữ trạng thái riêng.

## 5. Thứ tự build và tiêu chí hoàn thành

### Mốc A — Khởi tạo và khóa hệ thống Garden

- [ ] Tạo Next.js + TypeScript, script `dev`, `build`, `lint` và lockfile; không cài thư viện không dùng.
- [ ] Nạp `tokens.css`, `base.css` đúng thứ tự, cài font Vollkorn/Hanken Grotesk bằng cơ chế phù hợp của Next.js, fallback đầy đủ.
- [ ] Tạo các primitive nhỏ: `Container`, `Button`, `Input`, `SectionHeading`, `ProductImage`; các trạng thái hover/focus/active/disabled rõ ràng.
- [ ] Có khung header desktop/mobile và bottom navigation mobile giống mẫu Garden.

**Nghiệm thu A:** app chạy được, CSS dùng token, menu mobile bằng bàn phím được, các màn 320/375/768/1280/1920 không tràn ngang.

### Mốc B — Trang chủ và điều hướng danh mục

- [ ] Build hero **y như bố cục mẫu số 2**: typography lớn bên trái, hình hàng hóa bên phải; CTA dẫn tới trang sản phẩm và danh mục.
- [ ] Làm khu `Chọn theo từng thành viên`, các nhóm chính và danh sách sản phẩm tiêu biểu bằng dữ liệu seed.
- [ ] Dùng ảnh đúng sản phẩm được duyệt quyền; trong dev hiển thị nhãn demo khi ảnh/thông tin là mẫu.
- [ ] Thêm hướng dẫn đặt yêu cầu ngắn, footer gọn và liên kết điều hướng thực.

**Nghiệm thu B:** tại 1280×800 thấy toàn bộ heading, mô tả, CTA của hero; ở 375px search và CTA thao tác dễ; các link đều có trang đích.

### Mốc C — Catalog, lọc và chi tiết sản phẩm

- [ ] Lưới desktop 4 cột khi đủ rộng; sidebar danh mục độc lập. Mobile 2 cột nếu bảo đảm tên và nút không bị ép, nếu không giảm 1 cột ở viewport hẹp.
- [ ] Search theo tên/brand, lọc danh mục, sắp xếp phù hợp dữ liệu, phân trang; giữ state trong URL và có nút xóa lọc.
- [ ] Trang chi tiết có ảnh, thương hiệu, tên Nhật (nếu có), biến thể/ASIN, số lượng, nguồn/thời điểm giá, CTA thêm yêu cầu.
- [ ] Các trạng thái skeleton khi loading, empty có nút thử lại/bỏ lọc, lỗi tải có nút retry; ảnh lỗi có fallback rõ ràng.

**Nghiệm thu C:** tìm kiếm và lọc trả kết quả đúng, reload URL giữ trạng thái; không bao giờ dựng giá, nhãn khuyến mãi hay tồn kho không có nguồn.

### Mốc D — Giỏ yêu cầu và URL Amazon

- [ ] Thêm/bớt sản phẩm, điều chỉnh số lượng, giữ dữ liệu qua reload (không lưu thông tin nhạy cảm trong localStorage).
- [ ] Trường dán link Amazon Japan có label, ví dụ hợp lệ, lỗi gần input; frontend validate giao thức/domain/cấu trúc ASIN và vẫn để backend kiểm tra lại.
- [ ] Màn `/yeu-cau` thể hiện `chưa gửi`/`đang gửi`/`lỗi`; liên hệ và nút submit chỉ kích hoạt khi API thật đã được tích hợp.
- [ ] Khi có API: gửi một lần, chống double submit, hiển thị `quoteId` và `pending_review` khi server trả thành công; không gọi là đã mua hàng.

**Nghiệm thu D:** giỏ không mất khi reload, input lỗi có chỉ dẫn, không có thông báo “đã gửi” giả, link Amazon khác domain bị từ chối.

### Mốc E — Kết nối API và hoàn thiện chất lượng

- [ ] Chuyển `catalog.ts` từ dữ liệu demo sang `GET /api/catalog` khi endpoint có thật; xử lý data thiếu, stale và sync lỗi.
- [ ] Kiểm lại quyền ảnh/nội dung, alt text, metadata SEO, title/category canonical, loading ảnh và font.
- [ ] Kiểm tra bàn phím, screen reader cơ bản, focus trap drawer/dialog, nút chạm tối thiểu 44×44px và `prefers-reduced-motion`.
- [ ] Chạy `npm run build`, kiểm tra lint, smoke test các luồng chính ở mobile/desktop và Hallmark sloplint `--render` trên server dev.

**Nghiệm thu E:** không có lỗi build, không còn Hallmark **FAIL**; xử lý/ghi rõ các **REFLEX** còn lại trước bàn giao. Hiệu năng mobile đo thực tế bằng Lighthouse/Web Vitals, mục tiêu tham khảo: **LCP ≤ 2,5s**, **INP ≤ 200ms**, **CLS ≤ 0,1** (không tuyên bố đạt khi chưa đo).

## 6. Checklist Hallmark bắt buộc trong lúc code

- [ ] Mọi màu/font qua token; không thêm màu literal sau block token hoặc thay Garden bằng palette khác.
- [ ] Không `transition: all`, không animation layout (`width/height/top/left`); Garden chỉ chuyển trạng thái nhẹ, không cần reveal.
- [ ] `html, body { overflow-x: clip; }`; container max-width; grid có ảnh dùng `minmax(0, 1fr)`.
- [ ] Heading cân đối, không italic một từ để nhấn; không eyebrow/inert tracked-caps; không icon emoji hoặc card lồng card.
- [ ] Toàn bộ nút/link/input có focus-visible ngay lập tức, disabled/loading/error rõ; hỗ trợ reduced motion.
- [ ] Hero nhìn thấy CTA trong viewport 1280×800 và bố cục mobile không lệch/che bởi bottom nav.
- [ ] Có Hallmark stamp và critique ở đầu **stylesheet mới**; chạy `sloplint --render` với app đang mở trên dev server, kiểm tra ảnh chụp 375/1280/1920.
- [ ] Không công bố chỉ số, phản hồi, logo hãng, giá, tồn kho, cam kết giao hàng hoặc công dụng y tế chưa có bằng chứng.

## 7. Những đầu vào cần có trước khi public

1. Logo/wordmark chính thức (hiện tạm dùng text `mita japan`) và ảnh hero/bộ ảnh sản phẩm có quyền sử dụng. Ảnh ở `designs/assets` là mẫu tham khảo, chưa đủ căn cứ để coi là tài sản marketing được cấp phép.
2. Danh mục/seed sản phẩm đã duyệt, đơn vị kinh doanh và thông tin liên hệ thật; chính sách nhận đơn, báo giá, vận chuyển và bảo mật.
3. Backend catalog và API báo giá hoặc quyết định giữ chế độ demo. Chưa có backend thì chỉ nghiệm thu prototype tương tác, chưa nghiệm thu nghiệp vụ gửi đơn.

**Thứ tự thực hiện:** A → B → C → D → E. Hoàn tất và kiểm tra mỗi mốc trước khi làm mốc tiếp theo. Không cần tạo admin, app mobile riêng hoặc hệ thống tìm kiếm phức tạp ở giai đoạn này.
