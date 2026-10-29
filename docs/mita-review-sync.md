# Mita Japan — đồng bộ ảnh phản hồi Windows → VPS

**Trạng thái:** Đã triển khai mã nguồn, **chưa kích hoạt trên VPS**. Không chạy upload, SSH, thay đổi systemd, Caddy, DNS hoặc restart dịch vụ trong giai đoạn xây dựng. Bộ đồng bộ chỉ dành cho Mita, không truy cập thư mục hay dịch vụ E-KAIWA.

## Nguyên tắc

- Thư mục chủ shop thả ảnh: `public/reviews/` trong repository Mita trên Windows. Chỉ đặt ảnh **đã có sự đồng ý của khách, được owner duyệt và đã che tên, avatar, số điện thoại, thông tin tài khoản, profile**. Việc đặt ảnh trong thư mục được xem là quyết định công bố; chương trình không tự phê duyệt quyền riêng tư. File mới sửa trong 30 giây gần nhất được bỏ qua cho đến lượt sau, nhằm tránh đọc khi đang copy. Một file lock Windows ngăn nhiều phiên chạy trùng.
- Chấp nhận file PNG, JPEG, WebP có chữ ký đầu file đúng đuôi, 12 byte đến 8 MiB, tên file đơn an toàn (chữ Unicode/số, khoảng trắng, `_`, `-`, `.`, `(`, `)`), tối đa 240 byte UTF-8. Không upload file ẩn, symlink, junction, file sai định dạng hoặc `review-demo-<số>.*`; ba ảnh minh họa đã đóng gói sẵn trong release, vẫn được gắn nhãn **MINH HỌA – HƯ CẤU**.
- Windows supervisor kiểm tra **tối đa mỗi 5 phút** khi có `MITA_REVIEW_SYNC_ENABLED=1`; mỗi lần xét tối đa 300 ứng viên, tối đa 120 ảnh và upload tối đa 12 ảnh. Không chạy từ 03:45 đến 05:45 JST, trong lúc catalog sync hoặc DB worker đang giữ advisory lock, hay khi một phiên đồng bộ ảnh còn chạy. Có timeout 180 giây, không chạy bù bỏ lỡ; mất mạng/SSH sẽ báo lỗi trong `.agents/runtime/review-sync.*.log` và thử lại lần sau khi được phép.
- Dữ liệu đặt tại **`/opt/mita/shared/reviews` bên ngoài `/opt/mita/releases`**, nên không mất khi phát hành release mới. Next.js dùng `MITA_REVIEW_DIR=/opt/mita/shared/reviews` để đọc ảnh trực tiếp ở mỗi request, và phục vụ qua `/anh-danh-gia/<tên-file>` với `no-store`.
- Đồng bộ kiểu **append-only**: SHA-256 giống nhau → bỏ qua; tên đã tồn tại nhưng nội dung khác → báo conflict, **tiếp tục các ảnh khác**, không ghi đè; không xóa file public trên VPS, không mirror và không backup. Mỗi ảnh đi qua thư mục upload riêng `.incoming-<uuid>.tmp`, kiểm tra lại magic/size/SHA-256 trên VPS, dùng Linux `renameat2(RENAME_NOREPLACE)` để công bố nguyên tử. Nếu bị gián đoạn, file tạm có thể còn tồn tại và cần operator kiểm tra bằng tay. Trạng thái SHA cục bộ ở `.agents/runtime/mita-review-sync-state.json` chỉ là cache cho file đã được VPS xác nhận, không chứa nội dung ảnh; **tối đa 60 phút** phải xác minh lại từ VPS để tự sửa ảnh bị mất trên remote. Xóa cache cũng sẽ xác minh lại từ VPS (không ghi đè ảnh khác nội dung).

## Chuẩn bị VPS (chỉ thực hiện thủ công sau khi cho phép triển khai)

Các lệnh dưới đây là **hướng dẫn**, chưa được chạy. Đảm bảo `ubuntu` là tài khoản đã được xác minh bằng SSH host key Mita và `mita` là user/group của web service. Trên VPS, operator tạo đúng thư mục Mita:

