// routes/nodes.js - Connected VPS nodes: 10-minute connect links, node registry,
// agent WebSocket endpoint, and command/PTY proxying to the node (never local).
'use strict';
const crypto = require('crypto');
const { execFile } = require('child_process');
const { cfg } = require('../config');
const db = require('../db');
const { clientIp, requireRole } = require('../lib/middleware');

const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes, as specified
const nodes = new Map(); // nodeId -> { id, ws, meta, connectedAt, lastSeen, ownerId }

// ---------- connect links ----------
function newConnectToken({ note = '', ttlMs = CONNECT_TOKEN_TTL_MS } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const rec = db.insert('connectTokens', {
    token, note: String(note || '').slice(0, 120),
    createdAt: Date.now(), expiresAt: Date.now() + ttlMs,
    usedAt: null, usedBy: null, revoked: false,
  });
  return rec;
}
function tokenState(rec) {
  if (!rec || rec.revoked) return 'revoked';
  if (rec.usedAt) return 'used';
  if (rec.expiresAt < Date.now()) return 'expired';
  return 'active';
}
function gcTokens() {
  const cutoff = Date.now() - 864e5;
  db.coll('connectTokens').forEach(t => {
    const keep = t.expiresAt > Date.now() || (t.createdAt || 0) > cutoff;
    if (!keep) { /* drop nothing automatically: audit history matters */ }
  });
  db.save();
}

// ---------- curl command for a node ----------
// Build the panel base URL from the request, never from a broken config value.
function requestBase(req) {
  if (typeof cfg.url === 'string' && /^https?:\/\//.test(cfg.url)) return cfg.url.replace(/\/$/, '');
  const headers = (req && req.headers) || {};
  const host = String(headers['x-forwarded-host'] || headers.host || `127.0.0.1:${cfg.port}`).split(',')[0].trim();
  const proto = String(headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function curlCommand(rec, baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const endpoint = /^https?:\/\//.test(base) ? `${base}/connect.sh` : `http://127.0.0.1:${cfg.port}/connect.sh`;
  return `curl -fsSL "${endpoint}?t=${rec.token}" | sudo bash`;
}

// Routes used by the connect script BEFORE the agent is installed (no auth).
async function publicNodeRoutes(app) {
  app.get('/connect/token/:token', async (req, reply) => {
    const rec = db.findBy('connectTokens', 'token', String(req.params.token || ''));
    const state = tokenState(rec);
    if (state !== 'active') {
      return reply.code(403).send({ ok: false, state, error: state === 'expired' ? 'this connect link has expired (links last 10 minutes)' : `connect link ${state}` });
    }
    return {
      ok: true, state,
      panel: { name: cfg.name || 'VPS Panel', version: '1.1.0' },
      agentDownloadUrl: `${requestBase(req)}/agent.js`,
      expiresInSec: Math.max(0, Math.floor((rec.expiresAt - Date.now()) / 1000)),
      note: rec.note,
    };
  });
}

async function nodeRoutes(app, opts) {

  // Admin: mint a connect link (10-minute lifetime)
  app.post('/nodes/connect-link', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const { note } = req.body || {};
    const rec = newConnectToken({ note });
    db.audit(req.user.id, 'node.connect-link', rec.token.slice(0, 8), 'ok', { note: rec.note });
    const base = requestBase(req);
    return {
      ok: true,
      token: rec.token,
      expiresAt: rec.expiresAt,
      expiresInMin: CONNECT_TOKEN_TTL_MS / 60000,
      curl: curlCommand(rec, base),
      copy: curlCommand(rec, base),
    };
  });

  app.get('/nodes/connect-links', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const base = requestBase(req);
    return {
      ok: true,
      links: db.coll('connectTokens')
        .slice(-50).reverse()
        .map(t => ({
          id: t.id, note: t.note, state: tokenState(t),
          createdAt: t.createdAt, expiresAt: t.expiresAt, usedAt: t.usedAt, usedBy: t.usedBy,
          curl: tokenState(t) === 'active' ? curlCommand(t, base) : null,
        })),
    };
  });

  app.delete('/nodes/connect-links/:id', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const t = db.findBy('connectTokens', 'id', req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    db.remove('connectTokens', t.id);
    db.audit(req.user.id, 'node.connect-link.delete', t.token.slice(0, 8), 'ok');
    return { ok: true };
  });

  // Node registry
  app.get('/nodes', { preHandler: [opts.authMw] }, async (req) => {
    const out = [...nodes.values()].map(n => ({
      id: n.id, name: n.meta.name, os: n.meta.os, arch: n.meta.arch,
      ip: n.meta.ip, provider: n.meta.provider, cpu: n.meta.cpu, mem: n.meta.mem,
      connectedAt: n.connectedAt, lastSeen: n.lastSeen, sessions: n.sessions || 0,
      agentVersion: n.meta.agentVersion,
    }));
    const saved = db.coll('nodes').map(n => ({ ...n, online: nodes.has(n.id) }));
    const merged = saved.length ? saved.map(s => {
      const live = out.find(o => o.id === s.id);
      return live ? { ...s, ...live, online: true } : { ...s, online: false };
    }) : out;
    return { ok: true, nodes: merged, online: out.length };
  });

  app.delete('/nodes/:id', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const n = nodes.get(req.params.id);
    if (n && n.ws) { try { n.ws.close(); } catch { /* ignore */ } }
    nodes.delete(req.params.id);
    db.remove('nodes', req.params.id);
    db.audit(req.user.id, 'node.delete', req.params.id, 'ok');
    return { ok: true };
  });

  // Proxy a simple command to a node (used by the dashboard / health checks)
  app.post('/nodes/:id/command', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const n = nodes.get(req.params.id);
    if (!n || n.ws.readyState !== 1) return reply.code(400).send({ error: 'node is offline' });
    const cmd = String(req.body?.command || '');
    if (!cmd || cmd.length > 500) return reply.code(400).send({ error: 'invalid command' });
    const res = await proxy(n, { type: 'command', command: cmd }, 20000);
    db.audit(req.user.id, 'node.command', req.params.id, 'ok', { command: cmd.slice(0, 80) });
    return res;
  });
}

