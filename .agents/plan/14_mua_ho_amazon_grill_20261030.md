# Grill with Docs — Trang mua hộ Amazon Japan (30/10/2026)

**Trạng thái (03/11/2026):** Đã hoàn tất **4/4 vòng Grill Me**. Sáu quyết định vòng cuối đã được chốt; không tổ chức vòng Grill tiếp. Đây là **đặc tả nghiệp vụ cuối cùng để nghiên cứu/chuẩn bị triển khai**, không phải xác nhận tính khả thi kỹ thuật hay lệnh triển khai. **Chưa sửa code, chưa commit, chưa deploy.**

**Thứ tự hiệu lực:** yêu cầu trực tiếp mới nhất > quyết định Grill vòng 4 > vòng 3 > vòng 2 > vòng 1 > đề xuất kỹ thuật cũ. Nếu mô tả lịch sử bên dưới khác bản chốt thì dùng mục **Đặc tả cuối cùng** bên dưới.

## Yêu cầu đã nói rõ

- Header Mita Japan có tab **Mua hộ Amazon**. Khách mở trang mua hộ riêng với một ô lớn, nổi bật để dán link sản phẩm `amazon.co.jp`.
- Trang trả báo giá và thời điểm dự kiến về Việt Nam.
- **Yêu cầu mới thay thế mốc Osaka chính xác:** VPS phải lấy **giá và ngày giao thường mà Amazon.co.jp trả về khi không đăng nhập**, không cần đặt/xác nhận mã bưu điện Osaka. Không được gắn nhãn "giao tới Osaka" cho một ngày giao có đích chưa xác định. Cộng số ngày cấu hình trong Admin (mặc định theo đề xuất ban đầu: 7 ngày lịch) để tạo **ngày giao dự kiến tận nhà khách tại Việt Nam**. Đây là ước tính Mita, không phải cam kết của Amazon.
- Amazon của chủ cửa hàng đã đăng nhập trong BrowserOS Neo trên Windows PC; website khách chạy ở VPS Hermes.
- Windows/BrowserOS Neo chỉ dùng đối chiếu thử nghiệm, **không được dùng như phụ thuộc vận hành cho báo giá**. Khảo sát và Grill Me trước; **không sửa code** trong giai đoạn này.
- Trên **homepage**, ô nhập lớn, luôn hiện **ngay dưới header**. Khi nhập chữ thì tìm catalog Mita, khi dán link Amazon thì tra giá/ETA trên VPS. Có tab header **Mua hộ Amazon** tới trang riêng. Giữ phong cách Garden/Hallmark hiện có, không redesign toàn website.

## Bằng chứng đã kiểm tra

- Header hiện có `NAV` chung cho desktop/mobile tại `src/components/layout/header.tsx`. `SearchForm` tại `src/components/layout/search-form.tsx` hiện chỉ tìm **catalog Mita**, chưa xử lý link Amazon như một yêu cầu báo giá.
- `backend/src/admin/imports.ts` là nhập ASIN cho **Admin**, không phải quy trình quote công khai. Hiện chưa có bảng yêu cầu báo giá/ETA cá nhân hóa cho khách.
- Mita có `backend/src/pricing.ts` để tính VND từ JPY, tỷ giá và phụ phí; checkout/đơn hàng hiện phụ thuộc catalog và có chính sách phí vận chuyển riêng.
- Amazon Japan công khai xác nhận ngày giao hiển thị trên trang sản phẩm tùy địa chỉ giao: https://www.aboutamazon.jp/news/guide/how-to-shop-in-amazon
- Qua BrowserOS Neo, đã điều hướng một ASIN thử nghiệm `B08FTSH6KP`; trang hiển thị nhiều mốc giao khác nhau tùy ưu đãi/phương thức giao. Chưa xác minh bằng chứng liên kết rõ một ETA cụ thể với **đúng địa chỉ Osaka, offer, số lượng và phương thức vận chuyển**. Không ghi địa chỉ/cookie/dữ liệu tài khoản.
- Codex CLI đã review repository ở chế độ read-only: hiện không có máy lấy Amazon ETA cá nhân hóa; VPS không tự sở hữu phiên BrowserOS đăng nhập ở Windows.
- Kiểm tra thực tế trên VPS Hermes: truy cập công khai ASIN `B08FTSH6KP` HTTP 200, thấy giá ¥1.745 và các mốc giao hàng; BrowserOS Neo cũng thấy giá ¥1.745 nhưng có điều kiện Prime khác. Không thể xác minh Osaka: POST đổi ZIP mẫu `530-0001` phản hồi HTTP 200 với body **rỗng**. Sau đó người dùng **chủ động bỏ yêu cầu Osaka chính xác**, muốn dùng ETA thông thường mà Amazon trả về.
- BrowserOS Neo cũng xác nhận homepage live **không có ô tìm kiếm hiển thị trực tiếp**: input 43px/14px thuộc form search ẩn trong header; `src/app/(store)/page.tsx` chưa có search input.

