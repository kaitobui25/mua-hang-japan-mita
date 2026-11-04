# ADR 0019 — Trải nghiệm dán link và xem sản phẩm mua hộ Amazon Nhật

**Ngày quyết định:** 04/11/2026 (JST)

**Trạng thái:** Accepted — **quyết định yêu cầu sản phẩm**, chưa nghiệm thu triển khai

**Phạm vi:** Trang `/mua-ho-amazon` và điểm vào từ homepage Mita Japan
**Nguồn:** Câu trả lời Grill with Docs trực tiếp ngày 04/11/2026, kế thừa `.agents/plan/14_mua_ho_amazon_grill_20261030.md` và `.agents/plan/18_mua_ho_amazon_ui_grill_chot_20261103.md`.

## 1. Mục tiêu và thứ tự ưu tiên

**Mục tiêu đợt này (Q1 = B):** Khách dán URL/ASIN Amazon Nhật, xem **thông tin sản phẩm**, **báo giá VND hợp lệ** và **thêm vào giỏ Mita**. Hoàn tất gửi đơn/checkout vẫn tuân thủ đặc tả cũ, nhưng **không phải tiêu chuẩn hoàn thành chính của đợt Grill này**; không diễn giải Q1 = B thành xóa/bỏ các tính năng checkout đã thiết kế.

**Nhóm thông tin được ưu tiên (Q2 = A, B, D, E):**

- **A:** Tên, thương hiệu, ảnh sản phẩm.
- **B:** Mô tả, thành phần, cách dùng, thông số và đặc điểm khi có nguồn thực.
- **D:** Điểm sao, tổng số đánh giá và nội dung đánh giá **từ Amazon** khi có quyền hiển thị.
- **E:** Ngày giao Amazon và dự kiến về Việt Nam, điều kiện vận chuyển.

**Không chọn C ở câu hỏi ưu tiên không có nghĩa bỏ giá/seller/variant.** Để đáp ứng mục tiêu B, vẫn bắt buộc có báo giá VND, giá JPY nguồn và đúng người bán, phiên bản, số lượng, bằng chứng giao Nhật miễn phí thường theo chính sách đã chốt. Không có các trường bắt buộc này thì **không cho thêm giỏ**.

## 2. Quyết định đã chốt từ 12 câu trả lời

| Câu | Quyết định | Hệ quả trong sản phẩm |
| --- | --- | --- |
| Q1 — B | Hiển thị sản phẩm + báo giá VND + thêm giỏ | Không coi chỉ hiện ASIN hay tên sản phẩm là hoàn thành mục tiêu |
| Q2 — A/B/D/E | Ưu tiên tên/ảnh, nội dung chi tiết, rating/review, ETA/vận chuyển | Chỉ hiển thị thông tin có nguồn và quyền phù hợp; giá và seller vẫn bắt buộc cho quote |
| Q3 — ghi chú cụ thể | Giữ URL/ASIN đang hỗ trợ, **thêm/bao gồm URL dài Amazon.co.jp có slug trước `/dp/ASIN` và query tracking** | Lấy ASIN từ đường dẫn, chuẩn hóa về URL nguồn không có tracking; xem mục 3 |
| Q4 — B | Nhập/dán **ngay tại trang** mua hộ thì tra khi bấm nút hoặc Enter | Homepage nhập URL theo đặc tả cũ vẫn tự mở trang và bắt đầu tra một lần |
| Q5 — A | Amazon chặn và ASIN chưa có dữ liệu: hiển thị ASIN, link nguồn, lý do chưa tra được | **Không** tự tạo yêu cầu mua hộ thủ công, không lấy giá/ảnh từ catalog cũ để thay thế |
| Q6 — B | **Không dùng fallback tên catalog** cho trang mua hộ Amazon | Đây là thay đổi so với code local hiện tại; chỉ trình bày dữ liệu quan sát Amazon hợp lệ hoặc ASIN + trạng thái |
| Q7 — A | Tiếp tục nghiên cứu/hoàn thiện **Scrapling** với guard/cooldown hợp lệ | Không tự chuyển sang API trả phí, nhà cung cấp khác hay bypass |
| Q8 — A | Nếu **quote thương mại hợp lệ** nhưng không có ảnh/mô tả/review được phép, **vẫn cho thêm giỏ** | Dùng placeholder, ẩn trường thiếu; không chặn mua vì thiếu metadata trang trí |
| Q9 — A | Nếu cần liên hệ hỗ trợ, dùng Zalo/Messenger **hiện có** | Không xây form/queue thủ công mới; không tạo yêu cầu tự động khi Q5 xảy ra |
| Q10 — B | Khi tạm dừng nguồn, hiển thị **mốc sớm nhất được phép xét lại** nếu đã xác minh | Phải ghi “không bảo đảm khôi phục”; không hứa sẽ đọc được vào giờ đó |
| Q11 — A | Ưu tiên **hoàn chỉnh và kiểm chứng trên Windows local trước** | Không tự chuyển sang VPS, không dùng BrowserOS PC làm phụ thuộc production |
| Q12 — A | Nghiệm thu bằng **bộ tình huống đại diện**, so với hành vi kỳ vọng | Tách nhận diện ASIN, source-preview và quote thực; xem mục 6 |

