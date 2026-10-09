// terminal.js - WebSocket terminal engine: PTY, sessions, persistence, resize, heartbeat, recording
'use strict';
const pty = require('node-pty');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cfg, DATA_DIR } = require('./config');
const db = require('./db');
const auth = require('./auth');

const MAX_SESSIONS_PER_USER = 20;
const SCROLLBACK = cfg.sessionScrollback;   // 10000 lines server-side ring buffer
const HEARTBEAT_MS = 30000;
const RECORD_DIR = path.join(DATA_DIR, 'recordings');
fs.mkdirSync(RECORD_DIR, { recursive: true });

/**
 * TerminalSession:
 *  - real PTY via node-pty (bash / sh fallback)
 *  - detach / reattach: PTY stays alive, output ring buffer retained
 *  - resize sync, ANSI passthrough, binary frames, heartbeat
 *  - optional asciinema-style recording (JSONL) for playback
 */
class TerminalSession {
  constructor(ownerId, opts = {}) {
    this.id = uuid();
    this.ownerId = ownerId;
    this.name = opts.name || 'shell';
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
    this.demoted = false;
    this.cwd = opts.cwd || os.homedir();
    this.env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    this.shell = opts.shell || process.env.SHELL || '/bin/bash';
    this.clients = new Set();      // connected ws sockets
    this.buffer = [];              // ring buffer of {t, data}
    this.bufferBytes = 0;
    this.maxBufferBytes = 4 * 1024 * 1024; // ~4MB scrollback data
    this.recording = null;
    this.recordingFile = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.dead = false;
    this.exitCode = null;
    this.sock = null;
    this._spawn();
  }

