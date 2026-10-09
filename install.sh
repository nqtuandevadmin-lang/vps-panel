#!/usr/bin/env bash
#===============================================================================
# VPS Panel - One-command installer
# Usage: bash <(curl -sSL https://raw.githubusercontent.com/<repo>/vps-panel/main/install.sh)
# Options:
#   --port <n>      panel port (default 8080)
#   --domain <d>    setup domain + Nginx reverse proxy
#   --ssl           enable HTTPS (Let's Encrypt, requires --domain)
#   --no-ssl        disable HTTPS
#   --update        update existing installation (keeps data)
#   --uninstall     remove panel
#   --auto          non-interactive mode (CI/CD)
#   --local <dir>   install from an already-downloaded copy of this repo (no download)
#   --base-url <u>  serve tarball+SHA256SUMS from any HTTP host (GitLab/Codeberg/S3/self-hosted)
#   --force         skip checksum verification (not recommended)
# Env:   PANEL_REPO, PANEL_PORT, PANEL_DOMAIN, PANEL_AUTO=1, ADMIN_PASSWORD, PANEL_BASE_URL
#===============================================================================
set -Eeuo pipefail

# ---------------- config ----------------
PANEL_REPO="${PANEL_REPO:-nqtuandevadmin-lang/vps-panel}"
PANEL_VERSION="v1.0.0"           # release tag used for the verified tarball asset
PANEL_BRANCH="main"              # fallback branch if the release asset is missing
ASSET_NAME="vps-panel-${PANEL_VERSION}.tar.gz"
# Generic hosting: set PANEL_BASE_URL (or --base-url) to serve the tarball +
# SHA256SUMS from ANY HTTP location (GitLab, Codeberg, your own VPS, S3, ...).
# Example: PANEL_BASE_URL=https://gitlab.com/you/vps-panel/-/raw/v1.0.0
PANEL_BASE_URL="${PANEL_BASE_URL:-}"
# CDN mirror: jsDelivr serves the repo tarball + SHA256SUMS with no stale-cache
# problems (GitHub raw can lag minutes behind after a push). Overridable, and
# resolved from PANEL_REPO at run time so --repo/PANEL_REPO always wins.
PANEL_CDN_URL="${PANEL_CDN_URL:-}"
LOCAL_DIR=""                 # --local <dir>: install from a local copy, no download
INSTALL_DIR="/opt/vps-panel"
DATA_DIR="$INSTALL_DIR/data"
LOG_FILE="/var/log/vps-panel-install.log"
SERVICE="vps-panel"
NODE_VERSION="v20.18.1"
DEFAULT_PORT=8080
PORT="${PANEL_PORT:-$DEFAULT_PORT}"
DOMAIN="${PANEL_DOMAIN:-}"
ENABLE_SSL=0
MODE="install"          # install | update | uninstall
AUTO=0
FORCE=0
ADMIN_USER="admin"
ADMIN_PASS=""
BACKUP_DIR="/var/backups/vps-panel"
REQUIRED_DISK_MB=1500
WORK_DIR=""                      # private scratch dir, created after the root check
REQUIRED_RAM_MB_EVAL=512   # below this we warn; below 1GB we add swap

# ---------------- colors ----------------
if [ -t 1 ]; then
  C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YLW='\033[0;33m'; C_BLU='\033[0;34m'; C_CYN='\033[0;36m'; C_BLD='\033[1m'; C_RST='\033[0m'
else
  C_RED=''; C_GRN=''; C_YLW=''; C_BLU=''; C_CYN=''; C_BLD=''; C_RST=''
fi

# ---------------- logging ----------------
LOG_READY=0
enable_log_file() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  if touch "$LOG_FILE" 2>/dev/null; then
    exec > >(tee -a "$LOG_FILE") 2>&1 || true
    LOG_READY=1
  fi
}
log()  { echo -e "${C_CYN}[$(date '+%H:%M:%S')]${C_RST} $*"; }
ok()   { echo -e "${C_GRN}[ OK ]${C_RST} $*"; }
warn() { echo -e "${C_YLW}[WARN]${C_RST} $*"; }
err()  { echo -e "${C_RED}[FAIL]${C_RST} $*" >&2; }
die()  { err "$*"; echo -e "${C_RED}Installation failed. Full log: $LOG_FILE${C_RST}"; rollback; exit 1; }

# ---------------- banner (ASCII, no emoji) ----------------
print_banner() {
  cat <<'EOF'
============================================================
   __     __  _____  ____   ____   ______    _
   \ \   / / |  __ \|  _ \ / __ \ / __ \ \  / /
    \ \_/ /  | |__) | |_) | |  | | |  | \ \/ /
     \   /   |  ___/|  _ <| |  | | |  | |\   /
      | |    | |    | |_) | |__| | |__| || |
      |_|    |_|    |____/ \____/ \____/ |_|

   VPS Panel v1.0.0 - Web Control Panel Installer
   https://github.com/nqtuandevadmin-lang/vps-panel
============================================================
EOF
}

# ---------------- progress bar / spinner ----------------
PROGRESS_WIDTH=40
progress() { # progress <percent> <label>
  local pct="$1" label="$2"
  local filled=$(( pct * PROGRESS_WIDTH / 100 ))
  local bar="" j
  for ((j=0; j<filled; j++)); do bar+="="; done
  for ((j=filled; j<PROGRESS_WIDTH; j++)); do bar+=" "; done
  printf "\r${C_BLU}[${bar}] %3d%%${C_RST} %-40s" "$pct" "$label"
  [ "$pct" -ge 100 ] && printf "\n"
  return 0   # never let a progress redraw trip `set -e`
}