## Yêu cầu đã chốt — Grill Me vòng 1

1. **1A:** Home có ô nhập lớn ngay dưới header, luôn hiển thị.
2. **2A:** Một ô nhập tự nhận biết link Amazon JP so với từ khóa catalog Mita; không đưa Amazon URL sang `/san-pham?q=...`.
3. **3A:** Nhận mua hộ mọi ngành hàng Amazon JP **đủ điều kiện**, bao gồm người bán khác, không chỉ catalog hiện tại.
4. **4A:** Hiện **giá bán VND gồm giá hàng và phụ phí Mita**; phí vận chuyển **hiển thị riêng**. Vòng 3 còn quy định chỉ nhận trường hợp Amazon giao nội địa Nhật miễn phí.
5. **5B:** Ngày cộng thêm là **ước tính hàng tới tận nhà khách Việt Nam**, không chỉ điểm nhận trong VN. Số ngày vận chuyển phải **chỉnh được trong Admin** và được áp dụng đồng nhất tại các trang mua hộ, sản phẩm, giỏ, thanh toán, xác nhận đơn và mọi chỗ liên quan. Bản ghi đơn đã đặt giữ giá trị được báo tại thời điểm đặt, không sửa hồi tố.
6. **6A, được mở rộng bởi vòng 3 mục 4B:** Nếu VPS có giá nhưng chưa có ETA, vẫn **hiện giá**, ghi rõ chưa xác nhận ngày giao và cho phép thử lại; **vẫn cho thêm giỏ**. Cần chốt riêng có cho thanh toán/đặt hàng khi thiếu ETA hay không.
7. **7A:** Báo giá đủ điều kiện thì **thêm vào giỏ hàng Mita**; vòng 3 cho phép thêm giỏ ngay cả khi có giá nhưng chưa có ETA. Hiện checkout chỉ nhận sản phẩm catalog nên cần thiết kế luồng quote riêng, không tự động đưa mọi URL vào catalog.

## Yêu cầu đã chốt — Grill Me vòng 2

1. **1A:** Dùng **ngày lịch**, gồm cuối tuần và ngày lễ.
2. **2A, có sửa trực tiếp bởi người dùng:** **không cần chính xác Osaka**; "cứ báo ngày giao theo Amazon trả về". Không dùng phương án mặc định trong câu hỏi (cấu hình postal code Osaka); không diễn giải `2A` thành yêu cầu ZIP Osaka.
3. **3A:** Giá mua **một lần**, giao **thường**, **không** dùng ưu đãi Prime, Subscribe & Save, coupon có điều kiện.
4. **4A:** Báo giá dự kiến **hết hiệu lực sau 15 phút** và cần tra lại; chưa chốt quy tắc khi giá/ETA thay đổi trong giỏ/checkout.
5. **5A:** Một số ngày vận chuyển do Admin cấu hình **áp dụng chung toàn Việt Nam** (không phân biệt tỉnh/thành).
6. **6A:** Hết hàng hoặc không đọc được dữ liệu: báo không thể đặt, cho thử lại; không dùng dữ liệu cũ để cho đặt hàng.

