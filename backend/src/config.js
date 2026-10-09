// config.js - Centralized configuration: env vars + config file + secrets
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.PANEL_ROOT || '/opt/vps-panel';
const DATA_DIR = process.env.PANEL_DATA || path.join(ROOT, 'data');
const CONFIG_PATH = process.env.PANEL_CONFIG || path.join(DATA_DIR, 'config.json');
const SECRETS_PATH = process.env.PANEL_SECRETS || path.join(DATA_DIR, 'secrets.json');

const defaults = {
  port: parseInt(process.env.PANEL_PORT || '8080', 10),
  host: process.env.PANEL_HOST || '0.0.0.0',
  url: process.env.PANEL_URL || '',
  jwtAccessTTL: '15m',
  jwtRefreshTTL: '7d',
  bcryptCost: 12,
  sessionTimeoutMin: 1440,
  maxUploadMB: 200,
  sessionScrollback: 10000,
  cluster: process.env.PANEL_CLUSTER === '1',
  corsWhitelist: [],
  ipWhitelist: [],
  ipBlacklist: [],
  rateLimitGlobal: 300,
  rateLimitAuth: 10,
  bruteForceMax: 5,
  bruteLockoutMin: 15,
  passwordMinLen: 12,
  backupTime: '03:00',
  backupKeepDays: 7,
  notifyWebhook: '',
  smtp: { host: '', port: 587, user: '', pass: '', from: '' },
  updateCheck: true,
  auditLog: true,
  metricsEnabled: true,
  twoFactorRequired: false,
  // ---- multi-tenant / sharing ----
  allowPublicSignup: true,     // anyone can create an account
  invitesOnly: false,          // require an invite link instead
  defaultRole: 'user',
  adminGetsRootShell: true,
  userHomeTemplate: '/home/{username}',
  autoCreateLinuxUser: true,   // each account gets a real Linux user
  enforceTwoFactorForInvited: false,
};

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// Secrets: generated once, stored 0600, never in config
function loadSecrets() {
  ensureDir(DATA_DIR);
  let s = loadJSON(SECRETS_PATH, null);
  if (!s) {
    s = {
      jwtAccess: crypto.randomBytes(48).toString('hex'),
      jwtRefresh: crypto.randomBytes(48).toString('hex'),
      csrf: crypto.randomBytes(32).toString('hex'),
      aesKey: crypto.randomBytes(32).toString('hex'),
    };
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  return s;
}

ensureDir(DATA_DIR);
const fileCfg = loadJSON(CONFIG_PATH, {});
const cfg = { ...defaults, ...fileCfg };
const secrets = loadSecrets();

// Merge env overrides (env wins over file)
if (process.env.PANEL_JWT_TTL) cfg.jwtAccessTTL = process.env.PANEL_JWT_TTL;
if (process.env.PANEL_RATE_LIMIT_AUTH) cfg.rateLimitAuth = parseInt(process.env.PANEL_RATE_LIMIT_AUTH, 10);
if (process.env.PANEL_RATE_LIMIT_GLOBAL) cfg.rateLimitGlobal = parseInt(process.env.PANEL_RATE_LIMIT_GLOBAL, 10);
if (process.env.PANEL_BRUTE_MAX) cfg.bruteForceMax = parseInt(process.env.PANEL_BRUTE_MAX, 10);
if (process.env.PANEL_INVITES_ONLY) cfg.invitesOnly = process.env.PANEL_INVITES_ONLY === '1';
if (process.env.PANEL_PUBLIC_SIGNUP) cfg.allowPublicSignup = process.env.PANEL_PUBLIC_SIGNUP === '1';
if (process.env.PANEL_CORS) cfg.corsWhitelist = process.env.PANEL_CORS.split(',').filter(Boolean);
if (process.env.PANEL_IP_WHITELIST) cfg.ipWhitelist = process.env.PANEL_IP_WHITELIST.split(',').filter(Boolean);
if (process.env.PANEL_IP_BLACKLIST) cfg.ipBlacklist = process.env.PANEL_IP_BLACKLIST.split(',').filter(Boolean);
if (process.env.PANEL_NOTIFY_WEBHOOK) cfg.notifyWebhook = process.env.PANEL_NOTIFY_WEBHOOK;

module.exports = { cfg, secrets, ROOT, DATA_DIR, CONFIG_PATH, SECRETS_PATH };
