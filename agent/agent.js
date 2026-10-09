#!/usr/bin/env node
/**
 * VPS Panel Agent - runs on YOUR VPS and connects it to the panel.
 *
 * Installed by a one-line curl command with a link that expires after 10 minutes:
 *   curl -fsSL "http://<panel>/connect.sh?t=TOKEN" | sudo bash
 *
 * The agent opens an outbound WebSocket to the panel, so no inbound ports and no
 * firewall changes are needed on your server. It executes the PTY sessions and
 * file/system operations locally and streams the results back.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const CFG_CANDIDATES = [
  process.env.AGENT_CONFIG,
  path.join(__dirname, 'config.json'),
  '/opt/vps-panel-agent/config.json',
  '/etc/vps-panel-agent.json',
].filter(Boolean);
const CFG_PATH = CFG_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CFG_PATH) {
  console.error('[agent] no config file found. Re-run the connect command from the panel.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const NODE_ID = cfg.nodeId;
const TOKEN = cfg.token;
const PANEL = cfg.panel.replace(/\/$/, '');
const HOME_ROOT = cfg.homeRoot || os.homedir();

const run = (cmd, args = [], opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, {
    timeout: opts.timeout || 20000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LANG: 'C' },
  }, (err, so, se) => resolve({
    ok: !err, stdout: (so || '').toString(), stderr: (se || '').toString(),
    code: err ? err.code : 0,
  }));
});

// ---------------- PTY (lazy load: only needed once a terminal opens) ----------------
let pty = null;
let ptySessions = new Map(); // sessionId -> pty
const tryLoadPty = () => {
  if (pty) return pty;
  const candidates = ['node-pty', '/opt/vps-panel-agent/node_modules/node-pty'];
  for (const c of candidates) {
    try { pty = require(c); return pty; } catch { /* next */ }
  }
  return null;
};

// ---------------- file helpers (jailed to the owner home) ----------------
function safePath(rel) {
  const abs = path.resolve(HOME_ROOT, '.' + (rel || '/'));
  if (abs !== HOME_ROOT && !abs.startsWith(HOME_ROOT + path.sep)) throw new Error('path escapes home');
  return abs;
}

async function fsList(rel) {
  const abs = safePath(rel);
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    try {
      const st = await fs.promises.stat(path.join(abs, e.name));
      out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st.size, mode: (st.mode & 0o777).toString(8), modified: st.mtimeMs });
    } catch { /* skip */ }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

// ---------------- system info ----------------
function cpuModel() { return (os.cpus()[0] || {}).model || 'unknown'; }
function memInfo() {
  const total = os.totalmem(), free = os.freemem();
  return { total, used: total - free, free, usage: ((total - free) / total) * 100 };
}
function diskInfo() {
  try {
    const st = fs.statfsSync(HOME_ROOT);
    const total = st.blocks * st.bsize, free = st.bfree * st.bsize;
    return { total, used: total - free, usage: ((total - free) / total) * 100 };
  } catch { return { total: 0, used: 0, usage: 0 }; }
}
function publicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', { timeout: 4000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).ip); } catch { resolve(''); } });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

