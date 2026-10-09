// db.js - Atomic JSON database with schema versioning (migrations)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const DB_PATH = path.join(DATA_DIR, 'panel.db.json');
const SCHEMA_VERSION = 3;

const empty = () => ({
  version: SCHEMA_VERSION,
  users: [],        // {id, username, email, passwordHash, role, totpSecret, totpEnabled, backupCodes[], createdAt, lastLogin, failedAttempts, lockedUntil}
  sessions: [],     // {id, userId, tokenHash, createdAt, expiresAt, ip, ua, revoked}
  apiKeys: [],      // {id, userId, keyHash, name, createdAt, lastUsed, revoked, role}
  audit: [],        // {id, ts, userId, ip, action, target, result, meta}
  files: [],        // uploaded file registry
  backups: [],      // {id, name, path, size, createdAt, encrypted, sha256}
  notifications: [],// {id, ts, type, title, body, read}
  terminals: [],    // metadata for recorded sessions
  settings: [],       // append-only settings change history
  migrations: [],
});

let db = empty();
let saveTimer = null;

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    // Migration runner
    const migrations = {
      1: (d) => { d.users.forEach(u => { u.role = u.role || 'admin'; }); },
      2: (d) => { d.apiKeys = d.apiKeys || []; d.notifications = d.notifications || []; },
      3: (d) => { d.terminals = d.terminals || []; d.settings = Array.isArray(d.settings) ? d.settings : []; },
    };
    // Run every migration at or above the stored version. Each one is idempotent,
// so this is safe to run on a fresh file, a legacy file or an up-to-date file.
// (A `while (v < SCHEMA_VERSION)` loop would silently skip the last migration.)
const migrationSteps = Object.keys(migrations).map(Number).sort((a, b) => a - b);
    const fromVersion = db.version || 1;
    for (const step of migrationSteps) {
      if (step >= fromVersion) migrations[step](db);
    }
    db.version = SCHEMA_VERSION;
  } catch {
    db = empty();
  }
  save(true);
}

function save(sync = false) {
  if (sync) {
    writeAtomic();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeAtomic(); }, 50);
}

function writeAtomic() {
  const tmp = DB_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  fs.fsyncSync(fs.openSync(tmp, 'r+'));
  fs.renameSync(tmp, DB_PATH);
}

const collections = () => db;

// ---- generic helpers ----
function coll(name) { return db[name]; }
function insert(name, obj) {
  obj.id = obj.id || crypto.randomUUID();
  db[name].push(obj);
  save();
  return obj;
}
function findBy(name, key, val) { return db[name].find(x => x[key] === val) || null; }
function update(name, id, patch) {
  const i = db[name].findIndex(x => x.id === id);
  if (i < 0) return null;
  Object.assign(db[name][i], patch);
  save();
  return db[name][i];
}
function remove(name, id) {
  const i = db[name].findIndex(x => x.id === id);
  if (i < 0) return false;
  db[name].splice(i, 1);
  save();
  return true;
}
function prune(name, keepDays) {
  const cutoff = Date.now() - keepDays * 864e5;
  const before = db[name].length;
  db[name] = db[name].filter(x => (x.ts || x.createdAt || 0) > cutoff);
  if (db[name].length !== before) save();
  return before - db[name].length;
}

// ---- audit log ----
function audit(userId, action, target, result = 'ok', meta = {}, ip = '') {
  const { cfg } = require('./config');
  if (!cfg.auditLog) return;
  db.audit.push({ id: crypto.randomUUID(), ts: Date.now(), userId, ip, action, target, result, meta });
  if (db.audit.length > 50000) db.audit = db.audit.slice(-50000);
  save();
}

// ---- notification ----
function notify(type, title, body) {
  db.notifications.push({ id: crypto.randomUUID(), ts: Date.now(), type, title, body, read: false });
  if (db.notifications.length > 5000) db.notifications = db.notifications.slice(-5000);
  save();
  // async webhook
  const { cfg } = require('./config');
  if (cfg.notifyWebhook) {
    fetch(cfg.notifyWebhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, title, body, ts: Date.now() }),
    }).catch(() => {});
  }
}

load();
module.exports = { db, collections, coll, insert, findBy, update, remove, prune, audit, notify, save, DB_PATH };
