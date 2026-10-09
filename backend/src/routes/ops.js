// routes/ops.js - Ops: backup/restore, update, nginx, ssl, docker, notifications, metrics, health, audit, settings, users mgmt
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const { exec } = require('child_process');
const execP = util.promisify(exec);
const { cfg, DATA_DIR, ROOT } = require('../config');
const db = require('../db');
const auth = require('../auth');
const { clientIp, requireRole } = require('../lib/middleware');
const system = require('../lib/system');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const { newInvite, consumeInvite } = require('../ops-invites');

async function opsRoutes(app, opts) {
  // ---- health & metrics ----
  app.get('/health', async () => ({ ok: true, status: 'ok', ts: Date.now(), uptime: process.uptime() }));

  app.get('/metrics', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const mem = process.memoryUsage();
    const cpu = system.cpuUsage();
    const m = system.memInfo();
    const lines = [
      '# HELP panel_uptime_seconds Panel process uptime',
      '# TYPE panel_uptime_seconds gauge',
      `panel_uptime_seconds ${process.uptime().toFixed(2)}`,
      `panel_rss_bytes ${mem.rss}`,
      `panel_heap_bytes ${mem.heapUsed}`,
      `panel_external_bytes ${mem.external}`,
      `panel_cpu_usage_percent ${cpu.usage}`,
      `panel_sys_mem_usage_percent ${m.usage.toFixed(2)}`,
      `panel_db_users ${db.coll('users').length}`,
      `panel_db_sessions ${db.coll('sessions').filter(s => !s.revoked).length}`,
      `panel_db_audit ${db.coll('audit').length}`,
      `panel_ws_clients ${opts.wsClients()}`,
      `panel_process_open_fds ${Math.max(0, fs.readdirSync('/proc/self/fd').length - 2)}`,
    ];
    return reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  // ---- audit log query ----
  app.get('/audit', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const { limit = 100, userId, action } = req.query || {};
    let out = db.coll('audit').slice(-5000).reverse();
    if (userId) out = out.filter(a => a.userId === userId);
    if (action) out = out.filter(a => a.action.includes(String(action)));
    return { ok: true, total: out.length, audit: out.slice(0, Math.min(parseInt(limit, 10) || 100, 1000)) };
  });

  // ---- notifications ----
  app.get('/notifications', { preHandler: [opts.authMw] }, async (req) => {
    const list = db.coll('notifications').slice(-200).reverse();
    return { ok: true, notifications: list };
  });

  app.post('/notifications/:id/read', { preHandler: [opts.authMw, opts.csrfMw] }, async (req, reply) => {
    const n = db.findBy('notifications', 'id', req.params.id);
    if (!n) return reply.code(404).send({ error: 'not found' });
    n.read = true; db.save();
    return { ok: true };
  });

  app.post('/notifications/test', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    db.notify('test', 'Test notification', 'Webhook/notification pipeline works');
    return { ok: true, sent: !!cfg.notifyWebhook };
  });

  // ---- users management (panel users, admin only) ----
  app.get('/users', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    return {
      ok: true,
      users: db.coll('users').map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role, totpEnabled: u.totpEnabled, createdAt: u.createdAt, lastLogin: u.lastLogin, failedAttempts: u.failedAttempts, lockedUntil: u.lockedUntil })),
    };
  });

  app.post('/users', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const { username, email, password, role } = req.body || {};
    if (!username || !/^[a-z0-9._-]{3,32}$/i.test(username)) return reply.code(400).send({ error: 'invalid username' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'invalid email' });
    const errs = auth.passwordPolicy(password || '');
    if (errs.length) return reply.code(400).send({ error: 'weak password', details: errs });
    if (db.findBy('users', 'username', username.toLowerCase()) || db.findBy('users', 'email', email.toLowerCase())) {
      return reply.code(409).send({ error: 'exists' });
    }
    const user = db.insert('users', {
      username: username.toLowerCase(), email: email.toLowerCase(),
      passwordHash: await auth.hashPassword(password),
      role: role === 'admin' || role === 'viewer' ? role : 'user',
      totpSecret: '', totpEnabled: false, backupCodes: [],
      createdAt: Date.now(), lastLogin: null, failedAttempts: 0, lockedUntil: 0,
    });
    db.audit(req.user.id, 'panel.user.create', user.id, 'ok');
    return { ok: true, user: { id: user.id, username: user.username, role: user.role } };
  });

  app.delete('/users/:id', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    if (req.params.id === req.user.id) return reply.code(400).send({ error: 'cannot delete yourself' });
    const u = db.findBy('users', 'id', req.params.id);
    if (!u) return reply.code(404).send({ error: 'not found' });
    db.remove('users', u.id);
    db.audit(req.user.id, 'panel.user.delete', u.username, 'ok');
    return { ok: true };
  });

  app.put('/users/:id/role', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const { role } = req.body || {};
    if (!['admin', 'user', 'viewer'].includes(role)) return reply.code(400).send({ error: 'invalid role' });
    const u = db.findBy('users', 'id', req.params.id);
    if (!u) return reply.code(404).send({ error: 'not found' });
    db.update('users', u.id, { role });
    db.audit(req.user.id, 'panel.user.role', u.username, 'ok', { role });
    return { ok: true };
  });

  // ---- unlock a locked account (admin) ----
  app.post('/users/:id/unlock', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const u = db.findBy('users', 'id', req.params.id);
    if (!u) return reply.code(404).send({ error: 'not found' });
    db.update('users', u.id, { failedAttempts: 0, lockedUntil: 0 });
    db.audit(req.user.id, 'panel.user.unlock', u.username, 'ok');
    return { ok: true, username: u.username };
  });

  app.get('/login-diagnostics', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const rows = db.coll('users').map(u => ({
      username: u.username, role: u.role, locked: !!(u.lockedUntil && u.lockedUntil > Date.now()),
      lockedUntil: u.lockedUntil || 0, failedAttempts: u.failedAttempts || 0,
      lastLogin: u.lastLogin || 0, hasPlatformUser: typeof u.uid === 'number',
      uid: u.uid ?? null, totpEnabled: !!u.totpEnabled,
    }));
    const recent = db.coll('audit').filter(a => a.action.startsWith('auth.login')).slice(-20)
      .map(a => ({ ts: a.ts, user: (a.userId || '').slice(0, 8), result: a.result, ip: a.ip }));
    return { ok: true, users: rows, recentLogins: recent, bruteForceMax: cfg.bruteForceMax, bruteLockoutMin: cfg.bruteLockoutMin };
  });

  // ---------- invite links (share this panel with other people) ----------
  app.get('/auth/invite/:token', async (req, reply) => {
    const inv = db.findBy('invites', 'token', String(req.params.token || '').toLowerCase());
    if (!inv || inv.revoked) return reply.code(404).send({ error: 'invalid invite' });
    if (inv.expiresAt && inv.expiresAt < Date.now()) return reply.code(410).send({ error: 'invite expired' });
    const used = inv.uses >= inv.maxUses;
    return {
      ok: !used, valid: !used, role: inv.role, email: inv.email || null,
      maxUses: inv.maxUses, uses: inv.uses, note: inv.note,
      error: used ? 'invite already used' : null,
    };
  });

  app.get('/invites', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const base = (cfg.url || '').replace(/\/$/, '') || '';
    return {
      ok: true,
      invites: db.coll('invites').map(i => ({
        ...i,
        link: `${base}/?invite=${i.token}`,
        exhausted: i.uses >= i.maxUses,
        expired: i.expiresAt && i.expiresAt < Date.now(),
      })),
    };
  });

  app.post('/invites', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const { email, role, maxUses, note } = req.body || {};
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return reply.code(400).send({ error: 'invalid email' });
    const uses = Math.min(Math.max(parseInt(maxUses, 10) || 1, 1), 500);
    const inv = newInvite({ email: email || '', role: role === 'viewer' ? 'viewer' : 'user', maxUses: uses, note: String(note || '').slice(0, 200) });
    inv.createdBy = req.user.id;
    db.save();
    db.audit(req.user.id, 'invite.create', inv.token, 'ok', { maxUses: uses });
    const base = (cfg.url || '').replace(/\/$/, '') || '';
    return { ok: true, invite: { ...inv, link: `${base}/?invite=${inv.token}` } };
  });

  app.delete('/invites/:id', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const inv = db.findBy('invites', 'id', req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    db.remove('invites', inv.id);
    db.audit(req.user.id, 'invite.delete', inv.token, 'ok');
    return { ok: true };
  });

  app.post('/invites/:id/reset', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req) => {
    const inv = db.findBy('invites', 'id', req.params.id);
    if (!inv) return { ok: false, error: 'not found' };
    inv.uses = 0; inv.revoked = false; inv.usedBy = null; inv.usedAt = null;
    db.save();
    return { ok: true };
  });

  // ---- backups ----
  app.get('/backups', { preHandler: [opts.authMw, requireRole('user')] }, async (req) => {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.tar.gz')).map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, createdAt: st.mtimeMs };
    }).sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, backups: files.concat(db.coll('backups').map(b => ({ name: b.name, size: b.size, createdAt: b.createdAt, encrypted: b.encrypted }))) };
  });

  app.post('/backups/create', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const name = `panel-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const out = path.join(BACKUP_DIR, name);
    try {
      await execFileP('tar', ['-czf', out, '-C', DATA_DIR, 'panel.db.json', 'config.json']);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
      db.insert('backups', { name, path: out, size: fs.statSync(out).size, createdAt: Date.now(), sha256: sha, encrypted: false });
      db.audit(req.user.id, 'backup.create', name, 'ok');
      return { ok: true, name, sha256: sha };
    } catch (e) {
      return reply.code(500).send({ error: 'backup failed: ' + e.message });
    }
  });

  app.post('/backups/:name/restore', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const name = path.basename(String(req.params.name || ''));
    const src = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(src)) return reply.code(404).send({ error: 'backup not found' });
    // restore into temp, validate JSON, then swap atomically
    const tmp = path.join(BACKUP_DIR, 'restore-' + process.pid);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      await execFileP('tar', ['-xzf', src, '-C', tmp]);
      const restored = JSON.parse(fs.readFileSync(path.join(tmp, 'panel.db.json'), 'utf8'));
      if (!restored || !Array.isArray(restored.users)) throw new Error('invalid backup content');
      // keep current as fallback
      fs.copyFileSync(path.join(DATA_DIR, 'panel.db.json'), path.join(DATA_DIR, 'panel.db.json.pre-restore'));
      fs.copyFileSync(path.join(tmp, 'panel.db.json'), path.join(DATA_DIR, 'panel.db.json'));
      db.audit(req.user.id, 'backup.restore', name, 'ok');
      return { ok: true, message: 'restored. restart panel to load new data.' };
    } catch (e) {
      return reply.code(500).send({ error: 'restore failed: ' + e.message });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  app.get('/backups/:name/download', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const name = path.basename(String(req.params.name || ''));
    const src = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(src)) return reply.code(404).send({ error: 'not found' });
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    reply.type('application/gzip');
    return reply.send(fs.createReadStream(src));
  });

  app.delete('/backups/:name', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const name = path.basename(String(req.params.name || ''));
    const src = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(src)) return reply.code(404).send({ error: 'not found' });
    fs.rmSync(src);
    db.audit(req.user.id, 'backup.delete', name, 'ok');
    return { ok: true };
  });

  // ---- update checker (GitHub releases) ----
  app.get('/update/check', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    try {
      const res = await fetch('https://api.github.com/repos/vps-panel/panel/releases/latest', { headers: { 'user-agent': 'vps-panel' } });
      const rel = await res.json();
      const latest = rel.tag_name || null;
      const current = 'v1.0.0';
      return { ok: true, current, latest, updateAvailable: latest && latest !== current, release: rel.html_url || '' };
    } catch (e) {
      return { ok: false, error: 'cannot reach GitHub', current: 'v1.0.0' };
    }
  });

  // ---- nginx config manager ----
  app.get('/nginx/configs', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const dir = '/etc/nginx/conf.d';
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.conf')).map(f => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
      return { ok: true, configs: files };
    } catch (e) {
      return reply.code(400).send({ error: 'nginx conf.d not readable (needs sudo/permission)' });
    }
  });

  app.put('/nginx/configs/:name', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const name = path.basename(String(req.params.name || '')).replace(/[^\w.\-]/g, '') || 'site.conf';
    const content = String(req.body?.content || '');
    if (!content.includes('listen')) return reply.code(400).send({ error: 'config must contain a listen directive' });
    try {
      // write via sudo tee with stdin (execFile has no stdin option)
      const written = await new Promise((resolve) => {
        const p = execFile('sudo', ['-n', 'tee', path.join('/etc/nginx/conf.d', name)], (err) => resolve(!err));
        p.stdin.end(content);
      });
      if (!written) return reply.code(400).send({ error: 'write failed (needs sudo -n for nginx)' });
      db.audit(req.user.id, 'nginx.write', name, 'ok');
      return { ok: true, message: 'written. validate+reload via /nginx/test and /nginx/reload' };
    } catch (e) {
      return reply.code(400).send({ error: 'write failed: ' + e.message });
    }
  });

  app.post('/nginx/reload', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const t = await system.run('sudo', ['-n', 'nginx', '-t']);
    if (!t.ok) return reply.code(400).send({ error: 'config invalid:\n' + t.stderr });
    const r = await system.run('sudo', ['-n', 'nginx', '-s', 'reload']);
    db.audit(req.user.id, 'nginx.reload', '', r.ok ? 'ok' : 'fail');
    return r.ok ? { ok: true } : reply.code(400).send({ error: r.stderr });
  });

  app.post('/nginx/test', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const r = await system.run('sudo', ['-n', 'nginx', '-t']);
    return { ok: r.ok, output: r.stdout + r.stderr };
  });

  // ---- SSL (Let's Encrypt via certbot) ----
  app.post('/ssl/issue', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const { domain, email } = req.body || {};
    if (!/^[a-z0-9.\-]{4,253}$/i.test(String(domain || ''))) return reply.code(400).send({ error: 'invalid domain' });
    const certbot = (await system.run('which', ['certbot'])).ok;
    if (!certbot) return reply.code(400).send({ error: 'certbot not installed' });
    const args = ['certbot', 'certonly', '--nginx', '-d', domain, '--non-interactive', '--agree-tos', '--keep-until-expiring'];
    if (email) args.push('-m', String(email));
    const r = await system.run('sudo', ['-n'].concat(args), { timeout: 180000 });
    db.audit(req.user.id, 'ssl.issue', domain, r.ok ? 'ok' : 'fail');
    return r.ok ? { ok: true, domain, output: r.stdout } : reply.code(400).send({ error: r.stderr || 'certbot failed' });
  });

  app.get('/ssl/certs', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const dir = '/etc/letsencrypt/live';
    try {
      const domains = fs.readdirSync(dir);
      const out = [];
      for (const d of domains) {
        const cert = path.join(dir, d, 'cert.pem');
        const st = fs.statSync(cert);
        // parse expiry
        const r = await execP(`openssl x509 -enddate -noout -in ${cert}`).catch(() => ({ stdout: '' }));
        const m = r.stdout.match(/notAfter=(.*)/);
        out.push({ domain: d, expires: m ? new Date(m[1]).toISOString() : null, modified: st.mtimeMs });
      }
      return { ok: true, certs: out };
    } catch { return { ok: true, certs: [] }; }
  });

  // ---- docker manager (if docker present) ----
  app.get('/docker/ps', { preHandler: [opts.authMw, requireRole('user')] }, async (req) => {
    const r = await system.run('docker', ['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
    if (!r.ok) return { ok: false, installed: false, error: r.stderr };
    const containers = r.stdout.split('\n').filter(Boolean).map(l => {
      const [id, name, image, status, ports] = l.split('\t');
      return { id, name, image, status, ports };
    });
    return { ok: true, installed: true, containers };
  });

  app.post('/docker/:action/:id', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const { action, id } = req.params;
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return reply.code(400).send({ error: 'invalid container' });
    if (!['start', 'stop', 'restart', 'pause', 'unpause', 'kill'].includes(action)) return reply.code(400).send({ error: 'invalid action' });
    const r = await system.run('docker', [action, id]);
    db.audit(req.user.id, 'docker.' + action, id, r.ok ? 'ok' : 'fail');
    return r.ok ? { ok: true } : reply.code(400).send({ error: r.stderr || 'docker action failed' });
  });

  app.get('/docker/logs/:id', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return reply.code(400).send({ error: 'invalid container' });
    const r = await system.run('docker', ['logs', '--tail', '300', id]);
    return { ok: r.ok, content: (r.stdout || '') + (r.stderr || '') };
  });

  // ---- settings ----
  app.get('/settings', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const s = { ...cfg };
    delete s.corsWhitelist; // keep, it's fine
    return { ok: true, settings: db.coll('settings'), defaults: { port: cfg.port, backupTime: cfg.backupTime, rateLimitGlobal: cfg.rateLimitGlobal, passwordMinLen: cfg.passwordMinLen, twoFactorRequired: cfg.twoFactorRequired } };
  });

  app.put('/settings', { preHandler: [opts.authMw, requireRole('admin'), opts.csrfMw] }, async (req, reply) => {
    const { notifyWebhook, backupTime, twoFactorRequired } = req.body || {};
    const patch = {};
    if (notifyWebhook !== undefined) patch.notifyWebhook = String(notifyWebhook).slice(0, 500);
    if (backupTime !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(backupTime)) patch.backupTime = backupTime;
    if (twoFactorRequired !== undefined) patch.twoFactorRequired = !!twoFactorRequired;
    db.coll('settings').push({ ts: Date.now(), by: req.user.id, patch });
    Object.assign(cfg, patch);
    db.audit(req.user.id, 'settings.update', '', 'ok', patch);
    return { ok: true };
  });
}

module.exports = opsRoutes;
