# Mita Japan — Thuật ngữ nghiệp vụ

Các thuật ngữ đã được thống nhất trong quá trình thiết kế cửa hàng mua hàng Nhật cho khách tại Việt Nam.

## Ngôn ngữ chung

**Catalog sản phẩm**:
Tập sản phẩm từ Amazon Japan mà khách có thể tìm và xem trên Mita Japan, thuộc những danh mục đã chọn.
_Tránh_: Danh sách đơn hàng

**Nhập sản phẩm tự động**:
Sản phẩm tìm được trong những danh mục đã chọn được đưa tự động vào catalog, không cần nhân viên duyệt từng mặt hàng.
_Tránh_: Duyệt sản phẩm thủ công

**Sản phẩm đủ điều kiện bán**:
Sản phẩm trong catalog đã vượt qua các điều kiện lọc tự động để được phép đặt mua. Sản phẩm thiếu thông tin, không đủ quyền hiển thị hoặc thuộc nhóm hàng hạn chế chưa được phép bán.

**Khách hàng**:
Người mua hàng qua Mita Japan, với thị trường phục vụ đầu tiên là Việt Nam.
_Tránh_: Nhà bán hàng Amazon

**Đơn hàng**:
Yêu cầu mua sản phẩm do khách tạo trên Mita Japan, thanh toán trong quy trình đặt hàng và được nhân viên thực hiện mua hàng ở nguồn.
_Tránh_: Yêu cầu báo giá thủ công

**Thanh toán ngay**:
Khách thanh toán phần tiền hàng bằng VND qua cổng thanh toán tích hợp khi đặt hàng, trước bước Mita Japan mua hàng ở nguồn; phí vận chuyển được thu ở giai đoạn sau.
_Tránh_: Thanh toán sau khi được báo giá thủ công

**Giá chốt lúc thanh toán**:
Số tiền hàng bằng VND mà Mita Japan cam kết thu tại thời điểm khách thanh toán thành công. Phí vận chuyển được tính và thu riêng về sau; nếu không thể mua hàng như cam kết, cần hoàn tiền phần hàng không mua được theo chính sách.
_Tránh_: Giá tham khảo từ Amazon

**Mua hộ thủ công**:
Nhân viên Mita Japan thực hiện mua hàng trên Amazon Japan sau khi khách đã thanh toán thành công.

**Biến thể sản phẩm**:
Một lựa chọn cụ thể của sản phẩm, chẳng hạn dung tích, số viên, màu hoặc kích thước, có ASIN và giá, tình trạng hàng riêng. Nhiều biến thể được nhóm trên cùng một trang sản phẩm.
_Tránh_: Thuộc tính chỉ để hiển thị không gắn với ASIN

**Giỏ hàng**:
Tập nhiều sản phẩm và biến thể khách chọn để thanh toán chung thành một đơn hàng Mita Japan.

**Giá hết hạn**:
Giá sản phẩm không được cập nhật thành công trong hơn 24 giờ. Khách vẫn có thể xem sản phẩm nhưng không thể thanh toán biến thể có giá hết hạn cho tới khi dữ liệu được cập nhật.
_Tránh_: Giá đã được xác nhận còn hiệu lực

**Vận chuyển qua kho Nhật**:
Hàng từ Amazon Japan được nhận tại điểm nhận hàng của Mita Japan ở Nhật, sau đó vận chuyển về Việt Nam và giao tới địa chỉ khách.

**Mua hàng không cần tài khoản**:
Khách được phép đặt và thanh toán bằng thông tin liên hệ và địa chỉ nhận hàng mà không bắt buộc đăng ký tài khoản Mita Japan.
_Tránh_: Bắt buộc đăng nhập khi mua

**Tiền hàng**:
Khoản tiền VND khách thanh toán ngay khi đặt, được hệ thống tính tự động từ giá sản phẩm JPY và quy tắc giá bán của Mita Japan. Các thành phần phí nằm trong tiền hàng cần được chốt thêm.
_Tránh_: Tổng tiền đã bao gồm phí vận chuyển

**Phí vận chuyển thu sau**:
Khoản phí Mita Japan yêu cầu khách thanh toán ở giai đoạn sau khi đặt hàng, tách khỏi tiền hàng thanh toán ban đầu.
_Tránh_: Giá hàng đã thanh toán

**Phí vận chuyển ước tính**:
Mức phí dự tính theo danh mục sản phẩm khi chưa có đủ dữ liệu trọng lượng hoặc kích thước; không phải số tiền vận chuyển cuối cùng.
_Tránh_: Phí vận chuyển đã chốt