## 3. Phạm vi URL được xác nhận

Hỗ trợ như hiện tại: **ASIN 10 ký tự**, HTTPS `amazon.co.jp` hoặc `www.amazon.co.jp` với đường dẫn sản phẩm `/dp/<ASIN>`, `/gp/product/<ASIN>`; và **URL dài có tên sản phẩm trước `/dp/ASIN` với query parameters**, điển hình:

```text
https://www.amazon.co.jp/Double-Sided-Generator-Phosphate-Disaster-Prevention/dp/B0FR4GT3R7?ref=dlx_21617_dg_dcl_B0FR4GT3R7_dt_mese18_8a_pi&pf_rd_r=HB06B5ZPFY6H4ZPX70NM&pf_rd_p=57d8339a-4607-4c64-ad68-003dc8df7b8a&sbo=RZvfv%2F%2FHxDF%2BO5021pAnSA%3D%3D
```

**Kết quả chuẩn hóa mong đợi:** ASIN `B0FR4GT3R7`, URL nguồn `https://www.amazon.co.jp/dp/B0FR4GT3R7`. Không chuyển tracking/query sang URL nguồn, không cần dựa vào tên slug để xác định sản phẩm. Kiểm tra parser **offline** ngày 04/11/2026 trích đúng ASIN từ chuỗi trên; điều này **không chứng minh** đã truy cập Amazon hoặc đã xác minh sản phẩm/offer thật.

**Không được suy rộng quyết định Q3** thành hỗ trợ `amzn.asia`, `amzn.to`, mọi đoạn text chia sẻ, URL HTTP, domain giả, đường dẫn listing hoặc redirect. Người dùng không chọn các loại đó; giữ ngoài phạm vi đợt này. Bảo toàn kiểm tra HTTPS, hostname, không userinfo/port tùy ý, giới hạn độ dài và ASIN chính xác.

## 4. Điều kiện hiển thị và đặt mua không thay đổi

