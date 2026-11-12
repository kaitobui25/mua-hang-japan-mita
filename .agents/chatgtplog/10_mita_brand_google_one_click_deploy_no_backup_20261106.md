# 10 — Mita Japan: logo, Google Search, One-Click Deploy và quyết định không backup (06/11/2026)

> **Nhật ký lịch sử của phiên làm việc ngày 06/11/2026 JST**, không phải bằng chứng về runtime hoặc bản production ở thời điểm đọc. Trước khi làm tiếp cần kiểm tra Git, database, dịch vụ, GitHub Actions và website thực tế. Tài liệu này **không phải quyền tự thực hiện migration, push, deploy hoặc backup**.

## 1. Mục tiêu và yêu cầu của người dùng

1. Thực hiện kế hoạch thay logo Mita Japan bằng biểu tượng chữ **m** xanh rêu có lá cây; phối hợp Codex CLI và connector Chat On Steroids Core mana-phong.
2. Làm rõ quy trình khởi động website local rồi **tạo một BAT nhấp đúp** gọi scripts/start-local.ps1, để chạy PostgreSQL local (5433), migration, backend (4000), Next.js (3000), cùng các thành phần do script khởi động.
3. Google Search cần hiện tên **Mita Japan** và favicon logo mới, **không còn tên Duck DNS** và icon mặc định. Người dùng yêu cầu lập plan và phối hợp Codex CLI sửa local.
4. Khi One-Click Deploy thất bại, ban đầu yêu cầu giải thích nguyên nhân; sau đó nhấn mạnh thiết kế **một cú nhấp tự làm toàn bộ công việc**, không bắt người vận hành chạy migration riêng. Trong lượt điều tra người dùng nói **“chỉ tìm hiểu không sửa code”**; assistant chỉ đọc ở giai đoạn đó.
5. Sau điều tra, người dùng cho phép **“phối hợp cùng codex-cli-control để làm 1 click lam het”**: triển khai sửa luồng One-Click và test.
6. **Quyết định cuối cùng, khẳng định lại ngày 06/11/2026:** “**giữ chính sách không backup**”. One-Click không tạo backup/dump và không yêu cầu backup làm điều kiện tiên quyết. Cần giữ nguyên các rào an toàn và ghi rõ mất khả năng phục hồi dữ liệu sau commit.
7. Cuối cùng, người dùng yêu cầu **“summary session này và ghi vào chatgptlog”**: tạo chính file này, không chỉ trả lời tóm tắt bằng chat.

## 2. Repository và phân biệt local/production

- Windows repository: C:\phong\AI\web\mita-japan\mua-hang-japan-mita.
- CoS workdir: /ai/web/mita-japan/mua-hang-japan-mita.
- Git branch: main; HEAD khi chuẩn bị log: **bbbb54b**. Tracked working tree sạch trong lần kiểm tra trước khi tạo log.
- Local: Next.js http://127.0.0.1:3000; Fastify backend 127.0.0.1:4000; PostgreSQL local 127.0.0.1:5433. Cổng 15432 chỉ là SSH tunnel tạm tới PostgreSQL VPS, **không phải local DB**.
- Production: https://mitajapanshop.duckdns.org/; GitHub repository kaitobui25/mua-hang-japan-mita.
- Những commit trong các mục tiếp theo đều là **commit local**. Trong các tác vụ assistant của phiên này **không git push, không deploy VPS, không tự chạy migration/sync VPS và không gửi yêu cầu thu thập lại trên GSC**. Người dùng từng tự chạy một lượt One-Click thất bại (mục 5).
- Rất nhiều file untracked có sẵn từ các phiên khác, gồm .agents/chatgtplog/06–09, các plan 14/15/17/18/19, nhiều mẫu logo, các file GSC và reports. Giữ nguyên, không add hàng loạt.
- Không suy ra trạng thái các process hiện tại từ kết quả kiểm thử ở đầu ngày.

