#!/usr/bin/env bash
# Root-owned; forced SSH command for the single GitHub Actions deploy key.
# Runs as ubuntu without sudo. Receives an archive through SSH stdin, then
# passes its closed file to the root-owned, validation-only release receiver.
set -euo pipefail
umask 077
request="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$request" =~ ^deploy\ (v[0-9]+\.[0-9]+(\.[0-9]+)?-[0-9a-f]{12})\ ([0-9a-f]{64})$ ]]; then
  echo 'Unsupported CI SSH command' >&2
  exit 1
fi
release_id="${BASH_REMATCH[1]}"
expected_sha="${BASH_REMATCH[3]}"
archive="$(mktemp /tmp/mita-ci-XXXXXXXX.tar.gz)"
trap 'rm -f -- "$archive"' EXIT
cat > "$archive"
test "$(stat -c '%s' "$archive")" -le 268435456 || { echo 'Archive too large' >&2; exit 1; }
sudo -n /usr/local/sbin/mita-ci-receive "$release_id" "$expected_sha" "$archive"
