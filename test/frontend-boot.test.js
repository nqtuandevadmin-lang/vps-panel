// test/frontend-boot.test.js - Simulates the browser boot flow with jsdom.
// Verifies that a visitor always ends up on a real screen: login page when signed
// out, app shell when signed in, and never a blank/black page.
// Usage: node test/frontend-boot.test.js   (run from the repo root, needs jsdom)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18777;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// minimal static server so the page loads real assets
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, 'frontend', url === '/' ? 'index.html' : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(file);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webmanifest': 'application/json' };
  res.writeHead(200, { 'content-type': types[ext] || 'text/plain' });
  res.end(fs.readFileSync(file));
});

// The page loads xterm.js from a CDN. Stub it so the test works offline.
const STUB = `<script>
  window.Terminal = function(){ this.cols=80; this.rows=24; this.open=()=>{}; this.write=()=>{};
    this.loadAddon=()=>{}; this.resize=()=>{}; this.getSelection=()=>''; this.paste=()=>{};
    this.onData=()=>{}; this.onResize=()=>{}; };
  window.FitAddon = { FitAddon: function(){ this.fit=()=>{}; } };
  window.WebLinksAddon = { WebLinksAddon: function(){} };
  window.matchMedia = window.matchMedia || (q => ({ matches:false, addListener(){}, removeListener(){} }));
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/v1/auth/status')) return { ok:true, json: async () => ({ ok:true, needsSetup:false, users:1 }) };
    if (u.includes('/api/v1/auth/registration-info')) return { ok:true, json: async () => ({ ok:true, allowPublicSignup:true, invitesOnly:false }) };
    if (u.includes('/api/v1/settings')) return { ok:true, json: async () => ({ ok:true }) };
    if (u.includes('/api/v1/notifications')) return { ok:true, json: async () => ({ ok:true, notifications:[] }) };
    if (u.includes('/api/v1/auth/login')) return { ok:true, json: async () => ({ ok:true, user:{username:'admin',role:'admin'}, tokens:{access:'a.b.c', refresh:'r'}, csrf:'c' }) };
    return { ok:true, status:200, json: async () => ({ ok:true }) };
  };
</script>`;

async function run(signedIn) {
  const { JSDOM, VirtualConsole } = require('jsdom');
  const html = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="https://fonts.googleapis.com', '<link data-x href="https://fonts.googleapis.com');
  const errors = [];
  const vc = new VirtualConsole();
  const CDN = /cdn\.jsdelivr\.net|fonts\.googleapis\.com/;
  vc.on('jsdomError', (e) => { if (!CDN.test(String(e.message))) errors.push('jsdomError: ' + (e && e.stack ? e.stack.split('\n').slice(0,4).join(' | ') : String(e.message))); });
  vc.on('error', (...a) => { const t = a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0,5).join(' >> ') : String(x)).join(' '); if (!CDN.test(t)) errors.push(t); });
  vc.on('log', (...a) => { const line = a.map(x => (x && x.stack) ? x.stack : String(x)).join(' '); console.log('   [page]', line.slice(0,400)); });

  const dom = new JSDOM(html.replace('<script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.min.js"></script>', STUB), {
    url: `http://127.0.0.1:${PORT}/`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // inject the network stubs BEFORE any script runs
      window.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/v1/settings')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
        if (u.includes('/api/v1/system/overview')) return { ok: true, status: 200, json: async () => ({ ok: true,
          server: { hostname: 'test', cpus: 4, cpuModel: 'x', kernel: 'l', arch: 'x64', uptime: 100, load: { '1m': 0, '5m': 0, '15m': 0 }, os: {} },
          cpu: { usage: 1 }, mem: { usage: 10, used: 1, total: 10 }, disks: [], network: { interfaces: [], listening: [] }, services: [],
          panel: { node: 'v20' } }) };
        if (u.includes('/api/v1/system/monitor')) return { ok: true, status: 200, json: async () => ({ ok: true, cpu: { usage: 1 }, mem: {}, load: {}, disks: [], processes: [] }) };
        if (u.includes('/api/v1/system/history')) return { ok: true, status: 200, json: async () => ({ ok: true, series: [] }) };
        if (u.includes('/api/v1/auth/status')) return { ok: true, status: 200, json: async () => ({ ok: true, needsSetup: false, users: 1 }) };
        if (u.includes('/api/v1/auth/registration-info')) return { ok: true, status: 200, json: async () => ({ ok: true, allowPublicSignup: true, invitesOnly: false }) };
        if (u.includes('/api/v1/notifications')) return { ok: true, status: 200, json: async () => ({ ok: true, notifications: [] }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };
      window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      if (signedIn) {
        window.localStorage.setItem('panel_token', 'a.b.c');
        window.localStorage.setItem('panel_user', JSON.stringify({ username: 'admin', role: 'admin' }));
        window.localStorage.setItem('panel_csrf', 'csrf');
      }
    },
  });
  const { window } = dom;
  await new Promise(r => setTimeout(r, 3200)); // let boot() run

  const d = window.document;
  const auth = d.getElementById('login-screen');
  const shell = d.getElementById('app-shell');
  const splash = d.getElementById('splash');
  const visible = (el) => el && !el.hasAttribute('hidden');
  return { errors, authVisible: visible(auth), shellVisible: visible(shell), splashGone: !splash || splash.classList.contains('done') || splash.hasAttribute('hidden') };
}

(async () => {
  server.listen(PORT);
  try {
    // signed out -> the login page must be on screen
    const out = await run(false);
    check('signed out: no uncaught JS error', out.errors.length === 0, out.errors.slice(0, 2).join(' | '));
    check('signed out: login page is visible', out.authVisible);
    check('signed out: app shell is hidden', !out.shellVisible);
    check('signed out: splash is gone (no black screen)', out.splashGone);

    // signed in -> the app shell must be on screen
    const inr = await run(true);
    check('signed in: no uncaught JS error', inr.errors.length === 0, inr.errors.slice(0, 2).join(' | '));
    check('signed in: app shell is visible', inr.shellVisible);
    check('signed in: login page is hidden', !inr.authVisible);
    check('signed in: splash is gone', inr.splashGone);
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail > 0 ? 1 : 0);
})();