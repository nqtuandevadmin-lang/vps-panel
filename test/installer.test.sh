#!/usr/bin/env bash
# installer.test.sh - Unit tests for install.sh functions (no root needed)
# Usage: bash test/installer.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/install.sh"
export REPO="$(cd "$(dirname "$0")/.." && pwd)"
export PANEL_INSTALLER_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/install.sh"
export TMP_HARNESS_DIR="$(mktemp -d)"
TMP="$TMP_HARNESS_DIR"
trap 'rm -rf "$TMP_HARNESS_DIR"' EXIT

# extract install.sh without executing the main entrypoint, skip the root check
sed '/^# ---------------- main/,$d' "$PANEL_INSTALLER_SCRIPT" \
  | sed 's|^\[ "\$EUID" -ne 0 \].*|# root check skipped in tests|' > "$TMP/harness.sh"

cat >> "$TMP/harness.sh" <<'HARNESS'

PASS=0; FAIL=0
t() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1 ($3)"; else FAIL=$((FAIL+1)); echo "  FAIL  $1: got '$3' want '$2'"; fi; }

detect_arch; case "$ARCH" in x64|arm64) R=ok ;; *) R="$ARCH" ;; esac
t "detect_arch maps host arch to x64/arm64" "ok" "$R"
detect_distro; t "detect_distro accepts supported distro" "apt" "$PKG_MGR"

PORT=22; if check_port 22; then R=free; else R=busy; fi
t "check_port detects a listening port" "busy" "$R"
PORT=52399; if check_port 52399; then R=free; else R=busy; fi
t "check_port sees a free port" "free" "$R"

check_disk >/dev/null 2>&1 && t "check_disk passes on host" "0" "$?" || t "check_disk passes on host" "0" "1"
check_ram >/dev/null 2>&1 && t "check_ram passes on host" "0" "$?" || t "check_ram passes on host" "0" "1"

detect_other_panels >/dev/null 2>&1 && t "detect_other_panels returns 0 (set -e safe)" "0" "$?" || t "detect_other_panels returns 0 (set -e safe)" "0" "1"
detect_nginx >/dev/null 2>&1 && t "detect_nginx returns 0 (set -e safe)" "0" "$?" || t "detect_nginx returns 0 (set -e safe)" "0" "1"

MODE=install; INSTALLED_COMPONENTS=(); PRE_UPDATE_BACKUP=""
rollback >/dev/null 2>&1 && t "rollback is a no-op when nothing is installed" "0" "$?" || t "rollback is a no-op when nothing is installed" "0" "1"

# admin password generator must ALWAYS satisfy the password policy (would break install)
GOOD=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  RES=$(PANEL_ROOT="$TMP_HARNESS_DIR/pr" PANEL_DATA="$TMP_HARNESS_DIR/pr/data" node -e "const a=require('$REPO/backend/src/auth');const p=a.randomPassword(18);process.stdout.write(a.passwordPolicy(p).length===0?'OK':'BAD')" 2>/dev/null)
  [ "$RES" = "OK" ] || GOOD=1
done
t "randomPassword(18) passes policy 10/10 times" "0" "$GOOD"

print_banner | grep -qP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' && R=EMOJI || R=clean
t "banner is pure ASCII (no emoji)" "clean" "$R"
print_banner | grep -q 'VPS Panel' && R=yes || R=no
t "banner prints product name" "yes" "$R"
grep -q 'set -Eeuo pipefail' <<<"$(head -30 $PANEL_INSTALLER_SCRIPT)" && R=yes || R=no
t "strict mode (set -Eeuo pipefail) enabled" "yes" "$R"

echo ""
echo "INSTALLER TESTS: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
HARNESS

bash "$TMP/harness.sh" 2>&1 | grep -vE '^\s*$'
exit "${PIPESTATUS[0]}"