## 3. Đổi logo và icon Mita Japan — commit 03ff1ff

- Ảnh được chọn: designs/assets/logo/chatgpt-01-m-leaf.png (PNG gốc 1024×1024): nền kem, chữ m xanh rêu, hai lá cây, điểm nhấn cam.
- Derivative đã tạo:
  - public/brand/mita-mark.png — PNG 256×256.
  - src/app/icon.png — PNG 64×64 cho favicon Next.js App Router.
  - src/app/apple-icon.png — PNG 180×180 cho thiết bị Apple.
- Đã sửa src/components/layout/header.tsx và footer.tsx để đặt ảnh logo cùng wordmark hiện tại “mitajapan.” và giữ link về trang chủ, accessibility và hành vi menu.
- Đã sửa src/app/globals.css để căn logo và responsive ở desktop/mobile; giữ nhận diện Hallmark Garden.
- Plan: .agents/plan/20_mita_brand_icon_logo_local_20261106.md.
- Kiểm tra: npm run lint, git diff --check PASS; GET /, /gio-hang, /mua-ho-amazon, các URL icon/brand trên local HTTP 200; kiểm tra BrowserOS Neo các kích thước 320/375/768/1440 và link header/footer. Codex CLI review độc lập không tìm thấy lỗi cần sửa.
- Khi chỉ frontend chạy và backend chưa chạy, /san-pham từng HTTP 500 vì thiếu API port 4000; đây **không phải** lỗi do logo.
- Commit local: **03ff1ff feat: adopt Mita leaf brand mark and browser icons**. Không push/deploy.

## 4. Launcher khởi động local — đã tạo nhưng chưa commit

- File mới ở root: start-mita-local.bat (trong lần Git status cuối vẫn **untracked**).
- Nhấp đúp file sẽ cd về root từ %~dp0, gọi PowerShell 5.1 bằng -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1, kiểm tra exit code, báo lỗi và pause nếu thất bại.
- Nếu script thành công, BAT mở http://127.0.0.1:3000 và giữ cửa sổ để đọc kết quả; có hướng dẫn stop qua scripts/stop-local.ps1.
- Đã kiểm tra tĩnh đường dẫn, xử lý lỗi, tồn tại của script được gọi và URL mở browser.
- **Chưa chạy BAT thật** vì scripts/start-local.ps1 có thể migration database và khởi động worker/supervisor. Không được ghi “đã nghiệm thu chạy local đầy đủ”.

## 5. Tên website và favicon trên kết quả Google — commit 343235f

### Kết quả điều tra public trước khi sửa

- Ảnh Google Search do user cung cấp hiển thị **Duck DNS** và icon mặc định.
- GET https://mitajapanshop.duckdns.org/ trả HTTP 200, nhưng HTML public lúc đó thiếu WebSite JSON-LD, og:site_name và link icon mới.
- GET /icon.png và /brand/mita-mark.png trên public lúc đó đều **404**: các icon đã có ở local nhưng chưa được phát hành.
- robots.txt public HTTP 200, cho phép crawl đường dẫn / và khai báo sitemap.
- Không được khẳng định Google sẽ chắc chắn đổi tên và favicon: Google quyết định hiển thị sau các lượt crawl, có thể mất nhiều ngày/tuần.

### Source local đã sửa qua Codex CLI

- src/app/layout.tsx: chuẩn hóa brand title, applicationName và openGraph.siteName = “Mita Japan”. Tránh áp OG title/description của homepage lên mọi trang con; giữ metadataBase, robots và canonical đã có.
- src/app/(store)/page.tsx: thêm đúng **một** JSON-LD WebSite trên homepage:
  - @context: https://schema.org
  - @type: WebSite
  - name: Mita Japan
  - alternateName: mitajapan
  - url: https://mitajapanshop.duckdns.org/