**Hoàn tiền một phần**:
Hoàn tiền cho mặt hàng không thể mua được trong đơn có nhiều sản phẩm, trong khi phần hàng đã mua được tiếp tục xử lý.
_Tránh_: Hủy và hoàn toàn bộ đơn

**Gom kiện tại Nhật**:
Ưu tiên tập hợp các sản phẩm trong một đơn để vận chuyển về Việt Nam chung một kiện; nhân viên có thể tách kiện khi hàng chậm hoặc thiếu.

## Thuật ngữ Admin MVP

Các thuật ngữ dưới đây thuộc Admin MVP được chốt qua Q1–Q11 tại `.agents/plan/04_mita_minimal_admin_grill_with_docs_plan.md`, đã triển khai local trong app hiện có; xem `docs/admin-local.md`. Chúng không thay thế các quyết định nghiệp vụ gốc ở trên.

**Admin / chủ cửa hàng**:
Người được phép đăng nhập giao diện nội bộ để xem tình hình, quản lý việc hiển thị sản phẩm và thay đổi chính sách giá; không phải tài khoản mua hàng của khách.
_Tránh_: Bất kỳ ai truy cập được URL `/admin` đều có quyền chỉnh sửa

**Tài khoản owner duy nhất (Q3 đã chốt)**:
Admin MVP có đúng một tài khoản đăng nhập của chủ cửa hàng, được thiết lập với mật khẩu hash và phiên xác thực an toàn; không có đăng ký Admin công khai, màn quản lý nhân viên hoặc phân quyền nhiều cấp.
_Tránh_: Mật khẩu mặc định hardcode, tài khoản Admin dùng chung với khách mua hàng

**Đơn mô phỏng**:
Đơn có trạng thái `simulation_created`, dùng để thử luồng đặt hàng; không có bằng chứng giao dịch thanh toán hoặc mua hàng thật.
_Tránh_: Đơn đã thanh toán, doanh thu đã thu

**Đơn mô phỏng chỉ xem trong Admin (Q2 đã chốt)**:
Admin MVP chỉ đọc danh sách và chi tiết đơn mô phỏng. Không bổ sung trạng thái xử lý nội bộ, ghi chú hay thao tác thay đổi đơn; không được suy diễn đã thanh toán hoặc giao hàng thật.
_Tránh_: Bấm xác nhận đã thu tiền trên đơn mô phỏng

**Giá trị đơn mô phỏng**:
Tổng tiền hàng VND được ghi trong đơn thử nghiệm; chỉ dùng để kiểm tra luồng và số liệu demo.
_Tránh_: Doanh thu, lãi hoặc dòng tiền thực tế

**Ẩn sản phẩm**:
**Q6 đã chốt:** thao tác “Xóa” trong Admin chỉ đặt cờ ẩn, không xóa bản ghi, lịch sử giá hay tham chiếu đơn. ASIN ẩn không xuất hiện trong catalog/chi tiết công khai và bị chặn checkout; scraper hoặc thao tác thêm lại ASIN vẫn có thể cập nhật dữ liệu nguồn nhưng **không tự bật lại**. Chỉ chủ cửa hàng có thể chọn `Hiện lại`; sau đó sản phẩm vẫn phải đáp ứng điều kiện bán và giá mới trong 24 giờ.
_Tránh_: Xóa vĩnh viễn bản ghi, xóa lịch sử đơn

**Sản phẩm đủ điều kiện hiển thị**:
Sản phẩm có thể xuất hiện trong catalog khách xem khi không bị ẩn bởi Admin và đáp ứng quyền công bố nội dung; độc lập với giá còn hiệu lực hoặc khả năng checkout.
_Tránh_: Được hiển thị nghĩa là còn hàng và đặt mua được

**Yêu cầu thêm ASIN**:
Đề nghị nhập một sản phẩm từ URL/ASIN Amazon vào quy trình thu thập; chỉ thành công khi worker đã kiểm tra và lưu dữ liệu nguồn. **Q1 đã chốt phương án này cho Admin MVP**; hàng đợi có thể chờ khi worker chưa bật.
_Tránh_: Dán link đồng nghĩa sản phẩm được nhập và bán ngay

