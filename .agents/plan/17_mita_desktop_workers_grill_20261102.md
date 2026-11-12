# Mita Japan — Đặc tả tab Workers WinForms và Codex CLI (Grill Me, 02/11/2026)

**Trạng thái: đã chốt yêu cầu qua 5 vòng hỏi đáp; CHƯA TRIỂN KHAI.** Đây là bản thiết kế để review/thi công sau, **không phải lệnh sửa code, DB, worker, dịch thực tế, chạy sync hoặc deploy**. Luôn đối chiếu với yêu cầu mới hơn, `AGENTS.md` và code/runtime tại thời điểm thực hiện.

## 1. Mục tiêu và quyết định từ người dùng

Tab **Workers** của ứng dụng **Mita Desktop WinForms** là giao diện quan sát, cấu hình và yêu cầu chạy thủ công. Mỗi ô đại diện một công việc; bấm ô thì panel bên phải hiển thị lịch, kết quả, tiến độ tổng, nguyên nhân không thành công, ASIN cảnh báo, đường dẫn log và dự kiến lượt tiếp theo.

### Danh sách quyết định đã chốt

| Câu | Quyết định người dùng |
| --- | --- |
| 1A | **4 ô:** Amazon / Dịch tên / Dịch chi tiết / Đồng bộ PC → VPS. |
| 2B | Xem chi tiết, **chỉnh cấu hình và chạy ngay** có xác thực/kiểm tra an toàn; không chỉ là dashboard. |
| 3A | Đối với dịch tên, **OpenRouter hoặc Codex** được lưu làm engine mặc định, áp dụng cho lịch tự động. |
| 4C (đính chính) | Codex được **dịch lại tên đã thành công**, tự ghi đè kể cả khi có **cảnh báo ngữ nghĩa/nội dung**, chỉ hiện warning và ghi log; không bắt duyệt hoặc chặn vì cảnh báo. Kết quả vô dụng về cấu trúc được xử lý theo 8A. |
| 5B | Ưu tiên **tiến độ trên toàn bộ dữ liệu**, không chỉ số thành công của một lượt chạy. |
| 6 (tự chọn) | **Mỗi ngày Codex dịch lại tối đa 300 sản phẩm** theo lịch; không mặc định là dịch lại toàn bộ corpus mỗi ngày. |
| 7A | Một lượt Codex tạo cả **tên Việt đầy đủ** và **tên rút gọn tối đa 120 ký tự**. |
| 8A | JSON hỏng/thiếu ASIN/tên rỗng hoặc không dùng được: **không ghi đè**, giữ tên cũ, ghi lỗi, retry có giới hạn. |
| 9B | Chỉnh được giờ chạy của **từng worker**, lưu lâu dài. |
| 10A | Panel phải: tiến độ tổng, lượt gần nhất, lượt kế tiếp, số lỗi, lý do, danh sách ASIN cảnh báo và **vị trí log**; **không yêu cầu đọc raw log** trong UI. |
| 11A | Mỗi ngày ưu tiên tên mới/lỗi, rồi **luân phiên** dịch lại các tên cũ lâu chưa xử lý. |
| 12B | Lượt **chạy thủ công không tính** vào hạn mức 300 sản phẩm/ngày của lịch tự động. |
| 13 (tự chọn) | Nếu quota Codex **5 giờ còn dưới 20%**, tự ngừng hoặc không cho bắt đầu dịch. Kiểm tra trước mỗi batch; batch đã bắt đầu thì kết thúc an toàn, không gửi batch mới. |
| 14A | Nếu `short` không đạt, vẫn ghi tên Việt đầy đủ; hiển thị full thay cho short và ghi cảnh báo. |
| 15A | Bản dịch được đồng bộ VPS qua **lịch, barrier và ledger** hiện tại; không push riêng lập tức. |
| 16A | Chạy tay: người dùng nhập số sản phẩm **tối đa 300/lượt**. |
| 17A | **Không đọc được quota 5 giờ** thì **không chạy Codex**, hiển thị “Không xác định quota”. |
| 18A | Quota hồi phục thì chờ **lịch kế tiếp**, **không catch-up tự động**. |
| 19A | Cho chỉnh lịch nhưng **từ chối xung đột/không hợp lệ** làm vỡ rào chắn worker và đồng bộ. |
| 20C | Hai chỉ số riêng: **độ phủ tên tiếng Việt / tổng sản phẩm**, và **tiến độ dịch lại Codex trong chu kỳ / tổng sản phẩm**. |
| 21B | **OpenRouter giữ logic hiện tại** (tên thiếu/lỗi, quota riêng), **không** áp đặt lịch dịch lại 300 sản phẩm. |
| 22A | Nếu worker đang chạy hoặc đang đồng bộ VPS, **từ chối “Chạy ngay”**, giải thích lý do; **không xếp hàng**. |
| 23A | Mặc định Codex **`gpt-6.1-sol`, reasoning `low`** như trong `../my-test`; không mở tuỳ chọn model/effort ở vòng này. |

