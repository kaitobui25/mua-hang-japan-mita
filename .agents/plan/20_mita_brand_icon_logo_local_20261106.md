# Plan: Dùng logo chữ m lá cho Mita Japan local (2026-11-06)

## Mục tiêu và quyết định đã chốt

- Ảnh nguồn duy nhất: `designs/assets/logo/chatgpt-01-m-leaf.png`. Người dùng đã chọn ảnh này làm biểu tượng thương hiệu và favicon.
- Phạm vi: **website local**, chưa deploy/push. Giữ chữ nhận diện `mitajapan.` bên cạnh biểu tượng trong header/footer để khách nhận ra tên cửa hàng; không đổi thiết kế tổng thể.
- Phong cách: Hallmark Garden đang có; tôn trọng `designs/02-family/tokens.css`, Vollkorn/Hanken Grotesk, nền giấy kem, xanh rêu. Chỉ thay nhận diện, tránh redesign trang.
- Hiện trạng xác minh: PNG 1024×1024, không có alpha; có khoảng trắng kem quanh chữ `m` xanh, hai lá và dấu chấm cam. `public/` hiện chưa có logo/favicon; `src/app/` chưa có icon/apple-icon. Server `http://127.0.0.1:3000` chưa truy cập được khi khảo sát, do đó chưa kiểm tra trực quan bản local đang chạy.

## Các hạng mục triển khai

### 1. Chuẩn bị các phiên bản ảnh

- Giữ nguyên ảnh nguồn.
- Từ ảnh đã chọn xuất bản dùng ở header (cỡ khoảng 192–256px, WebP/PNG tối ưu). Cắt bớt vùng đệm để chữ `m` nhận ra ở kích thước nhỏ; không thay đổi nét, tỷ lệ hay dấu chấm. Loại nền kem cho bản trên header **nếu** kiểm tra được mép chữ/lá không bị quầng; nếu không, dùng nền kem phù hợp token và tránh hình vuông lệch màu.
- Footer nền xanh đậm: dùng bản nền kem trong ô vuông có chủ ý, hoặc bản tương phản sáng được kiểm tra trực quan, không đặt chữ xanh đậm trực tiếp trên nền tối.
- Tạo `src/app/icon.png` (favicon PNG ~48–64px) và `src/app/apple-icon.png` (180×180) từ cùng biểu tượng. Ưu tiên bố cục chặt để dễ nhìn tại 16/32px. Chưa cần manifest/PWA vì repository hiện chưa có.
- Lưu tài nguyên website dưới `public/brand/`, tên rõ ràng; tránh liên kết runtime tới `designs/assets/logo/` vì đây không phải đường dẫn public.

### 2. Thay logo trong storefront

- `src/components/layout/header.tsx`: đặt ảnh `m` cạnh wordmark hiện tại trong cùng Link về `/`; giữ `aria-label="Mita Japan, về trang chủ"`; ảnh trang trí có `alt=""`, không tạo hai liên kết riêng; giữ việc đóng mobile menu khi bấm logo.
- `src/components/layout/footer.tsx`: áp dụng cùng nhận diện; xử lý nền tối và giữ nội dung chân trang.
- `src/app/globals.css`: điều chỉnh tối thiểu lớp `.wordmark` / lớp logo mới để căn hàng, khoảng cách, focus và responsive. Chú ý selector `.wordmark span:first-child` hiện có, tránh để nó vô tình áp style của chữ lên bọc ảnh.
- Kích thước định hướng (sẽ chốt qua render): icon 36–40px desktop, 28–32px mobile; Link bao cả biểu tượng + chữ có vùng bấm cao ≥44px. Với màn 320–375px, kiểm tra logo không chèn nút menu, giỏ hàng hay thanh tìm kiếm; thu nhỏ chữ nếu cần thay vì tạo thanh cuộn ngang.

### 3. Gắn favicon đúng cơ chế Next.js 15 App Router

