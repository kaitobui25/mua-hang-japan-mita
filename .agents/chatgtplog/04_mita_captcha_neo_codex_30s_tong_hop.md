# 04 — Mita Japan: CAPTCHA BrowserOS Neo, Codex CLI và worker tiếp tục sau 30 giây (28/10/2026)

## Yêu cầu và quyết định
- Người dùng muốn backlog Amazon ~214 mục hoàn thành nhanh, dịch đầy đủ tiếng Việt, không để pipeline dừng khi CAPTCHA; yêu cầu dùng BrowserOS Neo MCP (`http://127.0.0.1:9010/mcp`) và phối hợp trực tiếp Codex CLI GPT-6.1 medium.
- Đã giải thích `translated` trước đây tính cả `name_only`: ban đầu DB có **31 success = 28 tên-only + 3 đầy đủ**, 20 dòng dịch thất bại. Lần kiểm tra sau: **293 sản phẩm**, **210 có detail**, **36 bản dịch success = 33 tên-only + 3 đầy đủ**; **214 pending** và **2 needs_human**. Trong số 214 pending, 213 thiếu detail; nhiều ASIN chưa có product row.
- Lượt backfill lịch sử: 207 saved/772 giây ≈3,7 giây/ASIN; 214 mục lý thuyết ~13–15 phút *nếu nguồn cho phép*. Dịch đầy đủ 293 sản phẩm cần ít nhất ~343 request (tên batch 5 + detail riêng), quota free tối đa ~50 request/ngày, dự phòng 2 ⇒ ít nhất ~8 ngày lý tưởng, thường dài hơn.
- Người dùng muốn không có người xác minh sau 30 giây thì tự tìm cách chạy tiếp và thậm chí yêu cầu vượt CAPTCHA. **Không triển khai tự giải/lách CAPTCHA, đổi proxy, né 403/429 hay tự ACK**; giới hạn thực tế là có thể tiếp tục **việc độc lập** (dịch dữ liệu đã lưu), chứ không bảo đảm lấy thêm Amazon trong lúc nguồn chặn. Muốn ASIN mới liên tục phải có nguồn hợp lệ được phép sử dụng.

## Những gì đã triển khai local
- Khi phát hiện CAPTCHA (không phải chỉ HTTP 403/429), sync và Admin Import gọi BrowserOS Neo `tabs/new` để mở URL Amazon hợp lệ cho người dùng thao tác, giữ nguyên `needs_human` và gate nguồn. Có lệnh `cd backend; npm run worker:captcha:open`, tùy chọn `BACKFILL_CAPTCHA_ASIN`; ACK **chỉ sau người dùng đã xác minh thực sự** qua `BACKFILL_ACK_ASIN` và `BACKFILL_ACCESS_CONFIRMED=1`, rồi mới `npm run worker:backfill`.
- Neo đã mở tab hai ASIN `B0FD9C1FD9` (whey) và `B00JWK5ILK` (sữa Morinaga). Tab hiển thị trang sản phẩm, **không chứng minh HTTP collector đã thông hoặc CAPTCHA được xác minh**. Gate Amazon không được tự xóa.
- Phối hợp Codex CLI (`codex-cli 0.161.0`, GPT-6.1 medium) thực hiện hai lượt đọc/review. Sau đó thêm `source_access_blocks.continuation_due_at`, `timeout_recorded_at` (migration additive), deadline 30 giây lưu DB, claim atomically đúng một lần, poll ~3 giây bằng pool PostgreSQL riêng (vẫn hoạt động khi `DB_POOL_MAX=1`), advisory lock chống race với ACK và phục hồi qua restart.
- Khi không có xác minh trong 30 giây, worker tự khởi động dịch tiếng Việt đối với **dữ liệu đã thu được**; nếu batch có tiến triển thì batch tiếp theo chạy sau 30 giây; hết quota, không có tiến triển hoặc provider lỗi thì lùi 2 giờ. Một scheduler dùng chung cho startup, CAPTCHA continuation, Admin Import và daily sync; có listener lỗi cho pool riêng. Vẫn giữ check quota/free model, không chuyển API trả phí.
- `worker:backfill:status` được cải tiến để hiện `title_only`, `fully_translated` và thời điểm pause/timeout của nguồn.
- Codex review phát hiện 5 lỗi Medium (race seed/ACK, không cập nhật timer từ continuation, retry quota quá sớm, pool thiếu `error` handler, daily sync chưa dùng scheduler chung); đã sửa.

## Kiểm thử, commit, vận hành
- Backend typecheck + build PASS, **86/86 isolated tests PASS** kể cả `DB_POOL_MAX=1`. Local API `http://127.0.0.1:4000/api/health` OK, web `http://127.0.0.1:3000`, worker daily 04:00 JST chạy khi PC bật. Không test DB fixture trực tiếp trên database thật; chỉ `cd backend; npm test`.
- Commit local không chứa `[deploy]`: `9a518e0` Neo CAPTCHA tab, `2628efe` docs; `c6f9f91` 30s continuation, `e911c3b` docs, `2e3793d` worker fixes. **Không push GitHub hoặc deploy VPS**; nếu deploy phải chạy production DB migration có kiểm soát.
- Lần trạng thái cuối: 293 products, 210 detailed, 33 title-only, 3 full Vietnamese translations, 214 pending, 2 `needs_human`. `continuation_due_at` và `timeout_recorded_at` đã được ghi, nên fallback dịch có chạy; nguồn Amazon vẫn cần xác minh để crawl thêm. Không khẳng định đã vượt CAPTCHA.

## Tiếp tục trong phiên sau
- Nếu mục tiêu ưu tiên là hoàn thành 214 ASIN: xác nhận quyền truy cập Amazon trên giao diện và thực hiện ACK hợp lệ trước khi quét; hoặc nghiên cứu nguồn/API được cấp phép, kèm provenance, freshness, giá/ASIN và chính sách quyền dữ liệu. Không tự tạo thông tin còn thiếu.
- Nếu ưu tiên bản dịch: xem quota OpenRouter và tăng hiệu quả batch title/detail trong giới hạn free; trạng thái `translated` phải phân biệt title-only và full.
- Repo Windows: `C:\phong\AI\web\mita-japan\mua-hang-japan-mita`; CoS workdir `/mita-japan/mua-hang-japan-mita`. Không đụng dự án E-KAIWA, không backup theo yêu cầu, không tự deploy và không thay đổi các file chatgtplog cũ.