## 2. Những gì đã kiểm tra trong code (HEAD lúc khảo sát `090cadd`)

- UI: `scripts/mita-desktop.ps1:108-139,472-493`; tab Workers hiện là TextBox read-only, chỉ đọc file ngày JST `.agents/runtime/mita-daily-YYYY-MM-DD.json` khi có phiên đăng nhập. Snapshot **không chứng minh tiến trình đang sống**.
- Supervisor: `scripts/mita-supervisor.mjs:78-90,193-254,367-416` có 3 worker `amazon`, `names`, `detail`; mặc định 04:00/05:00/05:15 JST; theo dõi lock và gửi sync khi barrier đủ. Hiện dựa một phần vào **chuỗi console** để suy trạng thái dịch; thiếu run ID và counters tin cậy.
- Dịch tên: `backend/src/translator.ts:9-43` gọi OpenRouter (`backend/src/translation/jobs.ts`) rồi rút gọn qua OpenRouter (`compact-title.ts`); pg-boss cron 05:00, bỏ qua dispatch muộn, không chạy bù khi PC bật trễ.
- Ghi DB: `backend/src/translation/jobs.ts:143-175,246-252` loại tên `success` khỏi hàng chờ và bảo vệ tên thành công, **trái yêu cầu Codex 4C**; cần luồng Codex retranslation độc lập, không phá logic OpenRouter 21B.
- Tên ngắn: `backend/src/translation/title-presentation.ts:11-38` chỉ áp dụng projection khi vẫn đúng cả tên Amazon nguồn lẫn tên Việt đầy đủ. Codex output `{asin,full,short|null}` hiện **khác** contract `shortName` + `omittedFacts`; cần chuyển đổi/lưu đúng mô hình hoặc thay thế có tương thích, không chép thẳng JSON.
- Nhật ký: Supervisor JSONL, `amazon/names/detail.out.log` / `.err.log`, `translation-warnings.jsonl`, PostgreSQL `sync_runs`, `sync_errors`, product translation/issue metadata; log có thể chứa dữ liệu nhạy cảm nên UI chỉ hiển thị bản tóm tắt an toàn, ASIN, mã lỗi và **đường dẫn log**, không nạp stderr/raw payload.
- VPS sync: `backend/scripts/sync-catalog-vps.mjs:9-15,56-84` bảo vệ tên `success` từ VPS, nên ghi đè PC không đồng nghĩa bản dịch mới lên VPS. Cần đồng bộ bằng **revision/generation** + kiểm tra đúng nội dung, vẫn bảo vệ chi tiết duyệt và ledger đồng bộ từng ngày.
- Codex benchmark: `../my-test/CODEX-SCALE-REPORT.md`: một lượt 320 tên được trả đủ JSON nhưng chưa đạt kiểm chứng nội dung; lựa chọn vận hành thận trọng khoảng **80 tên/batch**, kiểm ASIN/cấu trúc và cảnh báo. **Không** xem 80/300 là bảo đảm độ chính xác. Giao tiếp Codex CLI đăng nhập sẵn trên Windows, không thay bằng API trả phí.

## 3. Đặc tả màn hình

1. **Bên trái:** 4 thẻ: Amazon; Dịch tên; Dịch chi tiết; Đồng bộ VPS. Mỗi thẻ hiển thị trạng thái thực thi (đang chạy/đã kết thúc/bỏ lỡ/không rõ), thời điểm quan sát và tiến độ tổng có đơn vị rõ ràng. Không suy “hoàn tất = không có lỗi” hoặc “file trạng thái mới = process sống”.
2. **Bên phải khi chọn thẻ:** cấu hình/lịch đã lưu, lần chạy gần nhất (bắt đầu/kết thúc, engine nếu có, thành công/thất bại/cảnh báo), vì sao không đạt, ASIN bị cảnh báo, log nằm ở đâu, thời điểm chạy kế tiếp **dự kiến** và việc sẽ chọn xử lý trong lượt kế tiếp (loại queue, backlog, giới hạn và các điều kiện cần đạt). Nếu thiếu dữ liệu, hiển thị “chưa xác định”; không dựng số từ log không đủ bằng chứng.
3. **Dịch tên:** chọn OpenRouter/Codex; mặc định Codex như 23A khi engine Codex được chọn; số lượng tối đa 300 cho lần chạy thủ công. Có nút “Chạy ngay” của người có quyền, xác thực lại quyền và xác nhận. Cấu hình mới có version/audit; áp dụng **từ lần chạy sau**, không đổi engine giữa chừng.
4. **Lịch:** cho chỉnh giờ từng worker nhưng hệ thống phải xác nhận không trùng/xung đột và không vô hiệu hóa điều kiện sync. Sync là coordinator sau 3 trạng thái worker terminal trong cùng JST day, **không phải công việc có thể ép chạy bất chấp barrier**. Chặn lịch không hợp lệ và hiển thị lý do.
5. **Hai tiến độ dịch tên:** (a) sản phẩm có tên Việt dùng được / tổng sản phẩm trong catalog hiện tại; (b) sản phẩm Codex đã hoàn tất dịch lại trong chu kỳ luân phiên hiện tại / tổng tập sản phẩm của chu kỳ. **Tên có warning nhưng đã xuất bản vẫn tính hoàn tất**; tên không parse/không thể dùng không được tính. Chi tiết dịch dùng đơn vị **đoạn/slot**, không tráo với “sản phẩm”.

