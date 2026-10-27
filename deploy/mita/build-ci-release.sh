#!/usr/bin/env bash
# Create one immutable, platform-native web+API release. Runs ONLY on an Ubuntu x64 CI runner.
set -euo pipefail
cd "$(dirname "$0")/../.."
test "$(uname -s)" = Linux
test "$(node -p 'process.arch')" = x64

version="$(node -e 'const r=require("./release.json"); if(typeof r.version!=="string" || !/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(r.version))process.exit(1); console.log(r.version)')"
revision="$(git rev-parse HEAD)"
release_id="v${version}-${revision:0:12}"
artifact_dir="$PWD/.verification/mita-artifacts"
mkdir -p "$artifact_dir"

# CI uses a throwaway PostgreSQL container, never the production database.
npm ci --prefix backend
npm run typecheck --prefix backend
npm test --prefix backend
npm run build --prefix backend
npm prune --omit=dev --prefix backend
node --test scripts/test-vps-selftest.mjs

# Existing reproducible frontend builder sets production/read-only flags at build time.
MITA_RELEASE_ID="$release_id" MITA_TARGET_ARCH=x64 npm run build:release:linux

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/release/api"
tar -C "$staging/release" -xzf "$artifact_dir/${release_id}-web-linux-x64.tar.gz"
cp -a backend/dist backend/node_modules backend/package.json "$staging/release/api/"
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1],JSON.stringify({version:process.argv[2],revision:process.argv[3]},null,2)+"\n")' "$staging/release/release-info.json" "$version" "$revision"

bundle="$artifact_dir/${release_id}-mita-linux-x64.tar.gz"
tar -C "$staging" -czf "$bundle" release
(cd "$artifact_dir" && sha256sum "$(basename "$bundle")" > "$(basename "$bundle").sha256")
echo "RELEASE_ID=$release_id" >> "$GITHUB_ENV"
echo "RELEASE_BUNDLE=$bundle" >> "$GITHUB_ENV"
echo "RELEASE_SHA256=$(sha256sum "$bundle" | cut -d' ' -f1)" >> "$GITHUB_ENV"
echo "Ready: $release_id ($version, $revision)"
