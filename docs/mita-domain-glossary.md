# Mita Japan — Domain glossary và bất biến (29/10/2026)

**Trạng thái:** Design/Grill approved, chưa triển khai thay đổi code. Tham chiếu .agents/plan/12_mita_eight_issues_20261029.md và ADR 0013–0016.

## Entity và ý nghĩa

| Thuật ngữ | Ý nghĩa và bất biến |
| --- | --- |
| ASIN | ID sản phẩm Amazon 10 ký tự; phân biệt biến thể; mọi ảnh, giá, mô tả, bản dịch, log đều ràng buộc ASIN quan sát thực. |
| Product | Bản ghi catalog theo ASIN; hiện tại không đồng nghĩa được phép bán; quyền hiển thị do admin_hidden/verified switch và điều kiện vận hành quyết định. |
| SourceObservation | Kết quả quan sát nguồn đã xác minh ASIN, timestamp, adapter, URL, trường giá/ảnh/detail; không suy đoán dữ liệu. |
| ScanRun | Một lượt discovery + detail theo lịch. Có started/finished, attempted, saved, error/issue, deferred và từng loại kết quả; dữ liệu cũ không bị xóa bởi lỗi nguồn. |
| DiscoveredAsin | ASIN tìm thấy trên listing trong run, **không phải ASIN mới trong DB**. |
| AttemptedAsin | ASIN được truy cập detail trong run; khác với succeeded hoặc issue count. |
| SavedObservation | Lượt upsert thành công, có thể là update sản phẩm cũ; không được báo là số sản phẩm mới. |
| DeferredAsin | Mục còn chờ hoặc phải quét lại, kể cả từng success ở ngày cũ; cần reason/nextEligibleAt. |
| SourceGate | Trạng thái dừng/hoãn nguồn khi bị chặn hoặc Retry-After, bảo vệ mọi worker cùng nguồn; không tự bypass. |
| CatalogGalleryAsset | URL ảnh thực của ASIN, identity, vị trí, observed_at, provenance và bằng chứng size; có thể có ảnh cover và ảnh phụ. |
| ImageIdentity | Khóa của ảnh gốc bỏ modifier resize nhưng **không giả mạo link**; dùng dedupe/upgrade thumbnail đúng ảnh. |
| GalleryQuality | Đánh giá ảnh đã xác minh >=800 px; low-res thì không dùng trong gallery lớn; không nhầm raw URL count với displayable count. |
| GalleryCompleteness | complete chỉ khi thực sự nhận toàn bộ gallery được xác minh cho ASIN; partial/unknown không đồng nghĩa được xóa gallery cũ. |
| FrozenDetailSnapshot | Nguồn văn bản detail được chốt cho lần dịch để bảo toàn đối chiếu; không tự ghi đè bản dịch success. |
| TranslationSlot | Trường nguyên tử: features:i, ingredients:i, usage:i, cautions:i, specs key:i; **không bao gồm giá trị specs**. |
| TranslationCandidate | Chuỗi output dùng được, có source_hash/engine/model/attempts; luôn giữ nguồn để kiểm chứng. |
| StructuralInvalid | Output không dùng được (empty, malformed JSON/HTML/script, incomplete, sai ASIN/array), phải fallback nguồn, không publish. |
| SemanticWarning | Candidate dùng được nhưng khác số, đơn vị, code, brand, Nhật/Anh tồn dư; owner chọn mặc định **hiển thị** + log Admin khi semantic check OFF. |
| ApprovedTranslation | Candidate đạt semantic check; có thể giữ bất biến theo chính sách đã chốt. |
| ProviderFailure | Quota/timeout/HTTP hoặc không có usable candidate; không giả nội dung, hiển thị nguồn. |
| TranslationValidationPolicy | Setting Admin riêng với verified switch; OFF mặc định = semantic issue log + publish usable; ON = semantic gate cho kết quả mới, không làm mất dữ liệu đã có. Structural gate luôn ON. |
| WarningLogEntry | Log machine-readable gắn event ID, ASIN, slot, issue, source/output, model, attempt/time; private only, redacted, link từ Admin owner-only. |
| WorkerRun | Một execution của Amazon 04:00, Name 05:00, Detail 05:15 JST; bỏ missed window khi Windows offline (không catch-up). |
| WorkerVersion | Hash/fingerprint phiên bản đang nạp của tiến trình, để supervisor kiểm chứng code mới sau restart. |
| LlamaLease | Thời gian còn active inference/queue; server chỉ dừng sau 15 phút idle thực và không có lease. |
| DailySyncBatch | Một đợt đồng bộ source đã hoàn thành Windows → VPS sau các job hằng ngày; idempotent, watermark, kết quả verify và log. |
| Publication | API DuckDNS/front-end chỉ hiển thị nội dung được lấy từ nguồn hoặc translation usable; không suy từ quyền bán hay số URL raw. |

## Chuyển trạng thái tối thiểu

- **Translation:** pending → usable_warning | approved_success | provider_failed | structural_invalid; warning được retry có giới hạn, candidate mới chỉ thay khi hợp lệ hơn; đạt cap giữ usable warning; provider fail mà không có candidate hiển thị nguồn. Structural invalid **không bao giờ** publish.
- **Gallery:** unknown/partial → observed_images → verified_images → published_gallery; mỗi asset có thể nâng chất lượng theo identity, không thay nguồn bằng URL suy đoán; chỉ công bố tối đa 5.
- **Amazon detail:** queued → attempted → saved | deferred_reason | blocked_source; source-wide cooldown có precedence khi phát hiện access denial; không trộn issue và failure count.
- **Worker:** registered → scheduled_window → running → drained → idle/restart hoặc skipped_missed; không launch bù khi startup trễ.
- **Daily sync:** waiting_jobs → snapshot_ready → applying → verifying → success | partial/failed; không claim DuckDNS đã cập nhật nếu verify thất bại.

## Tách các cờ và bộ đếm dễ nhầm

- Công tắc **verified-only** chỉ quyết định quyền hiển thị/checkout; không thay phiên bản dịch hoặc quyền nội dung.
- Công tắc **semantic validation** chỉ điều chỉnh có chặn candidate usable vì issue ngữ nghĩa hay không; không cho phép output không hợp lệ về cấu trúc.
- **Số URL trong product_images** khác **số ảnh đủ chất lượng imageUrls từ public API**; 5 URL thumbnail không phải 5 ảnh hiRes.
- **saved** khác **new products**; **errors** có thể bao gồm cảnh báo giá và không nhất thiết là ASIN thất bại.
- **translation warning** không làm product stale/hidden/unorderable; giá phải tuân price freshness/rights độc lập.
- **local DB** và **VPS DB** là hai bản dữ liệu khác nhau; chỉ kết luận đã đồng bộ sau so sánh timestamp/hash/số liệu.