## Yêu cầu đã chốt — Grill Me vòng 3

1. **1C:** Chỉ nhận báo giá mua hộ khi **Amazon giao nội địa Nhật miễn phí**. Chưa chốt cách xử lý miễn phí có điều kiện (ngưỡng giá trị đơn, khách hàng mới, Prime...).
2. **2A:** Lấy **ngày giao thường** gắn với lựa chọn **mua một lần đang được báo giá**, không dùng ngày giao Prime/nhanh; giữ đúng các điều kiện của offer.
3. **3B:** **Giữ giá khách đã xem nếu báo giá còn hiệu lực trong 15 phút**, thay vì bắt buộc tra lại ngay khi chuẩn bị đặt. Chưa chốt ai chịu phần chênh nếu Amazon đổi giá trước khi Mita thực sự mua.
4. **4B:** **Có giá nhưng không lấy được ETA vẫn cho thêm vào giỏ**, kèm cảnh báo rõ ràng về thiếu ngày giao. Đây là quyết định mới **nới lỏng** mô tả vòng 1 mục 6A; chưa chốt có được hoàn tất đặt hàng khi ETA thiếu không.
5. **5C:** Hỗ trợ **cả URL sản phẩm Amazon.co.jp và mã ASIN 10 ký tự**. Không tự động suy ra phải hỗ trợ các short link `amzn.asia`; còn cần chốt nếu muốn.

## Quyết định đã chốt — Grill Me vòng 4 (vòng cuối, 03/11/2026)

1. **1A — Miễn phí giao nội địa Nhật:** Chỉ nhận offer **hiển thị miễn phí giao thường đối với đơn/số lượng đang xem, không Prime**. Không giả định gộp nhiều đơn, ưu đãi Prime, khách mới hoặc khuyến mại chưa thỏa điều kiện. Khả năng miễn phí tại địa chỉ nhận hàng thật của Mita vẫn **chưa được VPS xác minh**.
2. **2A — Thiếu ETA:** Nếu có giá hợp lệ và đáp ứng các điều kiện nhận hàng, khách **được thêm giỏ và gửi đơn**, kèm cảnh báo **chưa xác định ngày giao**. Không tự tạo ngày về Việt Nam khi thiếu mốc Amazon. Quyết định này thay thế câu hỏi còn mở ở vòng 1/3.
3. **3A — Giá được giữ 15 phút:** Khi khách **gửi đơn thành công trong thời hạn báo giá 15 phút**, Mita **chịu phần chênh lệch nếu giá mua Amazon tăng sau đó**, giữ nguyên giá hàng đã đặt của khách. Đây là cam kết kinh doanh về **giá hàng đã được chốt**, không mặc nhiên bao gồm phí vận chuyển quốc tế chưa biết. Nếu báo giá hết hạn **trước khi gửi đơn**, áp dụng mục 4B bên dưới.
4. **4B — Báo giá hết hạn trong giỏ:** Giữ sản phẩm trong giỏ, **tự động tra lại**; nếu giá, điều kiện mua, người bán/biến thể hoặc ngày giao thay đổi, **yêu cầu khách nhìn thấy và xác nhận thay đổi** trước khi gửi đơn. Tra lại thất bại không được tự gia hạn dữ liệu cũ để nhận đơn.
5. **5A — Vận chuyển tới Việt Nam:** Hiển thị **phí vận chuyển tính riêng sau**; khách được gửi đơn khi phí chưa xác định. Khi có phí, **khách phải xác nhận khoản phí đó trước khi áp dụng/thu**. Không ghi `0đ` cho phí chưa biết và không hiểu miễn phí giao tại Nhật là miễn phí về Việt Nam.
6. **6A — ASIN/phiên bản/người bán:** Nếu khách nhập ASIN hoặc URL, hệ thống **lấy offer công khai Amazon đang hiển thị**, trình bày **tên/phiên bản, người bán và số lượng** cho khách kiểm tra và xác nhận. Không tự thay người bán hay biến thể khi thực hiện đặt hàng; nếu không xác định được sản phẩm/offer phù hợp thì không lập báo giá như thể đã xác minh.