// ---------------- message handling ----------------
async function handle(msg, send) {
  const reply = (payload) => send({ ...payload, replyTo: msg.replyTo });

  switch (msg.type) {
    case 'hello':
      return;

    case 'ping':
      return reply({ type: 'pong', ts: Date.now() });

    case 'system': {
      const ip = await publicIp();
      return reply({
        type: 'result', ok: true,
        data: {
          hostname: os.hostname(), os: `${os.type()} ${os.release()}`, platform: os.platform(),
          arch: os.arch(), cpu: cpuModel(), cores: os.cpus().length,
          mem: memInfo(), disk: diskInfo(), ip,
          uptime: Math.round(os.uptime()), load: os.loadavg(),
          agentVersion: cfg.agentVersion || '1.1.0',
        },
      });
    }

    case 'command': {
      const r = await run('/bin/bash', ['-lc', String(msg.command || '')], { timeout: msg.timeout || 20000 });
      return reply({ type: 'cmd-result', ok: r.ok, stdout: r.stdout.slice(0, 200000), stderr: r.stderr.slice(0, 20000), code: r.code });
    }

    case 'pty-create': {
      const p = tryLoadPty();
      if (!p) return reply({ type: 'result', ok: false, error: 'node-pty is not installed on this VPS (the connect script installs it)' });
      const sid = msg.sessionId || crypto.randomUUID();
      let sock;
      try {
        sock = p.spawn(msg.shell || process.env.SHELL || '/bin/bash', [], {
          name: 'xterm-256color',
          cols: msg.cols || 80, rows: msg.rows || 24,
          cwd: msg.cwd || HOME_ROOT,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
      } catch (e) {
        return reply({ type: 'result', ok: false, error: 'cannot start shell: ' + e.message });
      }
      ptySessions.set(sid, sock);
      sock.onData((d) => send({ type: 'pty-data', sessionId: sid, data: d }));
      sock.onExit(({ exitCode }) => {
        send({ type: 'pty-exit', sessionId: sid, code: exitCode });
        ptySessions.delete(sid);
      });
      return reply({ type: 'pty-created', sessionId: sid });
    }

    case 'pty-forward': {
      const sock = ptySessions.get(msg.sessionId);
      if (!sock) return;
      const pl = msg.payload || {};
      try {
        if (pl.type === 'input') sock.write(String(pl.data || ''));
        else if (pl.type === 'resize') sock.resize(pl.cols | 0 || 80, pl.rows | 0 || 24);
        else if (pl.type === 'kill') sock.kill('SIGKILL');
      } catch { /* session already gone */ }
      return;
    }

    case 'pty-close': {
      const sock = ptySessions.get(msg.sessionId);
      if (sock) { try { sock.kill('SIGKILL'); } catch { /* ignore */ } ptySessions.delete(msg.sessionId); }
      return;
    }

    case 'fs-list':
      return reply({ type: 'fs-result', ok: true, data: await fsList(msg.path || '/') });
    case 'fs-read':
      return reply({ type: 'fs-result', ok: true, data: fs.readFileSync(safePath(msg.path), 'utf8').slice(0, 1024 * 512) });
    case 'fs-write':
      await fs.promises.mkdir(path.dirname(safePath(msg.path)), { recursive: true });
      await fs.promises.writeFile(safePath(msg.path), String(msg.content || ''), 'utf8');
      return reply({ type: 'fs-result', ok: true, data: { bytes: Buffer.byteLength(msg.content || '') } });
    case 'fs-mkdir':
      await fs.promises.mkdir(safePath(msg.path), { recursive: true });
      return reply({ type: 'fs-result', ok: true });
    case 'fs-delete':
      await fs.promises.rm(safePath(msg.path), { recursive: true, force: true });
      return reply({ type: 'fs-result', ok: true });
    case 'fs-rename':
      await fs.promises.rename(safePath(msg.from), safePath(msg.to));
      return reply({ type: 'fs-result', ok: true });
    case 'fs-stat': {
      const st = fs.statfsSync(safePath(msg.path || '/'));
      return reply({ type: 'fs-result', ok: true, data: { path: msg.path, total: st.blocks * st.bsize, free: st.bfree * st.bsize } });
    }

    case 'processes': {
      const out = [];
      for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const close = stat.lastIndexOf(')');
          const comm = stat.slice(stat.indexOf('(') + 1, close);
          const rest = stat.slice(close + 2).split(' ');
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || comm;
          out.push({
            pid: parseInt(pid, 10), ppid: parseInt(rest[1], 10), name: comm, cmd: cmd.slice(0, 300),
            cpu: (parseInt(rest[11], 10) + parseInt(rest[12], 10)) * 100 / os.cpus().length,
            mem: (parseInt(rest[21], 10) || 0) * 4096,
          });
        } catch { /* process vanished */ }
      }
      out.sort((a, b) => b.cpu - a.cpu);
      return reply({ type: 'result', ok: true, data: out.slice(0, 400) });
    }

    case 'process-kill': {
      const pid = parseInt(msg.pid, 10);
      if (!Number.isInteger(pid) || pid <= 1) return reply({ type: 'result', ok: false, error: 'invalid pid' });
      const r = await run('kill', [msg.signal || '-15', String(pid)]);
      return reply({ type: 'result', ok: r.ok, error: r.stderr || undefined });
    }

    case 'services': {
      const r = await run('systemctl', ['list-units', '--type=service', '--no-legend', '--no-pager', '--plain']);
      if (!r.ok) return reply({ type: 'result', ok: false, error: r.stderr || 'systemd not available' });
      const units = r.stdout.split('\n').filter(Boolean).map(l => {
        const p = l.trim().split(/\s+/);
        return { unit: p[0], active: p[2], sub: p[3], desc: p.slice(4).join(' ') };
      });
      return reply({ type: 'result', ok: true, data: units });
    }

    case 'service-action': {
      if (!/^[a-zA-Z0-9@._-]+$/.test(String(msg.unit))) return reply({ type: 'result', ok: false, error: 'invalid unit' });
      const r = await run('systemctl', [msg.action, String(msg.unit)]);
      return reply({ type: 'result', ok: r.ok, output: r.stdout + r.stderr, error: r.ok ? undefined : (r.stderr || 'failed') });
    }

    case 'logs': {
      const args = ['-n', String(msg.lines || 200), '--no-pager'];
      if (msg.unit) args.unshift('-u', String(msg.unit).replace(/[^a-zA-Z0-9@._-]/g, ''));
      const r = await run('journalctl', args);
      return reply({ type: 'result', ok: true, content: (r.stdout || r.stderr || '') });
    }

    case 'cron-list': {
      const r = await run('crontab', ['-l']);
      return reply({ type: 'result', ok: true, data: r.ok ? r.stdout.split('\n').filter(l => l.trim() && !l.startsWith('#')) : [] });
    }
    case 'cron-add': {
      const cur = await run('crontab', ['-l']);
      const line = `${String(msg.schedule).replace(/[^\s*/,-]/g, '')} ${String(msg.command).replace(/[\n\r]/g, ' ').slice(0, 400)}\n`;
      await new Promise((res) => { const p = execFile('crontab', ['-'], () => res()); p.stdin.end((cur.ok ? cur.stdout : '') + line); });
      return reply({ type: 'result', ok: true, line });
    }

    case 'packages': {
      const r = await run('dpkg-query', ['-W', '-f=${binary:Package}\\t${Version}\\n']).catch(() => ({ ok: false, stdout: '' }));
      if (!r.ok) return reply({ type: 'result', ok: false, error: 'unsupported package manager' });
      const list = r.stdout.split('\n').filter(Boolean).map(l => {
        const [name, version] = l.split('\t');
        return { name, version, status: 'installed' };
      });
      const q = String(msg.query || '').toLowerCase();
      return reply({ type: 'result', ok: true, data: q ? list.filter(p => p.name.toLowerCase().includes(q)).slice(0, 200) : list.slice(0, 300) });
    }

    case 'firewall-status': {
      const r = await run('ufw', ['status']);
      return reply({ type: 'result', ok: r.ok, output: r.stdout || r.stderr });
    }

    default:
      return reply({ type: 'result', ok: false, error: `unknown agent command: ${msg.type}` });
  }
}

