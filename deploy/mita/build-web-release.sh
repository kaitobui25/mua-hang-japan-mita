#!/usr/bin/env bash
# Run from an Ubuntu/Linux build checkout using the same CPU architecture as Hermes.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo 'Build the VPS artifact in Linux (Ubuntu CI or WSL2 Linux filesystem), not Windows.' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Node.js >=22.12 and npm are required on the Linux build machine.' >&2
  exit 1
fi

node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js >=22.12 required"); process.exit(1); }'
build_arch="$(node -p 'process.arch')"
if [[ -z "${MITA_TARGET_ARCH:-}" || "$build_arch" != "$MITA_TARGET_ARCH" ]]; then
  echo "Set MITA_TARGET_ARCH to the VPS Node architecture ($build_arch on this builder; e.g. x64 or arm64)." >&2
  exit 1
fi

release_id="${MITA_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)}"
if [[ ! "$release_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo 'MITA_RELEASE_ID must use only letters, digits, dots, underscores and hyphens.' >&2
  exit 1
fi

artifact_dir="${MITA_ARTIFACT_DIR:-$repo_dir/.verification/mita-artifacts}"
archive="$artifact_dir/${release_id}-web-linux-${build_arch}.tar.gz"
if [[ -e "$archive" || -e "$archive.sha256" ]]; then
  echo "Release artifact already exists: $archive" >&2
  exit 1
fi

echo "Building read-only Mita web for Linux/$build_arch (release $release_id, API proxy 127.0.0.1:4100)"
npm ci
npm run lint
API_PORT=4100 NEXT_PUBLIC_READ_ONLY=1 PUBLIC_READ_ONLY=1 NEXT_BUILD_DIR=.next NEXT_TELEMETRY_DISABLED=1 npm run build

if [[ ! -f .next/standalone/server.js || ! -d .next/static ]]; then
  echo 'Next standalone server.js or .next/static is missing.' >&2
  exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/web/.next"
cp -a .next/standalone/. "$staging/web/"
cp -a .next/static "$staging/web/.next/static"
if [[ -d public ]]; then
  cp -a public "$staging/web/public"
fi

mkdir -p "$artifact_dir"
tar -C "$staging" -czf "$archive" web
(
  cd "$artifact_dir"
  sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256"
)
echo "Created $archive"
echo "Created $archive.sha256"