## 4. Quy tắc engine, quota, dữ liệu

- **OpenRouter:** không đổi việc chọn tên chưa có/lỗi, thử lại, quota và trình tự dịch/rút gọn hiện có, ngoại trừ phần quan sát và điều khiển đã được chốt. Không ép nó ghi đè tên success theo quy tắc Codex.
- **Codex scheduled:** tối đa 300 **sản phẩm/ngày JST** (không phải 300 trong một request), ưu tiên mới/lỗi rồi đến tên cũ theo lần xử lý gần nhất, lưu con trỏ/chu kỳ để không luôn quay về đầu. Batch khoảng 80 nếu phù hợp độ dài prompt và output; theo dõi tổng số **ASIN đã được chọn** để không phá hạn mức khi retry. Lượt lỗi giữ quyền xử lý sau mà không tự reset attempt lịch sử.
- **Codex manual:** chọn 1–300 sản phẩm/lượt, quota riêng với 300 tự động. Không tự vượt qua lock/quota; từ chối khi có worker đang chạy hoặc sync đang chạy, không queue. **Manual không được ghi trạng thái terminal thay lịch** để thỏa giả barrier sync.
- **Quota:** chỉ phát lệnh batch Codex khi đọc được số phần trăm quota rolling 5 giờ đáng tin, và **không dưới 20%**; unknown/stale => ngừng an toàn, thông báo. Không dựa trên token đếm để suy %. Kiểm cả các giới hạn nhà cung cấp khác nếu có (quota tuần, lỗi xác thực). Quota hồi phục không chạy catch-up; chờ lịch sau hoặc thao tác thủ công mới. **Giao diện đã có tài liệu:** Codex App Server `account/rateLimits/read` trả `usedPercent` và `windowDurationMins`; xác định đúng bucket **300 phút** của đúng tài khoản, tính remaining = 100 - usedPercent; không mặc định `primary` luôn là 5 giờ. Tham khảo <https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt>. **Điểm chặn kỹ thuật:** chưa thử xác thực/đọc quota bằng tài khoản thực của **worker Node chạy độc lập** (tool `usage` trong Chat On Steroids không tự thành API của worker). Nếu không có adapter đọc-only đáng tin => **không bật tự chạy Codex**, đúng 17A.
- **Cập nhật tên Codex:** ASIN hợp lệ, đủ từng ASIN, JSON parse được, tên là chuỗi dùng được; dùng snapshot nguồn và compare-and-swap để không gắn bản dịch vào tên Amazon đã đổi khi chạy. Mọi sai số, đơn vị, brand, ngôn ngữ, hương vị, ngữ nghĩa là **warning**, **không chặn ghi đè** theo 4C kể cả toggle kiểm tra ngữ nghĩa đang ON; riêng cấu trúc không dùng được thì 8A. Ghi warning, engine/model, bản cũ và kết quả mới, source hash, run ID/generation, thời gian và outcome vào bản ghi bền vững/transaction. Không hủy bỏ dữ liệu gốc `products.name`, bản dịch mô tả đã duyệt, hoặc lịch sử bản dịch; log JSONL có thể xuất từ dữ liệu đã commit.
- **Rút gọn:** sinh cùng lời gọi Codex; nếu short rỗng/null, vượt 120 hoặc cảnh báo không dùng được thì dùng tên Việt full, **không cản bản dịch full**. Chỉ áp dụng short đúng identity nguồn/bản full mới; không hiển thị short cũ gắn với full khác. Thao tác cập nhật full và short cần có semantics rõ khi từng phần thất bại.
- **VPS:** vẫn chờ 3 worker lịch hoàn tất/barrier, retry ledger ngày không được bypass. Đồng bộ revision tên Codex mới từ PC lên VPS và so sánh dữ liệu đích thật sự trùng; giữ nguyên chính sách tránh mất chi tiết duyệt, remote rights/visibility, đơn hàng và chính sách giá. Không tự sync trực tiếp lúc chạy manual.
- **Lỗi/thất bại:** phân biệt skip do trễ lịch, không đủ quota/không đọc được quota, lock bận, provider lỗi, output không parse, warning đã xuất bản, lỗi DB, và sync có trạng thái không chắc chắn. Quota-blocked phải là **kết quả terminal có lý do rõ ràng** cho lượt lịch (ví dụ deferred/partial/skipped theo contract được thiết kế), không gắn nhãn hoàn thành sản phẩm; như vậy barrier sync trong ngày vẫn có trạng thái xác định mà không giả thành công. Không giả định auto retry khi kết quả ghi DB/sync chưa xác minh.

