# ADR 0015 — Vòng đời Windows worker, llama theo nhu cầu, đồng bộ VPS hằng ngày

**Ngày:** 29/10/2026 JST. **Trạng thái:** Accepted (thiết kế; chưa triển khai).

## Vấn đề

Các worker Mita chạy độc lập, Node.js không tự nạp code mới; 29/10 Name/Detail/Amazon từng dùng bản cũ dù Git đã được sửa. llama-server.exe vẫn thường trực dù không có inference. Source và sản phẩm dịch nằm trên PostgreSQL local/VPS; giao diện DuckDNS không phản ánh local nếu không đồng bộ đúng. Đồng bộ dữ liệu có script hiện hữu nhưng chưa gắn với barrier các jobs hằng ngày.

## Quyết định

1. **Windows startup:** Mita worker supervisor chạy sau Windows boot, check đúng executable/project/cmdline/version/port và PID creation time. Bắt đầu scheduler nhưng **không chạy bù** nếu bỏ lỡ 04:00 Amazon, 05:00 Names hoặc 05:15 Detail (owner chọn 2B). Log skipped windows.
2. **Code update:** monitor fingerprint worker code/release, khi thay đổi thì chờ job kết thúc hoặc graceful drain; restart **đúng worker** để nhận code mới. Với code đang chỉnh dở, có debounce/quiescence; một restart không được đổi version trong giữa run; không kill nhầm PostgreSQL, E-KAIWA hay service khác.
3. **LLM server:** on-demand trước 05:15 job/explicit detail request, health-check readiness và exclusive ownership. Sau khi hết requests và **15 phút không có inference/job** thì stop đúng tiến trình Mita; nếu có nhu cầu mới thì bật lại. Luôn bind localhost, không lộ model server trên VPS/public.
4. **Đồng bộ dữ liệu:** **một batch/ngày** từ Windows PostgreSQL → VPS PostgreSQL **sau jobs hoàn thành/được ghi nhận skipped**. Snapshot/watermark của run, stale-write guards cho source/translation/image, idempotent migration, dry-run/apply/verify và nhật ký hiệu lực trên API. Không động tới orders, pricing, Admin permission, rights_status hay E-KAIWA. Nếu sync lỗi hoặc worker chưa xong thì báo deferred/partial, không giả kết quả website đã cập nhật.
5. **Tách code deploy và data sync:** trigger [deploy] chỉ phát hành code Mita; data sync hằng ngày có vận hành riêng và không auto push Git. Trước nghiệm thu public phải chắc chắn backend live có schema/API tương thích; kiểm tra revision + health.
6. **Lỗi vận hành:** mọi scheduler/supervisor/sync event có run_id, state, timestamp, code version; Admin đọc được trạng thái và link log private. Không ghi DB credential/tunnel URL/HTTP payload; tự động phục hồi service không đồng nghĩa vượt nguồn Amazon hoặc chạy bù.

## Bổ sung sau Codex CLI architecture review

- **Không chạy DDL trong daily data sync.** Script hiện hành backend/scripts/sync-catalog-vps.mjs --apply chạy schema.sql, admin.sql, remove-needs-human.sql. Phải tách migration riêng có review khỏi luồng một batch dữ liệu/ngày, test bảng/permissions Admin/orders/pricing giữ nguyên.
- **Ledger sync bền theo ngày JST:** run_id, terminal state cho Amazon/Name/Detail, watermark, lock, remote commit marker, verify hashes per ASIN/field. Test crash trước/sau commit; không tự lặp batch hoặc chạy bù khi Windows bỏ lịch.
- **Restart an toàn quanh cron:** nếu worker restart trước mốc nhưng process mới lên sau 04:00/05:00/05:15, startedAt > due và job bị bỏ. Supervisor cần hoãn qua dispatch window hoặc ghi missed, test từng giờ, job drain lâu và old queue. Không vi phạm quyết định 2B.
- **Llama một lifecycle owner/lease duy nhất:** xác minh PID/start time/exe/model/endpoint/port 8080, test hai request đồng thời, inference lỗi, request đúng phút idle 15 và tiến trình khác chiếm cổng. Không kill theo tên file đơn thuần.

## Phụ thuộc và hệ quả

- Ưu tiên owner 14B là **tiếng Việt → ảnh → UX → supervisor đầy đủ**. Cho phép vận hành restart có kiểm soát và data-only verify tạm thời trong từng giai đoạn; không tuyên bố đã triển khai auto supervisor khi mới có script restart.
- Lệnh tự động phải cân nhắc SSH tunnel 15432 đã được sử dụng, không khởi tạo xung đột, xác nhận nhận diện tunnel trên Windows. Dùng lock một đợt sync/day; nếu task đã chạy lâu vượt ngày phải báo chờ, không spawn batch thứ hai ghi đè.
- Name/Detail chạy quota/compute lớn. Không bắt ép đồng bộ giữa chừng transaction hoặc dựa vào giờ cố định nếu job chưa hoàn tất; chỉ publish snapshot nhất quán.
- **Supersedes:** cách khởi động tay trong ADR 0010 Q10; bổ sung tự restart cho ADR 0012 nhưng **giữ quy tắc skip missed run**.
- Không tự backup và không tự rollback database phá dữ liệu theo yêu cầu owner; migration additive và code rollback tương thích schema cũ.

## Nghiệm thu

Windows boot trễ không chạy bù; update code khi job bận khiến worker drain và chỉ restart đúng một lần; crash/port-occupied không giết process khác; llama idle 15 phút tự dừng và bật lại khi job kế; sync chỉ một batch sau job, dry-run/verify/retry có lock; local/VPS/API khớp ASIN/last_updated và không đụng order/rights. E-KAIWA vẫn healthy.
