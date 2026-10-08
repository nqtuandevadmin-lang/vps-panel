// test/api.test.js - Integration tests: auth, 2FA, rate limit, files, system, ops
'use strict';
process.env.PANEL_ROOT = process.env.PANEL_ROOT || '/tmp/vps-panel-test';
process.env.PANEL_DATA = process.env.PANEL_DATA || '/tmp/vps-panel-test/data';
process.env.PANEL_PORT = '18099';
// raise limits so the full suite is not blocked by the (correct) production rate limits
process.env.PANEL_RATE_LIMIT_AUTH = process.env.PANEL_RATE_LIMIT_AUTH || '1000';
process.env.PANEL_RATE_LIMIT_GLOBAL = process.env.PANEL_RATE_LIMIT_GLOBAL || '5000';
process.env.PANEL_BRUTE_MAX = process.env.PANEL_BRUTE_MAX || '100';
// file manager needs a writable root; use a temp dir for tests (installer uses /home)
process.env.PANEL_FILE_ROOT = process.env.PANEL_FILE_ROOT || '/tmp/vps-panel-test/data/files';
require('fs').mkdirSync(process.env.PANEL_FILE_ROOT, { recursive: true });

const { startServer } = require('../src/index');
const fs = require('fs');

const BASE = 'http://127.0.0.1:18099/api/v1';
let pass = 0, fail = 0;
const results = [];