## Đặc tả cuối cùng — hành vi sản phẩm cần triển khai sau khi được phép

### 1. Điểm vào và giao diện Garden

- Header desktop/mobile có mục **Mua hộ Amazon** dẫn tới trang riêng; homepage có **ô tìm kiếm/dán link lớn, luôn hiển thị ngay dưới header**, dùng chung thao tác nhập cho Mita và Amazon.
- Nhập từ khóa thường → tìm catalog Mita. Nhập **URL HTTPS sản phẩm `amazon.co.jp` hợp lệ hoặc mã ASIN 10 ký tự** → tra mua hộ Amazon từ VPS. Không đẩy URL Amazon vào tìm kiếm catalog. Link rút gọn chưa được cam kết hỗ trợ.
- Trang mua hộ ưu tiên ô nhập rõ ràng, kết quả trên mobile dễ đọc; **giữ hệ màu, typography, token Garden/Hallmark** hiện tại, không redesign các khu vực khác. Trạng thái đang tra, thiếu dữ liệu, hết hiệu lực và không đủ điều kiện phải có thông báo riêng.

### 2. Tra giá, điều kiện nhận mua và xác nhận sản phẩm

- VPS tự tra Amazon Japan **không đăng nhập, không dựa vào PC/BrowserOS Neo**, ưu tiên đúng sản phẩm/biến thể/offer, mua **một lần**, giá thường; không dùng giá Prime, Subscribe & Save hoặc coupon có điều kiện. Hỗ trợ mọi ngành hàng **đủ điều kiện**, gồm bên bán thứ ba; không nhận mua sản phẩm không được phép hoặc không thể mua.
- Chỉ nhận khi offer mua đang xét **hiển thị miễn phí vận chuyển tiêu chuẩn nội địa Nhật đối với đơn/số lượng đó, không đòi quyền Prime**. Mốc miễn phí thực tế tới địa điểm Mita là rủi ro cần xác minh, vì user **không yêu cầu chọn mã bưu điện Osaka** trên VPS.
- Khách có thể chọn số lượng; phải xác nhận đúng **sản phẩm, phiên bản, người bán, số lượng và giá** trước khi gửi đơn. Thay số lượng/biến thể/offer phải kiểm tra lại mức giá và khả năng miễn phí giao hàng. Thiếu giá, hết hàng, không đọc được nguồn hoặc không xác nhận đủ điều kiện miễn phí → không nhận đơn dựa trên dữ liệu đó, cho phép thử lại.
- Hiển thị giá Amazon nguồn **JPY** (nếu có), **giá bán VND gồm giá hàng và phụ phí Mita** theo chính sách giá hiện hành; **phí vận chuyển quốc tế/nội địa VN tách riêng và có thể ở trạng thái “chưa xác định”**. Không tự đánh đồng không biết phí với phí bằng 0.

### 3. Ngày giao hàng và cấu hình Admin

