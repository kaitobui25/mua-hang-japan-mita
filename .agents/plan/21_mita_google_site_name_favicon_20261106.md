# Mita Japan — sửa tên và favicon trên kết quả Google (2026-11-06)

## Mục tiêu

- Google có đủ tín hiệu để ưu tiên tên website **Mita Japan** thay cho **Duck DNS**.
- Google có thể lấy favicon chữ **m** và lá cây đã chọn (`designs/assets/logo/chatgpt-01-m-leaf.png`), đang xuất thành `src/app/icon.png`.
- Giữ nguyên domain `https://mitajapanshop.duckdns.org/`, nhận diện Hallmark Garden, trang sản phẩm và logic backend.
- Đây là cải thiện điều kiện hiển thị; Google tự quyết định site name/favicon, không cam kết kết quả hoặc ngày cập nhật.

## Hiện trạng thực chứng

Kiểm tra ngày 2026-11-06 trên **HTTPS public**:

- `GET /`: HTTP 200; title `mita japan — Chăm chút từng điều nhỏ`, H1 trước đợt SEO gần đây chỉ là khẩu hiệu.
- HTML public **chưa có** `WebSite` JSON-LD, `og:site_name`, `link rel="icon"`, `apple-touch-icon`.
- `GET /icon.png` và `GET /brand/mita-mark.png` đều trả **404**. Ảnh đã có trong local ở commit `03ff1ff`, nhưng chưa có trên bản public đang phục vụ Google.
- `robots.txt`: HTTP 200, cho phép `/`, chỉ chặn `/api/`, khai báo sitemap.
- Google Search Central: `WebSite` structured data trên homepage là tín hiệu chính cho site name; favicon phải được Googlebot-Image tải được và URL ổn định. Google xử lý lại sau khi crawl, có thể mất nhiều ngày/tuần. Tham khảo:
  - https://developers.google.com/search/docs/appearance/site-names
  - https://developers.google.com/search/docs/appearance/favicon-in-search

## Phần thực hiện trong source local

1. **Tên website:** trong `src/app/layout.tsx`, chuẩn hóa metadata cho `Mita Japan`; thêm `applicationName`, `openGraph.siteName` và metadata Open Graph hợp lý, không thay đổi robots/siteURL hoặc canonical trang con.
2. **WebSite schema:** thêm đúng **một** JSON-LD `WebSite` tại `src/app/(store)/page.tsx` (homepage), `name: "Mita Japan"`, `alternateName: "mitajapan"`, `url: SITE_URL + "/"`. Không thêm vào root layout tất cả trang; không tạo `Organization` với dữ kiện chưa xác minh.
3. **Favicon:** giữ file convention hiện có `src/app/icon.png` (64×64) và `src/app/apple-icon.png` (180×180); kiểm tra HTML có link tự sinh, asset HTTP 200 và nội dung đúng logo. Không tạo icon khác không cần thiết hoặc link icon trùng.
4. **Kiểm chứng local:** `npm run lint`, `git diff --check`, HTML homepage chứa 1 WebSite JSON-LD, `og:site_name`, icon link, không có duplicate; kiểm tra các route khác không có WebSite schema ngoài homepage, giữ nguyên admin `noindex`.
5. **Review và commit:** rà diff và commit chọn lọc đúng file của task. Giữ nguyên file chưa commit của người dùng, không push GitHub, không deploy VPS hay động database.

## Việc cần thực hiện sau khi cho phép phát hành website public

1. Triển khai code bằng quy trình release được phê duyệt riêng; kiểm tra SHA/revision thực trên VPS, `GET /`, `GET /icon.png`, `GET /apple-icon.png` từ bên ngoài đều HTTP 200. Không phát hành bằng cách đồng bộ dữ liệu VPS ngoài lịch, không gộp với migration.
2. Dùng Google Search Console **URL Inspection** trên `https://mitajapanshop.duckdns.org/` để kiểm tra index và yêu cầu recrawl **một lần** sau khi mã mới đã public; không liên tục resubmit khi chưa có thay đổi.
3. Theo dõi kết quả Google ở Việt Nam/Nhật Bản qua vài ngày/tuần; tách tín hiệu site name/favicon trên SERP khỏi GSC index và sitemap.

## Điều kiện chấp nhận

- Local HTML có đầy đủ site name và favicon của Mita, không trùng schema, không đổi layout hay điều kiện index đã duyệt.
- Sau khi phát hành, trang chủ và favicon public truy cập được đối với Googlebot. **Chỉ khi Google thực sự cập nhật SERP** mới xác nhận vấn đề Duck DNS đã hết.

## Kết quả triển khai local

- Codex CLI thực hiện sửa `src/app/layout.tsx` và `src/app/(store)/page.tsx`. Sau review, giữ `openGraph.siteName` ở root, không ép tiêu đề OG của trang chủ lên trang con.
- `npm run lint` và `git diff --check` đạt.
- Trên web local `127.0.0.1:3000`: homepage HTTP 200, có đúng một JSON-LD `WebSite` (name `Mita Japan`, alternateName `mitajapan`, URL HTTPS public); trang `/mua-ho-amazon` và `/admin/login` không có schema `WebSite` dư. `og:site_name` và link icon có mặt, `/icon.png` và `/apple-icon.png` đều HTTP 200.
- Không thay database/worker, không đẩy GitHub, không deploy VPS và không gửi yêu cầu GSC.

**Trạng thái:** Code local đã triển khai và kiểm tra. **Bước còn lại để xử lý kết quả Google:** phát hành có phê duyệt, xác nhận favicon/metadata public rồi yêu cầu Google thu thập lại.