spinner_pid=""
spinner() { # spinner <label> - runs until kill_spinner
  local label="$1"
  local chars="/-\|"
  local i=0
  while true; do
    i=$(( (i + 1) % 4 ))
    printf "\r${C_CYN}${chars:$i:1}${C_RST} %s" "$label"
    sleep 0.12
  done
}
start_spinner() { spinner "$1" & spinner_pid=$!; }
stop_spinner() { [ -n "$spinner_pid" ] && kill "$spinner_pid" 2>/dev/null; wait "$spinner_pid" 2>/dev/null || true; spinner_pid=""; printf "\r%-60s\r" " "; }

# ---------------- error handling & rollback ----------------
INSTALLED_COMPONENTS=()
PRE_UPDATE_BACKUP=""
rollback() {
  if [ "$MODE" = "update" ] && [ -n "$PRE_UPDATE_BACKUP" ] && [ -f "$PRE_UPDATE_BACKUP" ]; then
    warn "Rolling back update from $PRE_UPDATE_BACKUP"
    if [ -d "$INSTALL_DIR" ]; then
      rm -rf "$INSTALL_DIR.broken"
      mv "$INSTALL_DIR" "$INSTALL_DIR.broken" || true
    fi
    mkdir -p "$(dirname "$INSTALL_DIR")"
    tar -xzf "$PRE_UPDATE_BACKUP" -C /opt/ 2>/dev/null || warn "rollback extraction failed - manual restore from $PRE_UPDATE_BACKUP"
    [ "$SYSTEMD_OK" = "1" ] && systemctl restart "$SERVICE" 2>/dev/null || supervisor_start 2>/dev/null || true
    warn "Rollback done. Previous version restored. Broken copy kept at $INSTALL_DIR.broken"
    return
  fi
  if [ "$MODE" = "install" ] && [ "${#INSTALLED_COMPONENTS[@]}" -gt 0 ]; then
    warn "Rolling back partial installation..."
    [ "$SYSTEMD_OK" = "1" ] && { systemctl stop "$SERVICE" 2>/dev/null || true; systemctl disable "$SERVICE" 2>/dev/null || true; } || supervisor_stop 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE.service"
    [ "$SYSTEMD_OK" = "1" ] && systemctl daemon-reload 2>/dev/null || true
    rm -f /usr/local/bin/vps-panel-start /usr/local/bin/vps-panel-stop
    [ "${KEEP_DATA:-0}" != "1" ] && rm -rf "$INSTALL_DIR"
    warn "Rollback complete. Log kept at $LOG_FILE"
  fi
}
trap 'die "interrupted"' INT TERM
trap 'on_error $?' ERR
on_error() {
  local code=$1
  [ "$code" = "0" ] && return 0
  err "error code $code at line $1: ${BASH_COMMAND}"
  rollback
  exit "$code"
}

# ---------------- arg parsing ----------------
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --ssl) ENABLE_SSL=1; shift ;;
    --no-ssl) ENABLE_SSL=0; shift ;;
    --update) MODE="update"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --auto) AUTO=1; shift ;;
    --force) FORCE=1; shift ;;
    --local) LOCAL_DIR="$2"; shift 2 ;;
    --base-url) PANEL_BASE_URL="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) err "unknown option: $1"; exit 2 ;;
  esac
done
[ -n "${PANEL_AUTO:-}" ] && AUTO=1
[ -n "${ADMIN_PASSWORD:-}" ] && ADMIN_PASS="$ADMIN_PASSWORD"

# ---------------- root check ----------------
[ "$EUID" -ne 0 ] && { err "this installer must run as root (use sudo)"; exit 1; }
enable_log_file
# private scratch dir (avoids collisions with stale or foreign-owned files)
WORK_DIR="$(mktemp -d /tmp/vps-panel-install.XXXXXX)"
chmod 700 "$WORK_DIR"

# ---------------- distro & arch detection ----------------
detect_distro() {
  if [ -f /etc/os-release ]; then . /etc/os-release; else die "/etc/os-release not found - unsupported system"; fi
  DISTRO_ID="${ID:-unknown}"; DISTRO_VER="${VERSION_ID:-0}"
  DISTRO_PRETTY_NAME="${PRETTY_NAME:-${DISTRO_ID} ${DISTRO_VER}}"
  case "$DISTRO_ID" in
    ubuntu)
      awk -v v="$DISTRO_VER" 'BEGIN{exit !(v+0 >= 20.04)}' || die "Ubuntu $DISTRO_VER not supported (need 20.04+)"
      PKG_MGR="apt"; ;;
    debian)
      awk -v v="$DISTRO_VER" 'BEGIN{exit !(v+0 >= 11)}' || die "Debian $DISTRO_VER not supported (need 11+)"
      PKG_MGR="apt"; ;;
    *) die "Unsupported distro: $DISTRO_ID $DISTRO_VER (supported: Ubuntu 20.04+, Debian 11+)" ;;
  esac
}
detect_arch() {
  local a
  a="$(uname -m)"
  case "$a" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "Unsupported architecture: $a (supported: x64, arm64)" ;;
  esac
}