- Giữ src/app/icon.png và apple-icon.png theo Next.js file convention, không thêm link icon trùng.
- Plan: .agents/plan/21_mita_google_site_name_favicon_20261106.md.
- Kiểm thử local: homepage có đúng 1 WebSite schema; /mua-ho-amazon và /admin/login không có schema WebSite dư; og:site_name và icon links có mặt; hai icon local HTTP 200; npm run lint và git diff --check PASS.
- Commit local: **343235f feat: add Mita Japan Google site name metadata**. Chưa push/deploy; chưa xác minh Google SERP thay đổi.

## 6. Lỗi One-Click thực tế người dùng gửi — không phát hành thành công

Người dùng gửi log chạy deploy lúc **2026-11-06T10:56:27.1642066+09:00**.

- Pinned HEAD: **343235f6953fda865d15b36189b4ac3cdb7af55c**.
- GitHub authentication, fetch origin main và check commit history: OK.
- Local schema migration: “Mita database schema applied”.
- SSH tunnel đến PostgreSQL VPS: OK.
- Đã chạy title revision migration, log “VPS_TITLE_REVISION_MIGRATION_OK”.
- BEFORE counts: categories 2/2; products 832/832; product_details 831/831; product_translations 832/832; product_title_presentations **local 632 / VPS 649**; local_detail_translations 828/828; local_detail_translation_items 12701/12701; price_observations 1581/1581; product_detail_queue 834/834; product_images 3989/3989. Chênh lệch title presentations **không phải nguyên nhân trực tiếp**.
- Lỗi chính xác:
    SYNC_FAILED Deploy ledger is missing; run reviewed migrate-vps-deploy-ledger.mjs --apply separately
    [DEPLOY FAILED] VPS catalog --deploy-apply failed; code release NOT pushed
    [ERROR] Deployment or verification failed. Exit code: 1
- Không được mô tả lượt deploy này là success; code không được push trong lượt đó.

### Root cause

- Commit **0d2c8cb**, 06/11/2026 08:42 JST, thêm cơ chế ledger per-run catalog_deploy_ledger để cho phép One-Click chạy nhiều lần cùng ngày.
- backend/scripts/sync-catalog-vps.mjs, function reserveTransfer, dùng to_regclass để xác định bảng và **dừng** khi chế độ deploy không thấy catalog_deploy_ledger.
- Nhưng scripts/deploy-one-click.ps1 ở nhánh bình thường lúc đó chỉ chạy migration title revisions trước sync; migration ledger chỉ tồn tại trong -MigrationsOnly. Đây là regression trong orchestration.
- Assistant ban đầu đề xuất user chạy thêm -MigrationsOnly; người dùng phản đối vì trái thiết kế một cú nhấp.
- Lượt kế tiếp người dùng chỉ cho phép điều tra. Đã đọc docs/hermes-vps-runbook.md, docs/mita-workers-runbook.md, deploy/mita/ci-deploy.md, lịch sử Git, **không sửa code** trong lượt đó.
- Tìm thấy drift: tài liệu ngày 28/10 mô tả One-Click tự làm toàn bộ kể cả tạo commit; ngày 05/11 commit **4c463c0** đổi để chỉ phát hành HEAD đã commit, không tự git add -A; ngày 06/11 commit 0d2c8cb thêm prerequisite ledger chưa nối vào nhánh chính.

## 7. Sửa One-Click bằng Codex CLI — commit 6971b22

Sau khi user cho phép implement, assistant phối hợp Codex CLI qua helper:
%APPDATA%\chat-on-steroids\skills\codex-cli-control\Invoke-Codex.ps1.
Codex CLI đã đăng nhập, version 0.161.0; thread sửa One-Click: **01a1aea3-6684-7441-b112-3c84618deb7d**.

### Source thay đổi

