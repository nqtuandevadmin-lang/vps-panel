// auth.js - JWT, bcrypt (cost 12), TOTP 2FA, sessions, API keys, brute-force protection
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const otplib = require('otplib');
const { cfg, secrets } = require('./config');
const db = require('./db');

const ACCESS_OPTS = (extra = {}) => ({ algorithm: 'HS256', expiresIn: cfg.jwtAccessTTL, ...extra });
const REFRESH_OPTS = (extra = {}) => ({ algorithm: 'HS256', expiresIn: cfg.jwtRefreshTTL, ...extra });

async function hashPassword(pw) { return bcrypt.hash(pw, cfg.bcryptCost); }
async function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash || ''); }

function passwordPolicy(pw) {
  const errs = [];
  if (pw.length < cfg.passwordMinLen) errs.push(`min ${cfg.passwordMinLen} chars`);
  if (!/[A-Z]/.test(pw)) errs.push('1 uppercase');
  if (!/[a-z]/.test(pw)) errs.push('1 lowercase');
  if (!/[0-9]/.test(pw)) errs.push('1 digit');
  if (!/[^A-Za-z0-9]/.test(pw)) errs.push('1 symbol');
  return errs;
}
function passwordScore(pw) {
  // zxcvbn-lite: 0..5
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (/(.)\1{2,}|123456|password|qwerty/i.test(pw)) s = Math.max(0, s - 2);
  return Math.min(5, s);
}

function signAccess(payload) {
  return jwt.sign(payload, secrets.jwtAccess, ACCESS_OPTS());
}
function signRefresh(payload) {
  return jwt.sign(payload, secrets.jwtRefresh, REFRESH_OPTS());
}
function verifyAccess(token) {
  try { return jwt.verify(token, secrets.jwtAccess, { algorithms: ['HS256'] }); } catch { return null; }
}
function verifyRefresh(token) {
  try { return jwt.verify(token, secrets.jwtRefresh, { algorithms: ['HS256'] }); } catch { return null; }
}

// ---------- sessions ----------
function createSession(userId, ip, ua) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const s = db.insert('sessions', {
    userId, tokenHash: hash, ip, ua: ua?.slice(0, 255) || '',
    createdAt: Date.now(), expiresAt: Date.now() + cfg.sessionTimeoutMin * 60000, revoked: false,
  });
  return { sessionId: s.id, raw };
}
function validateSession(raw) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const s = db.coll('sessions').find(x => x.tokenHash === hash);
  if (!s || s.revoked || s.expiresAt < Date.now()) return null;
  return s;
}
function revokeSession(id) { db.update('sessions', id, { revoked: true }); }
function revokeAllSessions(userId, exceptId) {
  db.coll('sessions').forEach(s => { if (s.userId === userId && s.id !== exceptId) s.revoked = true; });
  db.save();
}
function pruneSessions() {
  const now = Date.now();
  db.coll('sessions').forEach(s => { if (s.expiresAt < now) s.revoked = true; });
  db.save();
}

function validateSessionFromPayload(payload) {
  if (!payload || !payload.sid) return null;
  const s = db.coll('sessions').find(x => x.id === payload.sid);
  if (!s || s.revoked || s.expiresAt < Date.now()) return null;
  return s;
}

// ---------- API keys ----------
function createApiKey(userId, name, role = 'user') {
  const raw = 'vp_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const k = db.insert('apiKeys', { userId, keyHash: hash, name, role, createdAt: Date.now(), lastUsed: null, revoked: false });
  return { keyId: k.id, raw };
}
function validateApiKey(raw) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const k = db.coll('apiKeys').find(x => x.keyHash === hash);
  if (!k || k.revoked) return null;
  k.lastUsed = Date.now(); db.save();
  return k;
}

// ---------- 2FA ----------
function generateTotpSecret() { return otplib.authenticator.generateSecret(); }
function totpUri(secret, username) {
  return otplib.authenticator.keyuri(username, 'VPS-Panel', secret);
}
function verifyTotp(secret, token) {
  try { return otplib.authenticator.check(token, secret); } catch { return false; }
}
function generateBackupCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/g, '$1-').slice(0, 9));
  return codes.map(c => crypto.createHash('sha256').update(c).digest('hex'));
}

// ---------- brute force ----------
function checkBruteForce(user) {
  if (!user) return { ok: true };
  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    return { ok: false, locked: true, retryInMin: mins };
  }
  return { ok: true };
}
function recordFailedLogin(user) {
  const fails = (user.failedAttempts || 0) + 1;
  const patch = { failedAttempts: fails };
  if (fails >= cfg.bruteForceMax) patch.lockedUntil = Date.now() + cfg.bruteLockoutMin * 60000;
  db.update('users', user.id, patch);
}
function recordSuccessLogin(user, ip) {
  db.update('users', user.id, { failedAttempts: 0, lockedUntil: 0, lastLogin: Date.now(), lastIp: ip });
}

// ---------- CSRF ----------
function csrfToken(sessionId) {
  return crypto.createHmac('sha256', secrets.csrf).update(sessionId).digest('hex');
}
function verifyCsrf(sessionId, token) {
  if (!sessionId || !token) return false;
  const expect = csrfToken(sessionId);
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(token)));
}

// ---------- random admin ----------
function randomPassword(len = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  const b = crypto.randomBytes(len);
  return Array.from(b, x => chars[x % chars.length]).join('');
}

module.exports = {
  hashPassword, verifyPassword, passwordPolicy, passwordScore,
  signAccess, signRefresh, verifyAccess, verifyRefresh,
  createSession, validateSession, validateSessionFromPayload, revokeSession, revokeAllSessions, pruneSessions,
  createApiKey, validateApiKey,
  generateTotpSecret, totpUri, verifyTotp, generateBackupCodes,
  checkBruteForce, recordFailedLogin, recordSuccessLogin,
  csrfToken, verifyCsrf, randomPassword,
};
