// lib/middleware.js - auth, role, CSRF, security headers, rate limit, request logger, error handler
'use strict';
const crypto = require('crypto');
const { cfg, secrets } = require('../config');
const db = require('../db');
const auth = require('../auth');

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// Security headers (Helmet-equivalent, hand-rolled)
function securityHeaders(req, reply, next) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('X-XSS-Protection', '0'); // deprecated; CSP is the real defense
  reply.header('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

// IP whitelist/blacklist
function ipFilter(req, reply, next) {
  const ip = clientIp(req);
  if (cfg.ipBlacklist.includes(ip)) return reply.code(403).send({ error: 'blocked' });
  if (cfg.ipWhitelist.length && !cfg.ipWhitelist.includes(ip)) return reply.code(403).send({ error: 'not allowed' });
  next();
}

// JWT or API key authentication
function authenticate(req, reply, next) {
  // 1. Bearer JWT
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const p = auth.verifyAccess(h.slice(7));
    if (p && p.sub) {
      const user = db.findBy('users', 'id', p.sub);
      if (user) {
        req.user = user; req.role = user.role; req.sessionId = p.sid; req.authMethod = 'jwt';
        return next();
      }
    }
  }
  // 2. X-API-Key
  const ak = req.headers['x-api-key'];
  if (ak) {
    const k = auth.validateApiKey(ak);
    if (k) {
      const user = db.findBy('users', 'id', k.userId);
      if (user) {
        req.user = user; req.role = k.role || 'user'; req.sessionId = null; req.authMethod = 'apikey';
        return next();
      }
    }
  }
  // 3. Cookie session (browser)
  const raw = req.cookies?.panel_session;
  if (raw) {
    const s = auth.validateSession(raw);
    if (s) {
      const user = db.findBy('users', 'id', s.userId);
      if (user) {
        req.user = user; req.role = user.role; req.sessionId = s.id; req.authMethod = 'cookie';
        return next();
      }
    }
  }
  return reply.code(401).send({ error: 'unauthenticated' });
}

// CSRF for cookie-authenticated state changes
function csrf(req, reply, next) {
  if (req.authMethod !== 'cookie') return next(); // API keys / Bearer are not CSRF-able
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  if (!auth.verifyCsrf(req.sessionId, token)) return reply.code(403).send({ error: 'invalid CSRF token' });
  next();
}

// Role gate
function requireRole(role) {
  const order = { viewer: 0, user: 1, admin: 2 };
  return (req, reply, next) => {
    if ((order[req.role] || 0) < (order[role] || 0)) return reply.code(403).send({ error: 'forbidden' });
    next();
  };
}

// Per-route rate limit override for auth endpoints (brute force protection)
function authRateLimit(req, reply, next) {
  const ip = clientIp(req);
  const key = 'rl:auth:' + ip;
  const now = Date.now();
  const w = rateWindows.get(key) || { count: 0, reset: now + 60000 };
  if (now > w.reset) { w.count = 0; w.reset = now + 60000; }
  w.count++;
  rateWindows.set(key, w);
  reply.header('X-RateLimit-Limit', String(cfg.rateLimitAuth));
  reply.header('X-RateLimit-Remaining', String(Math.max(0, cfg.rateLimitAuth - w.count)));
  if (w.count > cfg.rateLimitAuth) {
    db.audit(null, 'rate.limit', ip, 'fail', { endpoint: req.routeOptions?.url || '' });
    return reply.code(429).send({ error: 'too many requests', retryAfterSec: Math.ceil((w.reset - now) / 1000) });
  }
  next();
}
const rateWindows = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of rateWindows) if (now > v.reset + 60000) rateWindows.delete(k); }, 60000).unref();

// Request logger middleware (use with addHook('onResponse', mw.requestLogger))
async function requestLogger(req, reply) {
  const ms = typeof req.elapsedTime === 'number' ? req.elapsedTime : 0;
  req.log.info({ method: req.method, url: req.url, status: reply.statusCode, ms, ip: clientIp(req) });
}

// Error handler (no stack traces leaked)
function errorHandler(error, req, reply) {
  req.log.error({ err: error, url: req.url });
  if (error.validation) return reply.code(400).send({ error: 'validation failed', details: error.validation.map(v => v.message) });
  if (error.name === 'PathTraversalError') return reply.code(400).send({ error: 'invalid path' });
  const code = error.statusCode || 500;
  return reply.code(code).send({ error: code >= 500 ? 'internal error' : (error.message || 'error') });
}

// Body parser limits + XSS prevention in string inputs (strip control chars)
function sanitizeBody(req, reply, next) {
  const clean = (v) => {
    if (typeof v === 'string') return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 100000);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = clean(val); return o; }
    return v;
  };
  if (req.body && typeof req.body === 'object') req.body = clean(req.body);
  next();
}

module.exports = { securityHeaders, ipFilter, authenticate, csrf, requireRole, authRateLimit, requestLogger, errorHandler, sanitizeBody, clientIp };