- scripts/deploy-one-click.ps1 thêm function **PrepareDeployLedger([string]$migrationMode)**, được gọi sau khi SSH tunnel đúng ownership sẵn sàng và trước --deploy-apply.
- Hàm chạy reviewed migration tool backend/scripts/migrate-vps-deploy-ledger.mjs --dry-run, đọc JSON preflight nghiêm ngặt (state dry_run, ledger null hoặc tên bảng mong đợi).
- Nếu bảng tồn tại: **skip DDL**.
- Nếu bảng thiếu và -DryRun: chỉ thông báo, không ghi.
- Nếu bảng thiếu và One-Click thực chạy: gọi **--apply** một lần. Migration sẵn có dùng CREATE TABLE IF NOT EXISTS trong transaction, lock_timeout 5s, kiểm tra database tên mita và endpoint SSH-forward 127.0.0.1:15432/mita. Không DROP/TRUNCATE ledger, không bỏ qua writer/source/claim guards.
- Nếu preflight thất bại, JSON lạ, mode sai, hoặc migration lỗi: **dừng trước sync/push/release**.
- Giữ hoạt động -MigrationsOnly, -DryRun và title revision migration.
- Không tự git add -A hay auto-commit; chỉ push **HEAD đã commit** và theo dõi GitHub Actions được khóa bằng SHA + request ID, giữ chống race/force-with-lease.
- scripts/test-mita-one-click-deploy-static.ps1 bổ sung test PowerShell 5.1 với node.exe mocked: schema missing/existing, chạy migration một lần, dry-run chỉ đọc, lỗi JSON, output không hợp lệ/trùng field, lỗi process, thứ tự preflight/sync, pinned SHA, exact CI run.
- Cập nhật docs/mita-workers-runbook.md, docs/hermes-vps-runbook.md, deploy/mita/ci-deploy.md cho flow hiện hành.

### Validation

- powershell.exe -NoProfile -File scripts/test-mita-one-click-deploy-static.ps1 — PASS.
- powershell.exe -NoProfile -File scripts/test-mita-sync-control-static.ps1 — PASS.
- node --test backend/scripts/sync-deploy-ledger.test.mjs backend/scripts/sync-policy.test.mjs — **26/26 PASS**.
- git diff --check — PASS.
- Codex review riêng xác nhận phần migration helper fail closed/skip DDL hợp lý, nhưng báo rủi ro về policy backup lúc đó chưa được giải quyết (mục 8).
- Commit local: **6971b22cd957aca56caffdec552f522291714d87**, “fix(deploy): bootstrap One-Click ledger before VPS sync”.
- **Chưa thử end-to-end với PostgreSQL VPS, GitHub push, Actions hoặc website production.** Các test đều read-only/mock, không phải nghiệm thu live.

## 8. Chính sách backup — quyết định cuối cùng, commit bbbb54b

### Xung đột phát hiện

- Quyết định owner trước đây ngày 27/10 trong .agents/plan/06_mita_hermes_vps_postgresql_grill_plan.md: **không backup**.
- AGENTS.md và docs/mita-workers-runbook.md sau đó có yêu cầu verified restorable backup cho migration production, dẫn đến Codex review báo P1 về automatic DDL.
- Người dùng trực tiếp chốt ngày 06/11: **“giữ chính sách không backup”**.

### Đã cập nhật tài liệu

- AGENTS.md: One-Click không tạo backup/dump và không yêu cầu backup. Người dùng chủ động nhấp deploy-one-click.bat cho phép **các bước đã định nghĩa rõ**, gồm migration additive/idempotent riêng cho catalog_deploy_ledger; các thao tác database khác cần phê duyệt riêng. Không mở rộng tự động sang arbitrary VPS DDL.
- docs/mita-workers-runbook.md: bỏ mô tả policy còn xung đột; xác nhận preflight ledger và conditional migration, không backup.
- docs/hermes-vps-runbook.md: xác nhận không backup/dump; rollback transaction chỉ trước commit.
- deploy/mita/ci-deploy.md: đồng bộ One-Click và không có backup prerequisite.
- Giữ DB identity, SSH tunnel ownership, SQL/lock scope, writer advisory lock, ledger guards, fail-closed.
- Nguy cơ đã nêu rõ: nếu lỗi được phát hiện sau DB commit, không có bản backup do One-Click tạo để khôi phục dữ liệu trước đó.
- Test sau chỉnh tài liệu: One-Click PS static PASS; node --test backend/scripts/sync-deploy-ledger.test.mjs **9/9 PASS**; git diff --check PASS.
- Commit local: **bbbb54b docs(deploy): confirm One-Click no-backup policy**. Đây là Git HEAD khi chuẩn bị nhật ký này.

