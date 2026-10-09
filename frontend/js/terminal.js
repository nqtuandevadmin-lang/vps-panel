/* ==========================================================================
   VPS Panel - Terminal view: xterm.js -> WebSocket -> remote node agent.
   There is no local shell: every session runs on a connected VPS.
   ========================================================================== */
'use strict';

(function () {
  const t = (k) => (window.i18n ? window.i18n.t(k) : k);

  class PanelTerminal {
    constructor(root, nodeId) {
      this.root = root;
      this.nodeId = nodeId;
      this.term = null;
      this.ws = null;
      this.sessionId = null;
      this.build();
      this.bindToolbar();
      this.bindKeys();
    }

    token() { return localStorage.getItem('panel_token') || ''; }

    async loadNodes() {
      const r = await fetch('/api/v1/nodes', { headers: { Authorization: `Bearer ${this.token()}` } }).then((x) => x.json());
      return (r.nodes || []).filter((n) => n.online);
    }

    async pickNode() {
      const nodes = await this.loadNodes();
      const body = $('#term-body', this.root);
      if (!nodes.length) {
        body.innerHTML = `<div class="empty-state" style="height:100%">
          <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/></svg>
          <div><strong>${t('nodes.noNode')}</strong><div>${t('nodes.sub')}</div></div>
          <button class="btn btn-sm btn-primary" onclick="location.hash='#/nodes'">${t('nodes.newLink')}</button>
        </div>`;
        return;
      }
      if (nodes.length === 1) { this.nodeId = nodes[0].id; this.connect(); return; }
      body.innerHTML = `<div class="empty-state" style="height:100%">
        <div><strong>${t('term.pickNode')}</strong></div>
        <div style="display:grid;gap:10px;width:min(420px,100%)">
          ${nodes.map((n) => `<button class="btn" data-pick="${n.id}">${n.name || n.id} <span class="mono" style="color:var(--text-faint)">${(n.ip || '') + ' ' + n.id.slice(0, 8)}</span></button>`).join('')}
        </div></div>`;
      body.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { this.nodeId = b.dataset.pick; this.connect(); });
    }

    build() {
      const body = $('#term-body', this.root);
      body.innerHTML = '<div class="empty-state" style="height:100%"><span class="spinner"></span></div>';
      this.term = new Terminal({
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13.5,
        cursorBlink: true,
        scrollback: 10000,
        theme: {
          background: '#000000', foreground: '#d4d4d4', cursor: '#4ade80',
          selectionBackground: '#264f78',
        },
      });
      const fit = new FitAddon.FitAddon();
      this.term.loadAddon(fit);
      this.fit = fit;
      this.term.open(body);
      this.term.write('\x1b[90m...\x1b[0m\r\n');
      this.pickNode();
      const ro = new ResizeObserver(debounce(() => this.fit && this.fit.fit(), 150));
      ro.observe(body);
      this.ro = ro;
    }

    connect() {
      const body = $('#term-body', this.root);
      body.innerHTML = '';
      this.term.open(body);
      this.fit.fit();
      this.term.write(`\x1b[90m${t('nodes.connecting')}\x1b[0m\r\n`);

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws/terminal?token=${encodeURIComponent(this.token())}&node=${encodeURIComponent(this.nodeId)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.setStatus('ok', 'connected');
        this.ws.send(JSON.stringify({ type: 'create', cols: this.term.cols, rows: this.term.rows }));
      };

      this.ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
        switch (m.type) {
          case 'created': this.sessionId = m.sessionId; this.updateStatusbar(); this.setStatus('ok', 'connected'); break;
          case 'data': this.term.write(m.data); break;
          case 'exit': this.term.write(`\r\n\x1b[33m[process exited: ${m.code}]\x1b[0m\r\n`); this.setStatus('warn', 'ended'); break;
          case 'error': this.term.write(`\x1b[31m${m.error}\x1b[0m\r\n`); this.setStatus('err', 'error'); break;
          case 'pong': this.lastPong = Date.now(); break;
        }
      };
      this.ws.onclose = () => { this.setStatus('warn', 'disconnected'); };

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

      this.hb = setInterval(() => {
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping' }));
      }, 15000);
      this.updateStatusbar();
    }

    setStatus(kind, text) {
      const el = $('#term-status', this.root);
      if (!el) return;
      el.className = `pill ${kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err'}`;
      el.innerHTML = `<span class="dot ${kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err'}"></span>${text}`;
    }

    updateStatusbar() {
      const sid = $('#term-sid', this.root);
      const rows = $('#term-rows', this.root);
      if (sid) sid.textContent = `node: ${String(this.nodeId || '-').slice(0, 12)}`;
      if (rows && this.term) rows.textContent = `${this.term.cols}x${this.term.rows}`;
    }

    bindToolbar() {
      const R = this.root;
      $('#term-new', R).onclick = () => this.connect();
      $('#term-reconnect', R).onclick = () => this.connect();
      $('#term-kill', R).onclick = () => {
        if (this.ws && this.sessionId) this.ws.send(JSON.stringify({ type: 'kill' }));
      };
      $('#term-copy', R).onclick = async () => {
        try { await navigator.clipboard.writeText(this.term.getSelection()); toast('Terminal', 'Copied', 'ok'); }
        catch { toast('Terminal', 'Use Ctrl+Shift+C', 'warn'); }
      };
      $('#term-paste', R).onclick = async () => {
        try { this.term.paste(await navigator.clipboard.readText()); } catch { toast('Terminal', 'Use Ctrl+Shift+V', 'warn'); }
      };
      $('#term-size', R).onchange = (e) => {
        const [c, r] = e.target.value.split('x').map(Number);
        if (c) { this.term.resize(c, r); this.fit.fit(); }
      };
    }

    bindKeys() {
      document.addEventListener('keydown', (e) => {
        if (!location.hash.startsWith('#/terminal')) return;
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') { e.preventDefault(); this.connect(); }
      });
    }
  }

  window.initTerminal = (root) => {
    const m = location.hash.match(/node=([^&]+)/);
    root.dataset.view = 'terminal';
    if (window._panelTerm) {
      clearInterval(window._panelTerm.hb);
      try { window._panelTerm.ws?.close(); } catch { /* ignore */ }
    }
    window._panelTerm = new PanelTerminal(root, m ? decodeURIComponent(m[1]) : '');
  };
})();