**Tỷ giá tính giá bán (VND/JPY)**:
Hệ số nội bộ quy đổi JPY sang VND để tạo giá tham khảo tại Mita; **Q4 đã chốt: chủ cửa hàng nhập thủ công rồi nhấn Lưu trong Admin**, không đồng bộ tỷ giá tự động. Thay đổi chỉ tác động báo giá và đơn mới, không sửa snapshot của đơn đã tạo. Không mặc nhiên là tỷ giá ngân hàng/live hoặc tỷ giá thanh toán Amazon.
_Tránh_: Tỷ giá thời gian thực

**Phụ phí dịch vụ (%)**:
Tỷ lệ cộng thêm vào tiền hàng đã quy đổi. **Q5 đã chốt: chủ cửa hàng có thể chỉnh (%) trên cùng màn với tỷ giá JPY/VND; hai giá trị dùng một nút `Lưu thay đổi` và cùng version chính sách giá.** Phụ phí có snapshot theo đơn, không thay đổi những đơn đã tạo.
_Tránh_: Phí vận chuyển quốc tế đã chốt

**Chính sách giá (PricingPolicy)**:
Một phiên bản **đồng thời** của tỷ giá và phụ phí, dùng để tính giá catalog/checkout mới. Mỗi lần chủ cửa hàng nhấn một nút `Lưu thay đổi`, cả hai được kiểm tra và lưu nguyên tử. Đơn đã tạo lưu tiền hàng, tỷ giá và phụ phí tại thời điểm đó, không bị thay đổi ngược.
_Tránh_: Sửa cấu hình là sửa luôn giá của mọi đơn cũ

**Lần đồng bộ được xác nhận**:
Một `sync_run` thực tế có thời gian, số lượng và trạng thái kết quả; cấu hình lịch tự động không được xem là bằng chứng job đã chạy.
_Tránh_: Cứ đến 04:00 là đồng bộ chắc chắn thành công

**Trạng thái đồng bộ chỉ đọc trong Admin (Q7 đã chốt)**:
Admin chỉ hiển thị lần chạy Amazon hằng ngày từ `sync_runs` / `sync_errors`, gồm trạng thái, thời điểm thật và lỗi. Không có nút hoặc API quản trị khởi chạy quét toàn bộ danh mục; `Thêm một ASIN` đã chốt ở Q1 là yêu cầu nhập sản phẩm riêng. Khi thiếu lần chạy theo lịch, cần hiển thị rõ chưa có dữ liệu xác nhận.
_Tránh_: Có lịch 04:00 JST nghĩa là đã chạy thành công, hoặc Admin được phép chạy lại toàn bộ theo nút

**Cảnh báo lỗi đồng bộ trong Admin (Q8 đã chốt)**:
Thông báo chỉ xuất hiện tại trang Tổng quan Admin khi lần đồng bộ Amazon thất bại, thành công một phần, cần can thiệp hoặc không có lần chạy theo lịch được xác nhận. Hiển thị thời điểm, trạng thái, lỗi ghi nhận; **không gửi email, SMS hay thông báo đẩy**, và không tự chạy lại scraper.
_Tránh_: Đã bật email tự động; thông báo lỗi đồng nghĩa có thể vượt CAPTCHA hoặc 403/429

**Truy cập Admin chỉ qua localhost (Q9 đã chốt)**:
Admin MVP chỉ được mở trên chính máy chạy dự án thông qua loopback (`localhost` / `127.0.0.1`); không cấp quyền truy cập qua internet hoặc mạng LAN. Vẫn phải đăng nhập bằng tài khoản owner duy nhất và xác thực ở backend.
_Tránh_: Chạy localhost thì không cần mật khẩu, hoặc điện thoại khác trong cùng mạng vẫn được phép mở Admin

**Khởi chạy thủ công (Q10 đã chốt)**:
Chủ cửa hàng chủ động bật/dừng website, backend và worker trên Windows khi cần; không tự khởi chạy các tiến trình này khi bật máy. Lịch quét 04:00 JST chỉ có thể chạy khi máy/worker hoạt động đến giờ đó. Nếu không có `sync_run` thực tế, Tổng quan báo thiếu/chưa xác nhận; job nhập một ASIN có thể nằm `pending` đến khi worker được bật.
_Tránh_: Cài lịch cron đồng nghĩa máy tắt hoặc worker tắt vẫn quét hằng ngày; mở Admin sẽ tự chạy quét bù