- Chỉ lấy **ngày giao thường Amazon công khai trả về cho offer đang báo giá**, không dùng Prime/nhanh. **Không yêu cầu đúng Osaka**: gọi là **“Ngày giao Amazon hiển thị”**, không gọi “Amazon tới Osaka” khi không xác minh địa điểm.
- **Ngày dự kiến tới tận nhà khách tại Việt Nam** = mốc ngày giao Amazon công khai **+ số ngày lịch do Admin thiết lập**, mặc định đề xuất ban đầu **7 ngày**. Áp dụng **cùng một số ngày cho mọi tỉnh/thành**; không dùng ngày làm việc. Nếu Amazon trả về khoảng ngày thì tính ra khoảng ngày tương ứng, không bịa ngày chính xác.
- Trong **Admin → Cấu hình**, phải có trường chỉnh số ngày này; dùng cùng giá trị xuyên suốt trang chủ/trang mua hộ, trang sản phẩm khi có ETA, giỏ hàng, thanh toán, xác nhận và chi tiết đơn. **Đơn đã được gửi giữ snapshot số ngày và ETA đã hiển thị lúc gửi**, không đổi hồi tố khi Admin sửa cấu hình.
- **Thiếu ETA Amazon** nhưng đủ điều kiện báo giá về hàng/giá/miễn phí giao Nhật: vẫn hiển thị giá, cảnh báo ngày chưa xác định, cho thêm giỏ **và gửi đơn**. Không cộng 7 ngày vào một mốc không tồn tại; đơn lưu ETA là **chưa biết**, không phải ngày tự suy đoán.

### 4. Báo giá 15 phút, giỏ hàng và gửi đơn

- Mỗi báo giá phải lưu **nguồn, thời điểm lấy, hết hạn sau 15 phút, ASIN/biến thể/người bán/số lượng, giá, điều kiện giao miễn phí, ETA gốc (nếu có), số ngày Admin và ETA VN được tính**. Đây là nguồn cho giỏ và đơn, không lấy giá catalog cũ thay thế báo giá mua hộ.
- Khách giữ được sản phẩm trong giỏ dù báo giá hết hạn; khi chuẩn bị gửi đơn, VPS **tự tra lại** và yêu cầu khách **xác nhận mọi thay đổi liên quan tới giá, offer/biến thể/người bán, điều kiện giao hay ETA**. Nếu không tra lại được, không được xác nhận đơn dựa vào dữ liệu hết hạn.
- **Giữ giá hàng đã báo cho đơn gửi thành công trước khi báo giá hết hạn**, ngay cả nếu Amazon tăng giá trước lúc Mita mua thực tế: **Mita chịu chênh lệch**, không tự tăng số tiền hàng của đơn. Cần triển khai cơ chế chốt giá phía server tránh khách vượt hạn hoặc gửi trùng; thời điểm chốt là **thời điểm server nhận và xác nhận gửi đơn hợp lệ**, không phải khi người dùng bấm mà backend chưa nhận.
- Phí vận chuyển từ Nhật đến nhà khách ở Việt Nam **tính và thông báo riêng sau khi gửi đơn**, được khách đồng ý trước khi áp dụng/thu. Không biến việc hiển thị ngày tới nhà khách thành lời đảm bảo thời gian giao hàng.
- Luồng checkout hiện tại dựa trên catalog, nên mua hộ Amazon **cần dữ liệu/đơn báo giá riêng có thể đưa vào giỏ Mita**; không tự thêm mọi ASIN khách gửi vào catalog sản phẩm công khai. Quy trình đơn không đồng nghĩa Amazon đã mua hàng ngay khi khách gửi.

### 5. Tiêu chí nghiệm thu nghiệp vụ