# ---------------- preflight checks ----------------
check_disk() {
  local avail_kb
  avail_kb="$(df -k / | awk 'NR==2{print $4}')"
  local avail_mb=$(( avail_kb / 1024 ))
  if [ "$avail_mb" -lt "$REQUIRED_DISK_MB" ]; then
    die "insufficient disk space: ${avail_mb}MB available, ${REQUIRED_DISK_MB}MB required"
  fi
  ok "disk space: ${avail_mb}MB available"
}
check_ram() {
  local mem_kb
  mem_kb="$(grep MemTotal /proc/meminfo | awk '{print $2}')"
  local mem_mb=$(( mem_kb / 1024 ))
  if [ "$mem_mb" -lt "$REQUIRED_RAM_MB_EVAL" ]; then
    warn "low memory: ${mem_mb}MB - panel may be slow; consider upgrading"
  fi
  if [ "$mem_mb" -lt 1024 ]; then
    if ! grep -q '^SwapTotal:' /proc/meminfo || [ "$(grep '^SwapTotal:' /proc/meminfo | awk '{print $2}')" -eq 0 ]; then
      warn "RAM < 1GB and no swap detected - creating 1GB swap file"
      create_swap
    else
      ok "swap already present"
    fi
  else
    ok "memory: ${mem_mb}MB"
  fi
}
create_swap() {
  local swapfile="/swapfile-vps-panel"
  if [ -f "$swapfile" ]; then return 0; fi
  start_spinner "creating swap file..."
  fallocate -l 1G "$swapfile" 2>/dev/null || dd if=/dev/zero of="$swapfile" bs=1M count=1024 status=none
  chmod 600 "$swapfile"
  mkswap "$swapfile" >/dev/null 2>&1
  swapon "$swapfile"
  grep -q "$swapfile" /etc/fstab || echo "$swapfile none swap sw 0 0" >> /etc/fstab
  stop_spinner
  ok "swap created: 1GB at $swapfile"
  INSTALLED_COMPONENTS+=("swap")
}
check_port() {
  local port="$1"
  local hexport
  hexport="$(printf '%04X' "$port")"
  # Authoritative check: /proc/net/tcp{,6} state 0A == LISTEN.
  # Counting TIME_WAIT (06) or SYN_SENT sockets would report a false "port busy".
  if awk -v p=":$hexport" '$4 == "0A" && $2 ~ p"$" { found=1 } END { exit !found }' \
       /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    return 1
  fi
  return 0
}
detect_other_panels() {
  local found=""
  [ -d /usr/local/aapanel ] && found="$found aaPanel"
  [ -d /usr/local/cpanel ] && found="$found cPanel"
  [ -d /etc/psa ] && found="$found Plesk"
  [ -f /usr/bin/cyberpanel ] && found="$found CyberPanel"
  [ -d /usr/local/hestia ] && found="$found Hestia"
  [ -n "$found" ] && warn "other control panels detected:$found - they may conflict on ports 80/443. The panel will use port $PORT by default."
  return 0
}
detect_nginx() {
  if command -v nginx >/dev/null; then
    NGINX_EXISTS=1
    warn "Nginx already installed - the installer will reuse it (reverse proxy config added to /etc/nginx/conf.d/)"
  else
    NGINX_EXISTS=0
  fi
}

# ---------------- package install with progress ----------------
# apt can hang forever on a dpkg lock (e.g. an interrupted package install, or a
# conffile prompt waiting for input). Recover, then always run non-interactively.
fix_dpkg_state() {
  local waited=0
  while [ $waited -lt 60 ]; do
    if ! fuser "${DPKG_LOCK:-/var/lib/dpkg/lock-frontend}" >/dev/null 2>&1 && \
       ! (command -v lsof >/dev/null && lsof /var/lib/dpkg/lock-frontend >/dev/null 2>&1); then
      return 0
    fi
    [ "$waited" = "0" ] && warn "another apt/dpkg process holds the lock - waiting (up to 60s)"
    sleep 3
    waited=$((waited + 3))
  done
  warn "dpkg lock still held after 60s - clearing stale locks and continuing"
  pkill -f 'apt-get' 2>/dev/null || true
  pkill -f 'dpkg --' 2>/dev/null || true
  sleep 1
  rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock 2>/dev/null || true
}

install_packages() {
  local pkgs=("$@")
  local total=${#pkgs[@]} i=0
  if [ "$PKG_MGR" = "apt" ]; then
    fix_dpkg_state
    export DEBIAN_FRONTEND=noninteractive
    start_spinner "resolving dependencies (${#pkgs[@]} packages)..."
    # never block on a conffile prompt in a non-interactive run
    if ! timeout 180 apt-get update -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold >> "$LOG_FILE" 2>&1; then
      stop_spinner
      warn "apt-get update failed (offline mirror?) - continuing with the cached package index"
    fi
    stop_spinner
    start_spinner "installing ${total} packages..."
    if ! timeout 600 apt-get install -y -qq --no-install-recommends \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
        "${pkgs[@]}" >> "$LOG_FILE" 2>&1; then
      stop_spinner
      # retry after repairing dpkg state (a half-configured package is common)
      fix_dpkg_state
      DEBIAN_FRONTEND=noninteractive dpkg --configure -a >> "$LOG_FILE" 2>&1 || true
      if ! timeout 600 apt-get install -y -qq --no-install-recommends \
          -o Dpkg::Options::==--force-confdef -o Dpkg::Options::=--force-confold \
          "${pkgs[@]}" >> "$LOG_FILE" 2>&1; then
        die "apt-get install failed - see $LOG_FILE"
      fi
    fi
  fi
  stop_spinner
  for p in "${pkgs[@]}"; do
    i=$((i + 1))
    progress $(( i * 100 / total )) "package: $p"
  done
  ok "packages installed: ${pkgs[*]}"
  return 0
}

# ---------------- node runtime ----------------
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/bin/node)"
install_node() {
  if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
    NODE_BIN="$(command -v node)"
    ok "Node.js $(node -v) already installed"
    return 0
  fi
  start_spinner "downloading Node.js $NODE_VERSION ($ARCH)..."
  local url="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.xz"
  local tmp="/tmp/node-$NODE_VERSION-linux-$ARCH.tar.xz"
  curl -fL --retry 3 --progress-bar -o "$tmp" "$url" || die "cannot download Node.js"
  stop_spinner
  mkdir -p /opt/node20
  tar -xJf "$tmp" -C /opt/node20 --strip-components=1
  ln -sf /opt/node20/bin/node /usr/local/bin/node
  ln -sf /opt/node20/bin/npm /usr/local/bin/npm
  ln -sf /opt/node20/bin/npx /usr/local/bin/npx
  rm -f "$tmp"
  export PATH="/usr/local/bin:$PATH"
  hash -r 2>/dev/null || true
  NODE_BIN="$(command -v node)"
  NODE_VER="$("$NODE_BIN" -v 2>/dev/null || echo unknown)"
  if [ "${NODE_VER#v}" = "${NODE_VER#v}" ] || [ "${NODE_VER#v}" -lt 20 ] 2>/dev/null; then
    warn "node on PATH is still $NODE_VER - using $NODE_BIN explicitly for the panel"
  else
    ok "Node.js $NODE_VER installed at $NODE_BIN ($("$NODE_BIN" -p 'process.arch'))"
  fi
  INSTALLED_COMPONENTS+=("node20")
}

