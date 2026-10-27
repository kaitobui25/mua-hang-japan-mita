#!/usr/bin/env bash
# Install as root at /usr/local/sbin/mita-ci-receive (root:root, mode 0755).
# Called by the root-owned /usr/local/sbin/mita-ci-gate (an SSH forced command).
# Arguments: <release-id> <sha256> </tmp/mita-ci-XXXXXXXX.tar.gz>.
set -euo pipefail
umask 027

if [[ "$(id -u)" != 0 ]]; then
  echo 'CI receiver must run as root via its restricted SSH command' >&2
  exit 1
fi
if [[ "$#" != 3 || ! "$1" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?-[0-9a-f]{12}$ || ! "$2" =~ ^[0-9a-f]{64}$ || ! "$3" =~ ^/tmp/mita-ci-[A-Za-z0-9]{8}\.tar\.gz$ ]]; then
  echo 'Invalid CI receiver arguments' >&2
  exit 1
fi
release_id="$1"
expected_sha="$2"
source_archive="$3"
test -f "$source_archive" && test ! -L "$source_archive"
releases=/opt/mita/releases
target="$releases/$release_id"
if [[ -e "$target" || -L "$target" ]]; then
  echo "Release id already used: $release_id" >&2
  exit 1
fi
test -d "$releases"
test -L /opt/mita/current
old_release="$(readlink -f /opt/mita/current)"
if [[ "$old_release" != "$releases/"* || ! -d "$old_release" ]]; then
  echo 'Invalid current Mita release pointer' >&2
  exit 1
fi
systemctl is-active --quiet ekaiwa.service
systemctl is-active --quiet mita-web.service
systemctl is-active --quiet mita-api.service
curl -fsS --max-time 8 http://127.0.0.1:7860/health >/dev/null

stage="$(mktemp -d "$releases/.ci.XXXXXXXX")"
next_link="/opt/mita/.next-$release_id"
activated=0
cleanup() {
  rm -rf -- "$stage"
  if [[ -L "$next_link" ]]; then rm -f -- "$next_link"; fi
}
trap cleanup EXIT
archive="$stage/bundle.tar.gz"
cp -- "$source_archive" "$archive"
test "$(stat -c '%s' "$archive")" -le 268435456 || { echo 'Release artifact exceeds 256 MiB' >&2; exit 1; }
actual_sha="$(sha256sum "$archive" | cut -d' ' -f1)"
test "$actual_sha" = "$expected_sha" || { echo 'Release SHA-256 mismatch' >&2; exit 1; }

# Check paths and links before extraction; an archive cannot write outside release/.
python3 - "$archive" <<'PY'
import posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for item in archive:
        name = posixpath.normpath(item.name)
        if name != 'release' and not name.startswith('release/'):
            raise SystemExit('Archive contains path outside release/')
        if item.issym() or item.islnk():
            path = (posixpath.dirname(name) if item.issym() else '')
            link = posixpath.normpath(posixpath.join(path, item.linkname))
            if link != 'release' and not link.startswith('release/'):
                raise SystemExit('Archive contains link outside release/')
        elif not (item.isfile() or item.isdir()):
            raise SystemExit('Unexpected archive member type')
PY
tar --no-same-owner -xzf "$archive" -C "$stage"
test -f "$stage/release/web/server.js"
test -d "$stage/release/web/.next/static"
test -f "$stage/release/api/dist/server.js"
test -d "$stage/release/api/node_modules/pg"

python3 - "$stage/release/release-info.json" "$release_id" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
version, revision = data.get('version'), data.get('revision')
if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', version):
    raise SystemExit('Invalid version')
if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}', revision):
    raise SystemExit('Invalid revision')
if sys.argv[2] != f'v{version}-{revision[:12]}':
    raise SystemExit('Revision/version mismatch')
PY

rm -f -- "$archive"
chown -R mita:mita "$stage/release"
mv -- "$stage/release" "$target"
chmod 755 "$target" "$target/web" "$target/api"

activate_release() {
  local destination="$1"
  ln -s -- "$destination" "$next_link"
  mv -Tf -- "$next_link" /opt/mita/current
  systemctl restart mita-api.service mita-web.service
}

ready() {
  local http_status
  curl -fsS --max-time 4 http://127.0.0.1:4100/api/health | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True' || return 1
  curl -fsS --max-time 4 http://127.0.0.1:3100/san-pham >/dev/null || return 1
  curl -fsS --max-time 4 http://127.0.0.1:3100/api/catalog?limit=1 >/dev/null || return 1
  http_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 https://mitajapanshop.duckdns.org/admin/login)"
  [[ "$http_status" == 404 ]] || return 1
  http_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 https://mitajapanshop.duckdns.org/api/admin/session)"
  [[ "$http_status" == 404 ]] || return 1
  http_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 https://mitajapanshop.duckdns.org/thanh-toan)"
  [[ "$http_status" == 404 ]] || return 1
  systemctl is-active --quiet ekaiwa.service || return 1
  curl -fsS --max-time 4 http://127.0.0.1:7860/health >/dev/null || return 1
}

activate_release "$target"
activated=1
ok=0
for attempt in {1..12}; do
  if ready; then ok=1; break; fi
  sleep 2
done
if [[ "$ok" != 1 ]]; then
  echo 'New Mita release unhealthy: reverting Mita services to previous release' >&2
  activate_release "$old_release" || true
  exit 1
fi

printf 'Mita release complete: %s\n' "$release_id"