| Trường hợp | Kết quả cần có |
| --- | --- |
| Nhập từ khóa / URL / ASIN | Vào đúng tìm kiếm Mita / tra Amazon; URL sai báo lỗi, không tìm như từ khóa |
| Có giá, giao Nhật miễn phí thường, có ETA | Hiện giá VND và các phí riêng; hiển thị ngày Amazon và ngày tới nhà VN ước tính; cho thêm giỏ |
| Có giá và xác nhận miễn phí giao Nhật, **không có ETA** | Hiện giá, cảnh báo không có ngày; vẫn được thêm giỏ và gửi đơn có xác nhận cảnh báo |
| Có phí giao Nhật, chỉ miễn phí Prime, hoặc không xác minh được miễn phí | Không cho đặt hàng dưới điều kiện **chỉ nhận giao Nhật miễn phí thường** |
| Amazon hết hàng / thiếu giá / trang lỗi, CAPTCHA, 403/429 | Báo không thể tra hoặc đặt, cho thử lại theo giới hạn an toàn; không dùng giá cũ hoặc vượt chặn |
| Báo giá hết 15 phút trong giỏ | Giữ item, tra lại trước khi gửi; bắt xác nhận thay đổi, không tự nhận giá cũ |
| Đơn hợp lệ gửi trong hạn 15 phút, Amazon tăng giá sau đó | Giá hàng đơn giữ nguyên, Mita chịu chênh lệch |
| Khách sửa số lượng, offer, biến thể | Tra lại giá, điều kiện miễn phí và ETA cho lựa chọn mới; không tự đổi người bán |
| Admin sửa số ngày vận chuyển | Báo giá mới dùng giá trị mới, trang liên quan nhất quán; đơn cũ không đổi snapshot |
| Có phí giao tới VN sau khi nhận đơn | Thông báo riêng và yêu cầu khách xác nhận trước khi áp dụng/thu |

## Những vấn đề kỹ thuật chưa kiểm chứng — không mở thêm Grill

1. **Độ ổn định Amazon trên VPS:** mới có kết quả thực tế cho một ASIN; chưa chứng minh đọc được giá, offer, seller, shipping free và ETA thường từ mọi ngành hàng, đặc biệt sản phẩm nhiều phiên bản, người bán thứ ba, ngày tương đối/khung giao và khi Amazon thay đổi HTML.
2. **Miễn phí giao Nhật vs đích giao:** người dùng bỏ yêu cầu chính xác Osaka, nên thông báo “miễn phí” của Amazon ở đích mặc định **không chứng minh** đơn thực mua giao tới địa chỉ Mita cũng miễn phí. Cần thử nhiều offer và đưa cảnh báo/kiểm soát rủi ro rõ ràng; không thể cam kết miễn phí thực tế chỉ từ một HTML công khai.
3. **Tính khả thi và quyền sử dụng dữ liệu:** cần xác minh Amazon cho phép hình thức truy cập/hiển thị lại giá và ngày giao thương mại phù hợp; rate limiting, cooldown và xử lý trang lỗi/403/429/CAPTCHA phải tuân thủ guard, tuyệt đối không vượt chặn.
4. **Cam kết giá 15 phút:** cần kiểm chứng mô hình rủi ro tài chính, bao gồm tăng giá rất mạnh, biến thể/offer hết hàng, trùng đơn, độ lệch tỷ giá và việc Mita chưa mua ngay. **Quyết định Mita chịu chênh lệch đã chốt**, không được âm thầm đổi sang yêu cầu khách thanh toán thêm tiền hàng.
5. **Tích hợp DB/API/checkout:** hiện chưa có cấu trúc quote công khai lưu seller, variant, JPY, điều kiện miễn phí, timestamp/expiry, buffer và ETA. Giỏ và checkout hiện dựa vào catalog; cần cơ chế chốt snapshot bất biến khi gửi đơn, kiểm tra hết hạn và xác nhận phí giao sau, với kiểm tra schema/migration và test ở môi trường an toàn trước khi triển khai.
6. **Ngày tới nhà Việt Nam:** cộng N ngày với ETA Amazon ở đích có thể khác Osaka chỉ là **ước tính chính sách của Mita**, chưa đo độ đúng theo lịch vận chuyển thật, ngày nghỉ, vùng xa hoặc giao chặng cuối. Thiếu ETA phải để trống mốc dự kiến, không tạo ngày giả.
7. **Điều kiện triển khai:** phát triển cần thiết kế trạng thái thất bại, giới hạn yêu cầu công khai/chống spam, kiểm thử mobile, và quy tắc vận hành xử lý hủy/hết hàng/không thể thực mua sau khi nhận đơn. Các vấn đề này là **hạng mục nghiên cứu/kiểm thử trước release**, không phải câu hỏi Grill mới.