# ---------------- download & verify source ----------------
# ---------- fetch the verified asset (GitHub API first: never serves a stale copy) ----------
# GitHub REST API requires no token for public repos and always returns the current
# release asset, unlike raw.githubusercontent / jsDelivr which cache for minutes.
# Prints "<asset_id>|<sha256-from-digest>". The digest lives in the same API
# response as the asset id, so the checksum can never come from a different
# (cached) revision than the bytes we download.
api_asset_info() {
  "$NODE_BIN" -e '
    let d = "";
    process.stdin.on("data", c => d += c).on("end", () => {
      try {
        const rel = JSON.parse(d);
        const a = (rel.assets || []).find(x => x.name === process.argv[1]);
        if (!a) return process.stdout.write("|");
        const dg = String(a.digest || "");
        const sha = dg.startsWith("sha256:") ? dg.slice(7) : "";
        process.stdout.write(a.id + "|" + sha);
      } catch { process.stdout.write("|"); }
    });
  ' "$1"
}
api_file() { # api_file <path-in-repo> -> writes decoded content to stdout
  "$NODE_BIN" -e '
    let d = "";
    process.stdin.on("data", c => d += c).on("end", () => {
      try {
        const j = JSON.parse(d);
        process.stdout.write(Buffer.from(j.content || "", "base64").toString("utf8"));
      } catch { process.stdout.write(""); }
    });
  '
}

download_asset_api() { # -> 0 on success; sets ASSET_DIGEST when available
  local info id
  ASSET_DIGEST=""
  info="$(curl -fsSL "https://api.github.com/repos/$PANEL_REPO/releases/latest?cb=$RANDOM$$" 2>/dev/null | api_asset_info "$ASSET_NAME")"
  id="${info%%|*}"
  ASSET_DIGEST="${info##*|}"
  [ -n "$id" ] || return 1
  curl -fsSL -H "Accept: application/octet-stream" \
    -o "$WORK_DIR/api-asset.tar.gz" "https://api.github.com/repos/$PANEL_REPO/releases/assets/$id" || return 1
  mv -f "$WORK_DIR/api-asset.tar.gz" "$1" || return 1
  return 0
}
fetch_checksums_api() { # -> 0 on success
  curl -fsSL "https://api.github.com/repos/$PANEL_REPO/contents/SHA256SUMS?ref=$PANEL_BRANCH" 2>/dev/null \
    | api_file > "$WORK_DIR/sums-api.txt" || return 1
  [ -s "$WORK_DIR/sums-api.txt" ] || return 1
  return 0
}

