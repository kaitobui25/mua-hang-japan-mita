# 11 — Mita Japan: PostgreSQL local 5433, Supervisor recovery, audit bug và kiểm tra thực tế (09/11/2026 JST)

> **Nhật ký lịch sử phiên ChatGPT ngày 09/11/2026, khoảng 10:11 JST.** Đây không phải trạng thái runtime vĩnh viễn hay quyền tự khởi động dịch vụ, chạy lại job, ghi database, migration, sync VPS, deploy. Khi tiếp tục, đọc `AGENTS.md`, kiểm tra Git diff/process/database/log/ledger thực tế trước khi hành động.

## 1. Yêu cầu và quyết định của người dùng

1. Điều tra vì sao PostgreSQL riêng của Mita tại `127.0.0.1:5433` liên tục từ chối kết nối `ECONNREFUSED`; phối hợp `codex-cli-control` qua Chat On Steroids Core — `mana-phong`. Giai đoạn điều tra chỉ đọc, không sửa code.
2. Yêu cầu gọi **Codex CLI gpt-6.1-sol, reasoning medium** để áp dụng `/diagnosing-bugs`, kết luận duy nhất 1–2 dòng về nguyên nhân. Phiên Codex đã thực thi.
3. Hỏi Supervisor cũ/mới khác nhau ở đâu và bản mới cập nhật khi nào; kiểm tra Git diff, mốc thời gian file và PID.
4. Hỏi vì sao sau khởi động lại Windows, PostgreSQL 5433 dường như không khởi động; đối chiếu Windows boot, Task Scheduler, PostgreSQL và Supervisor.
5. Đưa hai dòng FAIL của `MITA JAPAN — KIỂM TRA HẰNG NGÀY | 2026-11-09 JST`: (i) PostgreSQL “Sai danh tính …”; (ii) VPS không có daily sync ledger. Yêu cầu **chỉ tìm hiểu không sửa code** ở giai đoạn này.
6. Sau khi xác định nguyên nhân, người dùng **đổi yêu cầu, cho phép sửa riêng bug PostgreSQL FAIL**, chạy test và chạy audit thật, kết luận ngắn. Chỉ dùng audit **read-only** để không tạo thêm đơn QA.
7. Cuối phiên yêu cầu **summary session và ghi vào `.agents/chatgtplog/`**, tức file này.

Repository Windows: `C:\phong\AI\web\mita-japan\mua-hang-japan-mita`; connector workdir: `/ai/web/mita-japan/mua-hang-japan-mita`; múi giờ: Asia/Tokyo. DB Mita local là cổng **5433**, khác dịch vụ PostgreSQL Windows cổng **5432**; cổng **15432** dành cho tunnel VPS, không phải local DB.

## 2. Kết luận điều tra PostgreSQL ECONNREFUSED (đã đối chiếu Codex)

**Hai tầng nguyên nhân riêng:**

- **PostgreSQL bị ngắt:** log `backend/.local-postgres.log` ghi exit `C000013A` (Windows `STATUS_CONTROL_C_EXIT`, dạng sự kiện console/control) vào **06/11/2026 18:47:00.176 JST** và **08/11/2026 08:26:03.765 JST**. PostgreSQL lần lượt dừng các process; port 5433 ngừng lắng nghe; Supervisor bắt đầu ghi `database_unavailable ECONNREFUSED` lúc **06/11 18:47:09.515** và **08/11 08:26:21.065 JST**. **Không xác định được chính xác người/chương trình gửi sự kiện console**, không quy trách nhiệm cho thao tác người dùng, Task Scheduler hay ứng dụng cụ thể khi chưa có telemetry.
- **Không tự khôi phục và lỡ lịch:** tiến trình Supervisor cũ khởi chạy **06/11 08:16 JST**, trước khi source được cập nhật. Tại nhánh lỗi `activeLocks()`, bản cũ chỉ `record('database_unavailable',…); return;`, không gọi `pg_ctl` để khôi phục DB. Task Scheduler `MitaJapan-LocalWorkers` có trigger **AtLogOn**, không phải lịch 04:00; khi DB ngừng giữa phiên thì không có cơ chế độc lập tái khởi động. Mất DB qua các cửa sổ Amazon 04:00, Names 05:00, Detail 05:15; đồng bộ VPS bị bỏ qua và không tự chạy bù theo thiết kế.