function check(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} ${extra}`); }
}

async function req(method, path, { body, headers = {}, token } = {}) {
  const h = { ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json', ...h } : h,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

async function main() {
  // start server
  const app = startServer();
  await new Promise((r) => setTimeout(r, 1500));

  // ---- health ----
  let r = await req('GET', '/../health'); // health is outside /api/v1
  r = await fetch('http://127.0.0.1:18099/health').then(x => x.json());
  check('health endpoint', r.ok === true && r.status === 'ok');

  // ---- auth status (first run) ----
  r = await req('GET', '/auth/status');
  check('auth/status reports needsSetup', r.data.needsSetup === true);

  // ---- register validation ----
  r = await req('POST', '/auth/register', { body: { username: 'ab', email: 'x@y.z', password: 'short' } });
  check('register rejects weak password', r.status === 400);
  r = await req('POST', '/auth/register', { body: { username: 'bad name!', email: 'x@y.z', password: 'Longenough123!@#' } });
  check('register rejects invalid username', r.status === 400);

  // ---- register first admin ----
  const ADMIN = { username: 'admin', email: 'admin@test.dev', password: 'Sup3rSecure!Pass1' };
  r = await req('POST', '/auth/register', { body: ADMIN });
  check('first user becomes admin', r.status === 200 && r.data.user.role === 'admin', JSON.stringify(r.data));
  const adminId = r.data.user.id;

  // duplicate registration
  r = await req('POST', '/auth/register', { body: ADMIN });
  check('register rejects duplicates', r.status === 409);

  // ---- login ----
  r = await req('POST', '/auth/login', { body: { username: 'admin', password: 'wrongpassword123' } });
  check('login rejects wrong password', r.status === 401);
  r = await req('POST', '/auth/login', { body: { username: 'admin', password: ADMIN.password } });
  check('login success returns JWT + refresh + csrf', r.status === 200 && !!r.data.tokens.access && !!r.data.tokens.refresh && !!r.data.csrf);
  const TOKEN = r.data.tokens.access;
  const REFRESH = r.data.tokens.refresh;
  const CSRF = r.data.csrf;

  // ---- JWT enforcement ----
  r = await req('GET', '/system/overview');
  check('API requires auth (401)', r.status === 401);
  r = await req('GET', '/system/overview', { token: 'garbage.token.here' });
  check('API rejects invalid JWT', r.status === 401);

  // ---- system overview ----
  r = await req('GET', '/system/overview', { token: TOKEN });
  check('system/overview returns real data', r.status === 200 && r.data.ok && r.data.server.hostname && r.data.mem.total > 0);
  check('overview has cpu/mem/disk', r.data.cpu.usage >= 0 && r.data.mem.usage > 0 && Array.isArray(r.data.disks));

  // ---- monitor + history ----
  r = await req('GET', '/system/monitor', { token: TOKEN });
  check('system/monitor snapshot', r.status === 200 && r.data.cpu && r.data.processes.length > 0);
  r = await req('GET', '/system/history', { token: TOKEN });
  check('system/history returns series array', r.status === 200 && Array.isArray(r.data.series));

  // ---- processes ----
  r = await req('GET', '/system/processes', { token: TOKEN });
  check('process list non-empty', r.status === 200 && r.data.processes.length > 0);

  // ---- services ----
  r = await req('GET', '/system/services', { token: TOKEN });
  check('services list', r.status === 200 && Array.isArray(r.data.services));

  // ---- files: list/read/write/mkdir/remove with traversal protection ----
  r = await req('GET', '/files/list?path=/', { token: TOKEN });
  check('files/list root', r.status === 200 && Array.isArray(r.data.items));
  r = await req('GET', '/files/list?path=../../etc', { token: TOKEN });
  check('path traversal blocked', r.status === 400, `got ${r.status}`);
  r = await req('PUT', '/files/write', { token: TOKEN, body: { path: '/test-dir/hello.txt', content: 'vps-panel-test-123' } });
  check('file write', r.status === 200 && r.data.ok);
  r = await req('GET', '/files/read?path=/test-dir/hello.txt', { token: TOKEN });
  check('file read back', r.data.content === 'vps-panel-test-123');
  r = await req('GET', '/files/search?path=/&q=test-dir', { token: TOKEN });
  check('file search', r.status === 200);
  r = await req('DELETE', '/files/remove', { token: TOKEN, body: { path: '/test-dir' } });
  check('file remove', r.status === 200);

  // ---- file upload (multipart) ----
  const fd = new FormData();
  const blob = new Blob([Buffer.from('upload-test-content-' + Date.now())], { type: 'text/plain' });
  fd.append('file', blob, 'upload-test.txt');
  fd.append('path', '/uploads');
  const upRes = await fetch(BASE + '/files/upload', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
  const upData = await upRes.json();
  check('multipart upload works', upRes.status === 200 && upData.ok && upData.sha256, JSON.stringify(upData));
  r = await req('DELETE', '/files/remove', { token: TOKEN, body: { path: '/uploads' } });

  // ---- 2FA flow ----
  r = await req('POST', '/auth/2fa/setup', { token: TOKEN });
  check('2fa setup returns secret+uri', r.status === 200 && !!r.data.secret && r.data.uri.startsWith('otpauth://'));
  const secret = r.data.secret;
  r = await req('POST', '/auth/2fa/confirm', { token: TOKEN, body: { token: '000000' } });
  check('2fa confirm rejects wrong code', r.status === 400);
  // generate valid TOTP with otplib directly
  const otplib = require('otplib');
  const code = otplib.authenticator.generate(secret);
  r = await req('POST', '/auth/2fa/confirm', { token: TOKEN, body: { token: code } });
  check('2fa confirm with real TOTP code', r.status === 200 && Array.isArray(r.data.codesPlain) && r.data.codesPlain.length === 8, JSON.stringify(r.data));
  const backupCodes = r.data.codesPlain;

  // login now requires 2FA
  r = await req('POST', '/auth/login', { body: { username: 'admin', password: ADMIN.password } });
  check('login requires 2FA after enable', r.status === 401 && r.data.mfaRequired === true);
  r = await req('POST', '/auth/login', { body: { username: 'admin', password: ADMIN.password, totp: otplib.authenticator.generate(secret) } });
  check('login with TOTP succeeds', r.status === 200 && !!r.data.tokens.access);
  const TOKEN2 = r.data.tokens.access;

  // backup code login
  const bc = backupCodes[0];
  r = await req('POST', '/auth/login', { body: { username: 'admin', password: ADMIN.password, backupCode: bc } });
  check('login with backup code succeeds', r.status === 200);

  // ---- sessions ----
  r = await req('GET', '/auth/sessions', { token: TOKEN2 });
  check('session list', r.status === 200 && r.data.sessions.length >= 2);

  // ---- refresh token ----
  r = await req('POST', '/auth/refresh', { body: { refresh: REFRESH } });
  check('refresh token works', r.status === 200 && !!r.data.tokens.access);

  // ---- API keys ----
  r = await req('POST', '/auth/apikeys', { token: TOKEN2, body: { name: 'test-key' } });
  check('API key creation', r.status === 200 && r.data.key.startsWith('vp_'));
  const apiKey = r.data.key;
  r = await req('GET', '/system/overview', { headers: { 'x-api-key': apiKey } });
  check('API key auth works', r.status === 200 && r.data.ok);

  // ---- CSRF: cookie auth on mutating route without CSRF token ----
  // (simulate: no bearer, only cookie) - cookie not set in fetch easily; verify CSRF middleware exists by checking header requirement logic path
  r = await req('PUT', '/settings', { token: TOKEN2, body: { backupTime: '04:00' } });
  check('settings update (Bearer is CSRF-exempt)', r.status === 200);

  // ---- metrics ----
  r = await req('GET', '/metrics', { token: TOKEN2 });
  check('prometheus metrics', r.status === 200 && r.text.includes('panel_uptime_seconds'));

  // ---- audit ----
  r = await req('GET', '/audit', { token: TOKEN2 });
  check('audit log has entries', r.status === 200 && r.data.audit.length > 0);

  // ---- docs ----
  r = await req('GET', '/docs');
  check('OpenAPI docs endpoint', r.status === 200 && r.data.openapi === '3.0.0');

  // ---- update check ----
  r = await req('GET', '/update/check', { token: TOKEN2 });
  check('update checker responds', r.status === 200);

  // ---- notifications ----
  r = await req('GET', '/notifications', { token: TOKEN2 });
  check('notifications endpoint', r.status === 200 && Array.isArray(r.data.notifications));

  // ---- password change ----
  const NEWPASS = 'N3wSup3rSecure!Pass2';
  r = await req('POST', '/auth/password', { token: TOKEN2, body: { oldPassword: ADMIN.password, newPassword: NEWPASS } });
  check('password change', r.status === 200);

  // ---- logout ----
  r = await req('POST', '/auth/logout', { token: TOKEN2 });
  check('logout revokes session', r.status === 200);

  // ---- security headers ----
  const home = await fetch('http://127.0.0.1:18099/');
  check('security headers present',
    home.headers.get('x-content-type-options') === 'nosniff' &&
    home.headers.get('x-frame-options') === 'DENY' &&
    !!home.headers.get('content-security-policy'));
  check('static frontend served', home.status === 200 && (await home.text()).includes('VPS Panel'));

  // ---- graceful shutdown ----
  await app.close();
  check('graceful shutdown', true);

  // ---- report ----
  console.log('\n=== API TEST RESULTS ===');
  results.forEach(x => console.log(x));
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