download_source() {
  local tmp="$WORK_DIR/vps-panel-src.tar.gz"
  # resolve the CDN mirror lazily so PANEL_REPO set at run time is honoured.
  # The immutable release tag is preferred: its tarball and its SHA256SUMS can
  # never drift apart. Falls back to the branch when the tag is not published.
  if [ -z "$PANEL_CDN_URL" ] && [ -z "$PANEL_BASE_URL" ]; then
    if curl -fsI -o /dev/null "https://cdn.jsdelivr.net/gh/${PANEL_REPO}@${PANEL_VERSION}/SHA256SUMS" 2>/dev/null; then
      PANEL_CDN_URL="https://cdn.jsdelivr.net/gh/${PANEL_REPO}@${PANEL_VERSION}"
    else
      PANEL_CDN_URL="https://cdn.jsdelivr.net/gh/${PANEL_REPO}@${PANEL_BRANCH}"
    fi
  fi

  # ---- local mode: copy from a directory that already contains the project ----
  if [ -n "$LOCAL_DIR" ]; then
    [ -d "$LOCAL_DIR" ] || die "--local path does not exist: $LOCAL_DIR"
    [ -f "$LOCAL_DIR/install.sh" ] || die "--local path is not a vps-panel checkout: $LOCAL_DIR"
    start_spinner "using local source: $LOCAL_DIR ..."
    rm -rf "$WORK_DIR/extract"
    mkdir -p "$WORK_DIR/extract/vps-panel-local"
    tar -cf - -C "$LOCAL_DIR" \
        --exclude=node_modules --exclude=.git --exclude=data \
        install.sh README.md LICENSE SHA256SUMS backend frontend systemd nginx test publish.sh 2>/dev/null \
      | tar -xf - -C "$WORK_DIR/extract/vps-panel-local"
    stop_spinner
    EXTRACTED="$WORK_DIR/extract/vps-panel-local"
    [ -f "$EXTRACTED/install.sh" ] || die "local copy is incomplete"
    ok "local source ready: $EXTRACTED"
    return 0
  fi

  local release_url branch_url sums_url raw_base
  if [ -n "$PANEL_BASE_URL" ]; then
    release_url="${PANEL_BASE_URL%/}/$ASSET_NAME"
    sums_url="${PANEL_BASE_URL%/}/SHA256SUMS"
    branch_url="$release_url"
    raw_base="$release_url"
  elif [ -n "$PANEL_CDN_URL" ]; then
    raw_base="$PANEL_CDN_URL"
    release_url="https://github.com/$PANEL_REPO/releases/download/$PANEL_VERSION/$ASSET_NAME"
    branch_url="https://github.com/$PANEL_REPO/archive/refs/heads/$PANEL_BRANCH.tar.gz"
    sums_url="${PANEL_CDN_URL}/SHA256SUMS"
  else
    raw_base="https://raw.githubusercontent.com/$PANEL_REPO/$PANEL_BRANCH"
    release_url="https://github.com/$PANEL_REPO/releases/download/$PANEL_VERSION/$ASSET_NAME"
    branch_url="https://github.com/$PANEL_REPO/archive/refs/heads/$PANEL_BRANCH.tar.gz"
    sums_url="${raw_base}/SHA256SUMS"
  fi
  rm -f "$tmp"
  start_spinner "downloading verified asset..."
  # Order: 0) GitHub API release asset (authoritative, never CDN-cached)
  #        1) CDN mirror  2) raw  3) branch tarball (last resort)
  if [ -z "$PANEL_BASE_URL" ] && download_asset_api "$tmp"; then
    SOURCE_KIND="release asset via GitHub API"
  elif curl -fsSL --retry 3 -o "$tmp" "$raw_base/$ASSET_NAME"; then
    SOURCE_KIND="verified asset ($ASSET_NAME)"
  elif curl -fsSL --retry 2 -o "$tmp" "https://raw.githubusercontent.com/$PANEL_REPO/$PANEL_BRANCH/$ASSET_NAME"; then
    SOURCE_KIND="repo asset ($ASSET_NAME)"
  elif curl -fsSL --retry 2 -o "$tmp" "$release_url"; then
    SOURCE_KIND="release asset ($ASSET_NAME)"
  else
    warn "asset download failed, falling back to branch tarball ($PANEL_BRANCH)"
    start_spinner "downloading branch tarball..."
    curl -fsSL --retry 3 -o "$tmp" "$branch_url" || die "cannot download source (set PANEL_REPO=<owner>/<repo> or PANEL_BASE_URL=<url>)"
    SOURCE_KIND="branch tarball ($PANEL_BRANCH)"
  fi
  stop_spinner

  # SHA256 verification (real): compare against SHA256SUMS, with CDN retry
  local sums="$WORK_DIR/SHA256SUMS"
  local sums_ok=0
  # Preferred: the sha256 GitHub publishes for this exact asset (same API response)
  if [ "$FORCE" != "1" ] && [ -n "${ASSET_DIGEST:-}" ]; then
    local actual_now
    actual_now="$(sha256sum "$tmp" | awk '{print $1}')"
    if [ "$actual_now" = "$ASSET_DIGEST" ]; then
      ok "checksum verified (GitHub asset digest): $actual_now"
      sums_ok=2
    else
      die "CHECKSUM MISMATCH vs GitHub asset digest - refusing to install. expected=$ASSET_DIGEST actual=$actual_now"
    fi
  fi
  # fallback checksum sources (only used when the API gave us no digest)
  if [ "$FORCE" != "1" ] && [ "$sums_ok" != "2" ]; then
    if [ -z "$PANEL_BASE_URL" ] && fetch_checksums_api && grep -q "$ASSET_NAME" "$WORK_DIR/sums-api.txt" 2>/dev/null; then
      cp -f "$WORK_DIR/sums-api.txt" "$sums"; sums_ok=1
    fi
    if [ "$sums_ok" != "1" ]; then
      for attempt in 1 2 3; do
        if curl -fsSL -o "$sums" "$sums_url" 2>/dev/null; then sums_ok=1; break; fi
        sleep 3
        curl -fsSL -o "$sums" "${sums_url}?cb=$RANDOM$$" 2>/dev/null && { sums_ok=1; break; }
        curl -fsSL -o "$sums" "https://raw.githubusercontent.com/$PANEL_REPO/$PANEL_BRANCH/SHA256SUMS" 2>/dev/null && { sums_ok=1; break; }
      done
    fi
  fi
  if [ "$FORCE" != "1" ] && [ "$sums_ok" = "2" ]; then
    : # already verified against the authoritative asset digest
  elif [ "$FORCE" != "1" ] && [ "$sums_ok" = "1" ]; then
    local expected="" actual="" attempt=1 verified=0
    start_spinner "verifying SHA256 checksum..."
    while [ "$attempt" -le 3 ]; do
      expected="$(grep -F "$ASSET_NAME" "$sums" | head -1 | awk '{print $1}')"
      actual="$(sha256sum "$tmp" | awk '{print $1}')"
      [ -n "$expected" ] && [ "$expected" = "$actual" ] && { verified=1; break; }
      if [ "$attempt" -lt 3 ]; then
        # a stale CDN copy is the most likely cause: refetch everything fresh
        stop_spinner
        warn "checksum mismatch (attempt $attempt/3) - refetching to rule out a stale CDN copy"
        sleep 2
        curl -fsSL -o "$sums" "${sums_url}?cb=$RANDOM$$" 2>/dev/null || true
        curl -fL --retry 2 -o "$tmp" "${raw_base:-$branch_url}/$ASSET_NAME?cb=$RANDOM$$" 2>/dev/null \
          || curl -fL --retry 2 -o "$tmp" "$branch_url" 2>/dev/null || true
        start_spinner "verifying SHA256 checksum..."
      fi
      attempt=$((attempt + 1))
    done
    stop_spinner
    if [ "$verified" = "1" ]; then
      ok "checksum verified: $actual"
    elif [ -z "$expected" ]; then
      die "SHA256SUMS has no entry for $ASSET_NAME. Publish a proper release, or re-run with --force to skip verification."
    else
      die "CHECKSUM MISMATCH after 3 attempts - refusing to install. expected=$expected actual=$actual"
    fi
  elif [ "$FORCE" = "1" ]; then
    warn "--force: checksum verification skipped"
  else
    die "could not fetch $sums_url - cannot verify download. Re-run with --force to skip verification."
  fi

  rm -rf "$WORK_DIR/extract"
  mkdir -p "$WORK_DIR/extract"
  tar -xzf "$tmp" -C "$WORK_DIR/extract"
  rm -f "$tmp"
  EXTRACTED="$(find "$WORK_DIR/extract" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -z "$EXTRACTED" ] && die "downloaded archive is empty"
  ok "source ready: $EXTRACTED"
}

