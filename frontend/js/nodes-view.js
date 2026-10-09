/* nodes-view.js - Connected VPS servers + 10-minute connect links */
'use strict';
(function () {
  const t = (k) => (window.i18n ? window.i18n.t(k) : k);

  async function api(method, path, body) {
    const headers = { Accept: 'application/json' };
    const token = localStorage.getItem('panel_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const csrf = localStorage.getItem('panel_csrf');
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function nodeCard(n) {
    const live = n.online;
    return `<div class="card card-pad node-card" data-id="${esc(n.id)}" style="display:grid;gap:12px">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <span class="dot ${live ? 'ok' : 'warn'}" style="margin-top:7px"></span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <strong style="font-size:15px">${esc(n.name || n.id)}</strong>
            <span class="pill ${live ? 'ok' : 'warn'}">${live ? t('nodes.online') : t('nodes.offline')}</span>
          </div>
          <div style="font-size:12.5px;color:var(--text-dim);margin-top:4px" class="mono">
            ${esc(n.os || '')} · ${esc(n.arch || '')} · ${esc(n.cores || 1)} vCPU
          </div>
          <div style="font-size:12.5px;color:var(--text-faint);margin-top:2px">
            ${n.ip ? esc(n.ip) + ' · ' : ''}${esc(n.id.slice(0, 12))}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" data-term="${esc(n.id)}" ${live ? '' : 'disabled'}>${esc(t('nodes.terminal'))}</button>
          <button class="btn btn-sm btn-ghost" data-del="${esc(n.id)}">${esc(t('nodes.remove'))}</button>
        </div>
      </div>
      ${live ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12.5px">
        <div><span style="color:var(--text-dim)">CPU</span> <strong>${esc((n.cpu || '').slice(0, 28))}</strong></div>
        <div><span style="color:var(--text-dim)">RAM</span> <strong>${n.mem ? Math.round(n.mem.total / 1048576) + ' MB' : '-'}</strong></div>
        <div><span style="color:var(--text-dim)">Disk</span> <strong>${n.disk && n.disk.total ? Math.round(n.disk.usage) + '% used' : '-'}</strong></div>
        <div><span style="color:var(--text-dim)">Agent</span> <strong>v${esc(n.agentVersion || '1.1.0')}</strong></div>
      </div>` : ''}
    </div>`;
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.nodes = {
    async load(root) {
      root.innerHTML = `
        <div class="view-head">
          <h2>${esc(t('nodes.title'))}</h2>
          <div class="spacer"></div>
          <button class="btn btn-sm" id="n-refresh">${esc(t('common.refresh'))}</button>
          <button class="btn btn-sm btn-primary" id="n-newlink">${esc(t('nodes.newLink'))}</button>
        </div>
        <p style="color:var(--text-dim);margin:0">${esc(t('nodes.sub'))}</p>
        <div id="n-links"></div>
        <div id="n-grid" class="grid cols-2"></div>`;

      const grid = $('#n-grid', root);
      const linksBox = $('#n-links', root);

      const draw = async () => {
        const r = await api('GET', '/api/v1/nodes');
        if (!r.nodes.length) {
          grid.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-state">
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="7.5" r="1"/><circle cx="7" cy="16.5" r="1"/></svg>
            <div><strong>${esc(t('nodes.empty'))}</strong><div>${esc(t('nodes.emptySub'))}</div></div>
          </div></div>`;
        } else {
          grid.innerHTML = r.nodes.map(nodeCard).join('');
        }
        grid.querySelectorAll('[data-term]').forEach((b) => b.onclick = () => {
          location.hash = `#/terminal?node=${encodeURIComponent(b.dataset.term)}`;
        });
        grid.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
          if (!confirm(t('nodes.remove') + '?')) return;
          await api('DELETE', `/api/v1/nodes/${b.dataset.del}`);
          draw();
        });
      };

      // connect links (10 minute lifetime)
      const drawLinks = async () => {
        try {
          const r = await api('GET', '/api/v1/nodes/connect-links');
          const active = r.links.filter((l) => l.state === 'active');
          if (!active.length) { linksBox.innerHTML = ''; return; }
          linksBox.innerHTML = active.map((l) => `
            <div class="card card-pad" style="border-color:var(--brand);margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
                <strong>${esc(t('nodes.runThis'))}</strong>
                <span class="pill warn">${esc(t('nodes.expires'))} ${new Date(l.expiresAt).toLocaleTimeString()}</span>
                ${l.note ? `<span class="pill info">${esc(l.note)}</span>` : ''}
              </div>
              <div class="code-block" style="white-space:pre-wrap;word-break:break-all">${esc(l.curl)}</div>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button class="btn btn-sm btn-primary" data-copy="${esc(l.curl)}">${esc(t('nodes.copy'))}</button>
                <button class="btn btn-sm btn-ghost" data-dell="${l.id}">${esc(t('nodes.remove'))}</button>
              </div>
            </div>`).join('');
          linksBox.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
            try { await navigator.clipboard.writeText(b.dataset.copy); (window.toast || (() => {}))(t('nodes.copied'), '', 'ok'); } catch { /* ignore */ }
          });
          linksBox.querySelectorAll('[data-dell]').forEach((b) => b.onclick = async () => {
            await api('DELETE', `/api/v1/nodes/connect-links/${b.dataset.dell}`);
            drawLinks();
          });
        } catch { /* not admin or offline */ }
      };

      $('#n-newlink', root).onclick = async () => {
        try {
          const note = prompt('Note (optional):', '');
          const r = await api('POST', '/api/v1/nodes/connect-link', { note: note || '' });
          const exp = new Date(r.expiresAt);
          const html = `
            <div class="card card-pad" style="border-color:var(--brand)">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
                <strong>${esc(t('nodes.runThis'))}</strong>
                <span class="pill warn">${esc(t('nodes.expires'))} ${exp.toLocaleTimeString()} (${r.expiresInMin} ${esc(t('nodes.minutes'))})</span>
              </div>
              <div class="code-block" id="curl-box" style="white-space:pre-wrap;word-break:break-all">${esc(r.curl)}</div>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button class="btn btn-sm btn-primary" id="curl-copy">${esc(t('nodes.copy'))}</button>
              </div>
              <p style="font-size:12.5px;color:var(--text-dim);margin:12px 0 0">
                Chạy lệnh này trên VPS của bạn bằng quyền root. Sau đó máy chủ sẽ hiện trong danh sách này.
              </p>
            </div>`;
          $('#n-links', root).insertAdjacentHTML('afterbegin', html);
          $('#curl-copy', root).onclick = async () => {
            try { await navigator.clipboard.writeText(r.curl); (window.toast || (() => {}))(t('nodes.copied'), '', 'ok'); } catch { /* ignore */ }
          };
          drawLinks();
          setTimeout(() => { const g = $('#n-grid', root); if (g) draw(); }, 12000);
        } catch (e) {
          (window.toast || (() => {}))('error', e.message, 'err');
        }
      };

      $('#n-refresh', root).onclick = () => { draw(); drawLinks(); };
      await draw();
      await drawLinks();
      const timer = setInterval(() => { if (location.hash.startsWith('#/nodes')) draw(); }, 8000);
      return () => clearInterval(timer);
    },
  };
})();