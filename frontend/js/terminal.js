/* ==========================================================================
   VPS Panel - Terminal view: xterm.js + WebSocket + node-pty backend
   Features: connect, reconnect, detach/reattach, resize sync, copy/paste,
   recording, multi-session, heartbeat, search, scrollback 10000
   ========================================================================== */
'use strict';

(function () {
  const WS_PATH = '/ws/terminal';

  class PanelTerminal {
    constructor(root) {
      this.root = root;
      this.term = null;
      this.ws = null;
      this.sessionId = null;
      this.recording = false;
      this.connect();
      this.bindKeys();
      this.bindToolbar();
    }

    token() { return localStorage.getItem('panel_token') || ''; }

    connect(sessionId) {
      const body = $('#term-body', this.root);
      if (!body) return;
      body.innerHTML = '';
      this.term = new Terminal({
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13.5,
        cursorBlink: true,
        scrollback: 10000,
        theme: {
          background: '#000000',
          foreground: '#d4d4d4',
          cursor: '#4ade80',
          selectionBackground: '#264f78',
          black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
          blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        },
        allowProposedApi: false,
      });
      const fit = new FitAddon.FitAddon();
      const links = new WebLinksAddon.WebLinksAddon();
      this.term.loadAddon(fit);
      this.term.loadAddon(links);
      this.term.open(body);
      fit.fit();
      this.fit = fit;

      const url = `${WS_PATH}?token=${encodeURIComponent(this.token())}`;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}${url}`);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.setStatus('connected', 'connected');
        if (sessionId) {
          this.ws.send(JSON.stringify({ type: 'attach', sessionId }));
        } else {
          this.ws.send(JSON.stringify({
            type: 'create',
            name: 'shell-' + Date.now(),
            cols: this.term.cols,
            rows: this.term.rows,
          }));
        }
      };

      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
        catch { return; }
        switch (msg.type) {
          case 'created':
            this.sessionId = msg.sessionId;
            this.updateStatusbar();
            break;
          case 'attached':
            this.sessionId = msg.sessionId;
            this.term.resize(msg.cols, msg.rows);
            this.updateStatusbar();
            break;
          case 'data':
            this.term.write(msg.data);
            break;
          case 'exit':
            this.setStatus('warn', `process exited (code ${msg.code})`);
            this.term.write('\r\n\x1b[90m[session ended - press "New session" to start another]\x1b[0m\r\n');
            break;
          case 'record_started':
            this.recording = true;
            $('#term-record', this.root).textContent = 'Stop recording';
            this.setStatus('info', 'recording');
            break;
          case 'record_stopped':
            this.recording = false;
            $('#term-record', this.root).textContent = 'Record';
            break;
          case 'pong':
            this.lastPong = Date.now();
            break;
          case 'error':
            this.setStatus('err', msg.error);
            break;
          case 'killed':
            this.sessionId = null;
            break;
        }
      };

      this.ws.onclose = () => {
        this.setStatus('warn', 'disconnected');
        this.scheduleReconnect();
      };
      this.ws.onerror = () => { /* onclose follows */ };

      this.term.onData((data) => {
        if (this.ws && this.ws.readyState === 1 && this.sessionId) {
          this.ws.send(JSON.stringify({ type: 'input', data }));
        }
      });
      this.term.onResize(({ cols, rows }) => {
        if (this.ws && this.ws.readyState === 1 && this.sessionId) {
          this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
        this.updateStatusbar();
      });

      // heartbeat (requirement: WS heartbeat)
      this.hb = setInterval(() => {
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping' }));
      }, 15000);

      // reconnect watchdog
      this.watchdog = setInterval(() => {
        if (this.ws && this.ws.readyState === 1 && this.lastPong && Date.now() - this.lastPong > 45000) {
          this.ws.close(); // force reconnect
        }
      }, 20000);
    }

    scheduleReconnect() {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if ($('#view-root').dataset.view !== 'terminal') return;
        this.connect(this.sessionId); // reattach to live PTY (session persistence)
      }, 2000);
    }

    setStatus(kind, text) {
      const el = $('#term-status', this.root);
      if (!el) return;
      el.className = `pill ${kind === 'connected' ? 'ok' : kind === 'warn' ? 'warn' : kind === 'err' ? 'err' : 'info'}`;
      el.innerHTML = `<span class="dot ${kind === 'connected' ? 'ok' : kind}"></span>${esc(text)}`;
    }

    updateStatusbar() {
      const sid = $('#term-sid', this.root);
      const rows = $('#term-rows', this.root);
      if (sid) sid.textContent = `session: ${this.sessionId ? this.sessionId.slice(0, 8) : '-'}`;
      if (rows && this.term) rows.textContent = `${this.term.cols}x${this.term.rows}`;
    }

    bindKeys() {
      document.addEventListener('keydown', (e) => {
        if (location.hash !== '#/terminal') return;
        // Ctrl+Shift+T: new session
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
          e.preventDefault();
          $('#term-new', this.root)?.click();
        }
      });
    }

    bindToolbar() {
      const R = this.root;
      $('#term-new', R).onclick = () => {
        if (this.sessionId) this.ws.send(JSON.stringify({ type: 'detach' }));
        clearInterval(this.hb); clearInterval(this.watchdog);
        this.sessionId = null;
        this.connect();
      };
      $('#term-detach', R).onclick = () => {
        if (this.ws && this.sessionId) this.ws.send(JSON.stringify({ type: 'detach' }));
        toast('Terminal', 'Session detached - PTY stays alive. Reconnect any time.', 'ok');
      };
      $('#term-reconnect', R).onclick = () => {
        clearInterval(this.hb); clearInterval(this.watchdog);
        this.connect(this.sessionId);
      };
      $('#term-kill', R).onclick = async () => {
        if (this.sessionId && this.ws) {
          this.ws.send(JSON.stringify({ type: 'kill' }));
          this.sessionId = null;
        }
      };
      $('#term-record', R).onclick = () => {
        if (!this.ws || !this.sessionId) return toast('Terminal', 'Connect a session first', 'warn');
        this.ws.send(JSON.stringify({ type: this.recording ? 'record_stop' : 'record_start' }));
      };
      $('#term-copy', R).onclick = async () => {
        try { await navigator.clipboard.writeText(this.term.getSelection() || this.term.buffer.active.getLine(this.term.buffer.active.length - 1)?.translateToString(true) || ''); toast('Terminal', 'Copied', 'ok'); }
        catch { toast('Terminal', 'Clipboard blocked - use Ctrl+Shift+C', 'warn'); }
      };
      $('#term-paste', R).onclick = async () => {
        try {
          const t = await navigator.clipboard.readText();
          this.term.paste(t);
        } catch { toast('Terminal', 'Clipboard blocked - use Ctrl+Shift+V', 'warn'); }
      };
      $('#term-size', R).onchange = (e) => {
        const [cols, rows] = e.target.value.split('x').map(Number);
        if (cols) { this.term.resize(cols, rows); this.fit.fit(); }
      };
      // responsive resize
      const ro = new ResizeObserver(debounce(() => this.fit && this.fit.fit(), 150));
      ro.observe($('#term-body', R));
    }
  }

  window.initTerminal = (root) => {
    root.dataset.view = 'terminal';
    if (window._panelTerm) { try { window._panelTerm.ws?.close(); clearInterval(window._panelTerm.hb); clearInterval(window._panelTerm.watchdog); } catch { /* ignore */ } }
    window._panelTerm = new PanelTerminal(root);
  };
})();