**Khởi tạo owner bằng lệnh local (Q11 đã chốt)**:
Một tài khoản chủ cửa hàng được thiết lập từ công cụ dòng lệnh chạy trực tiếp trên máy dự án, nhập mật khẩu kín để backend hash và lưu an toàn. Không có trang web setup/đăng ký Admin, mật khẩu mặc định hay mật khẩu lưu trong Git; lệnh không tự tạo tài khoản thứ hai.
_Tránh_: Dán mật khẩu vào command line, ghi vào log/source hoặc xây trang đăng ký Admin công khai

## Thuật ngữ mở rộng nội dung sản phẩm (Grill 07 — đã chốt Q1–Q9)

Các khái niệm được owner xác nhận tại `.agents/plan/07_mita_product_detail_enrichment_grill_plan.md` và `docs/adr/0011-product-detail-enrichment.md`. Đây là quyết định thiết kế, chưa phải xác nhận đã triển khai tính năng.

**Bộ ảnh của một ASIN**:
Danh sách tối đa **5 ảnh nguồn khác nhau** gắn với chính ASIN đó, có thứ tự hiển thị; có thể ít hơn 5 nếu nguồn chỉ cung cấp ít ảnh hợp lệ. **Chỉ lưu URL ảnh nguồn**, không tải/cache file ảnh trên VPS.
_Tránh_: 5 ảnh tự tạo hoặc ảnh của biến thể khác chỉ để đủ số lượng

**Tên gốc / tên tiếng Việt**:
Tên sản phẩm quan sát từ nguồn và tên được dịch sang tiếng Việt lưu riêng trong DB. **Khách chỉ nhìn thấy một tên**, ưu tiên thuật ngữ tiếng Việt; nếu không có từ tương đương Việt thì dùng tiếng Anh; nếu tiếng Anh cũng không có thì giữ tiếng Nhật. **Không hiển thị dòng tên Nhật phụ**. Dịch không được thay đổi thương hiệu, mã ASIN, định lượng, đơn vị và thuộc tính sản phẩm. Không cần người duyệt bản dịch hoặc chỉnh bản dịch qua Admin.
_Tránh_: Ghi đè mất tên nguồn hoặc tự bổ sung công dụng chưa được xác nhận

**Thông tin sản phẩm quan sát được**:
Các nhóm nội dung có bằng chứng từ nguồn như đặc điểm, thành phần, cách sử dụng, thông số và cảnh báo; trường không có dữ liệu phải để trống/không xác minh. Bản dịch là cách thể hiện ngôn ngữ khác, không phải bằng chứng mới về tính đúng đắn của nội dung.
_Tránh_: AI tự viết thành phần, liều dùng hoặc lời khuyên y tế

**Thuộc tính của biến thể**:
Cặp thuộc tính/giá trị thực tế (ví dụ `hương vị: socola`, `quy cách: 980 g`) được gắn với **ASIN con cụ thể**. Nhóm sản phẩm chỉ hình thành khi có mã nhóm quan sát và xác minh được từ nguồn.
_Tránh_: Tạo tổ hợp style/size không có ASIN thực hoặc suy đoán nhóm từ tên gần giống

**Dịch nền sau thu thập**:
Công việc chuyển văn bản sản phẩm gốc sang bản dịch tiếng Việt sau khi snapshot nguồn được lưu, chạy riêng được với job đồng bộ. **Worker trên PC gọi OpenRouter API lần lượt 5 model `:free` theo thứ tự ở plan 07**, tự chuyển model khi giới hạn/lỗi và chỉ công bố bản dịch qua kiểm tra kỹ thuật **không có duyệt thủ công**; chỉ dịch lại khi nguồn đổi. Không dùng model trả phí, không gửi dữ liệu khách hàng lên model. `OPENROUTER_API_KEY` chỉ lưu trong môi trường PC, không đưa vào Git hoặc VPS.
_Tránh_: Dịch thất bại khiến mất dữ liệu gốc hoặc chặn khách xem catalog

**Làm mới thông tin chi tiết hằng ngày**:
Khi worker PC đang bật xuyên giờ quét 04:00 JST, thu thập lại ảnh, mô tả, thuộc tính và giá thực đọc được cho tối đa **200 ASIN độc nhất trên mỗi danh mục mỗi lượt, tính cả ASIN con**. Nếu vượt cap, xếp phần chưa làm vào lần quét sau; nếu PC tắt thì không tự quét bù. Lỗi nguồn giữ lại snapshot đã lưu và có trạng thái lỗi thật.
_Tránh_: Coi lịch chạy đồng nghĩa mọi sản phẩm đã được cập nhật hoặc tự tăng thời điểm xác minh giá khi không lấy được giá
