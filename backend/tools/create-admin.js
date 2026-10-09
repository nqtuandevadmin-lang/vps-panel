// create-admin.js - CLI: create the first admin user with random password (bcrypt cost 12)
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// bootstrap config/db without starting server
process.env.PANEL_ROOT = process.env.PANEL_ROOT || '/opt/vps-panel';
process.env.PANEL_DATA = process.env.PANEL_DATA || path.join(process.env.PANEL_ROOT, 'data');

const { cfg } = require('../src/config');
const db = require('../src/db');
const auth = require('../src/auth');

(async () => {
  const username = process.argv[2] || 'admin';
  const password = process.argv[3] || auth.randomPassword(18);
  const errs = auth.passwordPolicy(password);
  if (errs.length) { console.error('password does not meet policy: ' + errs.join(', ')); process.exit(1); }
  const existing = db.findBy('users', 'username', username.toLowerCase());
  if (existing) { console.error('user already exists: ' + username); process.exit(1); }
  const user = db.insert('users', {
    username: username.toLowerCase(),
    email: `${username.toLowerCase()}@localhost`,
    passwordHash: await auth.hashPassword(password),
    role: 'admin',
    totpSecret: '', totpEnabled: false, backupCodes: [],
    createdAt: Date.now(), lastLogin: null, failedAttempts: 0, lockedUntil: 0,
  });
  db.audit(user.id, 'install.create-admin', user.id, 'ok');
  // output machine-readable for installer
  console.log(JSON.stringify({ ok: true, username: user.username, password, id: user.id }));
})();