// ---------- agent WebSocket ----------
function attachAgentWs(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/agent') return;  // /ws/terminal is owned by terminal.js
    req.__panelWsHandled = true;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const nodeId = url.searchParams.get('node') || '';
      const token = url.searchParams.get('token') || '';
      const rec = db.findBy('connectTokens', 'token', token);
      if (!rec || rec.revoked || rec.expiresAt < Date.now()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      // The token binds to the first node that uses it. Later reconnects from the
      // same node (network blips, reboots) keep working; another node is refused.
      if (rec.nodeId && rec.nodeId !== nodeId) {
        socket.write('HTTP/1.1 409 Already In Use\r\n\r\n');
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      rec.nodeId = nodeId;
      rec.usedAt = rec.usedAt || Date.now();
      rec.ownerId = rec.ownerId || rec.createdBy || null;
      db.save();
      const node = {
        id: nodeId, ws, meta: {}, connectedAt: Date.now(), lastSeen: Date.now(),
        ownerId: rec.ownerId, sessions: 0, pending: new Map(), sessionMap: new Map(),
      };
      nodes.set(nodeId, node);
      ws.on('message', (raw) => handleAgentMessage(node, raw));
      ws.on('close', () => {
        nodes.delete(nodeId);
        db.coll('nodes').forEach(n => { if (n.id === nodeId) { n.lastSeen = Date.now(); n.online = false; db.save(); } });
      });
      ws.on('error', () => { /* socket errors are non-fatal */ });
      ws.send(JSON.stringify({ type: 'welcome', nodeId, panel: 'vps-panel' }));
    });
  });

  return wss;
}

function handleAgentMessage(node, raw) {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  node.lastSeen = Date.now();
  switch (m.type) {
    case 'hello':
      node.meta = { ...m.meta, agentVersion: m.meta?.agentVersion };
      const existing = db.findBy('nodes', 'id', node.id);
      if (existing) Object.assign(existing, { ...node.meta, lastSeen: Date.now(), online: true });
      else db.insert('nodes', { id: node.id, name: m.meta?.name || node.id, ...node.meta, lastSeen: Date.now(), online: true });
      db.notify('node', 'VPS connected', `${m.meta?.name || node.id} is now connected`);
      return;
    case 'pty-data': case 'pty-exit': case 'pty-created': case 'fs-result': case 'cmd-result': case 'result': {
      const cb = node.pending.get(m.replyTo);
      if (cb) { node.pending.delete(m.replyTo); cb(m); }
      return;
    }
    default: {
      const cb = node.pending.get(m.replyTo);
      if (cb) { node.pending.delete(m.replyTo); cb(m); }
    }
  }
}

// send a request to the agent and wait for its reply
function proxy(node, message, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!node || node.ws.readyState !== 1) return resolve({ ok: false, error: 'node offline' });
    const replyTo = crypto.randomUUID();
    const timer = setTimeout(() => {
      node.pending.delete(replyTo);
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    node.pending.set(replyTo, (m) => { clearTimeout(timer); resolve(m); });
    node.ws.send(JSON.stringify({ ...message, replyTo }));
  });
}

// relay every terminal frame to the node agent (PTY lives on the remote VPS)
function relayTerminal(node, ws, sid) {
  const onMsg = (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    switch (m.type) {
      case 'input': case 'resize':
        if (node.ws.readyState === 1) node.ws.send(JSON.stringify({ type: 'pty-forward', sessionId: sid, payload: { type: m.type, data: m.data, cols: m.cols, rows: m.rows } }));
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
      default:
        break;
    }
  };
  const onNode = (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!String(m.sessionId || '').startsWith(sid)) return;
    if (m.type === 'pty-data') ws.send(JSON.stringify({ type: 'data', data: m.data }));
    else if (m.type === 'pty-exit') ws.send(JSON.stringify({ type: 'exit', code: m.code }));
    else if (m.type === 'pty-created') ws.send(JSON.stringify({ type: 'created', sessionId: sid }));
  };
  ws.on('message', onMsg);
  node.ws.on('message', onNode);
  const cleanup = () => {
    ws.off('message', onMsg);
    node.ws.off('message', onNode);
    if (node.ws.readyState === 1) node.ws.send(JSON.stringify({ type: 'pty-close', sessionId: sid }));
  };
  ws.on('close', cleanup);
}

module.exports = { nodeRoutes, publicNodeRoutes, attachAgentWs, nodes, proxy, relayTerminal, newConnectToken, tokenState, CONNECT_TOKEN_TTL_MS, curlCommand, requestBase, gcTokens };