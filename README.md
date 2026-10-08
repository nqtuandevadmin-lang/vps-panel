# VPS Panel

Web-based VPS control panel with a real terminal, file manager, process & service control, firewall, packages, cron, backups, SSL, and more.

![stack](https://img.shields.io/badge/stack-Node20%20%2B%20Fastify%20%2B%20node--pty%20%2B%20ws-blue)
![license](https://img.shields.io/badge/license-MIT-green)

## Quick install (one command)

```bash
bash <(curl -sSL https://raw.githubusercontent.com/vps-panel/panel/main/install.sh)
```

Options:

```bash
bash <(curl -sSL .../install.sh) --port 9000 --domain panel.example.com --ssl
bash <(curl -sSL .../install.sh) --update      # keep data, update code
bash <(curl -sSL .../install.sh) --uninstall   # remove
bash <(curl -sSL .../install.sh) --auto        # non-interactive (CI/CD)
```

Supported: **Ubuntu 20.04/22.04/24.04**, **Debian 11/12**, **x64 and arm64** (Oracle Cloud ARM included).

## Features

- **Terminal** - real PTY (node-pty) over WebSocket: resize sync, detach/reattach (session persists), multi-session, recording, 10000-line scrollback, vim/htop/tmux work natively
- **File manager** - list/read/edit/upload/download/compress/extract with path jail and upload validation
- **System** - CPU/mem/disk/load realtime charts, process list & kill, systemd service control
- **Admin** - panel users (roles: admin/user/viewer), system users, firewall (ufw/firewalld), packages (apt/dnf), cron, logs (journalctl + SSE tail)
- **Ops** - daily backups + restore, Docker manager, Nginx config editor, Let's Encrypt SSL
- **Security** - JWT + bcrypt(cost 12) + TOTP 2FA + backup codes, session management, API keys, CSRF, rate limit per IP, brute-force lockout, audit log, security headers, IP allow/deny lists

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 LTS | ships on most distros or installed by installer in ~20s; single process, low RAM (~60MB) |
| Backend | Fastify 4 | fastest mainstream Node framework, schema validation, good plugin ecosystem |
| Terminal | node-pty + ws | real kernel PTY (not a fake shell), binary WebSocket frames, permessage-deflate |
| Frontend | Vanilla ES2022 + xterm.js 5.5.0 | zero build step, < 300KB, instant load, 11 CSS themes |
| Storage | Atomic JSON store | no native compile, survives crashes (fsync + rename), allowed by spec |
| Auth | JWT (HS256) + bcrypt + otplib | stateless API auth, strong password hashing, real TOTP |

RAM: ~50-70MB idle. Startup: < 500ms. Cluster mode (`--cluster`) uses all CPU cores.

## Project layout

```
install.sh              one-command installer (60 checks/features)
backend/
  src/index.js          server bootstrap (cluster, WS, schedulers, graceful shutdown)
  src/config.js         env + config file + secrets (0600)
  src/db.js             atomic JSON DB + migrations + audit + notify
  src/auth.js           JWT, bcrypt, TOTP, sessions, API keys, brute-force
  src/terminal.js       PTY session engine (persist, resize, record, search)
  src/lib/middleware.js security headers, CORS, CSRF, rate limit, roles
  src/lib/system.js     /proc-based system introspection (no fake data)
  src/lib/files.js      file manager with root-jail
  src/routes/*.js       auth, system, files, ops APIs (/api/v1)
  tools/create-admin.js first-admin bootstrap (bcrypt)
frontend/
  index.html            SPA shell (login + app: sidebar, topbar, tabs, drawer)
  css/app.css           design tokens + 11 themes + full component library
  js/app.js             router, 20 views, charts, modals, toasts
  js/terminal.js        xterm.js integration (reconnect, heartbeat, recording)
  sw.js                 PWA service worker (offline app shell)
systemd/vps-panel.service
nginx/vps-panel.conf    reverse proxy + WebSocket upgrade template
```

## API

REST: `/api/v1/...` - see `/api/v1/docs` (OpenAPI 3). WebSocket: `/ws/terminal?token=<JWT>`.
Prometheus metrics: `/api/v1/metrics`. Health: `/health`.

```bash
curl -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"..."}'
# -> tokens.access (JWT, 15m) + tokens.refresh (7d)
curl http://localhost:8080/api/v1/system/overview -H "Authorization: Bearer <token>"
```

## Development

```bash
cd backend && npm install
node src/index.js                 # start on :8080
node test/api.test.js             # API integration tests
node test/terminal.test.js        # WebSocket + PTY tests
```

## Security notes

- Default: HTTP on the install port. Use `--domain --ssl` for HTTPS (Let's Encrypt).
- First registered user becomes admin. Change the password and enable 2FA immediately.
- Panel actions that touch the system (systemctl, useradd, ufw, apt) run via `sudo -n` - grant the `panel` user a restricted sudoers entry (installer configures nothing automatically beyond standard groups; add: `panel ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/apt-get, /usr/sbin/ufw, /usr/sbin/useradd, /usr/sbin/userdel, /usr/bin/docker, /usr/bin/docker *`).
- Secrets are stored in `data/secrets.json` (mode 0600).

## License

MIT
