// terminal.js - Browser terminal sessions.
// Every session is relayed to a CONNECTED VPS node (the agent on that machine runs
// the PTY). This server never spawns a shell of its own: the panel manages other
// machines, it does not expose itself.
'use strict';
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const HEARTBEAT_MS = 30000;

function attachWs(server, deps = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/terminal') { socket.destroy(); return; }

    const token = url.searchParams.get('token') || '';
    const payload = deps.auth ? deps.auth.verifyAccess(token) : null;
    if (!payload || !payload.sub) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.userId = payload.sub;
      ws.role = payload.role || 'user';
      ws.nodeId = url.searchParams.get('node') || '';
      ws.sessionId = null;

      ws.on('pong', () => { ws.isAlive = true; });

      const send = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* closed */ } };
      const node = () => deps.nodes && deps.nodes.nodes.get(ws.nodeId);

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { send({ type: 'error', error: 'invalid JSON' }); return; }

        if (msg.type === 'ping') { send({ type: 'pong', ts: Date.now() }); return; }

        const n = node();
        if (!n || n.ws.readyState !== 1) {
          if (['create', 'attach'].includes(msg.type)) {
            send({ type: 'error', error: 'This VPS is not connected yet. Create a connect link and run the curl command on your server.', code: 'NO_NODE' });
          }
          return;
        }

        switch (msg.type) {
          case 'create': {
            const sid = crypto.randomUUID();
            ws.sessionId = sid;
            n.sessions = (n.sessions || 0) + 1;
            send({ type: 'connecting', node: ws.nodeId });
            n.ws.send(JSON.stringify({
              type: 'pty-create', replyTo: sid,
              sessionId: sid, cols: msg.cols || 100, rows: msg.rows || 30,
              cwd: msg.cwd, shell: msg.shell,
            }));
            // relay agent output for this session back to the browser
            const onNode = (rraw) => {
              let m; try { m = JSON.parse(rraw.toString()); } catch { return; }
              if (m.sessionId !== sid) return;
              if (m.type === 'pty-created') send({ type: 'created', sessionId: sid, node: ws.nodeId });
              else if (m.type === 'pty-data') send({ type: 'data', data: m.data });
              else if (m.type === 'pty-exit') send({ type: 'exit', code: m.code });
              else if (m.type === 'result' && m.ok === false) send({ type: 'error', error: m.error });
            };
            n.ws.on('message', onNode);
            const off = () => { n.ws.off('message', onNode); n.ws.send(JSON.stringify({ type: 'pty-close', sessionId: sid })); };
            ws.on('close', off);
            break;
          }

          case 'input':
            if (ws.sessionId && n.ws.readyState === 1) {
              n.ws.send(JSON.stringify({ type: 'pty-forward', sessionId: ws.sessionId, payload: { type: 'input', data: msg.data } }));
            }
            break;

          case 'resize': {
            if (!ws.sessionId || n.ws.readyState !== 1) break;
            const cols = Math.max(20, Math.min(500, msg.cols | 0));
            const rows = Math.max(5, Math.min(200, msg.rows | 0));
            n.ws.send(JSON.stringify({ type: 'pty-forward', sessionId: ws.sessionId, payload: { type: 'resize', cols, rows } }));
            break;
          }

          case 'kill':
            if (ws.sessionId && n.ws.readyState === 1) {
              n.ws.send(JSON.stringify({ type: 'pty-close', sessionId: ws.sessionId }));
            }
            ws.sessionId = null;
            send({ type: 'killed' });
            break;

          case 'agent-ping':
            if (n.ws.readyState === 1) n.ws.send(JSON.stringify({ type: 'ping', replyTo: crypto.randomUUID() }));
            break;

          default:
            send({ type: 'error', error: `unknown message: ${msg.type}` });
        }
      });

      ws.on('close', () => { ws.isAlive = false; });
      ws.on('error', () => { /* socket errors are non-fatal */ });
    });
  });

  // heartbeat: drop dead sockets so terminals do not hang forever
  const hb = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { try { ws.terminate(); } catch { /* ignore */ } return; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(hb));
  server.on('close', () => clearInterval(hb));

  return wss;
}

module.exports = { attachWs };