# ---------------- systemd detection ----------------
# Minimal VPS and containers often run without systemd as PID 1. Detect that once
# so every systemctl call in the installer can be guarded.
SYSTEMD_OK=1
detect_systemd() {
  if [ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]; then SYSTEMD_OK=0; fi
  if ! systemctl is-system-running >/dev/null 2>&1; then
    if systemctl --version >/dev/null 2>&1; then SYSTEMD_OK=0; else SYSTEMD_OK=0; fi
  fi
  if [ "$SYSTEMD_OK" = "0" ]; then
    warn "systemd is not running as PID 1 - using supervised fallback (no systemd unit)"
  fi
}

panel_enable() {
  if [ "$SYSTEMD_OK" = "1" ]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable "$SERVICE" >/dev/null 2>&1 && ok "systemd service enabled" || warn "systemctl enable failed"
  else
    install_supervisor
  fi
}
panel_restart() {
  if [ "$SYSTEMD_OK" = "1" ]; then systemctl restart "$SERVICE"
  else supervisor_stop; supervisor_start; fi
}
panel_stop() {
  if [ "$SYSTEMD_OK" = "1" ]; then systemctl stop "$SERVICE" 2>/dev/null || true
  else supervisor_stop; fi
}
panel_health() {
  for _ in $(seq 1 24); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# ---------------- supervised fallback (no systemd) ----------------
install_supervisor() {
  local launcher="/usr/local/bin/vps-panel-start"
  local stopper="/usr/local/bin/vps-panel-stop"
  cat > "$launcher" <<EOF
#!/usr/bin/env bash
# VPS Panel launcher (supervised fallback used when systemd is unavailable)
export PANEL_ROOT="$INSTALL_DIR"
export PANEL_DATA="$DATA_DIR"
export PANEL_PORT="$PORT"
cd "$INSTALL_DIR/backend"
exec "$NODE_BIN" src/index.js >> /var/log/vps-panel.log 2>&1
EOF
  cat > "$stopper" <<EOF
#!/usr/bin/env bash
pkill -f "node src/index.js" 2>/dev/null && exit 0
exit 1
EOF
  chmod +x "$launcher" "$stopper"
  if ! grep -q 'vps-panel-start' /etc/crontab 2>/dev/null; then
    echo "@reboot root $launcher # vps-panel-start" >> /etc/crontab
  fi
  ok "supervisor launcher installed: $launcher"
}
supervisor_start() {
  pkill -f 'node src/index.js' 2>/dev/null || true
  sleep 0.5
  cd "$INSTALL_DIR/backend"
  PANEL_ROOT="$INSTALL_DIR" PANEL_DATA="$DATA_DIR" PANEL_PORT="$PORT" PANEL_FILE_ROOT=/home \
    setsid nohup "$NODE_BIN" src/index.js >> /var/log/vps-panel.log 2>&1 &
  disown 2>/dev/null || true
  sleep 1
  ok "panel started (supervised mode, log: /var/log/vps-panel.log)"
}
supervisor_stop() {
  pkill -f 'node src/index.js' 2>/dev/null || true
  sleep 0.5
  ok "panel stopped"
}

# ---------------- install ----------------
do_install() {
  log "=== INSTALL MODE ==="
  print_banner

  detect_distro; detect_arch; detect_systemd
  ok "detected: $DISTRO_ID $DISTRO_VER ($DISTRO_PRETTY_NAME), arch $ARCH"
  check_disk
  check_ram
  detect_other_panels
  detect_nginx

  # existing install?
  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/backend/package.json" ]; then
    if [ "$AUTO" = "1" ]; then
      err "panel already installed at $INSTALL_DIR - use --update or --uninstall"
      exit 3
    fi
    echo -e "${C_YLW}Panel already installed.${C_RST}"
    echo "1) Update (keeps all data)"
    echo "2) Reinstall (keeps data dir only)"
    echo "3) Abort"
    read -r -p "Choose [1-3]: " choice
    case "$choice" in
      1) MODE="update"; do_update; return ;;
      2) warn "reinstalling - data dir $DATA_DIR will be preserved" ;;
      *) echo "aborted"; exit 0 ;;
    esac
  fi

  # port availability
  if ! check_port "$PORT"; then
    die "port $PORT is already in use - use --port <free-port>"
  fi
  ok "port $PORT is free"

  # dependencies (real packages)
  install_packages curl wget git unzip tar ca-certificates

  # runtime
  install_node

  # source
  download_source

  # install files
  start_spinner "installing panel files..."
  mkdir -p "$INSTALL_DIR"
  cp -r "$EXTRACTED/." "$INSTALL_DIR/"
  mkdir -p "$DATA_DIR" "$BACKUP_DIR"
  chown -R root:root "$INSTALL_DIR"
  stop_spinner
  progress 100 "files installed"
  INSTALLED_COMPONENTS+=("files")

  # backend deps
  start_spinner "installing backend dependencies (npm ci)..."
  (cd "$INSTALL_DIR/backend" && PATH="/usr/local/bin:$PATH" npm install --omit=dev --no-audit --no-fund >> "$LOG_FILE" 2>&1) || die "npm install failed (see $LOG_FILE)"
  stop_spinner
  ok "backend dependencies installed"
  INSTALLED_COMPONENTS+=("npm")

  # config: write port
  cat > "$DATA_DIR/config.json" <<EOF
{
  "port": $PORT,
  "host": "0.0.0.0",
  "url": "${DOMAIN:+https://$DOMAIN}${DOMAIN:-}"
}
EOF
  chmod 600 "$DATA_DIR/config.json"

  # admin user with random password (generated with the SAME policy-checked
  # generator the backend uses, so create-admin can never reject it)
  if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS="$(PANEL_ROOT="$INSTALL_DIR" PANEL_DATA="$DATA_DIR" "$NODE_BIN" -e "process.stdout.write(require('$INSTALL_DIR/backend/src/auth').randomPassword(18))")"
    [ -n "$ADMIN_PASS" ] || die "failed to generate admin password"
  fi
  local_admin_out="$(PANEL_ROOT="$INSTALL_DIR" PANEL_DATA="$DATA_DIR" "$NODE_BIN" "$INSTALL_DIR/backend/tools/create-admin.js" "$ADMIN_USER" "$ADMIN_PASS" 2>&1)" || die "admin creation failed: $local_admin_out"
  ok "admin user created (password bcrypt-hashed, cost 12)"

  # system user for the service
  if ! id -u panel >/dev/null 2>&1; then
    useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin panel
    ok "system user 'panel' created"
  fi
  chown -R panel:panel "$DATA_DIR" "$BACKUP_DIR"

  # systemd service (real)
  install -m 644 "$INSTALL_DIR/systemd/vps-panel.service" "/etc/systemd/system/$SERVICE.service"
  sed -i "s|Environment=PANEL_ROOT=.*|Environment=PANEL_ROOT=$INSTALL_DIR|" "/etc/systemd/system/$SERVICE.service"
  sed -i "s|Environment=PANEL_DATA=.*|Environment=PANEL_DATA=$DATA_DIR|" "/etc/systemd/system/$SERVICE.service"
  sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN $INSTALL_DIR/backend/src/index.js|" "/etc/systemd/system/$SERVICE.service"
  panel_enable
  INSTALLED_COMPONENTS+=("service")

  # fail2ban
  install_fail2ban

  # firewall
  open_firewall "$PORT"

  # domain / nginx / ssl
  if [ -n "$DOMAIN" ]; then
    setup_nginx
    if [ "$ENABLE_SSL" = "1" ]; then
      setup_ssl
    fi
  else
    warn "no --domain given: panel will serve HTTP directly on port $PORT (no reverse proxy)"
  fi

  # start service
  panel_restart
  if ! panel_health; then
    die "service started but health check failed - check the log (journalctl -u $SERVICE -n 50 or /var/log/vps-panel.log)"
  fi
  ok "service started and healthy"

  print_summary
}