```bash
sudo install -d -o root -g root -m 0755 /opt/mita/shared /opt/mita/shared/bin
sudo install -d -o ubuntu -g mita -m 2750 /opt/mita/shared/reviews
sudo install -d -o ubuntu -g ubuntu -m 0700 /opt/mita/shared/review-incoming
# Sau khi copy file scripts/mita-review-receiver.py đã review qua SFTP:
sudo install -o root -g root -m 0755 /path/operator-staged/mita-review-receiver.py /opt/mita/shared/bin/mita-review-receiver.py
```

Đảm bảo cả hai thư mục là directory thật, không có symlink; owner `ubuntu` ghi được thư mục incoming và reviews, service `mita-web` đọc được reviews. Bộ nhận VPS chạy theo `python3 /opt/mita/shared/bin/mita-review-receiver.py`, giới hạn tên file và đường dẫn cố định. Không cho phép SSH chọn thư mục đích qua tham số. Không dùng SSH key GitHub Actions vì key CI chỉ được phép nhận release qua forced command; script Windows tái sử dụng **SSH identity có sẵn** `~/.ssh/oracle_20260624` đang được Windows `ssh-agent` giữ, với `StrictHostKeyChecking=yes`, `BatchMode=yes`, `IdentitiesOnly=yes`, host cố định `ubuntu@217.142.225.255`. Chương trình từ chối nếu thiếu key/fingerprint hoặc host key đã ghim.

Đặt biến môi trường **riêng dịch vụ web Mita** `MITA_REVIEW_DIR=/opt/mita/shared/reviews` trong cấu hình `mita-web.service`/drop-in Mita. Chỉ áp dụng khi đã triển khai mã nguồn Next mới và được owner cho phép restart dịch vụ Mita; không sửa systemd toàn hệ thống hay E-KAIWA. Nếu biến này chưa đặt, Next sẽ dùng `public/reviews` bên trong release, tức ảnh được sync lên shared folder **chưa** xuất hiện trên web.

## Bật Windows (sau khi VPS đã sẵn sàng)

Không đưa private key, passphrase, password hay token lên repo, biến CLI hoặc log. Dùng Windows `ssh-agent` và host key đã xác minh sẵn; không tự khởi tạo credential. Thiết lập `MITA_REVIEW_SYNC_ENABLED=1` trong môi trường của tiến trình Mita supervisor (`scripts/start-mita-supervisor.ps1` / tác vụ logon hiện có) **sau khi** receiver và thư mục VPS sẵn sàng. Nếu supervisor đã chạy, thay đổi biến môi trường chỉ được nhận khi khởi động lại supervisor theo quy trình owner cho phép; không restart ở đây.

Từ đó owner chỉ cần thêm **ảnh đã được duyệt** vào `public/reviews/` trên Windows; supervisor tự chuyển ảnh lên Mita VPS khi ngoài giờ công việc và kết nối SSH sẵn sàng. Khi ảnh chưa tới: xem `.agents/runtime/review-sync.out.log`, `.err.log` và `mita-supervisor.jsonl` (tránh đưa dữ liệu khách lên log công khai). Giới hạn lịch và số file được giữ để tránh tăng tải vào 04:00.

## Kiểm thử offline và kiểm chứng thủ công khi được phép

Trước khi kích hoạt production, có thể chạy kiểm thử **không SSH**:

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/test-mita-review-sync.ps1
node --experimental-strip-types --test src/components/reviews/review-images.test.mjs
node --test scripts/test-mita-p4.mjs
python scripts/test-mita-review-receiver.py
```

Các test `openat`, `fcntl`, `renameat2` của Python chỉ chạy trên Linux; Windows tự bỏ qua phần này. Chạy lại `python3 scripts/test-mita-review-receiver.py` trong môi trường Linux staging trước khi cài receiver VPS.

Sau khi operator cấp quyền triển khai: xác minh bằng một ảnh không chứa thông tin thật, file xuất hiện tại `/opt/mita/shared/reviews`, `GET https://mitajapanshop.duckdns.org/anh-danh-gia/<tên-ảnh>` trả 200 đúng MIME và `no-store`, trang `/danh-gia` nhận ảnh sau reload. Kiểm tra cùng tên khác nội dung phải bị từ chối; ảnh cũ không đổi; đóng/mở release mới không làm mất ảnh shared. Không tự tạo ảnh khách hàng giả cho website đang chạy. Khi thu hồi quyền công bố, operator phải xóa file public trên VPS thủ công và xử lý cache/CDN nếu có — đồng bộ không bao giờ tự xóa từ xa.
