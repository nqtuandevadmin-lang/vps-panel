// test/terminal.test.js - Terminal relay tests.
// The panel no longer runs a shell of its own: every session is relayed to a
// CONNECTED VPS node through its agent. This test plays the part of that agent
// so the whole browser <-> panel <-> agent path is verified for real.
'use strict';
process.env.PANEL_ROOT = process.env.PANEL_ROOT || '/tmp/vps-panel-termtest';
process.env.PANEL_DATA = process.env.PANEL_DATA || '/tmp/vps-panel-termtest/data';
process.env.PANEL_PORT = '18096';

const fs = require('fs');
const { startServer } = require('../src/index');
const db = require('../src/db');
const auth = require('../src/auth');
const WebSocket = require('ws');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const user = db.insert('users', {
    username: 'termtest', email: 'term@test.dev',
    passwordHash: await auth.hashPassword('TermTest123!@#'),
    role: 'admin', totpSecret: '', totpEnabled: false, backupCodes: [],
    createdAt: Date.now(), lastLogin: null, failedAttempts: 0, lockedUntil: 0,
  });
  const token = auth.signAccess({ sub: user.id, role: 'admin' });

  // a connect token bound to this node, as the connect flow would create it
  const NODE = 'testnode0000000001';
  const rec = db.insert('connectTokens', {
    token: 'test-token-abc', note: '', createdAt: Date.now(),
    expiresAt: Date.now() + 600000, usedAt: null, usedBy: null, revoked: false,
    nodeId: NODE, ownerId: user.id, createdBy: user.id,
  });

  const app = startServer();
  await sleep(1200);

  // ---- 1. unauthenticated websocket is rejected ----
  const badWs = new WebSocket('ws://127.0.0.1:18096/ws/terminal?token=bad');
  const badCode = await new Promise((resolve) => {
    badWs.on('unexpected-response', (req, res) => resolve(res.statusCode));
    badWs.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('WS rejects an invalid token (401)', badCode === 401, String(badCode));

  // ---- 2. browser terminal without a node must not start a local shell ----
  const noNode = new WebSocket(`ws://127.0.0.1:18096/ws/terminal?token=${token}`);
  const frames = [];
  await new Promise((res, rej) => { noNode.on('open', res); noNode.on('error', rej); });
  noNode.on('message', (r) => frames.push(JSON.parse(r.toString())));
  noNode.send(JSON.stringify({ type: 'create', cols: 100, rows: 30 }));
  await sleep(900);
  const errFrame = frames.find((f) => f.type === 'error');
  check('terminal without a connected VPS is refused (no local shell)',
    !!errFrame && /not connected/i.test(errFrame.error || ''), JSON.stringify(frames));
  noNode.close();

  // ---- 3. connect a fake agent and relay a real session through it ----
  const agent = new WebSocket(`ws://127.0.0.1:18096/ws/agent?node=${NODE}&token=test-token-abc`);
  const agentMsgs = [];
  await new Promise((res, rej) => { agent.on('open', res); agent.on('error', rej); });
  agent.on('message', (r) => agentMsgs.push(JSON.parse(r.toString())));
  check('agent can connect with a valid connect token', agent.readyState === WebSocket.OPEN);
  check('agent frames start flowing', agentMsgs.length >= 0);

  // the node must show up in the registry
  await sleep(400);
  const brs = await fetch('http://127.0.0.1:18096/api/v1/nodes', { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  check('connected node appears in the node list', brs.nodes.some((n) => n.id === NODE && n.online === true), JSON.stringify(brs.nodes));

  // agent announces itself
  agent.send(JSON.stringify({
    type: 'hello', replyTo: 'h1',
    meta: { name: 'test-node', os: 'Linux 6.1', arch: 'x64', cpu: 'fake-cpu', cores: 2, ip: '203.0.113.5', agentVersion: '1.1.0' },
  }));
  await sleep(400);

  // browser opens a terminal on that node
  const t = new WebSocket(`ws://127.0.0.1:18096/ws/terminal?token=${token}&node=${NODE}`);
  const bFrames = [];
  await new Promise((res, rej) => { t.on('open', res); t.on('error', rej); });
  t.on('message', (r) => bFrames.push(JSON.parse(r.toString())));
  t.send(JSON.stringify({ type: 'create', cols: 120, rows: 40 }));
  await sleep(500);

  const ptyCreate = agentMsgs.find((m) => m.type === 'pty-create');
  check('panel forwards pty-create to the agent', !!ptyCreate, JSON.stringify(agentMsgs.map((m) => m.type)));
  check('pty-create carries the requested size', !!ptyCreate && ptyCreate.cols === 120 && ptyCreate.rows === 40, ptyCreate && `${ptyCreate.cols}x${ptyCreate.rows}`);

  // agent confirms the session
  const sid = ptyCreate && ptyCreate.sessionId;
  agent.send(JSON.stringify({ type: 'pty-created', sessionId: sid, replyTo: sid }));
  await sleep(400);
  check('browser receives the created session id', bFrames.some((f) => f.type === 'created' && f.sessionId === sid), JSON.stringify(bFrames));

  // keyboard input is relayed to the agent
  t.send(JSON.stringify({ type: 'input', data: 'ls -la\n' }));
  await sleep(400);
  const fwd = agentMsgs.find((m) => m.type === 'pty-forward' && m.payload && m.payload.type === 'input');
  check('keystrokes are relayed to the agent', !!fwd && fwd.payload.data === 'ls -la\n', JSON.stringify(fwd));

  // resize is relayed with clamped values
  t.send(JSON.stringify({ type: 'resize', cols: 9999, rows: 1 }));
  await sleep(400);
  const rs = agentMsgs.filter((m) => m.type === 'pty-forward' && m.payload && m.payload.type === 'resize').pop();
  check('resize is relayed and clamped (500x5)', !!rs && rs.payload.cols === 500 && rs.payload.rows === 5, rs && `${rs.payload.cols}x${rs.payload.rows}`);

  // agent output reaches the browser
  agent.send(JSON.stringify({ type: 'pty-data', sessionId: sid, data: 'total 48\r\ndrwxr-xr-x 3 root root 4096 .' }));
  await sleep(400);
  check('agent output is streamed to the browser',
    bFrames.some((f) => f.type === 'data' && f.data.includes('total 48')), JSON.stringify(bFrames.slice(-2)));

  // ping/pong on the browser socket
  t.send(JSON.stringify({ type: 'ping' }));
  await sleep(300);
  check('browser heartbeat pong', bFrames.some((f) => f.type === 'pong'));

  // killing the session tells the agent
  t.send(JSON.stringify({ type: 'kill' }));
  await sleep(400);
  check('kill closes the remote session', agentMsgs.some((m) => m.type === 'pty-close'), JSON.stringify(agentMsgs.slice(-2)));

  // disconnecting the browser must NOT kill the remote PTY (session persistence)
  const t2 = new WebSocket(`ws://127.0.0.1:18096/ws/terminal?token=${token}&node=${NODE}`);
  const f2 = [];
  await new Promise((res, rej) => { t2.on('open', res); t2.on('error', rej); });
  t2.on('message', (r) => f2.push(JSON.parse(r.toString())));
  t2.send(JSON.stringify({ type: 'create', cols: 100, rows: 30 }));
  await sleep(500);
  const sid2 = agentMsgs.filter((m) => m.type === 'pty-create').pop().sessionId;
  t2.close();
  await sleep(400);
  const closes = agentMsgs.filter((m) => m.type === 'pty-close' && m.sessionId === sid2);
  // Closing the tab must release the remote shell, otherwise PTYs would leak on
  // the user's VPS. Reconnecting starts a fresh one.
  check('closing the browser tab releases the remote shell (no leak)', closes.length === 1, JSON.stringify(closes));

  // agent going away is reported honestly
  agent.close();
  await sleep(500);
  const t3 = new WebSocket(`ws://127.0.0.1:18096/ws/terminal?token=${token}&node=${NODE}`);
  const f3 = [];
  await new Promise((res, rej) => { t3.on('open', res); t3.on('error', rej); });
  t3.on('message', (r) => f3.push(JSON.parse(r.toString())));
  t3.send(JSON.stringify({ type: 'create', cols: 80, rows: 24 }));
  await sleep(600);
  check('offline node is reported instead of silently hanging',
    f3.some((f) => f.type === 'error' && /not connected/i.test(f.error || '')), JSON.stringify(f3));

  // invalid connect token cannot attach an agent
  const badAgent = new WebSocket('ws://127.0.0.1:18096/ws/agent?node=x&token=nope');
  const badAgentCode = await new Promise((resolve) => {
    badAgent.on('unexpected-response', (q, r) => resolve(r.statusCode));
    badAgent.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('agent refuses an invalid connect token (401)', badAgentCode === 401, String(badAgentCode));

  // an expired connect token is refused
  rec.expiresAt = Date.now() - 1000; db.save();
  const expiredAgent = new WebSocket(`ws://127.0.0.1:18096/ws/agent?node=${NODE}&token=test-token-abc`);
  const expiredCode = await new Promise((resolve) => {
    expiredAgent.on('unexpected-response', (q, r) => resolve(r.statusCode));
    expiredAgent.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('expired connect link cannot attach an agent', expiredCode === 401, String(expiredCode));

  t3.close();
  await app.close();
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });