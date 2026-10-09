// test/db.test.js - Regression tests for the JSON store: persistence, atomic write,
// migrations, and the data-loss bug where a startup migration error wiped the file.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-panel-dbtest-'));
process.env.PANEL_ROOT = ROOT;
process.env.PANEL_DATA = path.join(ROOT, 'data');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

// seed a database file the way the installer does (external process writes it)
const dbPath = path.join(process.env.PANEL_DATA, 'panel.db.json');
fs.mkdirSync(process.env.PANEL_DATA, { recursive: true });
const seeded = {
  version: 4,
  users: [{ id: 'u1', username: 'admin', email: 'a@b.c', passwordHash: 'x', role: 'admin', totpSecret: '', totpEnabled: false, backupCodes: [], createdAt: 1, lastLogin: null, failedAttempts: 0, lockedUntil: 0 }],
  sessions: [], apiKeys: [], audit: [], files: [], backups: [], notifications: [], terminals: [], settings: [], migrations: [],
};
fs.writeFileSync(dbPath, JSON.stringify(seeded, null, 1), { mode: 0o600 });

const db = require('../src/db');

check('users survive a fresh process load', db.coll('users').length === 1, `got ${db.coll('users').length}`);
check('seeded user is the admin', db.coll('users')[0]?.username === 'admin');

// schema version is preserved / normalised
check('schema version is current', db.db.version === 4, `got ${db.db.version}`);

// a second write must not drop existing rows (this is the regression that wiped data)
db.insert('audit', { ts: Date.now(), userId: 'u1', action: 'test', target: 'x', result: 'ok' });
check('insert keeps existing users', db.coll('users').length === 1, `got ${db.coll('users').length}`);

setTimeout(() => {
  const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  check('file on disk still has the admin user', onDisk.users.length === 1, `got ${onDisk.users.length}`);
  check('file on disk has the new audit row', onDisk.audit.length === 1, `got ${onDisk.audit.length}`);

  // reload the same file in this process (simulates a restart) - must not wipe
  delete require.cache[require.resolve('../src/db')];
  const db2 = require('../src/db');
  check('restart preserves users', db2.coll('users').length === 1, `got ${db2.coll('users').length}`);
  check('restart preserves audit rows', db2.coll('audit').length === 1, `got ${db2.coll('audit').length}`);

  // old schema file gets migrated instead of discarded
  const legacy = path.join(ROOT, 'legacy.json');
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/db')];
  process.env.PANEL_DATA = path.join(ROOT, 'legacy-data');
  fs.mkdirSync(process.env.PANEL_DATA, { recursive: true });
  fs.writeFileSync(path.join(process.env.PANEL_DATA, 'panel.db.json'),
    JSON.stringify({ version: 1, users: [{ username: 'legacy' }], sessions: [] }));
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/db')];
  const db3 = require('../src/db');
  check('legacy schema is migrated (user kept)', db3.coll('users').length === 1 && db3.coll('users')[0].role === 'admin',
    JSON.stringify(db3.coll('users')));
  check('migration adds missing collections', Array.isArray(db3.coll('settings')) && Array.isArray(db3.coll('terminals')) && Array.isArray(db3.coll('connectTokens')) && Array.isArray(db3.coll('nodes')));

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail > 0 ? 1 : 0);
}, 200);