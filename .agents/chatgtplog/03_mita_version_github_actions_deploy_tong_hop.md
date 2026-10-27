# 03 — Mita Japan: version và tự động deploy qua GitHub Actions (27/10/2026)

## Yêu cầu và quyết định
- Chủ dự án **tự quyết định version** trong `release.json` (hiện `"0.3"`, dạng string); website hiển thị **`v0.3` thật nhỏ ở cuối footer**. `package.json` (frontend/backend đang `0.1.0`) không phải nguồn version công khai.
- Đã cân nhắc cờ `deploy: 0/1` rồi GitHub tự reset về 0, nhưng cách đó phát sinh commit ngược về Git, dễ lệch nhánh/conflict PC; Git tag/GitHub Releases có thể dùng nhưng thêm thao tác.
- **Chốt dùng `[deploy]` trong message của commit cuối (HEAD) khi push lên `main`**. Commit thường không deploy; không cần vào giao diện GitHub, không cần reset cờ, không có Git commit tự động từ bot. `workflow_dispatch` chỉ kiểm thử/build, **không deploy**.

## Đã triển khai
- Workflow `.github/workflows/mita-deploy.yml`: chỉ khi `push` `main` với HEAD message chứa đúng `[deploy]` mới test/build/deploy. GitHub Actions chạy **Ubuntu 24.04 x64, Node 22.23.4, PostgreSQL 16 disposable**; backend typecheck + tests + `tsc` build, QA selftests, frontend Next.js standalone build với cờ read-only; đóng gói `web/`, `api/` và `release-info.json` + SHA-256. Script `deploy/mita/build-ci-release.sh` tái sử dụng `build-web-release.sh`.
- Deploy truyền artifact qua SSH bằng key riêng, khóa lệnh ở `authorized_keys` (`/usr/local/sbin/mita-ci-gate`), receiver root-owned `/usr/local/sbin/mita-ci-receive`. Kiểm tra checksum, cấu trúc gói, version/Git SHA; tạo release `/opt/mita/releases/v<version>-<sha12>`, chuyển symlink `/opt/mita/current`, restart **chỉ `mita-api` và `mita-web`**, health check và rollback **code** nếu hỏng. Không build Next trên VPS 1 GiB, không tự migrate/rollback database, không đụng E-KAIWA/Caddy/Hermes Gateway, không tạo backup.
- GitHub repo `kaitobui25/mua-hang-japan-mita` ban đầu rỗng, nay đã push `main` thành công. Ba GitHub Actions secrets đã xác minh tồn tại: `MITA_DEPLOY_SSH_KEY`, `MITA_DEPLOY_HOST`, `MITA_DEPLOY_KNOWN_HOSTS` (không ghi nội dung secret vào tài liệu). Script kích hoạt key từ PC: `scripts/enable-mita-github-deploy.ps1`.
- Version ở `release.json`, giao diện `src/components/layout/footer.tsx` + `src/app/globals.css`. Tài liệu trong `README.md` (mục **Version và phát hành lên VPS Hermes**), `deploy/mita/ci-deploy.md`, `deploy/mita/README.md`, `docs/hermes-vps-runbook.md`.

## Kết quả kiểm chứng thực tế
- Build frontend production và **30/30 backend tests** trên PC đạt; GitHub Actions **build-only** Ubuntu PASS (run `40475633035`), artifact Linux ~27,5 MiB, SHA-256 hợp lệ. Thử forced SSH command không cho thực thi lệnh ngoài danh sách; thử triển khai chính artifact CI xuống Hermes thành công.
- **End-to-end GitHub → VPS đã PASS**: commit `eca2fa1bfa9d…` (`docs: clarify version and deployment [deploy]`) được push, GitHub Actions run **40478008591** `success` (gồm cả SSH deploy, khoảng 2 phút); VPS `/opt/mita/current` trỏ `/opt/mita/releases/v0.3-eca2fa1bfa9d`, `release-info.json` trùng version + SHA. Website HTTPS 200, footer `v0.3`, catalog **122 sản phẩm**, API khỏe; E-KAIWA `0.38`, Caddy/PostgreSQL và các service đều active. Một kiểm thử smoke public sau deploy trước đó PASS.
- Commit tài liệu cuối **`4e4a32f docs: record verified GitHub to Hermes deployment`** đã push; workflow tương ứng **skipped** vì không có `[deploy]`. `git status` sạch, local `main` đồng bộ `origin/main`. GitHub có cảnh báo deprecation Node 20 ở các `actions/*@v4`, **không ảnh hưởng run thành công**; có thể nâng action lên version mới trong một thay đổi bảo trì riêng.

## Cách dùng từ nay
```bash
# Chỉ lưu code trên GitHub, không động VPS:
git add .
git commit -m "Sửa giao diện"
git push origin main

# Yêu cầu GitHub tự build + deploy VPS:
git add .
git commit -m "Release v0.4 [deploy]"
git push origin main
```
Muốn đổi version hiển thị thì sửa `release.json` thành `"version": "0.4"` **trước khi commit `[deploy]`**. Đưa `[deploy]` vào **commit cuối cùng của batch được push**; chỉ thay file local chưa đủ kích hoạt. Version và Git SHA tách biệt: có thể triển khai nhiều commit mang cùng version hiển thị, release ID vẫn khác nhau.

**Giới hạn:** Pipeline chỉ phát hành code frontend/backend, **không tự deploy schema PostgreSQL** và không vận hành worker quét Amazon (worker vẫn ở PC); nên duyệt migration và thay đổi dịch vụ chia sẻ riêng. Quyền sử dụng nội dung Amazon là vấn đề độc lập với CI/CD.
