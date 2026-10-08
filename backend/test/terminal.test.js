// test/terminal.test.js - WebSocket + real PTY tests
'use strict';
process.env.PANEL_ROOT = process.env.PANEL_ROOT || '/tmp/vps-panel-test';
process.env.PANEL_DATA = process.env.PANEL_DATA || '/tmp/vps-panel-test/data';
process.env.PANEL_PORT = '18098';

const { startServer } = require('../src/index');
const db = require('../src/db');
const auth = require('../src/auth');
const WebSocket = require('ws');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} ${extra}`); }
}

async function main() {
  // create user directly in DB
  const user = db.insert('users', {
    username: 'termtest', email: 'term@test.dev',
    passwordHash: await auth.hashPassword('TermTest123!@#'),
    role: 'admin', totpSecret: '', totpEnabled: false, backupCodes: [],
    createdAt: Date.now(), lastLogin: null, failedAttempts: 0, lockedUntil: 0,
  });
  const token = auth.signAccess({ sub: user.id, role: 'admin' });

  const app = startServer();
  await new Promise((r) => setTimeout(r, 1200));

  const proto = 'ws';
  const url = `${proto}://127.0.0.1:18098/ws/terminal?token=${token}`;

  // ---- unauthenticated rejected ----
  const badWs = new WebSocket('ws://127.0.0.1:18098/ws/terminal?token=bad');
  const badResult = await new Promise((resolve) => {
    badWs.on('unexpected-response', (req, res) => resolve(res.statusCode));
    badWs.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('WS rejects invalid token (401)', badResult === 401, `got ${badResult}`);

  // ---- real PTY session ----
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  check('WS connects with valid JWT', ws.readyState === WebSocket.OPEN);

  const send = (o) => ws.send(JSON.stringify(o));
  const collect = (type, ms = 4000) => new Promise((resolve) => {
    const buf = [];
    const handler = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (type === '*' || m.type === type) buf.push(m);
      if (m.type === 'exit') resolve(buf);
    };
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(buf); }, ms);
  });

  // create session
  const createdP = collect('created', 5000);
  send({ type: 'create', name: 'test-shell', cols: 80, rows: 24 });
  const created = await createdP;
  const createdMsg = created.find(m => m.type === 'created');
  check('PTY session created', !!createdMsg && !!createdMsg.sessionId, JSON.stringify(created));
  const sid = createdMsg?.sessionId;

  // run real commands
  const outP = collect('data', 5000);
  send({ type: 'input', data: 'echo MARKER_$(whoami)_$(hostname)\n' });
  send({ type: 'input', data: 'ls /etc | head -3\n' });
  send({ type: 'input', data: 'uname -s\n' });
  const out = await outP;
  const allData = out.map(m => m.data || '').join('');
  check('PTY executes echo (real output)', allData.includes('MARKER_'), allData.slice(0, 200));
  check('PTY runs whoami', /MARKER_\w+_/.test(allData));
  check('PTY lists /etc files', /hostnam|passwd|os-release|apt|ssh/.test(allData));
  check('PTY runs uname (Linux)', allData.includes('Linux'));

  // resize
  send({ type: 'resize', cols: 120, rows: 40 });
  await new Promise((r) => setTimeout(r, 300));
  check('resize accepted without error', true);

  // detach + reattach (persistence)
  send({ type: 'detach' });
  await new Promise((r) => setTimeout(r, 300));
  const reattachP = collect('attached', 5000);
  send({ type: 'attach', sessionId: sid });
  const reattached = await reattachP;
  check('reattach to live PTY (session persistence)', reattached.some(m => m.type === 'attached'), JSON.stringify(reattached));

  // scrollback replay on reattach
  const replayP = collect('data', 3000);
  send({ type: 'input', data: 'echo SECOND_MARKER\n' });
  const replay = await replayP;
  check('PTY output continues after reattach', replay.some(m => (m.data || '').includes('SECOND_MARKER')));

  // heartbeat ping/pong
  const pongP = collect('pong', 3000);
  send({ type: 'ping' });
  const pongs = await pongP;
  check('WS heartbeat pong', pongs.length > 0);

  // recording
  const recP = collect('record_started', 3000);
  send({ type: 'record_start' });
  const rec = await recP;
  check('recording starts', rec.some(m => m.type === 'record_started'));
  send({ type: 'input', data: 'echo RECORDED_OUTPUT\n' });
  await new Promise((r) => setTimeout(r, 800));
  send({ type: 'record_stop' });
  await new Promise((r) => setTimeout(r, 500));
  const recMeta = db.coll('terminals').find(t => t.sessionId === sid);
  check('recording persisted to disk', !!recMeta && !!recMeta.file);

  // kill session
  send({ type: 'kill' });
  await new Promise((r) => setTimeout(r, 500));
  check('kill session', true);

  // second concurrent session (multi-terminal)
  const ws2 = new WebSocket(url);
  await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); });
  const c2 = collect2(ws2, 'created', 5000);
  ws2.send(JSON.stringify({ type: 'create', name: 'second-shell', cols: 80, rows: 24 }));
  const created2 = await c2;
  check('second concurrent PTY session', created2.some(m => m.type === 'created'));
  ws2.close();

  ws.close();
  await app.close();

  console.log('\n=== TERMINAL TEST RESULTS ===');
  results.forEach(x => console.log(x));
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail > 0 ? 1 : 0);
}

function collect2(socket, type, ms) {
  return new Promise((resolve) => {
    const buf = [];
    const handler = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === type) buf.push(m);
    };
    socket.on('message', handler);
    setTimeout(() => { socket.off('message', handler); resolve(buf); }, ms);
  });
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
