# ADR 0013 — Kiểm tra ngữ nghĩa bản dịch tùy chọn và xem warning trong Admin

**Ngày:** 29/10/2026 JST. **Trạng thái:** Accepted (quyết định owner; **chưa triển khai code**).

## Bối cảnh

Name Translator 05:00 dùng OpenRouter miễn phí; Detail Translator 05:15 dùng GGUF local. Một tiến trình cũ đã chuyển 5 tên có usable candidate và issues về failed, khiến catalog bỏ qua bản dịch. Detail Translator từng chặn output vì các lỗi facts_changed/brand_changed; nhiều nội dung tiếng Anh chưa được dịch. Công tắc Admin hiện có chỉ quyết định verified-only, **không** điều khiển dịch.

## Quyết định

1. Thêm **công tắc riêng** trong Admin, đặt tên rõ là **Kiểm tra ngữ nghĩa bản dịch**, **mặc định OFF**. Không chạm tới hide_local_test_only, rights_status, availability, giá, checkout hay order snapshot. Chỉ owner có quyền đổi, ghi version và audit.
2. **OFF:** model trả output structurally usable thì lưu và hiển thị nguyên văn dù validator phát hiện sai số/liều, đơn vị, product code, brand hoặc ngôn ngữ còn sót. Ghi trạng thái **warning**, issues, ASIN/slot, source và candidate, engine/model, số lần thử, timestamp; **không** đánh dấu là approved.
3. **ON:** semantic validator có thể không publish candidate mới có lỗi; candidate usable đã lưu không được xóa ngầm khi đổi cấu hình. Cần policy chọn phiên bản hiển thị nhất quán, có regression test.
4. **Luôn bắt buộc** kiểm tra cấu trúc/trust boundary: rỗng, JSON sai/thiếu, ASIN lệch, output cắt, script/HTML không an toàn, nguồn ngoài whitelist và các nội dung không thể parse không được publish; fallback sang nguồn. Việc tắt semantic check không nới security gate.
5. **Tên:** giữ usable warning trong catalog và UI. Phục hồi năm ASIN còn tên từ trạng thái failed do worker cũ; ASIN thứ sáu chưa có candidate thì giữ nguồn và cho retry có giới hạn. Không blanket-update mọi status hoặc reset tất cả attempts.
6. **Chi tiết:** dịch tiếng Anh và Nhật trong features/ingredients/usage/cautions và **khóa specs**, tuyệt đối không dịch/biến đổi **giá trị specs**; source frozen và các bản success hợp lệ giữ nguyên theo chính sách trước, warning có thể cải thiện trong tối đa 3 attempts. Khi không có usable candidate, giữ nguồn.
7. **Thông báo:** một dòng cảnh báo nhỏ trong **Admin owner-only**, có URL nội bộ tới bản ghi log đã lọc (ASIN/slot/run), không phải file://. Log gốc có thể tiếp tục là .agents/runtime/translation-warnings.jsonl local Windows; endpoint xem log phải auth, redacted, rate/bounds, không mở public. **Không thêm badge lỗi chi tiết ở storefront** theo quyết định owner cũ; storefront chỉ hiển thị candidate usable.
8. API/local/backend và VPS sync phải sử dụng cùng tiêu chuẩn warning display. Bản dịch vẫn có thể có nội dung sai về liều lượng khi OFF: cảnh báo có ý nghĩa vận hành chứ không phải chứng nhận tính chính xác; giữ source để xem xét.

## Hệ quả và đánh đổi

- Ưu tiên hiển thị/hoàn thiện ngôn ngữ hơn độ chính xác ngữ nghĩa được xác minh tự động; owner **chấp nhận nguy cơ** bản dịch sai liều lượng có thể xuất hiện công khai. Không phát sinh claim mới do hệ thống tự biên soạn. Việc thay đổi ON/OFF phải dễ kiểm tra và không mất dữ liệu.
- Không dùng paid API. OpenRouter free/quota hiện hữu và GGUF local giữ nguyên. Phân loại provider failure khác semantic warning để không hiển thị JSON hỏng.
- Migration additive/idempotent, status warning + attempts/issue metadata; log riêng owner, không đưa secrets/PII vào log.
- **Supersedes:** phần chặn semantic output ở ADR 0011 mục hậu quả và trong .agents/plan/10_local_detail_translator_grill_plan.md; làm rõ .agents/plan/11_translation_warning_policy_20261028.md bằng toggle OFF mặc định và link log Admin. **Giữ:** ADR 0012 về Name Translator độc lập 05:00/skip missed/giới hạn quota.

## Bổ sung sau Codex CLI architecture review

- Phải dùng **manifest đúng 6 ASIN** trước mọi migration dữ liệu: B0DDXYC8NL, B0FSL4CP1M, B0H1GZLGK9, B0H5C5GHMP, B0H5C6PKR1 có tên dịch cũ/issue; B0G5XT3VHX chưa có candidate. Mỗi entry có precondition source_hash/status/name/attempts, expected status, audit và test restore lặp lại không đổi.
- Cổng structural phải thực sự từ chối HTML/script/XSS/injection ở cả name và detail; OFF chỉ ngừng **chặn semantic**, không cho xuất bản text không thể sử dụng. Candidate warning được lưu nguyên trạng với nguồn; tránh tự sửa nội dung khiến log không khớp output.
- Retry cap hiện hữu có thể vô tình loại ASIN thiếu candidate; manifest phải quy định rõ remaining attempt budget trước khi sửa.

## Tiêu chí nghiệm thu

Kiểm thử OFF/ON + rights switch hoàn toàn độc lập; 6 tên lịch sử + tình huống failure với null candidate; mismatch số/đơn vị/code vẫn hiện usable candidate khi OFF và ghi log chính xác; malformed JSON/script tuyệt đối không xuất hiện; specs values byte-for-byte; warnings liên kết được đến log private, không public; đối chiếu local/VPS/DuckDNS trên ít nhất 5 ASIN. Không chạy migration thực tế chỉ dựa vào quyết định ADR.
