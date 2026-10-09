#!/usr/bin/env bash
# VPS Panel - connect this VPS to a panel.
# The link works once and expires 10 minutes after it was created.
# Usage (given by the panel):  curl -fsSL "http://panel/connect.sh?t=TOKEN" | sudo bash
set -Eeuo pipefail

AGENT_DIR="/opt/vps-panel-agent"
CFG="$AGENT_DIR/config.json"
LOG="/var/log/vps-panel-agent.log"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; CYN='\033[0;36m'; RST='\033[0m'
ok()   { echo -e "${GRN}[ OK ]${RST} $*"; }
warn() { echo -e "${YLW}[WARN]${RST} $*"; }
die()  { echo -e "${RED}[FAIL]${RST} $*"; exit 1; }

[ "$EUID" -ne 0 ] && die "run with sudo (or pipe to sudo bash)"

PANEL_BASE="__PANEL_BASE__"
TOKEN="__TOKEN__"
NODE_ID="__NODE_ID__"
AGENT_URL="__AGENT_URL__"

echo ""
echo "============================================================"
echo "  VPS Panel - connecting this VPS"
echo "============================================================"

# ---- 1. validate the connect token (10 minute lifetime) ----
echo -e "${CYN}[1/5]${RST} Checking the connect link..."
VALID=$(curl -fsS --max-time 20 "$PANEL_BASE/api/v1/connect/token/$TOKEN" 2>/dev/null) \
  || die "the connect link is invalid or has expired. Ask the panel owner for a new one (links last 10 minutes)."
echo "$VALID" | grep -q '"ok":true' || die "the connect link is no longer valid: $VALID"
ok "connect link valid, expires in $(echo "$VALID" | sed -n 's/.*"expiresInSec":\([0-9]*\).*/\1/p')s"

# ---- 2. dependencies ----
echo -e "${CYN}[2/5]${RST} Checking dependencies..."
MISSING=""
for c in curl node; do command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"; done
if [ -n "$MISSING" ]; then
  warn "installing:$MISSING"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates nodejs npm >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates nodejs npm >/dev/null 2>&1 || true
  fi
fi
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v node >/dev/null 2>&1 || die "node is required (apt-get install nodejs)"

# node-pty is only needed for terminal sessions
echo -e "${CYN}[3/5]${RST} Preparing the terminal engine..."
mkdir -p "$AGENT_DIR"
if [ ! -d "$AGENT_DIR/node_modules/node-pty" ]; then
  if ! command -v gcc >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential python3 >/dev/null 2>&1 || true
    fi
  fi
  (cd "$AGENT_DIR" && npm init -y >/dev/null 2>&1 && npm install node-pty --no-audit --no-fund >/dev/null 2>&1) \
    || warn "node-pty could not be installed - file tools still work, terminal will report an error"
fi
ok "dependencies ready"

# ---- 4. download the agent ----
echo -e "${CYN}[4/5]${RST} Downloading the agent..."
curl -fsSL --max-time 60 "$AGENT_URL" -o "$AGENT_DIR/agent.js" || die "cannot download the agent from $AGENT_URL"
chmod 644 "$AGENT_DIR/agent.js"

cat > "$CFG" <<EOF
{
  "panel": "$PANEL_BASE",
  "token": "$TOKEN",
  "nodeId": "$NODE_ID",
  "homeRoot": "$HOME",
  "agentVersion": "1.1.0",
  "connectedAt": "$(date -Is)"
}
EOF
chmod 600 "$CFG"
ok "agent installed in $AGENT_DIR"

# ---- 5. service ----
echo -e "${CYN}[5/5]${RST} Starting the agent..."
cat > /etc/systemd/system/vps-panel-agent.service <<EOF
[Unit]
Description=VPS Panel Agent (remote node connector)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=AGENT_CONFIG=$CFG
ExecStart=/usr/bin/env node $AGENT_DIR/agent.js
Restart=always
RestartSec=5
User=$USER
WorkingDirectory=$AGENT_DIR
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=multi-user.target
EOF

if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable vps-panel-agent >/dev/null 2>&1
  systemctl restart vps-panel-agent
  sleep 2
  if systemctl is-active --quiet vps-panel-agent; then
    ok "agent service running (survives reboot)"
  else
    warn "service did not report active - check: journalctl -u vps-panel-agent -n 30"
  fi
else
  # no systemd: run with nohup and a cron @reboot entry
  AGENT_CONFIG="$CFG" nohup /usr/bin/env node "$AGENT_DIR/agent.js" >> "$LOG" 2>&1 &
  disown 2>/dev/null || true
  grep -q 'vps-panel-agent' /etc/crontab 2>/dev/null || echo "AGENT_CONFIG=$CFG @reboot $USER /usr/bin/env node $AGENT_DIR/agent.js # vps-panel-agent" >> /etc/crontab
  ok "agent started in background (no systemd on this host)"
fi

echo ""
echo -e "${GRN}============================================================"
echo "  THIS VPS IS NOW CONNECTED"
echo -e "============================================================${RST}"
echo "  Node:   $NODE_ID"
echo "  Log:    tail -f $LOG"
echo "  Stop:   systemctl stop vps-panel-agent"
echo "  Remove: systemctl disable --now vps-panel-agent && rm -rf $AGENT_DIR"
echo ""
echo "  Go back to the panel to open the terminal."
echo ""