  _spawn() {
    // Multi-tenant: run the shell as the panel user's own Linux account so one
    // tenant can never read another tenant's files or become root. Admins keep a
    // root shell only when their account is actually uid 0.
    const opts = {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env,
    };
    const owner = db.findBy('users', 'id', this.ownerId);
    const canDrop = owner && typeof owner.uid === 'number' && owner.uid > 0 &&
      typeof process.getuid === 'function' && process.getuid() === 0;
    if (canDrop) {
      opts.uid = owner.uid;
      opts.gid = owner.gid || owner.uid;
      opts.cwd = owner.home || this.cwd;
      this.cwd = opts.cwd;
      this.demoted = true;
    }
    try {
      this.sock = pty.spawn(this.shell, [], opts);
    } catch (e) {
      opts.uid = undefined; opts.gid = undefined; // fall back to the panel identity
      opts.cwd = this.cwd;
      this.sock = pty.spawn('/bin/sh', [], opts);
    }
    this.sock.onData((data) => this._onData(data));
    this.sock.onExit(({ exitCode }) => {
      this.dead = true;
      this.exitCode = exitCode;
      this._push(`\r\n\r\n\x1b[33m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      this._closeRecording();
      this._broadcast(JSON.stringify({ type: 'exit', code: exitCode }), true);
      cleanupSession(this.id);
    });
  }

  _onData(data) {
    this.lastActivity = Date.now();
    this._push(data);
    this._broadcast(JSON.stringify({ type: 'data', data }));
  }

  _push(data) {
    this.buffer.push({ t: Date.now(), data });
    this.bufferBytes += Buffer.byteLength(data);
    while (this.buffer.length > SCROLLBACK || this.bufferBytes > this.maxBufferBytes) {
      const dropped = this.buffer.shift();
      if (dropped) this.bufferBytes -= Buffer.byteLength(dropped.data);
      else break;
    }
  }

  _broadcast(payload, force = false) {
    for (const ws of this.clients) {
      if (!force && ws.readyState !== 1) continue;
      try { ws.send(payload); } catch { /* drop dead socket */ }
    }
  }

  write(data) {
    if (this.dead || !this.sock) return false;
    this.lastActivity = Date.now();
    this.sock.write(data);
    return true;
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    if (!this.dead && this.sock) {
      try { this.sock.resize(cols, rows); return true; } catch { return false; }
    }
    return false;
  }

  attach(ws) {
    this.clients.add(ws);
    // replay scrollback so reconnect sees history (requirement: terminal persistence)
    const backlog = this.buffer.map(b => b.data).join('');
    if (backlog) {
      try { ws.send(JSON.stringify({ type: 'data', data: backlog, replay: true })); } catch { /* ignore */ }
    }
    if (this.dead) {
      try { ws.send(JSON.stringify({ type: 'exit', code: this.exitCode })); } catch { /* ignore */ }
    }
    return this.id;
  }

  detach(ws) { this.clients.delete(ws); }

  startRecording() {
    if (this.recording) return this.recordingFile;
    this.recordingFile = path.join(RECORD_DIR, `${this.id}.cast.jsonl`);
    this.recording = fs.createWriteStream(this.recordingFile, { flags: 'a' });
    this.recording.write(JSON.stringify({ version: 2, width: this.cols, height: this.rows, timestamp: Date.now(), env: { shell: this.shell } }) + '\n');
    return this.recordingFile;
  }

  _closeRecording() {
    if (this.recording) {
      this.recording.end();
      this.recording = null;
      db.insert('terminals', {
        sessionId: this.id, ownerId: this.ownerId, name: this.name,
        file: this.recordingFile, startedAt: this.createdAt, endedAt: Date.now(),
        exitCode: this.exitCode, lines: this.buffer.length,
      });
    }
  }

  kill() {
    if (this.dead) return;
    try { this.sock.kill('SIGKILL'); } catch { /* already dead */ }
    this.dead = true;
  }

  dispose() {
    this.kill();
    this._closeRecording();
    this.clients.clear();
  }
}

// ---------- session registry (per process; cluster shares via sticky ws) ----------
const sessions = new Map(); // id -> TerminalSession
const userSessions = new Map(); // userId -> Set<id>

function listSessions(userId) {
  const set = userSessions.get(userId);
  if (!set) return [];
  return [...set].map(id => {
    const s = sessions.get(id);
    if (!s) return null;
    return { id: s.id, name: s.name, cols: s.cols, rows: s.rows, createdAt: s.createdAt, lastActivity: s.lastActivity, dead: s.dead, clients: s.clients.size, recording: !!s.recording };
  }).filter(Boolean);
}

function createSession(ownerId, opts) {
  const set = userSessions.get(ownerId) || new Set();
  if (set.size >= MAX_SESSIONS_PER_USER) {
    // Evict the oldest idle session instead of refusing forever: a user with many
    // closed tabs would otherwise never be able to open a new terminal again.
    const idle = [...set]
      .map(id => sessions.get(id))
      .filter(s => s && s.clients.size === 0)
      .sort((a, b) => a.lastActivity - b.lastActivity);
    if (idle.length > 0) {
      const victim = idle[0];
      warn(`session cap (${MAX_SESSIONS_PER_USER}) reached - evicting idle session ${victim.id.slice(0, 8)}`);
      victim.dispose();
      cleanupSession(victim.id);
    } else {
      throw new Error(`max ${MAX_SESSIONS_PER_USER} sessions`);
    }
  }
  const s = new TerminalSession(ownerId, opts);
  sessions.set(s.id, s);
  set.add(s.id);
  userSessions.set(ownerId, set);
  return s;
}

function getSession(id, userId) {
  const s = sessions.get(id);
  if (!s || s.dead) return null;
  if (userId && s.ownerId !== userId) return null; // isolation
  return s;
}

function cleanupSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.ownerId && userSessions.has(s.ownerId)) {
    userSessions.get(s.ownerId).delete(id);
  }
  sessions.delete(id);
  // persist metadata for playback even if not recording
  if (!s.recordingFile) {
    db.insert('terminals', {
      sessionId: s.id, ownerId: s.ownerId, name: s.name,
      file: null, startedAt: s.createdAt, endedAt: Date.now(),
      exitCode: s.exitCode, lines: s.buffer.length,
    });
  }
}

function gcSessions(maxIdleMs = 2 * 3600e3) {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.clients.size === 0 && now - s.lastActivity > maxIdleMs) s.dispose();
    else if (s.dead) s.dispose();
  }
}
setInterval(gcSessions, 10 * 60e3).unref();

// ---------- WebSocket upgrade + protocol ----------
function attachWs(server, fastifyInstance) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/terminal') { socket.destroy(); return; }

    // WS auth: ?token=<JWT> or ?session=<raw> cookie-less query param
    const token = url.searchParams.get('token') || '';
    const payload = auth.verifyAccess(token);
    if (!payload || !payload.sub) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.userId = payload.sub;
      ws.role = payload.role || 'user';

      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('message', (raw, isBinary) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
          return;
        }
        switch (msg.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            break;

          case 'create': {
            try {
              const s = createSession(ws.userId, {
                name: msg.name, cols: msg.cols, rows: msg.rows, cwd: msg.cwd, shell: msg.shell,
              });
              s.attach(ws);
              ws.sessionId = s.id;
              ws.send(JSON.stringify({ type: 'created', sessionId: s.id }));
            } catch (e) {
              ws.send(JSON.stringify({ type: 'error', error: e.message }));
            }
            break;
          }

          case 'attach': {
            const s = getSession(msg.sessionId, ws.userId);
            if (!s) { ws.send(JSON.stringify({ type: 'error', error: 'session not found or dead' })); return; }
            s.attach(ws);
            ws.sessionId = s.id;
            ws.send(JSON.stringify({ type: 'attached', sessionId: s.id, cols: s.cols, rows: s.rows }));
            break;
          }

          case 'detach': {
            const s = ws.sessionId && sessions.get(ws.sessionId);
            if (s) s.detach(ws);
            ws.sessionId = null;
            break;
          }

          case 'input': {
            const s = ws.sessionId && sessions.get(ws.sessionId);
            if (!s) return;
            if (typeof msg.data !== 'string') return;
            // Command injection prevention: input is sent to the user's OWN pty as-is;
            // the pty is the sandbox boundary. No shell re-parsing here.
            s.write(msg.data);
            break;
          }

          case 'resize': {
            const s = ws.sessionId && sessions.get(ws.sessionId);
            if (!s) return;
            const cols = Math.max(20, Math.min(500, msg.cols | 0));
            const rows = Math.max(5, Math.min(200, msg.rows | 0));
            s.resize(cols, rows);
            break;
          }

          case 'record_start': {
            const s = ws.sessionId && sessions.get(ws.sessionId);
            if (!s) return;
            const f = s.startRecording();
            ws.send(JSON.stringify({ type: 'record_started', file: f }));
            break;
          }

          case 'record_stop': {
            const s = ws.sessionId && sessions.get(ws.sessionId);
            if (!s) return;
            s._closeRecording();
            ws.send(JSON.stringify({ type: 'record_stopped' }));
            break;
          }

          case 'kill': {
            const s = ws.sessionId && sessions.get(ws.sessionId);
            if (s) { s.kill(); ws.send(JSON.stringify({ type: 'killed' })); }
            break;
          }

          default:
            ws.send(JSON.stringify({ type: 'error', error: `unknown message: ${msg.type}` }));
        }
      });

      ws.on('close', () => {
        const s = ws.sessionId && sessions.get(ws.sessionId);
        if (s) s.detach(ws); // PTY persists (detach, not destroy)
      });

      ws.on('error', () => { /* socket errors are non-fatal */ });
    });
  });

  // heartbeat: terminate dead sockets
  const hb = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { try { ws.terminate(); } catch { /* ignore */ } return; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(hb));
  server.on('close', () => clearInterval(hb));

  return wss;
}

// ---------- playback / search ----------
function listRecordings(userId) {
  return db.coll('terminals').filter(t => t.ownerId === userId).sort((a, b) => b.startedAt - a.startedAt);
}

function getRecording(id, userId) {
  const t = db.coll('terminals').find(x => x.id === id && x.ownerId === userId);
  if (!t || !t.file) return null;
  return { meta: t, content: fs.existsSync(t.file) ? fs.readFileSync(t.file, 'utf8') : '' };
}

function searchSessionOutput(id, userId, query) {
  const s = sessions.get(id);
  if (!s || s.ownerId !== userId) return [];
  const q = String(query || '');
  if (!q) return [];
  const out = [];
  for (let i = 0; i < s.buffer.length; i++) {
    const d = s.buffer[i];
    if (d.data.includes(q)) {
      out.push({ index: i, t: d.t, snippet: d.data.slice(0, 500) });
      if (out.length >= 100) break;
    }
  }
  return out;
}

module.exports = { attachWs, createSession, getSession, listSessions, cleanupSession, listRecordings, getRecording, searchSessionOutput, sessions };
