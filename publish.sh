#!/usr/bin/env bash
# publish.sh - Build the verified release asset and publish it to GitHub.
# Requires: a GitHub token with `repo` scope (env GITHUB_TOKEN or first arg).
#
#   GITHUB_TOKEN=ghp_xxx bash publish.sh [owner/repo]
#
# It will: build the tarball from the tag, upload it as a release asset, write
# SHA256SUMS, and print the one-line install command.
set -Eeuo pipefail

REPO_SLUG="${1:-${PANEL_REPO:-tuancutephomaiquedethuong-code/vps-panel}}"
VERSION="${VERSION:-v1.0.0}"
TAG="$VERSION"
ASSET="vps-panel-${VERSION}.tar.gz"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

[ -n "$TOKEN" ] || { echo "GITHUB_TOKEN is required"; exit 1; }
[ -d "$HERE/.git" ] || { echo "run this inside the git checkout"; exit 1; }

cd "$HERE"

echo "==> validating"
bash -n install.sh
for f in backend/src/*.js backend/src/*/*.js frontend/js/*.js; do node --check "$f"; done
echo "    syntax OK"

echo "==> committing and tagging $TAG"
git add -A
git diff --cached --quiet || git -c commit.gpgsign=false commit -q -m "release $VERSION"
git tag -f "$TAG" -m "VPS Panel $VERSION"

echo "==> building $ASSET"
git archive --format=tar.gz --prefix="vps-panel-${VERSION}/" "$TAG" -o "$ASSET"
HASH="$(sha256sum "$ASSET" | awk '{print $1}')"
printf '# SHA256 checksums for release assets\n# verify: sha256sum -c SHA256SUMS\n%s  %s\n%s  install.sh\n' \
  "$HASH" "$ASSET" "$(sha256sum install.sh | awk '{print $1}')" > SHA256SUMS
echo "    sha256: $HASH"

api() { curl -fsSL -H "Authorization: token $TOKEN" "$@"; }

OWNER="${REPO_SLUG%%/*}"
NAME="${REPO_SLUG##*/}"

echo "==> creating repo $REPO_SLUG if missing"
api -X POST -H "Content-Type: application/json" https://api.github.com/user/repos \
  -d "{\"name\":\"$NAME\",\"description\":\"Self-hosted web VPS control panel\",\"private\":false}" \
  | grep -q '"full_name"' || echo "    repo already exists"

echo "==> pushing code"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${TOKEN}@github.com/$REPO_SLUG.git"
git push -q origin HEAD:main || true
git push -q -f origin "$TAG" || true
git remote remove origin

echo "==> creating release $TAG"
REL_ID=$(api -X POST -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO_SLUG/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"VPS Panel $VERSION\",\"body\":\"Install: bash <(curl -sSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh)\"}" \
  | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*') || REL_ID=""

if [ -n "$REL_ID" ]; then
  # delete an existing asset with the same name, then upload
  api "https://api.github.com/repos/$REPO_SLUG/releases/$REL_ID/assets" \
    | grep -o '"id": *[0-9]*' | grep -o '[0-9]*' | while read -r aid; do
      curl -fsSL -X DELETE -H "Authorization: token $TOKEN" \
        "https://api.github.com/repos/$REPO_SLUG/releases/assets/$aid" >/dev/null 2>&1 || true
    done
  curl -fsSL -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary "@$ASSET" \
    "https://uploads.github.com/repos/$REPO_SLUG/releases/$REL_ID/assets?name=$ASSET" >/dev/null
  echo "    asset uploaded"
fi

git add SHA256SUMS 2>/dev/null || true
git -c commit.gpgsign=false commit -q -m "update SHA256SUMS for $TAG" 2>/dev/null || true

rm -f "$ASSET"

cat <<EOF

Published $VERSION to $REPO_SLUG

Install:
  bash <(curl -sSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh)

With domain + HTTPS:
  bash <(curl -sSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh) --domain panel.example.com --ssl

EOF