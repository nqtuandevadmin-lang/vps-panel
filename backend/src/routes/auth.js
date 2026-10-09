// routes/auth.js - Auth API: register, login, 2FA, refresh, sessions, API keys, profile
'use strict';
const crypto = require('crypto');
const { cfg } = require('../config');
const db = require('../db');
const auth = require('../auth');

const { ipWhitelist, ipBlacklist } = cfg;
function ipAllowed(ip) {
  if (!ip) return true;
  if (ipBlacklist.length && ipBlacklist.includes(ip)) return false;
  if (ipWhitelist.length && !ipWhitelist.includes(ip)) return false;
  return true;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, role: u.role, totpEnabled: !!u.totpEnabled, createdAt: u.createdAt, lastLogin: u.lastLogin };
}

async function authRoutes(app, opts) {
  // ---- server status (first-run detection) ----
  app.get('/auth/status', async (req) => {
    return { ok: true, needsSetup: db.coll('users').length === 0, users: db.coll('users').length };
  });

  // ---- public signup rules (shown on the auth screen before login) ----
  app.get('/auth/registration-info', async (req) => {
    const { cfg } = require('../config');
    return {
      ok: true,
      allowPublicSignup: cfg.allowPublicSignup,
      invitesOnly: cfg.invitesOnly,
      passwordMinLen: cfg.passwordMinLen,
      totalUsers: db.coll('users').length,
    };
  });

  // ---- password strength score ----
  app.post('/auth/password-score', async (req) => {
    return { ok: true, score: auth.passwordScore((req.body && req.body.password) || '') };
  });

  // ---- 2FA status ----
  app.get('/auth/2fa/status', { preHandler: [opts.authMw] }, async (req) => {
    const user = db.findBy('users', 'id', req.user.id);
    return { ok: true, enabled: !!user.totpEnabled };
  });

  // ---- public registration (multi-tenant) ----
  app.post('/auth/register', async (req, reply) => {
    const { username, email, password, invite } = req.body || {};
    const ip = clientIp(req);
    if (!ipAllowed(ip)) return reply.code(403).send({ error: 'IP not allowed' });
    if (!username || !/^[a-z0-9._-]{3,32}$/i.test(username)) return reply.code(400).send({ error: 'invalid username (3-32 chars, a-z 0-9 . _ -)' });
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) return reply.code(400).send({ error: 'username must start with a letter and can only contain a-z, 0-9, _ and - (it is also your Linux account)' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'invalid email' });
    const errs = auth.passwordPolicy(password || '');
    if (errs.length) return reply.code(400).send({ error: 'weak password', details: errs });

    const isFirst = db.coll('users').length === 0;
    if (!isFirst) {
      if (cfg.invitesOnly) {
        const { consumeInvite } = require('../ops-invites');
        const chk = consumeInvite(invite, username);
        if (!chk.ok) return reply.code(403).send({ error: chk.error });
      } else if (!cfg.allowPublicSignup) {
        return reply.code(403).send({ error: 'registration is disabled on this panel' });
      }
    }

    const existing = db.findBy('users', 'username', username.toLowerCase()) || db.findBy('users', 'email', email.toLowerCase());
    if (existing) return reply.code(409).send({ error: 'user already exists' });
    const dupeSystem = await new Promise((resolve) => {
      require('child_process').execFile('id', ['-u', username.toLowerCase()], (err) => resolve(!!err));
    });
    if (!dupeSystem) return reply.code(409).send({ error: 'that system username is already taken' });

    const user = db.insert('users', {
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      passwordHash: await auth.hashPassword(password),
      role: isFirst ? 'admin' : cfg.defaultRole,
      totpSecret: '', totpEnabled: false, backupCodes: [],
      createdAt: Date.now(), lastLogin: null, failedAttempts: 0, lockedUntil: 0,
      invitedByInvite: invite || null,
    });

    // give them their own Linux identity so the terminal is never a root shell
    let platform = { ok: false };
    if (cfg.autoCreateLinuxUser) {
      const assigned = await auth.assignPlatformIdentity(user);
      platform = assigned ? { ok: true, uid: user.uid, home: user.home } : { ok: false, error: 'could not create the system account' };
      if (platform.ok) await auth.grantReadOnlySudo(user.username).catch(() => {});
    }

    db.audit(user.id, 'user.register', user.id, 'ok', { invited: !!invite, platform }, ip);
    db.notify('user', 'New account', `${user.username} registered${invite ? ' via invite link' : ''}`);
    return {
      ok: true,
      user: publicUser(user),
      role: user.role,
      platform,
      message: platform.ok
        ? `Account created. Your shell runs as the system user "${user.username}" (home ${user.home}).`
        : 'Account created. Terminal runs with the panel identity.',
    };
  });

  // ---- login (step 1: password, step 2: 2FA if enabled) ----
  app.post('/auth/login', async (req, reply) => {
    const { username, password, totp, backupCode } = req.body || {};
    const ip = clientIp(req);
    if (!ipAllowed(ip)) return reply.code(403).send({ error: 'IP not allowed' });

    const user = db.findBy('users', 'username', String(username || '').toLowerCase());
    const bf = auth.checkBruteForce(user);
    if (!bf.ok) return reply.code(423).send({ error: 'account locked', retryInMin: bf.retryInMin });

    if (!user || !(await auth.verifyPassword(password || '', user.passwordHash))) {
      if (user) { auth.recordFailedLogin(user); db.audit(user.id, 'auth.login', user.id, 'fail', {}, ip); }
      // constant-ish delay to reduce timing signal
      await new Promise(r => setTimeout(r, 400));
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    // password OK -> check 2FA
    if (user.totpEnabled) {
      let ok2fa = false;
      if (totp) ok2fa = auth.verifyTotp(user.totpSecret, String(totp));
      else if (backupCode) {
        const h = crypto.createHash('sha256').update(String(backupCode)).digest('hex');
        const i = (user.backupCodes || []).indexOf(h);
        if (i >= 0) { user.backupCodes.splice(i, 1); db.save(); ok2fa = true; }
      }
      if (!ok2fa) {
        auth.recordFailedLogin(user);
        db.audit(user.id, 'auth.login.2fa', user.id, 'fail', {}, ip);
        return reply.code(401).send({ error: 'invalid 2FA code', mfaRequired: true });
      }
    }

    auth.recordSuccessLogin(user, ip);
    db.audit(user.id, 'auth.login', user.id, 'ok', {}, ip);

    const { sessionId, raw } = auth.createSession(user.id, ip, req.headers['user-agent']);
    const access = auth.signAccess({ sub: user.id, role: user.role, sid: sessionId });
    const refresh = auth.signRefresh({ sub: user.id, sid: sessionId });
    reply.setCookie('panel_session', raw, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      maxAge: cfg.sessionTimeoutMin * 60,
    });
    return {
      ok: true, user: publicUser(user), csrf: auth.csrfToken(sessionId),
      tokens: { access, refresh, expiresIn: cfg.jwtAccessTTL },
    };
  });

  // ---- logout ----
  app.post('/auth/logout', { preHandler: [opts.authMw] }, async (req, reply) => {
    if (req.sessionId) auth.revokeSession(req.sessionId);
    reply.clearCookie('panel_session', { path: '/' });
    return { ok: true };
  });

  // ---- refresh ----
  app.post('/auth/refresh', async (req, reply) => {
    const refresh = (req.body && req.body.refresh) || '';
    const p = auth.verifyRefresh(refresh);
    if (!p) return reply.code(401).send({ error: 'invalid refresh token' });
    const s = auth.validateSessionFromPayload(p);
    if (!s) return reply.code(401).send({ error: 'session expired or revoked' });
    const user = db.findBy('users', 'id', p.sub);
    if (!user) return reply.code(401).send({ error: 'user gone' });
    const access = auth.signAccess({ sub: user.id, role: user.role, sid: s.id });
    return { ok: true, tokens: { access, expiresIn: cfg.jwtAccessTTL }, csrf: auth.csrfToken(s.id) };
  });

  // ---- 2FA setup ----
  app.post('/auth/2fa/setup', { preHandler: [opts.authMw] }, async (req, reply) => {
    const user = db.findBy('users', 'id', req.user.id);
    const secret = auth.generateTotpSecret();
    user.totpSecret = secret; user.totpEnabled = false; db.save();
    return { ok: true, secret, uri: auth.totpUri(secret, user.username), message: 'scan QR with authenticator app, then confirm' };
  });

  app.post('/auth/2fa/confirm', { preHandler: [opts.authMw] }, async (req, reply) => {
    const { token } = req.body || {};
    const user = db.findBy('users', 'id', req.user.id);
    if (!user || !user.totpSecret) return reply.code(400).send({ error: 'setup first' });
    if (!auth.verifyTotp(user.totpSecret, String(token || ''))) return reply.code(400).send({ error: 'invalid code' });
    user.totpEnabled = true;
    const plain = Array.from({ length: 8 }, () =>
      crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})(?!$)/g, '$1-'));
    user.backupCodes = plain.map(c => crypto.createHash('sha256').update(c).digest('hex'));
    db.save();
    db.audit(user.id, 'auth.2fa.enable', user.id, 'ok');
    return { ok: true, codesPlain: plain, message: '2FA enabled. Store these backup codes NOW - shown once.' };
  });

  app.post('/auth/2fa/disable', { preHandler: [opts.authMw] }, async (req, reply) => {
    const user = db.findBy('users', 'id', req.user.id);
    const { token } = req.body || {};
    if (user.totpEnabled && !auth.verifyTotp(user.totpSecret, String(token || ''))) {
      return reply.code(400).send({ error: 'invalid code' });
    }
    user.totpEnabled = false; user.totpSecret = ''; user.backupCodes = []; db.save();
    db.audit(user.id, 'auth.2fa.disable', user.id, 'ok');
    return { ok: true };
  });

  // ---- password change ----
  app.post('/auth/password', { preHandler: [opts.authMw] }, async (req, reply) => {
    const { oldPassword, newPassword } = req.body || {};
    const user = db.findBy('users', 'id', req.user.id);
    if (!(await auth.verifyPassword(oldPassword || '', user.passwordHash))) return reply.code(401).send({ error: 'wrong password' });
    const errs = auth.passwordPolicy(newPassword || '');
    if (errs.length) return reply.code(400).send({ error: 'weak password', details: errs });
    user.passwordHash = await auth.hashPassword(newPassword);
    db.save();
    db.audit(user.id, 'auth.password.change', user.id, 'ok');
    return { ok: true };
  });

  // ---- sessions ----
  app.get('/auth/sessions', { preHandler: [opts.authMw] }, async (req) => {
    const list = db.coll('sessions').filter(s => s.userId === req.user.id)
      .map(s => ({ id: s.id, ip: s.ip, ua: s.ua, createdAt: s.createdAt, expiresAt: s.expiresAt, revoked: s.revoked, current: s.id === req.sessionId }));
    return { ok: true, sessions: list };
  });

  app.post('/auth/sessions/:id/revoke', { preHandler: [opts.authMw] }, async (req, reply) => {
    const s = db.findBy('sessions', 'id', req.params.id);
    if (!s || s.userId !== req.user.id) return reply.code(404).send({ error: 'not found' });
    auth.revokeSession(s.id);
    db.audit(req.user.id, 'auth.session.revoke', s.id, 'ok');
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-all', { preHandler: [opts.authMw] }, async (req) => {
    auth.revokeAllSessions(req.user.id, req.sessionId);
    db.audit(req.user.id, 'auth.session.revoke-all', req.user.id, 'ok');
    return { ok: true };
  });

  // ---- API keys ----
  app.post('/auth/apikeys', { preHandler: [opts.authMw] }, async (req, reply) => {
    const { name, role } = req.body || {};
    if (!name || !/^[a-zA-Z0-9 _-]{1,64}$/.test(name)) return reply.code(400).send({ error: 'invalid name' });
    const { keyId, raw } = auth.createApiKey(req.user.id, name, role === 'viewer' ? 'viewer' : 'user');
    db.audit(req.user.id, 'apikeys.create', keyId, 'ok');
    return { ok: true, keyId, key: raw, warning: 'copy now, shown once' };
  });

  app.get('/auth/apikeys', { preHandler: [opts.authMw] }, async (req) => {
    return { ok: true, keys: db.coll('apiKeys').filter(k => k.userId === req.user.id).map(k => ({ id: k.id, name: k.name, role: k.role, createdAt: k.createdAt, lastUsed: k.lastUsed, revoked: k.revoked })) };
  });

  app.delete('/auth/apikeys/:id', { preHandler: [opts.authMw] }, async (req, reply) => {
    const k = db.findBy('apiKeys', 'id', req.params.id);
    if (!k || k.userId !== req.user.id) return reply.code(404).send({ error: 'not found' });
    db.update('apiKeys', k.id, { revoked: true });
    db.audit(req.user.id, 'apikeys.revoke', k.id, 'ok');
    return { ok: true };
  });
}

module.exports = authRoutes;
