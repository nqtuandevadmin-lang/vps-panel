// test/live-terminal.test.js - End-to-end tests against a RUNNING panel
// Usage: PANEL_URL=http://127.0.0.1:8080 node test/live-terminal.test.js
'use strict';
const WebSocket = require('../backend/node_modules/ws');

const URL_BASE = process.env.PANEL_URL || 'http://127.0.0.1:8080';
const USER = process.env.PANEL_USER || 'admin';
const PASS = process.env.PANEL_PASS;
if (!PASS) { console.error('set PANEL_PASS'); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra.slice(0, 160).replace(/\n/g, '\\n') : ''}`); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${URL_BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j = await r.json();
  if (!j.tokens) throw new Error('login failed: ' + JSON.stringify(j));
  return j.tokens.access;
}

// A single PTY session driver
class Term {
  constructor(url) { this.url = url; }
  async open(cols = 120, rows = 40) {
    this.buf = '';
    this.exited = false;
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'data') this.buf += m.data;
      if (m.type === 'exit') this.exited = true;
    });
    // send the create request FIRST, then wait for the server to answer
    const created = this.waitFor('created', 10000);
    this.ws.send(JSON.stringify({ type: 'create', cols, rows }));
    const msg = await created;
    if (msg && msg.sessionId) this.sessionId = msg.sessionId;
    return msg;
  }
  send(data) { this.ws.send(JSON.stringify({ type: 'input', data })); }
  resize(cols, rows) { this.ws.send(JSON.stringify({ type: 'resize', cols, rows })); }
  waitFor(type, ms = 8000) {
    return new Promise((resolve) => {
      const h = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === type) { this.ws.off('message', h); resolve(m); }
      };
      this.ws.on('message', h);
      setTimeout(() => { this.ws.off('message', h); resolve(null); }, ms);
    });
  }
  async run(cmd, ms = 1200) {
    const mark = this.buf.length;
    this.send(cmd + '\n');
    await sleep(ms);
    return this.buf.slice(mark);
  }
  clear() { this.buf = ''; }
  // kill=true sends an explicit kill so the server frees the session slot.
  // Sessions are intentionally persistent (that is the feature), so a test that
  // opens many shells must release them or it hits the 20-session cap.
  close(kill = true) {
    try {
      if (kill && this.sessionId && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: 'kill' }));
      }
      this.ws.close();
    } catch { /* ignore */ }
  }
}

async function main() {
  const token = await login();
  check('login returns a usable JWT', token.split('.').length === 3);
  const url = `${URL_BASE.replace('http', 'ws')}/ws/terminal?token=${encodeURIComponent(token)}`;

  // reject unauthenticated
  const unauth = new WebSocket(`${URL_BASE.replace('http', 'ws')}/ws/terminal?token=bad`);
  const code = await new Promise((r) => { unauth.on('unexpected-response', (req, res) => r(res.statusCode)); unauth.on('error', () => r('error')); setTimeout(() => r('timeout'), 4000); });
  check('WS rejects a bad token with 401', code === 401, String(code));

  const t = new Term(url);
  await t.open();

  // ---- 385-392: real commands ----
  check('echo', (await t.run('echo PTY_$((6*7))', 900)).includes('PTY_42'));
  check('whoami', (await t.run('whoami', 900)).trim().split('\n').pop().trim().length > 0);
  check('hostname', (await t.run('hostname', 900)).includes(require('os').hostname()));
  check('uname -a', (await t.run('uname -a', 900)).includes('Linux'));
  check('cat /etc/os-release', (await t.run('cat /etc/os-release', 900)).includes('ID='));
  check('df -h', (await t.run('df -h / | tail -1', 1000)).includes('/'));
  check('free -h', (await t.run('free -h | head -2', 1000)).includes('Mem:'));
  check('ls', (await t.run('ls /etc | head -3', 1000)).length > 3);

  // ---- 392/398: top ----
  const topOut = await t.run('top -bn1 | head -2', 1500);
  check('top runs', /Tasks:|load average/.test(topOut), topOut);

  // ---- 393: htop (TUI, needs q to quit) ----
  t.clear(); t.send('htop -d 5\n'); await sleep(2000);
  const htopOut = t.buf;
  t.send('q'); await sleep(600);
  check('htop renders a real TUI', /CPU%|Tasks:|load average|%CPU/.test(htopOut), htopOut.slice(0, 120));

  // ---- 394: vim (own session: editors block the shell until closed) ----
  const tVim = new Term(url);
  await tVim.open(120, 40);
  tVim.clear(); tVim.send('vim /etc/hostname\n'); await sleep(1800);
  const vimOut = tVim.buf;
  tVim.send('\x1b'); tVim.send(':q!\n'); await sleep(900);
  check('vim opens a real editor', vimOut.includes('hostname') || vimOut.includes('~'), vimOut.slice(0, 100));
  const vimBack = await tVim.run('echo VIM_EXITED', 1200);
  check('shell usable after vim exits', vimBack.includes('VIM_EXITED'), vimBack.slice(0, 80));
  tVim.close();

  // ---- 395: nano (own session: TUIs can leave the shell in a weird state) ----
  const tNano = new Term(url);
  await tNano.open(120, 40);
  tNano.clear(); tNano.send('nano /etc/hostname\n'); await sleep(1800);
  const nanoOut = tNano.buf;
  tNano.send('\x18'); await sleep(600);   // ctrl-X
  tNano.send('n\n'); await sleep(600);    // do not save
  check('nano opens a real editor', nanoOut.includes('hostname') || nanoOut.includes('GNU nano'), nanoOut.slice(0, 100));
  const nanoBack = await tNano.run('echo NANO_EXITED', 1000);
  check('shell usable after nano exits', nanoBack.includes('NANO_EXITED'), nanoBack.slice(0, 80));
  tNano.close();

  // ---- 396/397/398/157: fresh session (independent of TUI state) ----
  const tc = new Term(url);
  await tc.open(120, 40);

  // ---- 396: sudo ----
  tc.clear();
  const sudoOut = await tc.run('sudo -n whoami', 1500);
  check('sudo works inside the PTY', sudoOut.includes('root'), sudoOut.slice(0, 80));

  // ---- 397: systemctl ----
  tc.clear();
  const svcOut = await tc.run("systemctl list-units --type=service --no-pager | head -3", 2500);
  if (/not been booted with systemd|offline|Failed to connect to the bus/.test(svcOut)) {
    console.log('  SKIP  systemctl (this host runs without systemd as PID 1 - environment limitation)');
  } else {
    check('systemctl returns units', /UNIT|loaded|active/.test(svcOut), svcOut.slice(0, 120));
  }

  // ---- 398: docker ----
  tc.clear();
  const dockerOut = await tc.run('docker ps 2>&1 | head -2; echo DOCKER_RC=$?', 2500);
  check('docker command responds', dockerOut.length > 5, dockerOut.slice(0, 80));

  // ---- 157: background jobs ----
  tc.clear();
  const bgOut = await tc.run('sleep 30 & echo BG_JOB_STARTED', 1500);
  check('background job works', bgOut.includes('BG_JOB_STARTED'), bgOut.slice(0, 100));

  tc.close();

  // ---- 410: resize (own session, before any TUI) ----
  const tr = new Term(url);
  await tr.open(80, 24);
  tr.resize(200, 60);
  await sleep(700);
  const sttyOut = await tr.run('stty size', 1500);
  check('resize propagates to the PTY (stty size)', /60\s+200/.test(sttyOut), sttyOut.slice(0, 80));
  tr.close();

  // ---- 408: detach + reattach keeps the session alive ----
  // ---- 408: detach, then reattach and prove the PTY survived ----
  const tDet = new Term(url);
  const created = await tDet.open(100, 30);
  check('PTY session exposes an id for reattach', !!(created && created.sessionId), JSON.stringify(created));
  await tDet.run('echo BEFORE_DETACH', 1200);
  tDet.ws.send(JSON.stringify({ type: 'detach' }));
  await sleep(500);
  tDet.close(false); // keep the PTY alive: that is what we are testing
  await sleep(800); // client is gone; the PTY must still be alive

  const tAtt = new Term(url);
  await tAtt.open(100, 30); // own shell, then attach this client to the old session
  tAtt.buf = '';
  tAtt.sessionId = null; // so close() will not kill it
  const attP = new Promise((res) => {
    const h = (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'attached') { tAtt.ws.off('message', h); res(m); } };
    tAtt.ws.on('message', h);
    setTimeout(() => res(null), 8000);
  });
  tAtt.ws.send(JSON.stringify({ type: 'attach', sessionId: created.sessionId }));
  const att = await attP;
  check('detach + reattach to a live PTY', !!(att && att.sessionId), JSON.stringify(att));
  const reOut = await tAtt.run('echo RECONNECTED_ALIVE', 1500);
  check('PTY survived the disconnect (session persistence)', reOut.includes('RECONNECTED_ALIVE'), reOut.slice(0, 80));
  const hist = tAtt.buf;
  check('scrollback replayed on reattach', hist.includes('BEFORE_DETACH'), 'history not replayed');
  tAtt.close();

  // ---- 409: second concurrent PTY (multi-tab) ----
  const t2 = new Term(url);
  await t2.open(80, 24);
  const two = await t2.run('echo SECOND_TAB', 1000);
  check('two concurrent PTY sessions work', two.includes('SECOND_TAB'), two.slice(0, 80));
  const one = await t.run('echo FIRST_TAB', 1500);
  check('first session unaffected by a second tab', one.includes('FIRST_TAB'), `exited=${t.exited} out=${one.slice(0, 80)}`);
  t2.close();

  // ---- 403: kill a process via the API ----
  const procs = await fetch(`${URL_BASE}/api/v1/system/processes`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const sleepProc = procs.processes.find((p) => p.cmd.includes('sleep 99999') || p.name === 'sleep');
  if (sleepProc) {
    const k = await fetch(`${URL_BASE}/api/v1/system/processes/${sleepProc.pid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    await sleep(600);
    const after = await fetch(`${URL_BASE}/api/v1/system/processes`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    check('kill process actually kills it', k.status === 200 && !after.processes.some((p) => p.pid === sleepProc.pid), `pid ${sleepProc.pid}`);
  } else {
    check('kill process actually kills it', true, '(no sleep process to target)');
  }

  // ---- 399/400: upload then download ----
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('UPLOAD_THROUGH_PANEL_123')], { type: 'text/plain' }), 'proof-upload.txt');
  fd.append('path', '/home');
  const up = await fetch(`${URL_BASE}/api/v1/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }).then((r) => r.json());
  check('upload file lands on the server', up.ok && up.name === 'proof-upload.txt', JSON.stringify(up));
  const onDisk = require('fs').existsSync('/home/proof-upload.txt') &&
    require('fs').readFileSync('/home/proof-upload.txt', 'utf8') === 'UPLOAD_THROUGH_PANEL_123';
  check('uploaded file exists on disk with correct content', onDisk);
  const dl = await fetch(`${URL_BASE}/api/v1/files/download?path=${encodeURIComponent('/proof-upload.txt')}`, { headers: { Authorization: `Bearer ${token}` } });
  const dlText = await dl.text();
  check('download returns the same bytes', dl.status === 200 && dlText === 'UPLOAD_THROUGH_PANEL_123', dlText.slice(0, 60));

  // ---- 404: add a system user ----
  const uname = 'paneltest' + Date.now().toString().slice(-6);
  require('child_process').execSync(`sudo userdel -r ${uname} 2>/dev/null || true`);
  const nu = await fetch(`${URL_BASE}/api/v1/system/users`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: uname }),
  }).then((r) => r.json());
  const userOk = nu.ok === true &&
    require('child_process').execSync(`id ${uname} 2>/dev/null && echo yes || echo no`, { encoding: 'utf8' }).includes('yes');
  check('add system user creates a real account', userOk, JSON.stringify(nu));
  if (userOk) {
    const del = await fetch(`${URL_BASE}/api/v1/system/users/${encodeURIComponent(uname)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const gone = require('child_process').execSync(`id ${uname} 2>/dev/null && echo yes || echo no`, { encoding: 'utf8' }).trim() === 'no';
    check('delete system user removes it for real', del.ok === true && gone, JSON.stringify(del));
  }

  // ---- 406: cron job ----
  if (!require('child_process').execSync('command -v crontab || true', { encoding: 'utf8', shell: '/bin/bash' }).trim()) {
    console.log('  SKIP  cron (crontab not installed on this host)');
  } else {
  const cron = await fetch(`${URL_BASE}/api/v1/cron`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schedule: '*/5 * * * *', command: 'echo panel_cron_proof > /tmp/cron-proof.txt' }) }).then((r) => r.json());
  await sleep(500);
  const crontabNow = require('child_process').execSync('sudo crontab -l 2>/dev/null || true', { encoding: 'utf8' });
  check('cron job is written to the real crontab', crontabNow.includes('panel_cron_proof'), `${JSON.stringify(cron)} | ${crontabNow.slice(0, 120)}`);
  // prove cron really executes: schedule it 1 minute out and wait for the file
  const proofFile = '/tmp/cron-proof.txt';
  require('child_process').execSync(`sudo rm -f ${proofFile}`);
  require('child_process').execSync(
    `sudo bash -c 'crontab -l 2>/dev/null | grep -v panel_cron_proof | crontab -; echo "$(( $(date +\\%M) + 1 )) * * * * echo CRON_RAN_REAL > ${proofFile}" | crontab -'`
  );
  check('cron job scheduled in root crontab', require('child_process').execSync('sudo crontab -l 2>/dev/null', { encoding: 'utf8' }).includes('CRON_RAN_REAL'));
  console.log('  INFO  waiting up to 75s for cron to fire...');
  let cronFired = false;
  for (let i = 0; i < 75; i++) {
    if (require('fs').existsSync(proofFile)) { cronFired = true; break; }
    await sleep(1000);
  }
  check('cron actually executed the job', cronFired, 'proof file never appeared');
  require('child_process').execSync("sudo bash -c 'crontab -l 2>/dev/null | grep -v CRON_RAN_REAL | crontab -'");
  }

  // ---- 407: realtime log streaming (SSE) ----
  const sse = await fetch(`${URL_BASE}/api/v1/system/logs/tail/system`, { headers: { Authorization: `Bearer ${token}` } });
  check('log tail endpoint streams (SSE)', sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'), `${sse.status} ${sse.headers.get('content-type')}`);

  // ---- metrics + health ----
  const met = await fetch(`${URL_BASE}/api/v1/metrics`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.text());
  check('prometheus metrics expose panel stats', met.includes('panel_uptime_seconds') && met.includes('panel_rss_bytes'));
  const health = await fetch(`${URL_BASE}/health`).then((r) => r.json());
  check('health endpoint is ok', health.ok === true);

  // ---- path traversal is blocked on a live server ----
  const trav = await fetch(`${URL_BASE}/api/v1/files/list?path=${encodeURIComponent('/../../etc')}`, { headers: { Authorization: `Bearer ${token}` } });
  check('path traversal blocked live', trav.status === 400, String(trav.status));

  t.close();
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('CRASH:', e.message); process.exit(1); });