- Dùng file convention `src/app/icon.png` / `src/app/apple-icon.png`; Next.js tạo link icon từ các file này. Kiểm tra markup của trang và URL asset thực tế sau chạy.
- `src/app/layout.tsx` hiện chỉ khai báo title/description/robots. **Không thêm `metadata.icons` nếu file convention đã đủ**; tránh hai bộ `<link rel="icon">` trùng nhau. Không thay title, canonical hay cấu hình SEO khác.
- Logo admin ở `src/app/admin/login/page.tsx` và `src/app/admin/(protected)/layout.tsx` đang dùng chữ `mita japan`; đưa vào bước riêng sau khi storefront đạt chuẩn nếu muốn đồng bộ cả giao diện quản trị.

### 4. Kiểm tra và nghiệm thu trên local

- Trước khi chạy website: kiểm tra port/process; không gọi `scripts/start-local.ps1` hay đụng database, worker, VPS. Có thể dùng `npm run dev` khi port 3000 trống, rồi dừng đúng process đã tự khởi chạy sau kiểm tra.
- Chạy `npm run lint` (`tsc --noEmit`), `git diff --check`, xem `git status --short`; chỉ review file thuộc phạm vi logo và những file mới thực sự phát sinh.
- Kiểm tra trang chủ, catalog, sản phẩm, giỏ hàng và mua hộ Amazon ở desktop/mobile: biểu tượng đúng, wordmark dễ đọc, không CLS/overflow; kiểm tra keyboard focus và click quay về `/`.
- Kiểm tra favicon thực ở tab 16/32px, apple icon 180px, trả về HTTP 200 và hard-refresh sau khi đổi vì trình duyệt cache favicon.
- Chụp/so sánh trước-sau ở 1440, 768, 375 và 320px nếu browser local chạy được. Nếu chưa chạy, ghi rõ chưa xác minh visual runtime; không báo hoàn tất chỉ dựa trên TypeScript.

## Tiêu chí hoàn thành

1. Source ảnh được giữ nguyên, các bản public/icon đều xuất phát từ đúng file người dùng chọn.
2. Logo trong header/footer rõ và hòa cùng nền trên cả desktop/mobile; tên `mitajapan.` còn nhận diện được.
3. Tab trình duyệt và icon khi lưu ra màn hình chính dùng biểu tượng mới.
4. Không đụng API/database/VPS, không thay SEO ngoài các link icon; các file đã có của người dùng được giữ nguyên.
5. Có bằng chứng lint + kiểm tra visual hoặc giới hạn kiểm chứng được báo rõ.

## File dự kiến tác động

| Loại | Đường dẫn |
| --- | --- |
| Giữ nguyên | `designs/assets/logo/chatgpt-01-m-leaf.png` |
| Thêm | `public/brand/mita-mark.png` |
| Không cần thêm | Bản riêng cho footer; ảnh nền kem gốc được dùng như ô icon tương phản trên nền tối |
| Thêm | `src/app/icon.png`, `src/app/apple-icon.png` |
| Sửa | `src/components/layout/header.tsx`, `src/components/layout/footer.tsx` |
| Sửa | `src/app/globals.css` |
| Chỉ sửa nếu kiểm chứng cần | `src/app/layout.tsx` |

## Kết quả triển khai local (2026-11-06)

- Đã tạo ba ảnh từ nguồn đã chọn: `public/brand/mita-mark.png` (256×256), `src/app/icon.png` (64×64), `src/app/apple-icon.png` (180×180). File nguồn được giữ nguyên (SHA-256: `B71DF5B0E90724F25CDB7D5067305FD0BA19AC31F3F4C21331FEBB1B87F52487`).
- Đã tích hợp biểu tượng và wordmark trong header/footer; xử lý responsive và vòng focus. Không sửa giao diện admin.
- `npm run lint` và `git diff --check` đạt; Codex CLI review độc lập không phát hiện vấn đề.
- Next local: `/`, `/mua-ho-amazon`, `/gio-hang` và cả ba URL ảnh trả 200; HTML có icon 64×64 và apple-touch-icon 180×180; BrowserOS Neo xác minh header/biểu tượng và kiểm tra tràn ngang theo kích cỡ thiết bị.
- Giới hạn: `/san-pham` trả 500 trong phiên chỉ chạy frontend vì backend `127.0.0.1:4000` không hoạt động; không khởi động backend hay thay database.

**Trạng thái:** Đã triển khai và kiểm tra cho frontend local. Chưa push hoặc deploy lên VPS.
