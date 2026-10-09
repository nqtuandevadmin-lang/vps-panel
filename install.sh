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
PANEL_REPO="${PANEL_REPO:-tuancutephomaiquedethuong-code/vps-panel}"
PANEL_VERSION="v1.0.0"           # release tag used for the verified tarball asset
PANEL_BRANCH="main"              # fallback branch if the release asset is missing
ASSET_NAME="vps-panel-${PANEL_VERSION}.tar.gz"
# Generic hosting: set PANEL_BASE_URL (or --base-url) to serve the tarball +
# SHA256SUMS from ANY HTTP location (GitLab, Codeberg, your own VPS, S3, ...).
# Example: PANEL_BASE_URL=https://gitlab.com/you/vps-panel/-/raw/v1.0.0
PANEL_BASE_URL="${PANEL_BASE_URL:-}"
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
   https://github.com/vps-panel/panel
============================================================
EOF
}

# ---------------- progress bar / spinner ----------------
PROGRESS_WIDTH=40
progress() { # progress <percent> <label>
  local pct="$1" label="$2"
  local filled=$(( pct * PROGRESS_WIDTH / 100 ))
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="="; done
  for ((i=filled; i<PROGRESS_WIDTH; i++)); do bar+=" "; done
  printf "\r${C_BLU}[${bar}] %3d%%${C_RST} %-40s" "$pct" "$label"
  [ "$pct" -ge 100 ] && printf "\n"
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
    systemctl restart "$SERVICE" 2>/dev/null || true
    warn "Rollback done. Previous version restored. Broken copy kept at $INSTALL_DIR.broken"
    return
  fi
  if [ "$MODE" = "install" ] && [ "${#INSTALLED_COMPONENTS[@]}" -gt 0 ]; then
    warn "Rolling back partial installation..."
    systemctl stop "$SERVICE" 2>/dev/null || true
    systemctl disable "$SERVICE" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE.service"
    systemctl daemon-reload 2>/dev/null || true
    [ "${KEEP_DATA:-0}" != "1" ] && rm -rf "$INSTALL_DIR"
    warn "Rollback complete. Log kept at $LOG_FILE"
  fi
}
trap 'die "interrupted"' INT TERM
trap 'on_error $?' ERR
on_error() {
  local code=$1
  [ "$code" = "0" ] && return 0
  err "error code $code - see $LOG_FILE"
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

# ---------------- distro & arch detection ----------------
detect_distro() {
  if [ -f /etc/os-release ]; then . /etc/os-release; else die "/etc/os-release not found - unsupported system"; fi
  DISTRO_ID="${ID:-unknown}"; DISTRO_VER="${VERSION_ID:-0}"
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
  if command -v ss >/dev/null; then
    if ss -tuln 2>/dev/null | grep -qE "[:.]$port\b"; then
      return 1
    fi
  elif command -v netstat >/dev/null; then
    if netstat -tuln 2>/dev/null | grep -qE "[:.]$port\b"; then
      return 1
    fi
  else
    # /proc fallback
    local hexport
    hexport="$(printf '%04X' "$port")"
    if grep -qE ".*:$hexport .* 0[0-9A-F]{13}" /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
      return 1
    fi
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
install_packages() {
  local pkgs=("$@")
  local total=${#pkgs[@]} i=0
  start_spinner "installing ${total} packages..."
  if [ "$PKG_MGR" = "apt" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "${pkgs[@]}" >/dev/null
  fi
  stop_spinner
  for p in "${pkgs[@]}"; do
    i=$((i + 1))
    progress $(( i * 100 / total )) "package: $p"
  done
  ok "packages installed: ${pkgs[*]}"
}

# ---------------- node runtime ----------------
install_node() {
  if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
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
  ok "Node.js $(node -v) installed ($(node -p 'process.arch'))"
  INSTALLED_COMPONENTS+=("node20")
}

# ---------------- download & verify source ----------------
download_source() {
  local tmp="/tmp/vps-panel-src.tar.gz"

  # ---- local mode: copy from a directory that already contains the project ----
  if [ -n "$LOCAL_DIR" ]; then
    [ -d "$LOCAL_DIR" ] || die "--local path does not exist: $LOCAL_DIR"
    [ -f "$LOCAL_DIR/install.sh" ] || die "--local path is not a vps-panel checkout: $LOCAL_DIR"
    start_spinner "using local source: $LOCAL_DIR ..."
    rm -rf /tmp/vps-panel-extract
    mkdir -p /tmp/vps-panel-extract/vps-panel-local
    tar -cf - -C "$LOCAL_DIR" \
        --exclude=node_modules --exclude=.git --exclude=data \
        install.sh README.md LICENSE SHA256SUMS backend frontend systemd nginx test publish.sh 2>/dev/null \
      | tar -xf - -C /tmp/vps-panel-extract/vps-panel-local
    stop_spinner
    EXTRACTED="/tmp/vps-panel-extract/vps-panel-local"
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
  else
    raw_base="https://raw.githubusercontent.com/$PANEL_REPO/$PANEL_BRANCH"
    release_url="https://github.com/$PANEL_REPO/releases/download/$PANEL_VERSION/$ASSET_NAME"
    branch_url="https://github.com/$PANEL_REPO/archive/refs/heads/$PANEL_BRANCH.tar.gz"
    sums_url="${raw_base}/SHA256SUMS"
  fi
  rm -f "$tmp"
  start_spinner "downloading verified release asset..."
  # Order: 1) tarball committed in the repo (raw, always reliable)
  #        2) release asset (may be unavailable on some GitHub states)
  #        3) branch tarball (last resort)
  if curl -fL --retry 2 -o "$tmp" "$raw_base/$ASSET_NAME"; then
    SOURCE_KIND="repo tarball ($ASSET_NAME)"
  elif curl -fL --retry 2 -o "$tmp" "$release_url"; then
    SOURCE_KIND="release asset ($ASSET_NAME)"
  else
    warn "asset download failed, falling back to branch tarball ($PANEL_BRANCH)"
    start_spinner "downloading branch tarball..."
    curl -fL --retry 3 -o "$tmp" "$branch_url" || die "cannot download source (set PANEL_REPO=<owner>/<repo> or PANEL_BASE_URL=<url>)"
    SOURCE_KIND="branch tarball ($PANEL_BRANCH)"
  fi
  stop_spinner

  # SHA256 verification (real): compare against SHA256SUMS, with CDN retry
  local sums="/tmp/vps-panel-SHA256SUMS"
  if [ "$FORCE" != "1" ] && curl -fsSL -o "$sums" "$sums_url" 2>/dev/null; then
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

  rm -rf /tmp/vps-panel-extract
  mkdir -p /tmp/vps-panel-extract
  tar -xzf "$tmp" -C /tmp/vps-panel-extract
  rm -f "$tmp"
  EXTRACTED="$(find /tmp/vps-panel-extract -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -z "$EXTRACTED" ] && die "downloaded archive is empty"
  ok "source ready: $EXTRACTED"
}

# ---------------- install ----------------
do_install() {
  log "=== INSTALL MODE ==="
  print_banner

  detect_distro; detect_arch
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
  (cd "$INSTALL_DIR/backend" && npm install --omit=dev --no-audit --no-fund >/dev/null) || die "npm install failed"
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
    ADMIN_PASS="$(PANEL_ROOT="$INSTALL_DIR" PANEL_DATA="$DATA_DIR" node -e "process.stdout.write(require('$INSTALL_DIR/backend/src/auth').randomPassword(18))")"
    [ -n "$ADMIN_PASS" ] || die "failed to generate admin password"
  fi
  local_admin_out="$(PANEL_ROOT="$INSTALL_DIR" PANEL_DATA="$DATA_DIR" node "$INSTALL_DIR/backend/tools/create-admin.js" "$ADMIN_USER" "$ADMIN_PASS" 2>&1)" || die "admin creation failed: $local_admin_out"
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
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  ok "systemd service enabled"
  INSTALLED_COMPONENTS+=("systemd")

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
  systemctl restart "$SERVICE"
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    die "service started but health check failed - check: journalctl -u $SERVICE -n 50"
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
  detect_distro; detect_arch
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
  (cd "$INSTALL_DIR/backend" && npm install --omit=dev --no-audit --no-fund >/dev/null) || die "npm install failed after update"
  stop_spinner
  ok "files updated (data dir untouched)"

  systemctl daemon-reload
  systemctl restart "$SERVICE"
  sleep 2
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
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
  [ -d "$INSTALL_DIR" ] || { err "nothing to uninstall"; exit 0; }
  if [ "$AUTO" != "1" ]; then
    read -r -p "This removes the panel AND its data ($DATA_DIR). Also remove the 'panel' system user? [y/N]: " c
    [ "$c" != "y" ] && [ "$c" != "Y" ] && { echo "aborted"; exit 0; }
  fi
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
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
  echo "    systemctl status $SERVICE      # check status"
  echo "    systemctl restart $SERVICE     # restart"
  echo "    systemctl stop $SERVICE        # stop"
  echo "    journalctl -u $SERVICE -f      # live logs"
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
