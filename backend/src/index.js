// index.js - Panel bootstrap: Fastify server, middlewares, routes, WebSocket, cluster, schedulers
'use strict';
const cluster = require('cluster');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const cors = require('@fastify/cors');
const multipart = require('@fastify/multipart');
const fastifyStatic = require('@fastify/static');
const compress = require('compression');
const { cfg, DATA_DIR, ROOT, secrets } = require('./config');
const db = require('./db');
const auth = require('./auth');
const mw = require('./lib/middleware');
const terminal = require('./terminal');
const system = require('./lib/system');
const authRoutes = require('./routes/auth');
const systemRoutes = require('./routes/system');
const fileRoutes = require('./routes/files');
const opsRoutes = require('./routes/ops');
const nodesMod = require('./routes/nodes');

// Frontend location resolution order:
//   1. PANEL_FRONTEND env (explicit override)
//   2. <install root>/frontend      (production: /opt/vps-panel/frontend)
//   3. <repo>/frontend              (running from a git checkout: backend/src/../..)
function resolveFrontendDir() {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    process.env.PANEL_FRONTEND,
    path.join(ROOT, 'frontend'),
    path.resolve(__dirname, '..', '..', 'frontend'),
    path.resolve(process.cwd(), 'frontend'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return candidates[1]; // report the production path in the warning
}
const FRONTEND_DIR = resolveFrontendDir();

// ---------- metrics ring (chart history, real data) ----------
const METRIC_RING = [];
const metrics = {
  push() {
    METRIC_RING.push({ ts: Date.now(), cpu: system.cpuUsage().usage, mem: system.memInfo().usage, load: system.loadAvg()['1m'] });
    if (METRIC_RING.length > 17280) METRIC_RING.shift(); // 24h @ 5s
  },
  history() { return METRIC_RING.slice(-2880); }, // last 4h
};

// ---------- daily backup scheduler ----------
function nextBackupDelay() {
  const [h, m] = (cfg.backupTime || '03:00').split(':').map(Number);
  const now = new Date();
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}
async function dailyBackup() {
  const name = `auto-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
  const out = path.join(DATA_DIR, 'backups', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { execFile } = require('child_process');
  await new Promise((resolve) => {
    execFile('tar', ['-czf', out, '-C', DATA_DIR, 'panel.db.json', 'config.json'], (err) => resolve(!err));
  });
  // prune old
  const keep = cfg.backupKeepDays * 864e5;
  for (const f of fs.readdirSync(path.dirname(out))) {
    const p = path.join(path.dirname(out), f);
    if (Date.now() - fs.statSync(p).mtimeMs > keep) fs.rmSync(p, { force: true });
  }
  db.notify('backup', 'Daily backup', `Backup ${name} completed`);
}

// ---------- update checker ----------
async function updateCheck() {
  try {
    const res = await fetch('https://api.github.com/repos/vps-panel/panel/releases/latest', { headers: { 'user-agent': 'vps-panel' } });
    const rel = await res.json();
    if (rel.tag_name && rel.tag_name !== 'v1.0.0') db.notify('update', `Update available: ${rel.tag_name}`, rel.html_url || '');
  } catch { /* offline */ }
}

// ---------- server factory ----------
function startServer() {
  const app = Fastify({
    logger: { level: process.env.PANEL_LOG_LEVEL || 'info', transport: undefined },
    bodyLimit: 2 * 1024 * 1024, // JSON body limit (multipart has its own)
    trustProxy: true,
    disableRequestLogging: true,
  });

  let wssRef = null;
  const wsClients = () => (wssRef ? wssRef.clients.size : 0);

  // plugins
  app.register(cookie, { secret: secrets.csrf });
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || cfg.corsWhitelist.length === 0) return cb(null, true); // same-origin default
      if (cfg.corsWhitelist.includes(origin)) return cb(null, true);
      cb(new Error('not allowed by CORS'));
    },
    credentials: true,
  });
  app.register(multipart, { limits: { fileSize: cfg.maxUploadMB * 1024 * 1024, files: 1 } });

  // compression (gzip/deflate/brotli) for HTTP responses
  app.register(require('@fastify/compress'), { global: true, threshold: 1024 });

  // static frontend
  const HAS_FRONTEND = fs.existsSync(path.join(FRONTEND_DIR, 'index.html'));
  if (HAS_FRONTEND) {
    app.register(fastifyStatic, { root: FRONTEND_DIR, wildcard: false });
  } else {
    app.log.warn(`frontend not found at ${FRONTEND_DIR} - serving API only`);
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    if (HAS_FRONTEND) return reply.sendFile('index.html');
    return reply.code(503).send('VPS Panel API is running, but the frontend directory is missing. Expected: ' + FRONTEND_DIR);
  });

  // /connect.sh?t=TOKEN -> the bootstrap script with this token baked in
  app.get('/connect.sh', async (req, reply) => {
    const tplPath = [
      path.join(ROOT, 'agent', 'connect.sh'),
      path.resolve(__dirname, '..', '..', 'agent', 'connect.sh'),
    ].find(p => fs.existsSync(p)) || '';
    const token = String(req.query?.t || '');
    let tpl;
    try { tpl = fs.readFileSync(tplPath, 'utf8'); }
    catch { return reply.code(500).send('# agent template missing'); }
    // the agent id is derived from the token so retries reuse the same node
    const nodeId = require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 16);
    const base = nodesMod.requestBase(req);
    const script = tpl
      .replaceAll('__PANEL_BASE__', base)
      .replaceAll('__TOKEN__', token)
      .replaceAll('__NODE_ID__', nodeId)
      .replaceAll('__AGENT_URL__', `${base}/agent.js`);
    reply.header('Content-Type', 'text/x-shellscript; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.send('#!/usr/bin/env bash\n' + script);
  });

  // the agent program itself
  app.get('/agent.js', async (req, reply) => {
    const p = path.join(require('path').resolve(__dirname, '..', '..'), 'agent', 'agent.js');
    const alt = path.join(ROOT, 'agent', 'agent.js');
    const file = fs.existsSync(p) ? p : alt;
    try {
      reply.header('Content-Type', 'application/javascript; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      reply.send(fs.readFileSync(file, 'utf8'));
    } catch { reply.code(404).send('agent.js not found'); }
  });

  // global hooks
  app.addHook('onRequest', (req, reply, next) => { mw.securityHeaders(req, reply, next); });
  app.addHook('onRequest', (req, reply, next) => { mw.ipFilter(req, reply, next); });
  app.addHook('onResponse', mw.requestLogger);
  app.addHook('preHandler', (req, reply, next) => { mw.sanitizeBody(req, reply, next); });

  // global rate limit (per IP)
  app.register(require('@fastify/rate-limit'), {
    max: cfg.rateLimitGlobal,
    timeWindow: 60000,
    keyGenerator: (req) => mw.clientIp(req),
    allowList: ['127.0.0.1'],
  });

  app.setErrorHandler(mw.errorHandler);

  // health (no auth)
  app.get('/health', async () => ({ ok: true, status: 'ok', ts: Date.now() }));

  // auth routes (stricter rate limit)
  app.register(async (a) => {
    a.addHook('preHandler', mw.authRateLimit);
    authRoutes(a, { authMw: mw.authenticate });
  }, { prefix: '/api/v1' });

  // authenticated API
  app.register(async (a) => {
    a.addHook('preHandler', mw.authenticate);
    a.addHook('preHandler', mw.csrf);
    systemRoutes(a, { authMw: mw.authenticate, metrics });
    fileRoutes(a, { authMw: mw.authenticate, csrfMw: mw.csrf });
    opsRoutes(a, { authMw: mw.authenticate, csrfMw: mw.csrf, wsClients });
    nodesMod.nodeRoutes(a, { authMw: mw.authenticate, csrfMw: mw.csrf });
  }, { prefix: '/api/v1' });

  // connect-token validation happens before the agent exists, so it is public
  app.register(async (a) => {
    nodesMod.publicNodeRoutes(a);
  }, { prefix: '/api/v1' });

  // OpenAPI-ish docs (real API documentation)
  app.get('/api/v1/docs', async () => ({
    openapi: '3.0.0',
    info: { title: 'VPS Panel API', version: '1.0.0' },
    servers: [{ url: cfg.url || `http://localhost:${cfg.port}` }],
    paths: {
      '/api/v1/auth/register': { post: { summary: 'Register first user (becomes admin)', body: { username: 'string', email: 'string', password: 'string' } } },
      '/api/v1/auth/login': { post: { summary: 'Login (+TOTP when enabled)', body: { username: 'string', password: 'string', totp: 'string?' } } },
      '/api/v1/auth/refresh': { post: { summary: 'Refresh access token', body: { refresh: 'string' } } },
      '/api/v1/auth/logout': { post: { summary: 'Revoke session' } },
      '/api/v1/auth/2fa/setup': { post: { summary: 'Start 2FA setup (returns secret + otpauth URI)' } },
      '/api/v1/auth/2fa/confirm': { post: { summary: 'Enable 2FA', body: { token: 'string' } } },
      '/api/v1/auth/sessions': { get: { summary: 'List sessions' } },
      '/api/v1/auth/apikeys': { get: { summary: 'List API keys' }, post: { summary: 'Create API key' } },
      '/api/v1/system/overview': { get: { summary: 'Dashboard overview' } },
      '/api/v1/system/monitor': { get: { summary: 'Realtime snapshot' } },
      '/api/v1/system/history': { get: { summary: 'Chart history (4h)' } },
      '/api/v1/system/processes': { get: { summary: 'Process list' } },
      '/api/v1/system/services': { get: { summary: 'systemd units' } },
      '/api/v1/system/users': { get: { summary: 'System users (admin)' } },
      '/api/v1/firewall/status': { get: { summary: 'Firewall status' } },
      '/api/v1/packages': { get: { summary: 'Installed packages' } },
      '/api/v1/cron': { get: { summary: 'Crontab jobs' } },
      '/api/v1/files/list': { get: { summary: 'List directory', params: { path: 'string' } } },
      '/api/v1/files/read': { get: { summary: 'Read text file' } },
      '/api/v1/files/upload': { post: { summary: 'Upload file (multipart)' } },
      '/api/v1/files/download': { get: { summary: 'Download file' } },
      '/api/v1/backups': { get: { summary: 'List backups' } },
      '/api/v1/metrics': { get: { summary: 'Prometheus metrics' } },
      '/api/v1/audit': { get: { summary: 'Audit log (admin)' } },
      '/ws/terminal': { get: { summary: 'WebSocket terminal (auth via ?token=JWT)' } },
    },
  }));

  // WebSocket endpoints: browser terminal + remote-node agents
  const server = app.server;
  nodesMod.attachAgentWs(server);
  // safety net: destroy upgrade sockets no handler claimed
  server.prependListener('upgrade', (req, socket) => {
    setTimeout(() => {
      if (!req.__panelWsHandled && !socket.destroyed) socket.destroy();
    }, 1000);
  });
  wssRef = terminal.attachWs(server, { nodes: nodesMod, auth });

  // metrics sampler
  const sampler = setInterval(() => metrics.push(), 5000).unref();

  // daily backup + update check
  const scheduleBackup = () => {
    setTimeout(async () => { await dailyBackup().catch(() => {}); scheduleBackup(); }, nextBackupDelay());
  };
  scheduleBackup();
  if (cfg.updateCheck) setInterval(updateCheck, 6 * 3600e3).unref();

  // graceful shutdown
  const shutdown = async (sig) => {
    app.log.info(`received ${sig}, shutting down`);
    clearInterval(sampler);
    for (const n of nodesMod.nodes.values()) { try { n.ws.close(); } catch { /* ignore */ } }
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // listen
  app.listen({ port: cfg.port, host: cfg.host }).then(() => {
    app.log.info(`vps-panel v1.0.0 listening on ${cfg.host}:${cfg.port} (pid ${process.pid})`);
    console.log(`\n  Panel URL: http://<server-ip>:${cfg.port}\n`);
  }).catch((e) => { app.log.error(e); process.exit(1); });

  return app;
}

// ---------- entrypoint ----------
if (require.main === module) {
  if (cfg.cluster && cluster.isPrimary) {
    const n = Math.min(os.cpus().length, 4);
    console.log(`[panel] cluster mode: ${n} workers`);
    for (let i = 0; i < n; i++) cluster.fork();
    cluster.on('exit', (w) => {
      console.log(`[panel] worker ${w.process.pid} exited, restarting`);
      cluster.fork();
    });
    process.on('SIGTERM', () => { for (const id in cluster.workers) cluster.workers[id].kill('SIGTERM'); });
  } else {
    startServer();
  }
}

module.exports = { startServer, metrics };