1. **ASIN hợp lệ theo cú pháp ≠ sản phẩm xác minh từ Amazon ≠ quote hợp lệ.** Khi nguồn bị block/cooldown hoặc ASIN không có nguồn, chỉ hiện ASIN, URL chuẩn và trạng thái lỗi, **không hiện tên đã lưu trong catalog Mita**. Không lấy ảnh, giá, seller hay review catalog để bù thiếu; thay đổi Q6 chỉ áp dụng luồng mua hộ Amazon, không xóa catalog Mita.
2. Nội dung Amazon (ảnh, mô tả, rating/review) cần đúng ASIN, provenance và **quyền công bố cụ thể**. `displayPermission` backend vẫn phải có tài liệu/quyết định xác minh quyền; chỉ đọc được HTML không đồng nghĩa được hiển thị lại thương mại. Không có quyền thì bỏ field hoặc dùng placeholder; không trộn review Amazon với review Mita.
3. Chỉ phát hành quote/cho thêm giỏ sau khi xác minh **cùng một offer**: ASIN, phiên bản, người bán, số lượng, mua một lần, giá, còn hàng, **miễn phí giao thường nội địa Nhật không cần Prime**. Không dùng Prime, Subscribe & Save, coupon có điều kiện hay offer khác. Thay số lượng phải báo giá lại; không suy ra giá số lượng mới.
4. Quote **15 phút**, VND tính theo chính sách Mita; phí Nhật → Việt Nam riêng và có thể chưa biết (`null` ≠ 0). ETA công khai có thể thiếu; thiếu ETA **không chặn** quote hợp lệ, nhưng phải cảnh báo/xác nhận. Nếu có ETA: + N **ngày lịch** Admin cấu hình, không gắn nhãn Osaka khi chưa xác minh địa điểm.
5. Hết hạn phải tra lại và yêu cầu khách xác nhận các thay đổi; đơn gửi thành công trong hạn được chốt giá hàng, Mita chịu chênh lệch tăng sau đó. Phí vận chuyển được đề xuất và khách xác nhận riêng. Gửi đơn tại Mita **không tự động mua trên Amazon**.
6. Giao diện kết quả trên cùng `/mua-ho-amazon`, dùng phong cách Garden/Hallmark và link nguồn Amazon. Nút Google Dịch miễn phí theo thao tác người dùng và các giới hạn dịch của plan 18 không đổi.

## 5. Trạng thái và hành vi khi nguồn gián đoạn

| Trạng thái | Thông tin được hiển thị | Quyền thêm giỏ |
| --- | --- | --- |
| Link/ASIN sai | Lỗi đầu vào, không suy đoán ASIN | Không |
| `recognized_input` | ASIN + URL nguồn; chưa có dữ liệu sản phẩm mới | Không |
| `source_blocked` / `cooldown` | ASIN, URL nguồn, lý do; **mốc đủ điều kiện xét lại** nếu có dữ liệu đáng tin, cảnh báo không bảo đảm | Không |
| `observed_source_preview` nhưng offer thiếu điều kiện | Chỉ trường có bằng chứng và quyền công bố, ghi rõ chưa phải quote | Không |
| `verified_quote` | Tên, seller, variant, qty, giá JPY/VND, điều kiện giao, hạn, ETA nếu có; metadata tùy quyền | **Có**, sau xác nhận cần thiết |
| Quote hết hạn | Giữ dòng giỏ; tra lại và chờ xác nhận quote mới | Không checkout với giá cũ |

Không biến mốc `retry_after_at` thành giờ tự mở gate hoặc khẳng định nguồn sẽ thành công. Nếu không có mốc được xác minh, ghi **chưa xác định**. Không tự gọi lại Amazon ngoài lịch/nguồn cho phép để đáp ứng hiển thị mốc. Không xóa gate, không giải/vượt CAPTCHA, 403/429 hoặc rate limit.

## 6. Bộ nghiệm thu yêu cầu (Q12 = A)