Codex CLI: helper `%APPDATA%\chat-on-steroids\skills\codex-cli-control\Invoke-Codex.ps1`, Action `run`, `-Model gpt-6.1-sol -Json -UnelevatedSandbox` (cấu hình `model_reasoning_effort = "medium"`), read-only, hoàn tất `turn.completed` và exit 0; **thread `01a1bdb8-0630-7573-beaa-55fffa74db6a`**. Codex đã kiểm tra lịch sử log, Git, scheduler, replay tối thiểu chỉ trong bộ nhớ. Loop replay đọc log cho hai sự cố: **6703** và **4265** bản ghi `database_unavailable/ECONNREFUSED` trong hai khoảng DB ngừng; kiểm chứng sự vắng mặt của nhánh recovery trong Supervisor lịch sử. Có một số lệnh kiểm tra Codex gặp hạn chế quyền/quoting, nhưng replay cuối chạy thành công; các thông tin Windows/Task đã được trợ lý xác nhận độc lập qua connector.

**Mốc khởi động Windows 09/11**:

| JST | Quan sát |
|---|---|
| 08:12:45 | Windows boot (`Win32_OperatingSystem.LastBootUpTime`, System event) |
| 08:13:18 | Task Scheduler `MitaJapan-LocalWorkers` chạy, LastTaskResult 0 |
| 08:13:43 | PostgreSQL Mita process bắt đầu listen 127.0.0.1:5433 |
| 08:14:16.548 | Kết thúc crash recovery/WAL; PostgreSQL sẵn sàng nhận kết nối |
| 08:14:23–08:14:25 | Supervisor mới PID **25616** khởi chạy và ghi `supervisor_started` |

**Lưu ý:** Không đúng khi nói PostgreSQL *không hề khởi động sau reboot*. Nó được `scripts/start-mita-on-boot.ps1` khởi động trước Supervisor, nhưng **quá muộn so với 04:00/05:00/05:15**. Reboot lúc 08:12 **không phải** nguyên nhân ban đầu của sự cố DB từ ngày 08/11; Supervisor cũ vẫn ghi lỗi liên tục sáng sớm 09/11.

## 3. Khác biệt Supervisor cũ và mới

- Bản trong Git commit **`15c7ba4` ngày 05/11/2026 13:43 JST** chưa có recovery.
- File làm việc `scripts/mita-supervisor.mjs` có **LastWriteTime 08/11/2026 05:28:14 JST**, diff chưa commit **36 dòng thêm, 1 dòng thay** (theo kiểm tra session).
- Bản mới thêm `canRecoverMitaPostgres()` và `recoverMitaPostgres()`, chỉ khi lỗi **`ECONNREFUSED`** và URL đúng cluster Mita local; kiểm tra `PG_VERSION=18`, `pg_ctl status` trước khi `pg_ctl start`, log `database_recovery_starting/started/failed`, giới hạn **1 lần/60 giây**, không chạy bù job.
- Supervisor cũ đã chạy từ **06/11**, không tự tải lại mã vừa sửa hôm 08/11; tiến trình mới khởi động **09/11 08:14**, PID **25616**, sau khi PostgreSQL đã sẵn sàng. **Chưa có bằng chứng kiểm thử khi DB thật sự sập cho thấy nhánh recovery mới thành công.**
- File Supervisor mới **đã sửa nhưng chưa commit**; không tự commit/restart, tránh đụng thay đổi khác.

## 4. Điều tra PostgreSQL FAIL trong audit và sửa đúng một dòng

Thông báo người dùng đưa:

```text
[FAIL] PostgreSQL Mita (5433) chưa hoạt động hoặc chưa thể kiểm tra.
Nguyên nhân: Sai danh tính PostgreSQL local (tên database, user, địa chỉ hoặc cổng).
```

**Phát hiện:** PostgreSQL vẫn đang chạy đúng `backend/.local-db`, PID **24336**, executable `C:\Program Files\PostgreSQL\18\bin\postgres.exe`, listener `127.0.0.1:5433`; truy vấn read-only trên DB `postgres` với role `mita_local` trả:

```text
current_database=postgres
current_user=mita_local
inet_server_addr()::text=127.0.0.1/32
host(inet_server_addr())=127.0.0.1
inet_server_port()=5433
```

Ở `scripts/mita-daily-audit.mjs` dòng ~95, SQL snapshot đặt `host = inet_server_addr()::text`, còn dòng ~156 kiểm tra host phải bằng `127.0.0.1` hoặc `::1`. PostgreSQL trả `127.0.0.1/32`, khiến kiểm tra sai dù DB kết nối bình thường. Thông báo “chưa hoạt động” chỉ là nhãn chung khi lỗi ở `checkLocal()`.

**Đã sửa đúng 1 dòng** trong `scripts/mita-daily-audit.mjs`:

```diff
- inet_server_addr()::text AS host
+ host(inet_server_addr()) AS host
```

Không sửa điều kiện kiểm tra identity, không sửa schema, migrations, Supervisor, Task Scheduler, DB hay VPS.

**Kiểm thử thực hiện:**

