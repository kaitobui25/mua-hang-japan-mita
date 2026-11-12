# Kế hoạch thông báo đơn mới qua Telegram — 2026-11-09

## Mục tiêu và hiện trạng

- Đơn thật `pending_confirmation` trên VPS gửi thông báo riêng tới Telegram chat ID `7480163903`, bot dự kiến `@Mita01Bot`.
- Checkout hiện ghi `orders` và sự kiện `order_placed/owner/admin` trong `order_notification_outbox` cùng transaction (`backend/src/orders.ts`). Simulation không tạo sự kiện.
- Theo quyết định mới của owner: dùng **scheduler Gmail hiện có làm bộ kích hoạt chung** mỗi 15 giây cho cả Gmail và Telegram; mỗi kênh vẫn có trạng thái gửi/retry độc lập, không phụ thuộc nút Admin "Đã xem".
- Kiểm tra chỉ đọc VPS Hermes ngày 2026-11-09: `mita-api.service` active; `api.telegram.org` DNS thành công, HTTPS GET `/` trả 200. Chưa kiểm tra Bot API có token, chưa gửi thông báo thật.
- Codex CLI đã rà soát độc lập chế độ read-only tại HEAD `795b121`; không sửa code và không dùng token.

## Thiết kế

1. Tái sử dụng outbox hiện hữu; mở rộng `startEmailAlertScheduler()` thành scheduler thông báo chung trong API VPS sau khi Fastify listen. Không gửi trực tiếp trong request checkout, không tạo timer Telegram thứ hai.
2. Thêm `order_telegram_delivery_activation` (singleton, mốc bật lần đầu) và `order_telegram_deliveries` (unique event/chat, pending/sending/sent/failed, retry, lease, message_id). Migration additive/idempotent, không backfill đơn cũ.
3. Scheduler chung poll khoảng 15 giây, gọi xử lý hai kênh độc lập và cách ly lỗi để Telegram hỏng không chặn Gmail. Telegram claim bằng `FOR UPDATE SKIP LOCKED`; gửi HTTPS POST Bot API `sendMessage` bằng `fetch`, timeout và giới hạn retry (đề xuất 5), tôn trọng `429 retry_after`. Không cần Telegram SDK, webhook hay inbound port.
4. Chỉ bật khi `NODE_ENV=production`, Linux, hai opt-in `MITA_TELEGRAM_ALERTS_ENABLED=1`, `MITA_TELEGRAM_ALERTS_VPS=1`, token hợp lệ và chat ID allowlist chính xác `7480163903`. Token chỉ tồn tại trong protected API environment; không đưa vào repo, URL command-line, log hay frontend.
5. Tin nhắn chỉ chứa mã đơn UUID, mã sự kiện, thời gian và trạng thái "đã đặt, chưa thanh toán"; truy cập Admin qua đường riêng. Không chứa tên, SĐT, địa chỉ, email, dòng hàng, token hay đường dẫn Admin công khai.
6. At-least-once: DB unique chống duplicate enqueue, nhưng crash sau khi Telegram nhận và trước ghi `sent` vẫn có thể gửi lặp. Hiển thị event ID cố định để chủ shop nhận ra.

## Trình tự triển khai

1. Viết sender Telegram, mở rộng scheduler Gmail hiện có thành scheduler chung, migration, kiểm thử và hướng dẫn vận hành. Các file dự kiến thêm: `backend/src/notifications/telegram-delivery.ts`, `backend/src/db/telegram-delivery.sql`, `backend/tests/telegram-delivery.test.ts`, `docs/order-telegram-alerts.md`. Sửa `backend/src/notifications/email-scheduler.ts` (hoặc đổi tên thành scheduler chung), `backend/src/server.ts` nếu đổi entrypoint, `backend/src/db/migrate.ts`, `backend/tests/run.ts`, `backend/scripts/copy-assets.mjs`, `deploy/mita/ci-deploy.md`.
2. Test offline với HTTP mock và PostgreSQL disposable: đơn thật/simulation/đơn cũ, mốc activation, checkout trùng, seed/claim đồng thời, lease, network timeout, 429, 5xx, lỗi token, giới hạn retry, leak secrets/PII, graceful shutdown; typecheck và build.
3. Chủ bot nhắn `/start` tới `@Mita01Bot`; cấp bot token từ BotFather bằng kênh bí mật trên VPS. Kiểm tra `getMe`, và private chat ID `7480163903` qua phiên provisioning an toàn. Không ghi token vào chat.
4. Kiểm tra **đúng VPS DB** bằng truy vấn chỉ đọc về host/port/database/schema và systemd EnvironmentFile. Trình SQL mới để duyệt phạm vi DB riêng; One-Click hiện không bao gồm migration này.
5. Sau khi được phép, áp dụng đúng SQL đã duyệt, phát hành code với flag tắt, kiểm tra version/schema. Bật flag trong secret environment, restart **chỉ** `mita-api.service`, kiểm tra activation và sender.
6. Smoke bằng thông báo thử có nhãn `TEST KẾT NỐI` và không chứa dữ liệu đơn; xác thực end-to-end khi đơn thật tiếp theo phát sinh. Quan sát queue pending/sent/failed, thời gian chờ, lỗi chuẩn hóa. Rollback bằng tắt flag và restart API, giữ ledger/activation để không gửi lại đơn cũ.

## Ranh giới và việc chưa thực hiện

- Chưa đọc bot token, chưa gửi test Telegram, chưa tạo đơn thật/giả, chưa đổi DB/schema/config/VPS service, chưa deploy.
- Không cần sửa frontend, checkout, Caddy, email-delivery hay catalog sync theo thiết kế này. Scheduler Gmail hiện có cần sửa để điều phối thêm Telegram và vẫn chạy khi Gmail bị tắt.
- Trước lúc kích hoạt production cần duyệt chính xác migration mới và thao tác thay đổi dịch vụ theo `AGENTS.md`.