## 9. Trạng thái triển khai và các giới hạn chưa được giải quyết

- **Đã làm/đã commit local:** logo, favicon, metadata Google, One-Click ledger auto-preparation, test, docs no-backup.
- **Đã tạo local nhưng chưa commit:** start-mita-local.bat.
- **Chưa push/deploy:** các commit 03ff1ff, 343235f, 6971b22, bbbb54b chưa được assistant phát hành lên GitHub/VPS trong session này.
- **Chưa xác nhận One-Click end-to-end** sau fix. Một lần user chạy trước fix đã FAILED do thiếu catalog_deploy_ledger.
- **Không khẳng định production đã có icon và SEO mới**, không khẳng định Google đã hiện tên Mita Japan. Trước deploy, /icon.png và /brand/mita-mark.png production trả 404.
- **Giới hạn UX còn lại:** người dùng muốn “một cú nhấp làm hết”, nhưng One-Click bảo vệ Git bằng cách chỉ phát hành HEAD đã commit; **không tự gom những file chưa commit** để tránh vô tình đưa các untracked/unfinished files và dữ liệu private lên GitHub. Tài liệu đã ghi rõ; không mô tả phần auto-commit như tính năng hiện có.
- **Không backup:** là quyết định có chủ đích của chủ dự án, không tự đảo ngược hoặc thêm background backup.
- **Không tự chạy nightly worker/migration/deploy**, không làm gì với E-KAIWA, Caddy, admin, checkout hoặc pricing ngoài phạm vi.

## 10. Các commit liên quan (theo thứ tự)

| SHA | Nội dung |
| --- | --- |
| 03ff1ff | feat: adopt Mita leaf brand mark and browser icons |
| 343235f | feat: add Mita Japan Google site name metadata |
| 6971b22 | fix(deploy): bootstrap One-Click ledger before VPS sync |
| bbbb54b | docs(deploy): confirm One-Click no-backup policy |

Các commit nền cần nhớ: **0d2c8cb** (thêm per-run deploy ledger nhưng không wire normal migration), **4c463c0** (pin committed SHA, không auto-stage/commit), **312a764/515c337** (cải tiến SEO sitemap/landing trước đó).

## 11. Khi tiếp tục công việc

1. Trước thao tác cần đọc AGENTS.md mới và kiểm tra git status, HEAD, port ownership, current VPS schema/ledger với truy vấn chỉ đọc phù hợp.
2. Nếu người dùng muốn chạy One-Click thật: kiểm tra source đã commit, các scripts khớp SHA, GitHub/SSH/DB prerequisite và trạng thái running/uncertain ledger; áp dụng đúng no-backup policy và chỉ trong phạm vi được user cho phép. Đừng bỏ qua cảnh báo nếu đồng bộ ở trạng thái không xác định.
3. Chỉ khi có log release thành công mới xác nhận GitHub Actions, deployed SHA và website public. Sau đó xác minh favicon/icon HTTP 200 và homepage WebSite schema/og:site_name.
4. Khi public đã phát hành, có thể kiểm tra GSC URL Inspection và theo dõi Google SERP; không hứa thời gian Google đổi tên.
5. File log này không được xem là lệnh tự phát hành, tạo backup, migration, hay sửa code. Những file untracked cũ cần giữ nguyên; khi user chỉ yêu cầu ghi log thì **không commit/push log**.