## 5. Lộ trình thi công sau khi có yêu cầu triển khai

1. **Quan sát chuẩn hóa:** thiết kế cấu trúc event có run ID, counters theo đơn vị, thời điểm, engine, planned next actions, warnings an toàn. Tái dùng snapshot/log/DB hiện có thay vì dựng hệ thống mới không cần thiết; bản UI read-only tương thích với dữ liệu cũ.
2. **Settings và chạy thủ công:** lưu engine/lịch/quyền và audit có version; thiết kế dispatch/locks, phân biệt manual và scheduled, từ chối trùng việc, không thay barrier hoặc daily ledger. Test scheduling với JST, late boot, xung đột, thay đổi giờ, idempotency khi người dùng click lặp.
3. **Codex adapter:** kiểm nguồn quota rolling 5 giờ từ môi trường worker trước; nếu không có phương pháp an toàn và có thể kiểm thử thì **NO-GO cho automated Codex**. Sau đó tích hợp CLI Windows có sandbox, model/effort đã chốt, batching/retry/resume, output validation, source CAS, overwritten title+short, warning/history và chu kỳ 300/ngày. OpenRouter behavior regression giữ nguyên.
4. **Sync compatible:** cập nhật quy tắc đồng bộ tên có revision và xác minh end-to-end, không ảnh hưởng detail, không phá ledger hoặc nguồn Amazon. Mọi thay đổi DB local/VPS phải được đối chiếu schema live read-only trước, migration additive/test trên DB disposable, backup/restore rehearsal và **phê duyệt riêng** trước khi sửa DB đang hoạt động.
5. **Nghiệm thu:** parser WinForms PowerShell 5.1, static desktop/sync/supervisor tests, backend typecheck và disposable-DB tests; thử các ca quota unknown/<20%, warning overwrite, JSON hỏng, source đổi giữa chừng, short null, 300 giới hạn, manual trùng job, VPS giữ tên cũ, crash giữa DB commit/log, stale snapshot; test GUI thật riêng và ghi nhận cái gì chưa xác minh. Không tự restart supervisor (có thể auto-reload khi sửa code), không push/deploy.

**Phân công gợi ý:** Chat On Steroids chịu trách nhiệm thiết kế, UI, tích hợp, kiểm thử, commit các milestone đã xác minh; Codex CLI chỉ nhận các phần khó có phạm vi độc lập như adapter/provider, source-safe persistence và review logic sync. Đọc lại diff + test độc lập trước mỗi commit. Không thêm chức năng chưa được chốt.

## 6. Vấn đề kỹ thuật chưa được chứng minh, không phải câu hỏi mới cho người dùng

1. Worker Node có thể xác thực và gọi **`account/rateLimits/read`** bằng chính Codex profile khi **không chạy trong phiên Chat On Steroids** hay không? Giao diện đã được tài liệu hóa, nhưng thử nghiệm thực tế trên worker hiện **chưa có**; fallback phải là khóa Codex (17A), không ước lượng từ token.
2. Schema live của hệ thống ghi lịch sử/campaign có sẵn đến đâu? Không suy từ SQL file; chỉ nghiên cứu **read-only**, xin phê duyệt riêng nếu cần schema/data migration.
3. Phải đo “đã dịch lại trong chu kỳ” bằng generation/last-success để tránh đếm trùng qua ngày, nhưng quy tắc ưu tiên tên mới/lỗi có thể lấn hết 300 slot trong ngày khi backlog lớn. Hiển thị backlog thật; không hứa mỗi ASIN đều được dịch lại trong một số ngày cố định.
4. Bộ kiểm tra cảnh báo hiện dùng cơ chế throw-on-first-error. Muốn “log mọi warning” cần tập hợp lỗi độc lập; log phải gắn commit thực tế, không giả báo published khi insert/update chưa thành công.

**Bằng chứng kiểm tra trước khi ghi plan:** Code hiện tại, `../my-test/CODEX-SCALE-REPORT.md`, 2 lượt Codex CLI read-only; các con số trạng thái ngày 02/11 là snapshot lịch sử. Không chạy worker, dịch, SQL, migration hay sync trong phiên chốt kế hoạch.