# ---------------- fail2ban ----------------
install_fail2ban() {
  if command -v fail2ban-client >/dev/null; then
    ok "fail2ban already installed"
  else
    install_packages fail2ban || { warn "fail2ban install failed - continuing"; return; }
  fi
  cat > /etc/fail2ban/jail.d/vps-panel.local <<EOF
[vps-panel]
enabled = true
port = $PORT
filter = vps-panel
logpath = $LOG_FILE
maxretry = 5
bantime = 3600
findtime = 600
EOF
  cat > /etc/fail2ban/filter.d/vps-panel.conf <<'EOF'
[Definition]
failregex = ^\[FAIL\].*$
ignoreregex =
EOF
  systemctl restart fail2ban 2>/dev/null && ok "fail2ban configured for panel port $PORT" || warn "fail2ban restart failed"
  INSTALLED_COMPONENTS+=("fail2ban")
}

# ---------------- firewall ----------------
open_firewall() {
  local port="$1"
  if command -v ufw >/dev/null && ufw status | grep -q active; then
    ufw allow "$port/tcp" >/dev/null 2>&1 && ok "UFW: port $PORT/tcp allowed" || warn "ufw allow failed"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state 2>/dev/null | grep -q running; then
    firewall-cmd --permanent --add-port="$port/tcp" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && ok "firewalld: port $PORT/tcp allowed" || warn "firewalld failed"
  else
    warn "no active firewall found (ufw/firewalld) - open port $PORT manually if needed"
  fi
}

