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
# exclude any previously published asset so the tarball cannot embed itself
git archive --format=tar.gz --prefix="vps-panel-${VERSION}/" --output "$ASSET" "$TAG" \
  -- . ':(exclude)vps-panel-*.tar.gz'
HASH="$(sha256sum "$ASSET" | awk '{print $1}')"
printf '# SHA256 checksums for release assets\n# verify: sha256sum -c SHA256SUMS\n%s  %s\n%s  install.sh\n' \
  "$HASH" "$ASSET" "$(sha256sum install.sh | awk '{print $1}')" > SHA256SUMS
echo "    sha256: $HASH"

# The installer downloads the tarball from the repo itself (raw.githubusercontent),
# because GitHub's release download URLs are not always immediately reachable.
git add "$ASSET" SHA256SUMS
git -c commit.gpgsign=false commit -q -m "release $VERSION: asset + checksums"
git tag -f "$TAG" -m "VPS Panel $VERSION" >/dev/null
ASSET_HASH_AFTER_TAG="$(sha256sum "$ASSET" | awk '{print $1}')"
if [ "$ASSET_HASH_AFTER_TAG" != "$HASH" ]; then
  echo "    note: tag content changed, re-hashing for SHA256SUMS"
  printf '# SHA256 checksums for release assets\n# verify: sha256sum -c SHA256SUMS\n%s  %s\n%s  install.sh\n' \
    "$ASSET_HASH_AFTER_TAG" "$ASSET" "$(sha256sum install.sh | awk '{print $1}')" > SHA256SUMS
  git add SHA256SUMS
  git -c commit.gpgsign=false commit -q -m "SHA256SUMS for $VERSION"
fi

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

TMPIDS="$(mktemp)"
trap 'rm -f "$TMPIDS"' EXIT
echo "==> creating release $TAG (or reusing it if it already exists)"
REL_ID=$(api -X POST -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO_SLUG/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"VPS Panel $VERSION\",\"body\":\"Install: bash <(curl -sSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh)\"}" \
  | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9][0-9]*' || true)

if [ -z "$REL_ID" ]; then
  # release already exists: look it up by tag (a 422 from POST means exactly that)
  REL_ID=$(api "https://api.github.com/repos/$REPO_SLUG/releases/tags/$TAG" \
    | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9][0-9]*' || true)
  [ -n "$REL_ID" ] && echo "    release exists, reusing id $REL_ID"
fi

if [ -z "$REL_ID" ]; then
  echo "    ERROR: could not create or find release $TAG (GitHub said 422 and the tag lookup failed)"
  exit 1
fi

# The release holds exactly one asset (the verified tarball). Remove whatever is
# there before uploading, otherwise GitHub rejects the upload with already_exists.
# Parsed with node so the ids are exact (grep/tr parsing of minified JSON is fragile).
node -e '
  let d = "";
  process.stdin.on("data", c => d += c).on("end", () => {
    try { (JSON.parse(d) || []).forEach(a => console.log(a.id)); } catch { }
  });
' < <(api "https://api.github.com/repos/$REPO_SLUG/releases/$REL_ID/assets" 2>/dev/null || echo "[]") > "$TMPIDS"
while read -r aid; do
  [ -n "$aid" ] || continue
  echo "    removing existing asset id $aid"
  curl -fsSL -X DELETE -H "Authorization: token $TOKEN" \
    "https://api.github.com/repos/$REPO_SLUG/releases/assets/$aid" >/dev/null 2>&1 || true
done < "$TMPIDS"

# upload (the installer fetches the asset through the API, so the id may change)
if curl -fsSL -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary "@$ASSET" \
    "https://uploads.github.com/repos/$REPO_SLUG/releases/$REL_ID/assets?name=$ASSET" >/dev/null 2>&1; then
  echo "    release asset uploaded"
else
  echo "    ERROR: release asset upload failed"
  exit 1
fi




rm -f "$ASSET"

cat <<EOF

Published $VERSION to $REPO_SLUG

Install:
  bash <(curl -sSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh)

With domain + HTTPS:
  bash <(curl -sSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh) --domain panel.example.com --ssl

EOF