// ---------------- connection loop ----------------
let ws = null;
let backoff = 1000;

function connect() {
  const url = PANEL.replace(/^http/, 'ws') + `/ws/agent?node=${encodeURIComponent(NODE_ID)}&token=${encodeURIComponent(TOKEN)}`;
  ws = new WebSocketShim(url);
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  ws.onopen = async () => {
    backoff = 1000;
    const sys = await handle({ type: 'system' }, send);
    send({
      type: 'hello',
      meta: {
        name: os.hostname(), os: `${os.type()} ${os.release()}`, arch: os.arch(),
        cpu: cpuModel(), cores: os.cpus().length, mem: memInfo(), disk: diskInfo(),
        ip: await publicIp(), agentVersion: cfg.agentVersion || '1.1.0',
      },
    });
    console.log(`[agent] connected to ${PANEL} at ${new Date().toISOString()}`);
    // heartbeat
    setInterval(() => send({ type: 'ping', replyTo: crypto.randomUUID() }), 30000);
  };

  ws.onmessage = async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    try { await handle(m, send); } catch (e) {
      send({ type: 'result', ok: false, error: e.message, replyTo: m.replyTo });
    }
  };

  ws.onclose = () => {
    console.log(`[agent] disconnected, retrying in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

// Minimal WebSocket client (no dependencies on the target VPS)
class WebSocketShim {
  constructor(url) {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const mod = require('crypto').createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.readyState = 0;
    const client = u.protocol === 'wss:' ? https : http;
    const req = client.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: u.pathname + u.search, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      this.socket = socket;
      this.readyState = 1;
      this.buffer = Buffer.alloc(0);
      socket.on('data', (d) => this._onData(d));
      socket.on('close', () => { this.readyState = 3; this.onclose && this.onclose(); });
      socket.on('error', () => { this.readyState = 3; this.onerror && this.onerror(); });
      this.onopen && this.onopen();
    });
    req.on('error', (e) => {
      this.readyState = 3;
      if (!this._opened) { this.onerror && this.onerror(e); this.onclose && this.onclose(); }
    });
    req.end();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b1 = this.buffer[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); off = 10; }
      if (this.buffer.length < off + len) return;
      const payload = this.buffer.slice(off, off + len).toString('utf8');
      this.buffer = this.buffer.slice(off + len);
      const opcode = this.buffer.length ? 0 : 0;
      if ((b1 & 0x80) === 0x80) this.onmessage && this.onmessage(payload);
      if (opcode === 8) { try { this.socket.end(); } catch { /* ignore */ } }
    }
  }

  send(str) {
    if (this.readyState !== 1) return;
    const data = Buffer.from(str, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x81, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    try { this.socket.write(Buffer.concat([header, mask, masked])); } catch { /* closed */ }
  }

  close() { try { this.socket && this.socket.end(); } catch { /* ignore */ } }
}

console.log(`[agent] vps-panel agent ${cfg.agentVersion || '1.1.0'} starting, node=${NODE_ID}`);
connect();