# ---------------- nginx reverse proxy ----------------
setup_nginx() {
  if [ "$NGINX_EXISTS" = "0" ]; then
    install_packages nginx
    INSTALLED_COMPONENTS+=("nginx")
  fi
  mkdir -p /var/www/certbot
  local conf="/etc/nginx/conf.d/vps-panel.conf"
  cat > "$conf" <<EOF
upstream vps_panel_upstream { server 127.0.0.1:$PORT; keepalive 32; }
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 200m;
    location /ws/ {
        proxy_pass http://vps_panel_upstream;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
    }
    location /api/v1/system/logs/tail/ {
        proxy_pass http://vps_panel_upstream;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
    location / {
        proxy_pass http://vps_panel_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  nginx -t >/dev/null 2>&1 || die "nginx config test failed"
  systemctl enable --now nginx >/dev/null 2>&1
  systemctl reload nginx
  ok "nginx reverse proxy configured for $DOMAIN"
  INSTALLED_COMPONENTS+=("nginx-conf")
}

# ---------------- Let's Encrypt ----------------
setup_ssl() {
  if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    if ! command -v certbot >/dev/null; then
      install_packages certbot python3-certbot-nginx || die "certbot install failed"
    fi
    start_spinner "issuing Let's Encrypt certificate for $DOMAIN..."
    if ! certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --keep-until-expiring; then
      stop_spinner
      warn "Let's Encrypt issuance failed - panel still works on port $PORT (HTTP)"
      return
    fi
    stop_spinner
    ok "Let's Encrypt certificate issued for $DOMAIN"
  else
    ok "certificate already exists for $DOMAIN"
  fi
  # schedule renewal
  if ! grep -q "vps-panel certbot" /etc/crontab 2>/dev/null; then
    echo "17 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx' # vps-panel certbot" >> /etc/crontab
  fi
  INSTALLED_COMPONENTS+=("ssl")
}

# ---------------- update ----------------
do_update() {
  log "=== UPDATE MODE ==="
  print_banner
  detect_distro; detect_arch; detect_systemd
  [ -d "$INSTALL_DIR" ] || die "no existing installation found at $INSTALL_DIR"

  # backup before update (keeps user data safe)
  mkdir -p "$BACKUP_DIR"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  PRE_UPDATE_BACKUP="$BACKUP_DIR/pre-update-$stamp.tar.gz"
  start_spinner "backing up current installation..."
  tar -czf "$PRE_UPDATE_BACKUP" -C /opt "$(basename "$INSTALL_DIR")" 2>/dev/null || die "backup failed - aborting update, nothing changed"
  stop_spinner
  ok "backup created: $PRE_UPDATE_BACKUP (user data preserved)"

  download_source

  start_spinner "applying update..."
  # preserve data dir
  rm -rf /tmp/vps-panel-data-keep
  cp -r "$DATA_DIR" /tmp/vps-panel-data-keep
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -r "$EXTRACTED/." "$INSTALL_DIR/"
  rm -rf "$DATA_DIR"
  cp -r /tmp/vps-panel-data-keep "$DATA_DIR"
  rm -rf /tmp/vps-panel-data-keep
  (cd "$INSTALL_DIR/backend" && PATH="/usr/local/bin:$PATH" npm install --omit=dev --no-audit --no-fund >> "$LOG_FILE" 2>&1) || die "npm install failed after update"
  stop_spinner
  ok "files updated (data dir untouched)"

  panel_enable
  panel_restart
  sleep 2
  if panel_health; then
    ok "update successful - panel is running"
    print_summary
  else
    err "update failed - service unhealthy, restoring backup"
    rollback
    exit 1
  fi
}

# ---------------- uninstall ----------------
do_uninstall() {
  log "=== UNINSTALL MODE ==="
  print_banner
  detect_systemd
  [ -d "$INSTALL_DIR" ] || { err "nothing to uninstall"; exit 0; }
  if [ "$AUTO" != "1" ]; then
    read -r -p "This removes the panel AND its data ($DATA_DIR). Also remove the 'panel' system user? [y/N]: " c
    [ "$c" != "y" ] && [ "$c" != "Y" ] && { echo "aborted"; exit 0; }
  fi
  panel_stop
  [ "$SYSTEMD_OK" = "1" ] && systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  [ "$SYSTEMD_OK" = "1" ] && systemctl daemon-reload 2>/dev/null || true
  rm -f /usr/local/bin/vps-panel-start /usr/local/bin/vps-panel-stop
  rm -rf "$INSTALL_DIR"
  rm -f /etc/fail2ban/jail.d/vps-panel.local /etc/fail2ban/filter.d/vps-panel.conf
  systemctl restart fail2ban 2>/dev/null || true
  rm -f /etc/nginx/conf.d/vps-panel.conf
  systemctl reload nginx 2>/dev/null || true
  userdel panel 2>/dev/null || true
  ok "panel uninstalled"
  echo "  remaining: Node.js at /opt/node20, log at $LOG_FILE, backups at $BACKUP_DIR"
}

# ---------------- summary ----------------
print_summary() {
  local ip_list
  ip_list="$(hostname -I 2>/dev/null | awk '{print $1}')"
  local url
  if [ -n "$DOMAIN" ] && [ "$ENABLE_SSL" = "1" ]; then url="https://$DOMAIN"
  elif [ -n "$DOMAIN" ]; then url="http://$DOMAIN"
  else url="http://$ip_list:$PORT"; fi

  echo ""
  echo -e "${C_GRN}============================================================"
  echo -e "  VPS PANEL INSTALLED SUCCESSFULLY"
  echo -e "============================================================${C_RST}"
  echo ""
  echo -e "  ${C_BLD}URL:${C_RST}        $url"
  echo -e "  ${C_BLD}Direct URL:${C_RST} http://$ip_list:$PORT"
  echo -e "  ${C_BLD}Username:${C_RST}   $ADMIN_USER"
  echo -e "  ${C_BLD}Password:${C_RST}   ${C_YLW}$ADMIN_PASS${C_RST}"
  echo ""
  echo -e "  ${C_BLD}Manage:${C_RST}"
  if [ "$SYSTEMD_OK" = "1" ]; then
    echo "    systemctl status $SERVICE      # check status"
    echo "    systemctl restart $SERVICE     # restart"
    echo "    systemctl stop $SERVICE        # stop"
    echo "    journalctl -u $SERVICE -f      # live logs"
  else
    echo "    vps-panel-start                # start"
    echo "    vps-panel-stop                 # stop"
    echo "    tail -f /var/log/vps-panel.log  # live logs"
  fi
  echo "    tail -f $LOG_FILE              # installer log"
  echo ""
  echo -e "  ${C_BLD}Uninstall:${C_RST}"
  echo "    bash $INSTALL_DIR/install.sh --uninstall"
  echo ""
  echo -e "  ${C_YLW}SECURITY WARNING:${C_RST}"
  echo "    1. Change the admin password immediately after first login."
  echo "    2. Enable 2FA (Two-factor auth) in the user menu."
  echo "    3. Restrict access with firewall / IP whitelist if exposed."
  echo "    4. Keep the panel updated: bash $INSTALL_DIR/install.sh --update"
  echo -e "${C_GRN}============================================================${C_RST}"
  echo ""
}

# ---------------- main ----------------
case "$MODE" in
  install) do_install ;;
  update)  do_update ;;
  uninstall) do_uninstall ;;
esac