1. Trước fix: `psql` read-only xác nhận `127.0.0.1/32` và phép so sánh cũ cho `FAIL` dù query thành công.
2. `node.exe --check scripts/mita-daily-audit.mjs` — PASS.
3. `node.exe scripts/mita-daily-audit.mjs --self-test` — PASS; fixture JST/key/schema/index, checkout mô phỏng; không gọi DB thật, HTTP, SSH hay gửi checkout thật.
4. `git diff --check -- scripts/mita-daily-audit.mjs` — PASS (cảnh báo LF/CRLF không phải lỗi).
5. **Chạy audit thực tế nhưng chỉ đọc**:
   `'' | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/mita-daily-audit.ps1 -ReadOnly`
   - **[OK] Kết nối PostgreSQL Mita 127.0.0.1:5433/postgres**
   - **[OK] Schema local và các index theo hợp đồng**
   - **[OK] PostgreSQL VPS mita và schema VPS**
   - Checkout QA ngày đó **đã tồn tại**, chỉ đối chiếu, **không tạo lại**; không ghi PII hoặc mã đơn vào nhật ký này.
   - **Tổng: 7 OK, 6 WARN, 1 FAIL; exit code 1**, không phải lỗi PostgreSQL: FAIL còn lại là **VPS sync ledger ngày 09/11 chưa có**. Không thể tuyên bố toàn audit đạt.

## 5. Vì sao VPS daily sync FAIL?

`scripts/mita-daily-audit.mjs` truy vấn `catalog_sync_ledger WHERE sync_day='2026-11-09'` rồi yêu cầu đúng một dòng. Trợ lý độc lập dùng SSH + `psql` trong transaction READ ONLY; truy vấn hoàn thành exit 0, **0 dòng** cho ngày đó.

`.agents/runtime/mita-daily-2026-11-09.json` ghi:

| Hạng mục | State |
|---|---|
| Amazon 04:00 | `skipped` |
| Names 05:00 | `skipped` |
| Detail 05:15 | `skipped` |
| VPS sync | `skipped` |

**Hai FAIL khác nguyên nhân**: “PostgreSQL danh tính sai” là **bug audit đã sửa**; VPS thiếu daily sync ledger là **trạng thái job/sync thực tế**, không thể giải quyết bằng sửa host IP. Không có yêu cầu hoặc quyền chạy bù các worker/VPS sync; policy không tự catch-up.

## 6. Trạng thái bàn giao và lưu ý tiếp tục

- **Đã sửa và test thành công bug PostgreSQL FAIL.** File `scripts/mita-daily-audit.mjs` đang **modified, chưa commit** tại thời điểm kiểm tra. Không push/deploy/migrate/restart.
- `scripts/mita-supervisor.mjs` **đã modified từ trước**; phải bảo toàn thay đổi. Các file untracked `.agents/chatgtplog/06–10`, kế hoạch, thiết kế/logo, báo cáo… là công việc khác; **không stage hàng loạt**.
- **VPS daily sync ngày 09/11 chưa có ledger**, 4 việc buổi sáng đã skipped. Không tự chạy bù hoặc viết ledger giả.
- Cần kiểm chứng riêng cơ chế DB recovery Supervisor mới bằng test an toàn không làm gián đoạn PostgreSQL live; muốn tác động process/service thật cần quyền và đánh giá trạng thái trước.
- Khi muốn commit fix có thể stage đúng `scripts/mita-daily-audit.mjs` và file nhật ký này, nhưng **chưa commit theo yêu cầu summary-only hiện tại**.
- Việc tạo nhật ký này không thay đổi hành vi hệ thống; ở lần kiểm tra trước khi ghi, `.agents/chatgtplog/` đã có 01–10, file 11 chưa tồn tại.

## 7. Điểm tra cứu

- `AGENTS.md` — quy tắc dự án và ranh giới thao tác DB.
- `scripts/mita-daily-audit.mjs:94–100,143–167,318–335,402–445` — SQL identity, điều kiện, reporter, VPS ledger.
- `scripts/mita-daily-audit.ps1:15–52,103–153` — xác minh PostgreSQL owner, cờ VERIFIED và wrapper `-ReadOnly`; file kết thúc chờ Enter.
- `scripts/mita-supervisor.mjs:39–78,507–515` — recovery mới chưa commit và nhánh lỗi Supervisor.
- `scripts/start-mita-on-boot.ps1`, `scripts/register-mita-boot.ps1` — PostgreSQL được khởi động khi logon Windows.
- `backend/.local-postgres.log`, `.agents/runtime/mita-supervisor.jsonl`, `.agents/runtime/mita-daily-2026-11-09.json` — bằng chứng lịch sử runtime.
- `git show 15c7ba4:scripts/mita-supervisor.mjs` và `git diff -- scripts/mita-supervisor.mjs` — so sánh phiên bản.
