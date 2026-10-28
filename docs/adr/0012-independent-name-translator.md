# ADR 0012 — Translator tên độc lập, 05:00 JST

**Trạng thái:** Accepted — owner chọn Q1 A, Q2 chỉ tên, Q3 không dịch lại, Q4 bỏ lượt khi PC tắt (28/10/2026). Thay thế phần lịch dịch tự động ở ADR 0011 và README cũ.

- Amazon worker giữ lịch 04:00 JST; không có trigger dịch từ sync, import, CAPTCHA, startup hay hết 30 giây.
- Translator chạy trong **tiến trình Windows riêng**, với pg-boss queue `translation.names.daily` lúc **05:00 Asia/Tokyo**. Bỏ lượt khi tiến trình chưa khởi động đúng giờ; không chạy bù. Có lệnh dịch thủ công rõ ràng.
- Mỗi lượt dịch mọi tên ASIN chưa thành công theo batch tối đa 100 (JSON request thực tế tối đa 24.000 byte UTF-8; dự toán output bảo thủ tối đa 8.192 token), đến khi hết tên, quota miễn phí (giữ 2 request), hoặc provider không khả dụng. ASIN thất bại được thử lại ngày sau; khóa PostgreSQL ngăn dùng quota song song.
- Một khi tên Việt của ASIN được lưu với `status='success'`, không tự dịch lại dù tên/chi tiết nguồn thay đổi. Catalog tiếp tục hiển thị tên Việt đó. Dịch mô tả nằm ngoài phạm vi translator mới và sẽ dùng model khác trong công việc sau; các bản dịch mô tả lịch sử giữ nguyên, chỉ hiển thị khi nội dung nguồn còn khớp.
- Hai tiến trình có PID/log riêng qua `scripts/start-local.ps1`, dừng được bởi `scripts/stop-local.ps1`.

**Đánh đổi được owner chấp nhận:** tên đã dịch có thể không còn phản ánh phiên bản Amazon mới; cần quy trình cập nhật thủ công riêng nếu thay đổi quyết định sau này.

Name-only requests explicitly send `reasoning: { enabled: false }`: the owner's PC probe
returned a truncated Nemotron response when reasoning consumed 3,962 of 4,960 completion
tokens. Subsequent probes with reasoning disabled on `nvidia/nemotron-3-ultra-550b-a55b:free`
returned `finish_reason=stop`, zero provider cost, and every ASIN/name in JSON:

| Names | Wire bytes | Prompt tokens | Completion tokens | Duration |
| --- | --- | --- | --- | --- |
| 40 | 7,276 | 2,339 | 1,936 | 29.5s |
| 70 | 12,940 | 4,185 | 3,527 | 47.5s |
| 100 | 18,896 | 6,095 | 5,194 | 76.7s |

These PC probes did not mutate the database. Presence in probe JSON does not replace
production validation of identity, numbers, units, codes, brands, and source freshness.
Name-only requests now allow 120s per provider, with an explicit timeout override retained;
full-description requests keep their existing timeout. Model order remains unchanged.
Packing uses the actual serialized UTF-8 request (including prompt, model and reasoning
settings), a 100-name cap, and an 8,192-token output ceiling. The output estimate is
`64 + sum(max(80, ceil(sourceName.length * 1.25) + 32))`: title expansion plus JSON/ASIN
overhead and an 80-token floor per name, versus about 52 tokens/name observed at 100 names.
This heuristic allows representative short titles to fill a 100-name request and reduces
batch sizes for longer titles; it is not a completion guarantee. Explicit non-stop completion
reasons are rejected before validation/persistence, including parseable JSON marked `length`.

A response marked `length`, malformed JSON or mismatched identity/count raises a distinct incomplete-batch signal without disabling that
provider. The scheduled job discards the partial reply and retries the two halves in source
order, up to two split levels (at most seven attempts per initial batch). Every retry uses the existing quota/rate gate and
every complete child batch passes the same validation and source-freshness checks before
saving. An incomplete parent is not marked failed. Successfully saved children remain saved
if quota expires; unattempted children stay eligible for the next run. A leaf that
still fails after bounded recovery is marked failed through the existing guarded failure write.

For a complete response with the correct ASIN order/count, validate each title independently.
Return validated names and rejected ASINs separately: save only validated names through the
unchanged source-freshness and first-success guards, and mark only rejected names failed.
Content validation failures do not split, refetch siblings, or disable a provider. Rejected
names are eligible again on the next scheduled run. This avoids repeating the owner's
76-name manual run that spent seven requests saving only 38 names. The mocked regression
with 38 valid and 38 invalid titles now uses one inference request, with 38 guarded success
writes and 38 guarded failure writes. No validation rule was relaxed.
