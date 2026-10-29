# ADR 0014 — Ảnh HiRes theo nguồn thực và trạng thái lỗi Amazon

**Ngày:** 29/10/2026 JST. **Trạng thái:** Accepted (thiết kế; chưa sửa code/crawler).

## Bối cảnh và chứng cứ

Các commit 5b4b3e1/0a5d173 sửa TS hiRes trước khi collector chuyển sang Scrapling Python ở ae9fb2e. Lượt sáng 29/10 có 347 detail cập nhật nhưng 0 colorImages.initial và 0 gallery:complete, chỉ 15 gallery mới, còn 332 giữ cũ. HTML thật đã lưu của ASIN B0D32RZY9M chứa 9 hiRes trong A.$.parseJSON('[...]'); parser Python/TS hiện bỏ qua wrapper, chỉ còn ảnh lớn và thumbnail. Unit fixture JSON trực tiếp không bắt được lỗi đó. Public API loại thumbnail 38x50/40x40, kết quả có thể chỉ 1 ảnh.

## Quyết định

1. **Luồng được phép lấy ảnh:** Windows Amazon Worker → ScraplingSession → Python amazon_bridge.py / amazon_parser.py → validate/identity → storage TS → PostgreSQL → API. Không sửa một parser TS không sử dụng rồi coi là đã fix collector. Giữ fixture TS cho tương thích nếu có người dùng độc lập.
2. **Đầu tiên thử offline** trên HTML đã lưu: đọc wrapper A.$.parseJSON bằng trích chuỗi JSON có giới hạn, không eval/execute script, chống trộn ASIN child/recommendation; direct JSON, data-old-hires, dynamic/main/large vẫn hoạt động. Nguồn hiRes phải có provenance và gắn đúng ASIN.
3. **Ảnh publish:** tối đa 5 URL khác identity, thực sự quan sát, có chứng cứ >=800px. Không dùng phép đổi đuôi URL để phóng ảnh; không xóa cover/ảnh rõ cũ khi nguồn partial/blocked; nâng cấp thumbnail theo identity. Nếu thiếu thì gallery trả ít hơn 5 và Admin ghi ảnh còn thiếu.
4. **Đảm bảo lượt quét có ích:** ưu tiên 5 ASIN thử nghiệm DuckDNS trước, sau đó các ASIN thiếu ảnh theo hàng đợi có cap và fairness; không tự chạy quét ngoài lịch đã cho phép; 200 attempted ASIN/danh mục/lượt theo ADR 0011 được giữ.
5. **Issue taxonomy:** phân biệt page/listing error, product identity mismatch, missing price (lưu nhưng warning), access verification/CAPTCHA, rate limit, timeout, success/upsert và deferred. Không báo 347 saved như 347 ASIN mới; đưa counters vào Admin theo category và run.
6. **CAPTCHA/verification:** không tự giải/vượt, đổi proxy/IP/profile, không thử dồn khi nguồn đang chặn. Bỏ ASIN đang bị chặn, giảm tốc. **Một** retry sau vài phút chỉ khi đã qua mức backoff/Retry-After và tình trạng nguồn cho phép; nếu còn blocked thì hoãn tới ngày hôm sau và lưu log private; jobs dịch từ dữ liệu cũ vẫn hoạt động. Dừng toàn nguồn nếu tín hiệu chặn áp dụng ở mức session/source, mặc dù record per-ASIN vẫn được tạo.
7. Lưu issue event có ID, ASIN, run, category, retry-after và code; Admin owner-only cung cấp link log redacted. Không gửi HTML challenge hoặc token/cookie lên log hay public API. Các lỗi không được xóa giá/snapshot tốt; giữ price freshness và quyền nội dung độc lập.

## Bổ sung sau Codex CLI architecture review

- Tiêu chuẩn >=800px được đo bằng **cạnh ngắn của ảnh**, dựa trên metadata/chiều ảnh đã kiểm tra đáng tin, không dựa vào một modifier có thể sai.
- Storage và sync phải dùng **snapshot gallery nguyên tử theo ASIN/version**: không dùng mỗi upsert (asin,position) làm ảnh dư trên VPS. Khi nguồn partial, giữ ảnh rõ cũ và merge đúng image identity; khi snapshot mới complete và đã verify có thể loại slot cũ. Test 5→1, 1→5, reorder và stale source.
- Mỗi ASIN attempted có outcome cuối loại trừ nhau; cảnh báo missing price tách với failed. Test các con số phiên 29/10: 349 attempted, 347 saved, 9 issues gồm 6 missing-price warnings và 3 issue kỹ thuật.
- **Không có Retry-After không phải là quyền retry CAPTCHA.** Muốn retry vài phút phải có dấu hiệu tích cực là lỗi transient/page-scoped và nguồn cho phép; nếu không thì cooldown đến hôm sau. Test HTTP 200 verification, 403/429, Retry-After giây/HTTP-date và restart giữa backoff.

## Hệ quả và rủi ro

- Không thể đảm bảo mọi ASIN có 5 ảnh lớn: nguồn có thể không cung cấp đủ; phải báo số thực.
- Phân tích 347 detail không có colorImages.initial **không chứng minh** mọi HTML đều có đúng cùng wrapper như mẫu đã lưu. Cần nhiều fixture có provenance và live QA khi nguồn được phép.
- Retry CAPTCHA trong vài phút chỉ là **quy tắc có điều kiện**; không được ghi đè Retry-After hoặc source gate để đảm bảo thử ngay. Thời gian đến hạn phải được chứng minh từ nguồn và bảo vệ chung.
- **Supersedes:** phần ưu tiên TS extractor ở ADR 0011/plan 08 nếu không nối vào active collector, và nguồn-wide cooldown ngay đến hôm sau ở hiện trạng theo hướng chỉ có retry có điều kiện một lần. Không thay giới hạn nguồn, quyền sử dụng ảnh hoặc lịch worker.

## Nghiệm thu

Test HTML thật 9 hiRes → tối đa 5 ảnh verified, 0 thumbnail; wrong-ASIN/script injection không nhận; gallery giữ cover cũ khi nguồn partial; mỗi ASIN sync đúng với API DuckDNS sau daily sync; 5 ASIN QA có bảng URL/thông số/identity và thiếu nguồn được nêu rõ. CAPTCHA tests offline: source gate/backoff/Retry-After, một retry tối đa khi được phép, dừng next-day khi blocked, log private đúng reason; không cần thử CAPTCHA thật để coi unit test đạt.