**Kết thúc Grill:** Không còn vòng phỏng vấn. Chờ một yêu cầu riêng cho giai đoạn thiết kế triển khai hoặc kiểm thử kỹ thuật; không được hiểu tài liệu này là lệnh sửa code, commit hay deploy.

## Hướng thiết kế và kỹ thuật đang nghiên cứu — chưa được phê duyệt triển khai

1. VPS nhận URL Amazon JP, chuẩn hóa ASIN/biến thể, tìm giá mua một lần và ETA giao thường của **phiên công khai không đăng nhập**; lưu nguồn và thời điểm quan sát, tính trạng thái hiệu lực 15 phút. Với đích giao Amazon không xác minh, **không gọi đây là ETA Osaka**. Chưa có bằng chứng độ ổn định trên mọi ASIN.
2. Tính giá VND theo chính sách định giá đang có; **hiển thị phí vận chuyển riêng**. Ngày dự kiến tận nhà VN = ngày Amazon công khai trả về + số **ngày lịch** Admin thiết lập; nếu Amazon đưa khoảng ngày thì giữ khoảng ngày. Giá và ngày đều chỉ là ước tính.
3. Thiết kế Garden/Hallmark: ô nhập nổi bật dưới header, auto-detect URL/từ khóa, trang mua hộ có kết quả đọc rõ trên mobile; vẫn giữ search catalog, tránh thay đổi cấu trúc site ngoài phạm vi đã chọn.
4. Không phụ thuộc PC đăng nhập Amazon; không yêu cầu/bóc cookie hoặc tài khoản; không vượt CAPTCHA/403. Không tự nhập tất cả sản phẩm link khách gửi vào catalog, không giao báo giá tồn kho cũ như dữ liệu mới.

## Danh sách các vấn đề đã được vòng cuối giải quyết (lưu lịch sử)

- Miễn phí giao hàng Nhật: chỉ offer thực tế hiển thị miễn phí giao thường cho đơn đang xem, không Prime (vòng 4: 1A).
- Thiếu ETA: được gửi đơn với cảnh báo, không chỉ thêm giỏ (2A).
- Chênh lệch tăng giá Amazon sau khi khách đặt trong hạn: Mita chịu (3A).
- Báo giá hết hạn trong giỏ: tự tra lại, buộc khách xác nhận thay đổi (4B).
- Phí giao quốc tế/nội địa VN: tính riêng sau, phải được khách xác nhận (5A).
- ASIN có nhiều biến thể/offer: lấy offer Amazon công khai đang hiển thị, khách xác nhận tên/phiên bản, người bán, số lượng (6A).
- Quản trị ngày cộng thêm: mặc định 7 ngày, một giá trị dùng cho toàn Việt Nam; nên đặt tại Admin `Cấu hình`, thống nhất mọi nơi hiển thị và giữ snapshot đơn hàng.

## Chưa thể kết luận

- VPS có thể lấy ổn định giá mua thường và ETA giao thường công khai của **đúng offer/biến thể** cho nhiều ASIN hay không vẫn cần thử nghiệm; người dùng không yêu cầu xác minh chính xác đích Osaka nữa.
- Chi phí giao nội địa, thuế, giao quốc tế và ngày nghỉ có thể làm thực tế khác công thức `+7 ngày`.
- Quote 15 phút và **Mita chịu chênh lệch tăng giá Amazon sau khi khách gửi đơn hợp lệ trong hạn** đã được chốt; cơ chế triển khai an toàn còn phải nghiên cứu/kiểm thử.

**Tiếp theo:** không hỏi Grill tiếp; chỉ khi người dùng cho phép mới chuyển sang thiết kế kỹ thuật, code, kiểm thử và phê duyệt deploy riêng. Không xem bản chốt này là phê duyệt sửa code.