| Case | Kết quả mong đợi |
| --- | --- |
| URL mẫu dài `B0FR4GT3R7` với slug và tracking | Nhận đúng ASIN, URL chuẩn không có tracking; thao tác tra chỉ khi người dùng bấm/Enter trên trang mua hộ |
| ASIN `B0FR4GT3R7` và URL chuẩn `/dp/B0FR4GT3R7` | Cùng một định danh, không tự sinh nhiều mặt hàng |
| Homepage dán URL | Mở trang mua hộ và tự bắt đầu tra một lần như đặc tả trước |
| URL domain giả, HTTP, thiếu ASIN hoặc short link chưa hỗ trợ | Từ chối rõ ràng, không truy cập nguồn sai |
| Có sản phẩm cùng ASIN trong catalog Mita, Amazon không truy cập được | Chỉ hiện ASIN/link/lỗi; **không** hiện tên catalog fallback |
| ASIN ngoài catalog, nguồn cho phép và offer hợp lệ | Hiện **dữ liệu thực** cùng nguồn/thời điểm, quote VND, điều kiện giao và thêm giỏ; không gắn thông tin từ ASIN khác |
| Quote hợp lệ nhưng không có metadata được quyền hiển thị | Placeholder/ẩn thông tin thiếu; vẫn có giá và thêm giỏ |
| Chỉ lấy được tên hoặc ảnh, thiếu giá/seller/giao Nhật miễn phí | Hiện preview nếu có quyền, **không** có quote và giỏ |
| Không lấy được ETA, các điều kiện khác hợp lệ | Hiện cảnh báo thiếu ngày, không bịa ETA VN; cho giỏ/gửi đơn theo xác nhận đã chốt |
| Đổi số lượng hoặc quote hết hạn | Báo giá lại, xác nhận điều khoản mới; không dùng quote cũ cho checkout |
| CAPTCHA/403/429/cooldown | Chặn truy cập; hiển thị mốc xét lại nếu có, không cam kết tự khôi phục |

Nghiệm thu gồm kiểm thử offline với fixture và kiểm thử nguồn thật **chỉ khi được phép**. Bộ test giả lập không chứng minh Amazon live hoạt động; không coi “ASIN parse đúng” là “đã lấy thành công sản phẩm”.

## 7. Những điểm chưa được chứng minh / chưa được chọn

- **Chưa chứng minh kỹ thuật:** Đọc ổn định sản phẩm mới, seller/offer/giá/free-shipping/ETA thực tế qua Scrapling; quyền công bố ảnh, mô tả, ratings/reviews; độ bao phủ danh mục. Chưa thể cam kết mọi ASIN có đầy đủ metadata hoặc quote.
- **Khoảng trống runtime lịch sử (ghi nhận 04/11/2026):** Quote local `4010` dùng PostgreSQL smoke riêng, từng có gate `amazon_blocked` với thời điểm xét lại **05/11/2026 04:00 JST**; worker catalog đang dùng DB khác, chưa có re-entry quote an toàn được xác nhận. **Không coi timestamp là hết chặn tự động**. Cần kiểm tra lại hiện trạng trước mọi kế hoạch sửa.
- **Khoảng cách code và quyết định:** Code hiện vẫn có `lookupLocalAmazonPreview` và render cached title; Q6 = B yêu cầu bỏ hành vi đó **trong luồng mua hộ** sau một thay đổi code được phép và được test. Code hiện cũng chưa có đủ dữ liệu/nguồn xác minh để bảo đảm Q1/Q2 trên sản phẩm mới; Q10 chưa hoàn thiện trình bày mốc xét lại. ADR này **không khẳng định đã triển khai**.
- **Ngoài phạm vi, chưa chọn:** Hỗ trợ short link/đoạn share tự tách link; tích hợp nguồn thương mại khác; form/queue yêu cầu hỗ trợ; triển khai VPS; tiêu chuẩn % tỷ lệ thành công/pilot người dùng. Không suy diễn việc các mục này bị cấm vĩnh viễn.

## 8. Phê duyệt thực hiện

**Chỉ phê duyệt định hướng yêu cầu và tài liệu.** Chưa được phép thực thi thay đổi code, source gate, DB active, worker, dịch vụ, dữ liệu khách hàng, `git push` hay VPS deployment từ ADR này. Khi có lệnh triển khai riêng: ưu tiên local, tách thiết kế/fixture tests và chứng cứ nguồn/quyền khỏi vận hành, tuân thủ `AGENTS.md`.
