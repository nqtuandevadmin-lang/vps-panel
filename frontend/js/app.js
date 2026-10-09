/* ==========================================================================
   VPS Panel - SPA: API client, router, views, components (ES2022)
   ========================================================================== */
'use strict';

/* ---------- API client ---------- */
const store = {
  get token() { return localStorage.getItem('panel_token') || ''; },
  set token(v) { v ? localStorage.setItem('panel_token', v) : localStorage.removeItem('panel_token'); },
  get refresh() { return localStorage.getItem('panel_refresh') || ''; },
  set refresh(v) { v ? localStorage.setItem('panel_refresh', v) : localStorage.removeItem('panel_refresh'); },
  get user() { try { return JSON.parse(localStorage.getItem('panel_user') || 'null'); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('panel_user', JSON.stringify(v)) : localStorage.removeItem('panel_user'); },
  get csrf() { return localStorage.getItem('panel_csrf') || ''; },
  set csrf(v) { v ? localStorage.setItem('panel_csrf', v) : localStorage.removeItem('panel_csrf'); },
};

async function api(method, path, body, { raw = false, timeout = 30000 } = {}) {
  const headers = { 'Accept': 'application/json' };
  if (store.token) headers['Authorization'] = `Bearer ${store.token}`;
  const isMutating = !['GET', 'HEAD'].includes(method);
  if (isMutating) {
    if (typeof body === 'string' || body instanceof FormData) {
      // multipart or text: no content-type (browser sets boundary)
    } else {
      headers['Content-Type'] = 'application/json';
    }
    if (store.csrf) headers['X-CSRF-Token'] = store.csrf;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, { method, headers, body: typeof body === 'string' || body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: ctrl.signal, credentials: 'same-origin' });
  } finally { clearTimeout(t); }
  if (res.status === 401 && store.refresh) {
    const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: store.refresh }) });
    if (r.ok) {
      const j = await r.json();
      store.token = j.tokens.access;
      headers['Authorization'] = `Bearer ${store.token}`;
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    } else { logout(); throw new Error('session expired'); }
  }
  if (raw) return res;
  if (res.status === 204) return { ok: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

/* ---------- Theme ---------- */
const THEMES = ['midnight', 'dark', 'light', 'solarized', 'nord', 'monokai', 'dracula', 'contrast', 'sunset', 'paper', 'matrix'];
function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'midnight';
  document.documentElement.dataset.theme = name;
  localStorage.setItem('panel_theme', name);
}
function cycleTheme() {
  const i = THEMES.indexOf(document.documentElement.dataset.theme);
  applyTheme(THEMES[(i + 1) % THEMES.length]);
  toast('Theme', `Switched to ${document.documentElement.dataset.theme}`, 'ok');
}
function initTheme() {
  const saved = localStorage.getItem('panel_theme');
  const auto = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'midnight';
  applyTheme(saved || auto);
}

/* ---------- Toast ---------- */
function toast(title, body = '', type = 'info', ms = 4200) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div><div class="toast-title"></div><div class="toast-body"></div></div>`;
  el.querySelector('.toast-title').textContent = title;
  el.querySelector('.toast-body').textContent = body;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

/* ---------- Modal ---------- */
function openModal({ title, body, actions = [], wide = false }) {
  const root = document.getElementById('modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal" ${wide ? 'style="width:min(860px,100%)"' : ''} role="dialog" aria-modal="true" aria-label="">
        <div class="modal-head"><h3></h3><button class="icon-btn" data-close aria-label="Close"><svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>
    </div>`;
  root.querySelector('.modal-head h3').textContent = title;
  const bodyEl = root.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const foot = root.querySelector('.modal-foot');
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.textContent = a.label;
    b.onclick = async () => { if (a.onClick) await a.onClick(closeModal); else closeModal(); };
    foot.appendChild(b);
  }
  root.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', (e) => { if (e.target === el) closeModal(); }));
  const first = bodyEl.querySelector('input,select,textarea,button');
  if (first) first.focus();
  return { body: bodyEl, close: closeModal };
}
function closeModal() { const root = document.getElementById('modal-root'); root.hidden = true; root.innerHTML = ''; }
function confirmDialog(title, text, { danger = false, confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    openModal({
      title, body: `<p style="margin:0;color:var(--text-dim)">${text}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => { closeModal(); resolve(false); } },
        { label: confirmLabel, kind: danger ? 'btn-danger' : 'btn-primary', onClick: () => { closeModal(); resolve(true); } },
      ],
    });
  });
}

/* ---------- Helpers ---------- */
window.__esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => { if (n == null) return '-'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; };
const fmtPct = (n) => (n == null ? '-' : `${Number(n).toFixed(1)}%`);
const fmtAgo = (ts) => { if (!ts) return 'never'; const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; };
const fmtUptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return `${d}d ${h}h ${m}m`; };
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function skeleton(n = 3, h = 60) {
  return `<div class="grid" style="gap:10px">${Array.from({ length: n }, () => `<div class="skeleton" style="height:${h}px"></div>`).join('')}</div>`;
}

function emptyState(title, sub = '', icon = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>') {
  return `<div class="empty-state">${icon}<div><strong>${esc(title)}</strong>${sub ? `<div>${esc(sub)}</div>` : ''}</div></div>`;
}

/* ---------- Canvas line chart ---------- */
function lineChart(canvas, series, { colors = [], height = 180, yLabel = '' } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  canvas.width = w * dpr; canvas.height = height * dpr;
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const cText = css.getPropertyValue('--text-faint').trim() || '#888';
  const cGrid = css.getPropertyValue('--border').trim() || '#333';
  const cols = colors.length ? colors : [css.getPropertyValue('--chart-1').trim(), css.getPropertyValue('--chart-2').trim(), css.getPropertyValue('--chart-3').trim()];
  const pad = { l: 44, r: 12, t: 12, b: 22 };
  const W = w - pad.l - pad.r, H = height - pad.t - pad.b;
  const all = series.flatMap(s => s.data.filter(v => v != null));
  if (!all.length) return;
  let max = Math.max(...all) * 1.15 || 1;
  let min = Math.min(0, Math.min(...all));
  // grid
  ctx.strokeStyle = cGrid; ctx.fillStyle = cText; ctx.lineWidth = 1; ctx.font = '10px JetBrains Mono, monospace';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (H / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    const val = max - ((max - min) / 4) * i;
    ctx.fillText(yLabel === '%' ? val.toFixed(0) + '%' : fmtBytes(val), 4, y + 3);
  }
  series.forEach((s, si) => {
    const data = s.data;
    if (!data.length) return;
    ctx.strokeStyle = cols[si % cols.length]; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad.l + (W / Math.max(1, data.length - 1)) * i;
      const y = pad.t + H - ((v - min) / (max - min || 1)) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    // area fill
    ctx.lineTo(pad.l + W, pad.t + H); ctx.lineTo(pad.l, pad.t + H); ctx.closePath();
    ctx.globalAlpha = 0.08; ctx.fillStyle = cols[si % cols.length]; ctx.fill(); ctx.globalAlpha = 1;
  });
}

/* ---------- Sortable table ---------- */
function sortableTable(container, { columns, rows, rowKey, onRow } = {}) {
  let sortCol = null, sortDir = 1;
  const render = () => {
    let data = rows();
    if (sortCol) data = [...data].sort((a, b) => { const va = a[sortCol.key], vb = b[sortCol.key]; return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir; });
    container.innerHTML = `<div class="table-wrap card"><table><thead><tr>${columns.map(c => `<th class="${c.sortable !== false ? 'sortable' : ''}" data-key="${c.key}">${esc(c.label)}${sortCol?.key === c.key ? `<span class="sort-arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead><tbody>${data.map(r => `<tr data-id="${r[rowKey] ?? ''}">${columns.map(c => `<td class="${c.mono ? 'mono' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}">${emptyState('No data')}</td></tr>`}</tbody></table></div>`;
    $$('th.sortable', container).forEach(th => th.onclick = () => {
      const key = th.dataset.key;
      if (sortCol?.key === key) sortDir *= -1; else { sortCol = { key }; sortDir = 1; }
      render();
    });
    if (onRow) $$('tr[data-id]', container).forEach(tr => tr.onclick = () => onRow(tr.dataset.id));
  };
  render();
  return { refresh: render };
}

/* ---------- Pagination ---------- */
function paginate(items, page, perPage = 20) {
  const total = Math.ceil(items.length / perPage) || 1;
  const p = Math.min(Math.max(1, page), total);
  return { items: items.slice((p - 1) * perPage, p * perPage), page: p, total };
}

/* ---------- Tabs (open views) ---------- */
const tabState = { open: [], active: null };
function syncTabs() {
  const bar = $('#tabbar');
  if (tabState.open.length <= 1) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = tabState.open.map(v => `<button class="tab ${v === tabState.active ? 'active' : ''}" role="tab" data-view="${v}">${esc(viewMeta(v).title)}<span class="tab-close" data-close="${v}" aria-label="Close tab">×</span></button>`).join('');
  $$('.tab', bar).forEach(t => t.onclick = (e) => {
    if (e.target.dataset.close) { closeView(e.target.dataset.close); return; }
    navigate(t.dataset.view);
  });
}
function openView(v) { if (!tabState.open.includes(v)) tabState.open.push(v); tabState.active = v; syncTabs(); }
function closeView(v) {
  const i = tabState.open.indexOf(v);
  if (i >= 0) tabState.open.splice(i, 1);
  if (tabState.active === v) { tabState.active = tabState.open[tabState.open.length - 1] || 'dashboard'; navigate(tabState.active, true); return; }
  syncTabs();
}

/* ---------- Router ---------- */
const VIEWS = {};
const viewMeta = (v) => ({ title: v ? v.charAt(0).toUpperCase() + v.slice(1) : 'Dashboard' });
function navigate(view, replace = false) {
  if (!VIEWS[view]) view = 'dashboard';
  if (location.hash !== `#/${view}`) { location.hash = `/${view}`; } else renderView(view);
}
function renderView(view) {
  tabState.active = view; openView(view);
  $('#crumb-view').textContent = viewMeta(view).title;
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  const root = $('#view-root');
  root.innerHTML = skeleton(3, 120);
  const fn = VIEWS[view];
  if (window.i18n) window.i18n.apply();
  if (fn && fn.load) {
    fn.load(root).then(() => { if (fn.after) fn.after(root); if (window.i18n) window.i18n.apply(); })
      .catch(e => { root.innerHTML = emptyState('Failed to load', e.message); });
  } else if (fn) {
    fn(root);
  }
}
window.addEventListener('hashchange', () => { const v = location.hash.replace('#/', '') || 'dashboard'; renderView(v); });

/* ---------- Login / logout ---------- */
function logout() {
  store.token = ''; store.refresh = ''; store.user = ''; store.csrf = '';
  // hard reset: the app shell is fully torn down so nothing shows behind the login page
  $('#app-shell').hidden = true;
  $('#app-shell').innerHTML = '';
  location.hash = '';
  history.replaceState(null, '', '/');
  $('#login-screen').hidden = false;
  document.body.classList.remove('app-active');
  initAuthScreen();
}

/* ================= AUTH SCREEN ================= */
const authState = { invite: null, info: { allowPublicSignup: true, invitesOnly: false }, tab: 'login' };

// animated tab underline
function moveTabInk() {
  const active = $('.auth-tab.is-active');
  const ink = $('.auth-tab-ink');
  if (!active || !ink) return;
  ink.style.width = active.offsetWidth + 'px';
  ink.style.transform = `translateX(${active.offsetLeft}px)`;
}

function switchAuthTab(name) {
  if (authState.tab === name) return;
  authState.tab = name;
  $$('.auth-tab').forEach(t => {
    const on = t.dataset.authTab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $$('.auth-pane').forEach(p => {
    const on = p.dataset.authPane === name;
    p.classList.toggle('is-active', on);
    if (on) { // replay the entrance animation
      const inner = p.querySelector('.pane-anim');
      inner.style.animation = 'none';
      void inner.offsetWidth;
      inner.style.animation = '';
    }
  });
  moveTabInk();
  setTimeout(() => {
    const f = $(`.auth-pane[data-auth-pane="${name}"] input`);
    if (f) f.focus();
  }, 120);
}

function busy(btn, on) {
  if (on) {
    btn.dataset.label = btn.querySelector('.btn-label')?.textContent || '';
    btn.classList.add('busy');
    btn.disabled = true;
  } else {
    btn.classList.remove('busy');
    btn.disabled = false;
    const l = btn.querySelector('.btn-label');
    if (l && btn.dataset.label) l.textContent = btn.dataset.label;
  }
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

async function doLogin(e) {
  e.preventDefault();
  const btn = $('#login-btn');
  const err = $('#login-error');
  err.hidden = true;
  busy(btn, true);
  try {
    const body = { username: $('#login-user').value.trim(), password: $('#login-pass').value };
    const totp = $('#login-totp').value.trim();
    if (totp) body.totp = totp;
    let r = null;
    try {
      r = await api('POST', '/api/v1/auth/login', body);
    } catch (ex) {
      if (ex.data?.mfaRequired) {
        $('#totp-field').hidden = false;
        $('#login-totp').focus();
        busy(btn, false);
        return;
      }
      throw ex;
    }
    store.token = r.tokens.access; store.refresh = r.tokens.refresh; store.user = r.user; store.csrf = r.csrf;
    document.querySelector('.auth-card').classList.add('done');
    busy(btn, false);
    setTimeout(() => enterApp(), 260);
    toast('Welcome back', `Signed in as ${r.user.username}`, 'ok');
  } catch (ex) {
    showError('#login-error', ex.message);
    busy(btn, false);
  }
}

async function doSignup(e) {
  e.preventDefault();
  const btn = $('#signup-btn');
  const err = $('#signup-error');
  err.hidden = true;
  const username = $('#signup-user').value.trim();
  const email = $('#signup-email').value.trim();
  const password = $('#signup-pass').value;
  busy(btn, true);
  try {
    const body = { username, email, password };
    if (authState.invite) body.invite = authState.invite;
    await api('POST', '/api/v1/auth/register', body);
    document.querySelector('.auth-card').classList.add('done');
    busy(btn, false);
    const lr = await api('POST', '/api/v1/auth/login', { username, password });
    store.token = lr.tokens.access; store.refresh = lr.tokens.refresh; store.user = lr.user; store.csrf = lr.csrf;
    toast('Account created', `Welcome, ${lr.user.username}`, 'ok');
    setTimeout(() => enterApp(), 260);
  } catch (ex) {
    showError('#signup-error', (ex.data?.details ? ex.message + ': ' + ex.data.details.join(', ') : ex.message));
    busy(btn, false);
  }
}

// live password strength meter (instant local feedback)
function scorePassword(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (/(.)\1{2,}|123456|password|qwerty/i.test(pw)) s = Math.max(0, s - 2);
  return Math.min(5, s);
}

function initAuthScreen() {
  $$('.auth-tab').forEach(t => t.onclick = () => switchAuthTab(t.dataset.authTab));
  $$('[data-goto]').forEach(b => b.onclick = () => switchAuthTab(b.dataset.goto));
  $$('.pw-toggle').forEach(b => b.onclick = () => {
    const input = document.getElementById(b.dataset.pwToggle);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    b.style.color = show ? 'var(--brand)' : '';
  });
  $('#login-form').onsubmit = doLogin;
  $('#signup-form').onsubmit = doSignup;

  const pass = $('#signup-pass');
  pass.addEventListener('input', () => {
    const s = scorePassword(pass.value);
    $$('#strength .bar').forEach((b, i) => { b.className = 'bar' + (i < s ? ' on-' + s : ''); });
    const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
    $('#strength-text').textContent = pass.value ? labels[s] : 'At least 12 characters, upper + lower + digit + symbol.';
  });

  window.addEventListener('resize', moveTabInk);
  setTimeout(moveTabInk, 60);
}

// load signup rules + validate any invite token in the URL
async function initAuth() {
  initAuthScreen();
  const params = new URLSearchParams(location.search);
  const token = params.get('invite');
  try {
    authState.info = await api('GET', '/api/v1/auth/registration-info');
  } catch { /* keep defaults */ }
  try {
    const status = await api('GET', '/api/v1/auth/status');
    const el = $('#hero-users');
    if (el) el.textContent = status.users ?? 0;
  } catch { /* ignore */ }

  if (token) {
    try {
      const inv = await api('GET', `/api/v1/auth/invite/${encodeURIComponent(token)}`);
      if (inv.valid) {
        authState.invite = token;
        $('#invite-banner').hidden = false;
        $('#invite-detail').textContent = [
          inv.email ? `reserved for ${inv.email}` : 'open invitation',
          inv.maxUses > 1 ? `${inv.uses}/${inv.maxUses} uses` : 'single use',
          inv.role === 'viewer' ? 'read-only access' : 'full account',
        ].join(' · ');
        if (inv.email) $('#signup-email').value = inv.email;
        switchAuthTab('signup');
        history.replaceState(null, '', location.pathname);
      } else {
        toast('Invite problem', inv.error || 'this invite is no longer valid', 'err', 6000);
      }
    } catch {
      toast('Invite problem', 'invalid invite link', 'err', 6000);
    }
  }

  const tab = $('#signup-tab');
  if (authState.info.invitesOnly) {
    if (!token) { tab.disabled = true; tab.style.opacity = .55; tab.title = 'This panel is invite-only'; }
  } else if (authState.info.allowPublicSignup === false) {
    tab.hidden = true;
    switchAuthTab('login');
  }
  moveTabInk();
}

/* ---------- Notifications ---------- */
async function refreshNotifications() {
  try {
    const r = await api('GET', '/api/v1/notifications');
    const unread = r.notifications.filter(n => !n.read).length;
    const badge = $('#notif-badge');
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : unread;
    $('#bell-btn').onclick = () => {
      openModal({
        title: 'Notifications', wide: true,
        body: r.notifications.length ? `<div class="grid" style="gap:10px">${r.notifications.map(n => `
          <div class="card card-pad" style="display:flex;gap:12px;align-items:flex-start">
            <span class="dot ${n.type === 'backup' ? 'ok' : n.type === 'update' ? 'warn' : 'info'}"></span>
            <div><strong>${esc(n.title)}</strong><div style="color:var(--text-dim);font-size:12.5px">${esc(n.body)}</div>
            <div style="font-size:11px;color:var(--text-faint)">${new Date(n.ts).toLocaleString()}</div></div>
          </div>`).join('')}</div>` : emptyState('No notifications'),
        actions: [{ label: 'Close', onClick: (c) => c() }],
      });
    };
  } catch { /* ignore */ }
}

/* ---------- User menu ---------- */
function initUserMenu() {
  const btn = $('#user-btn'), dd = $('#user-dropdown');
  btn.onclick = (e) => { e.stopPropagation(); dd.hidden = !dd.hidden; btn.setAttribute('aria-expanded', String(!dd.hidden)); };
  document.addEventListener('click', () => { dd.hidden = true; });
  $$('[data-action]', dd).forEach(item => item.onclick = async () => {
    dd.hidden = true;
    const a = item.dataset.action;
    if (a === 'logout') { await api('POST', '/api/v1/auth/logout').catch(() => {}); logout(); }
    if (a === '2fa') view2fa();
    if (a === 'sessions') viewSessions();
    if (a === 'apikeys') viewApiKeys();
    if (a === 'profile') viewProfile();
  });
}

async function viewProfile() {
  const u = store.user;
  openModal({
    title: 'Profile',
    body: `<div class="grid" style="gap:12px">
      <div class="field"><span class="field-label">Username</span><input value="${esc(u.username)}" disabled></div>
      <div class="field"><span class="field-label">Email</span><input value="${esc(u.email)}" disabled></div>
      <div class="field"><span class="field-label">Role</span><input value="${esc(u.role)}" disabled></div>
      <div class="field"><span class="field-label">Change password</span>
        <form id="pw-form"><input type="password" name="oldPassword" placeholder="Current password" required style="margin-bottom:8px">
        <input type="password" name="newPassword" placeholder="New password (min 12)" required minlength="12" style="margin-bottom:8px">
        <button class="btn btn-primary btn-sm" type="submit">Update password</button></form>
      </div></div>`,
    actions: [{ label: 'Close', onClick: (c) => c() }],
  });
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api('POST', '/api/v1/auth/password', { oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }); toast('Password updated', '', 'ok'); closeModal(); }
    catch (err) { toast('Error', err.message, 'err'); }
  };
}

async function view2fa() {
  const { body, close } = openModal({ title: 'Two-factor authentication', body: skeleton(2, 80), actions: [{ label: 'Close', onClick: (c) => c() }] });
  const r = await api('GET', '/api/v1/auth/2fa/status').catch(() => ({ enabled: false }));
  if (r.enabled) {
    body.innerHTML = `<p>2FA is <span class="pill ok">ENABLED</span></p>
      <div style="display:flex;gap:10px">
        <button class="btn btn-sm" id="2fa-disable">Disable</button>
      </div>`;
    $('#2fa-disable', body).onclick = async () => {
      const code = prompt('Enter a 2FA code to disable:');
      if (!code) return;
      try { await api('POST', '/api/v1/auth/2fa/disable', { token: code }); toast('2FA disabled', '', 'ok'); close(); }
      catch (e) { toast('Error', e.message, 'err'); }
    };
    return;
  }
  const s = await api('POST', '/api/v1/auth/2fa/setup');
  body.innerHTML = `
    <p>Scan this secret in your authenticator app:</p>
    <div class="code-block">${esc(s.secret)}</div>
    <p style="font-size:12px;color:var(--text-dim)">otpauth URI: <span class="mono">${esc(s.uri.slice(0, 80))}...</span></p>
    <label class="field"><span class="field-label">Enter 6-digit code to confirm</span>
      <input id="2fa-code" inputmode="numeric" maxlength="6" placeholder="000000"></label>
    <button class="btn btn-primary btn-sm" id="2fa-confirm">Enable 2FA</button>
    <div class="form-error" id="2fa-err" hidden></div>`;
  $('#2fa-confirm', body).onclick = async () => {
    try {
      const r = await api('POST', '/api/v1/auth/2fa/confirm', { token: $('#2fa-code', body).value });
      close();
      openModal({
        title: 'Backup codes - save now',
        body: `<p>Store these codes. Each works once:</p><div class="code-block">${r.codesPlain.join('\n')}</div>`,
        actions: [{ label: 'I saved them', kind: 'btn-primary', onClick: (c) => c() }],
      });
      toast('2FA enabled', '', 'ok');
    } catch (e) { const el = $('#2fa-err', body); el.textContent = e.message; el.hidden = false; }
  };
}

async function viewSessions() {
  const r = await api('GET', '/api/v1/auth/sessions');
  openModal({
    title: 'Active sessions', wide: true,
    body: r.sessions.length ? `<div class="table-wrap card"><table><thead><tr><th>IP</th><th>Device</th><th>Created</th><th>Expires</th><th></th></tr></thead>
      <tbody>${r.sessions.map(s => `<tr><td class="mono">${esc(s.ip)}</td><td>${esc(s.ua || '-')}</td><td>${new Date(s.createdAt).toLocaleString()}</td><td>${fmtAgo(s.expiresAt)}</td>
      <td>${s.current ? '<span class="pill info">current</span>' : `<button class="btn btn-sm btn-ghost" data-revoke="${s.id}">Revoke</button>`}</td></tr>`).join('')}</tbody></table></div>`
      : emptyState('No sessions'),
    actions: [{ label: 'Close', onClick: (c) => c() }],
  });
  $$('[data-revoke]').forEach(b => b.onclick = async () => { await api('POST', `/api/v1/auth/sessions/${b.dataset.revoke}/revoke`); toast('Session revoked', '', 'ok'); closeModal(); viewSessions(); });
}

async function viewApiKeys() {
  const r = await api('GET', '/api/v1/auth/apikeys');
  openModal({
    title: 'API keys', wide: true,
    body: `
      <form id="key-form" style="display:flex;gap:8px;margin-bottom:14px">
        <input name="name" placeholder="Key name" required style="flex:1">
        <select name="role"><option value="user">user</option><option value="viewer">viewer</option></select>
        <button class="btn btn-primary btn-sm" type="submit">Create</button>
      </form>
      ${r.keys.length ? `<div class="table-wrap card"><table><thead><tr><th>Name</th><th>Role</th><th>Created</th><th>Last used</th><th></th></tr></thead>
      <tbody>${r.keys.map(k => `<tr><td>${esc(k.name)}</td><td><span class="pill info">${k.role}</span></td><td>${new Date(k.createdAt).toLocaleDateString()}</td><td>${fmtAgo(k.lastUsed)}</td>
      <td><button class="btn btn-sm btn-ghost" data-revoke="${k.id}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('No API keys')}
      <p style="font-size:12px;color:var(--text-dim)">Use as: <span class="mono">Authorization: Bearer</span> for JWT or <span class="mono">X-API-Key: vp_...</span> for API keys.</p>`,
    actions: [{ label: 'Close', onClick: (c) => c() }],
  });
  $('#key-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/v1/auth/apikeys', { name: e.target.name.value, role: e.target.role.value });
      openModal({ title: 'API key created', body: `<p>Copy it now - shown once:</p><div class="code-block">${esc(r.key)}</div>`, actions: [{ label: 'Done', kind: 'btn-primary', onClick: (c) => c() }] });
      closeModal(); viewApiKeys();
    } catch (err) { toast('Error', err.message, 'err'); }
  };
  $$('[data-revoke]').forEach(b => b.onclick = async () => { await api('DELETE', `/api/v1/auth/apikeys/${b.dataset.revoke}`); toast('Key revoked', '', 'ok'); closeModal(); viewApiKeys(); });
}

/* ============ VIEWS ============ */

/* ---- Dashboard ---- */
VIEWS.dashboard = {
  async load(root) {
    const d = await api('GET', '/api/v1/system/overview');
    const h = await api('GET', '/api/v1/system/history');
    root.innerHTML = `
      <div class="view-head"><h2>Dashboard</h2><div class="spacer"></div>
        <span class="pill ok"><span class="dot ok"></span>online</span>
        <button class="btn btn-sm" id="refresh-dash"><svg class="icon" style="width:15px;height:15px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11A8 8 0 105.6 6.6M4 4v5h5"/></svg>Refresh</button>
      </div>
      <div class="grid cols-4">
        <div class="card stat"><span class="stat-label">CPU</span><span class="stat-value" id="d-cpu">${fmtPct(d.cpu.usage)}</span><span class="stat-sub">${d.server.cpus} cores - ${esc(d.server.cpuModel.slice(0, 40))}</span></div>
        <div class="card stat"><span class="stat-label">Memory</span><span class="stat-value" id="d-mem">${fmtPct(d.mem.usage)}</span><span class="stat-sub">${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}</span></div>
        <div class="card stat"><span class="stat-label">Swap</span><span class="stat-value">${fmtPct(d.mem.swapUsage)}</span><span class="stat-sub">${fmtBytes(d.mem.swapUsed)} / ${fmtBytes(d.mem.swapTotal)}</span></div>
        <div class="card stat"><span class="stat-label">Uptime</span><span class="stat-value" style="font-size:20px">${fmtUptime(d.server.uptime)}</span><span class="stat-sub">load ${d.server.load['1m'].toFixed(2)} ${d.server.load['5m'].toFixed(2)} ${d.server.load['15m'].toFixed(2)}</span></div>
      </div>
      <div class="grid cols-2">
        <div class="card"><div class="card-head"><h3>CPU & Memory history</h3><div class="legend"><span class="key"><span class="swatch" style="background:var(--chart-1)"></span>CPU</span><span class="key"><span class="swatch" style="background:var(--chart-2)"></span>MEM</span></div></div><div class="card-pad"><canvas class="chart" id="dash-chart"></canvas></div></div>
        <div class="card"><div class="card-head"><h3>System</h3></div><div class="card-pad" style="display:grid;gap:8px;font-size:13px">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Hostname</span><strong class="mono">${esc(d.server.hostname)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">OS</span><strong>${esc(d.server.os.pretty_name || d.server.os.NAME || '-')} ${esc(d.server.os.VERSION_ID || '')}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Kernel</span><strong class="mono">${esc(d.server.kernel)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Arch</span><strong class="mono">${esc(d.server.arch)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Panel</span><strong>v1.0.0 (Node ${esc(d.panel.node.split('.')[0])})</strong></div>
        </div></div>
      </div>
      <div class="grid cols-2">
        <div class="card"><div class="card-head"><h3>Disk usage</h3></div><div class="card-pad grid" style="gap:12px">
          ${d.disks.map(x => `<div><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px"><span class="mono">${esc(x.mount)}</span><span>${fmtPct(x.usage)} - ${fmtBytes(x.used)}/${fmtBytes(x.total)}</span></div><div class="progress ${x.usage > 90 ? 'err' : x.usage > 75 ? 'warn' : ''}"><div style="width:${Math.min(100, x.usage)}%"></div></div></div>`).join('') || emptyState('No disks')}
        </div></div>
        <div class="card"><div class="card-head"><h3>Top processes</h3></div><div class="table-wrap"><table><thead><tr><th>PID</th><th>Name</th><th>CPU%</th><th>Memory</th></tr></thead><tbody>
          ${d.panel ? '' : ''}${(await api('GET', '/api/v1/system/monitor')).processes.slice(0, 8).map(p => `<tr><td class="mono">${p.pid}</td><td>${esc(p.name)}</td><td>${p.cpu.toFixed(1)}</td><td>${fmtBytes(p.mem)}</td></tr>`).join('')}
        </tbody></table></div></div>
      </div>`;
    lineChart($('#dash-chart'), [
      { data: h.series.map(p => p.cpu) },
      { data: h.series.map(p => p.mem) },
    ], { yLabel: '%' });
    $('#refresh-dash').onclick = () => renderView('dashboard');
  },
};

/* ---- Terminal view (rendered by js/terminal.js) ---- */
VIEWS.terminal = {
  load(root) {
    root.innerHTML = `
      <div class="view-head"><h2 data-i18n="term.title">Terminal</h2><div class="spacer"></div>
        <span class="pill info" id="term-status"><span class="dot info"></span>connecting</span>
      </div>
      <div class="card term-card">
        <div class="term-toolbar">
          <button class="btn btn-sm" id="term-new" data-i18n="term.newSession">New session</button>
          <button class="btn btn-sm btn-ghost" id="term-detach">Detach (keep alive)</button>
          <button class="btn btn-sm btn-ghost" id="term-reconnect" data-i18n="term.reconnect">Reconnect</button>
          <span class="sep"></span>
          <button class="btn btn-sm btn-ghost" id="term-record">Record</button>
          <button class="btn btn-sm btn-ghost" id="term-copy">Copy</button>
          <button class="btn btn-sm btn-ghost" id="term-paste">Paste</button>
          <button class="btn btn-sm btn-ghost" id="term-kill" data-i18n="term.kill" style="color:var(--err)">Kill</button>
          <span class="sep"></span>
          <select id="term-size" class="btn btn-sm" style="border:1px solid var(--border)">
            <option value="auto">Auto size</option>
            <option value="80x24">80x24</option>
            <option value="120x32">120x32</option>
            <option value="160x40">160x40</option>
          </select>
        </div>
        <div class="term-body" id="term-body"></div>
        <div class="term-statusbar">
          <span id="term-sid">session: -</span>
          <span id="term-rows">-</span>
          <span>scrollback 10000</span>
          <span id="term-hint">shortcuts: Ctrl+Shift+C copy, Ctrl+Shift+V paste, Ctrl+Shift+T new</span>
        </div>
      </div>`;
    if (window.initTerminal) window.initTerminal(root);
  },
};

/* ---- Files ---- */
VIEWS.files = {
  path: '/',
  async load(root) {
    const render = async (p = this.path) => {
      this.path = p;
      root.innerHTML = `
        <div class="view-head"><h2>File Manager</h2><div class="spacer"></div>
          <button class="btn btn-sm" id="f-newdir">New folder</button>
          <button class="btn btn-sm" id="f-upload-btn">Upload</button>
          <button class="btn btn-sm" id="f-refresh">Refresh</button>
        </div>
        <div class="card card-pad" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <div class="breadcrumb-path" id="f-path"></div>
        </div>
        <div class="card" style="margin-top:12px"><div class="card-head"><h3 id="f-count"></h3>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-ghost" id="f-compress">Compress</button>
            <button class="btn btn-sm btn-ghost" id="f-extract">Extract</button>
          </div></div>
          <div class="card-pad" id="f-list"></div>
        </div>`;
      const data = await api('GET', `/api/v1/files/list?path=${encodeURIComponent(p)}`);
      // breadcrumb
      const parts = p.split('/').filter(Boolean);
      $('#f-path').innerHTML = `<button data-path="/">/</button>` + parts.map((x, i) => `<span style="color:var(--text-faint)">/</span><button data-path="/${parts.slice(0, i + 1).join('/')}">${esc(x)}</button>`).join('');
      $$('#f-path button').forEach(b => b.onclick = () => render(b.dataset.path));
      $('#f-count').textContent = `${data.items.length} items in ${p}`;
      const list = $('#f-list');
      if (!data.items.length) { list.innerHTML = emptyState('Empty folder'); }
      else {
        list.innerHTML = `<div class="file-grid">` + data.items.map(it => `
          <button class="file-tile" data-name="${esc(it.name)}" data-type="${it.type}">
            ${it.type === 'dir'
              ? '<svg class="file-icon" viewBox="0 0 40 40"><path d="M4 10a3 3 0 013-3h7l4 5h15a3 3 0 013 3v14a3 3 0 01-3 3H7a3 3 0 01-3-3z" fill="var(--chart-3)" opacity=".85"/></svg>'
              : '<svg class="file-icon" viewBox="0 0 40 40"><path d="M8 4h14l8 8v22a2 2 0 01-2 2H8a2 2 0 01-2-2V6a2 2 0 012-2z" fill="var(--bg-elev)" stroke="var(--border-strong)" stroke-width="1.5"/><path d="M22 4v8h8" fill="var(--chart-2)" opacity=".7"/></svg>'}
            <span class="file-name">${esc(it.name)}</span>
            <span class="file-size">${it.type === 'dir' ? 'folder' : fmtBytes(it.size)}</span>
          </button>`).join('') + `</div>`;
        $$('.file-tile', list).forEach(t => {
          t.onclick = async (e) => {
            const name = t.dataset.name;
            const full = p === '/' ? '/' + name : p + '/' + name;
            if (t.dataset.type === 'dir') render(full);
            else openFileView(full);
          };
          t.oncontextmenu = (e) => { e.preventDefault(); fileContext(t.dataset.name, p); };
        });
      }
      // toolbar actions
      $('#f-refresh').onclick = () => render(p);
      $('#f-newdir').onclick = async () => {
        const name = prompt('Folder name:');
        if (!name) return;
        await api('POST', '/api/v1/files/mkdir', { path: p === '/' ? '/' + name : p + '/' + name });
        toast('Folder created', name, 'ok'); render(p);
      };
      $('#f-upload-btn').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async () => {
          const f = input.files[0];
          if (!f) return;
          const fd = new FormData();
          fd.append('file', f);
          fd.append('path', p);
          const r = await api('POST', '/api/v1/files/upload', fd);
          toast('Upload complete', `${r.name} (${fmtBytes(r.size)}) sha256:${r.sha256.slice(0, 12)}...`, 'ok');
          render(p);
        };
        input.click();
      };
      $('#f-compress').onclick = async () => {
        const name = prompt('Path to compress (relative to /home):', p);
        if (!name) return;
        const fmt = prompt('Format (tar.gz / zip):', 'tar.gz');
        const r = await api('POST', '/api/v1/files/compress', { path: name, format: fmt === 'zip' ? 'zip' : 'tar.gz' });
        toast('Compressed', r.output, 'ok'); render(p);
      };
      $('#f-extract').onclick = async () => {
        const name = prompt('Archive path to extract:', p);
        if (!name) return;
        const r = await api('POST', '/api/v1/files/extract', { path: name });
        toast('Extracted', '', 'ok'); render(p);
      };
    };
    await render();
  },
};

async function openFileView(path) {
  const { body, close } = openModal({ title: path, wide: true, body: skeleton(2, 100), actions: [
    { label: 'Download', kind: 'btn-primary', onClick: () => { window.open(`/api/v1/files/download?path=${encodeURIComponent(path)}`, '_blank'); } },
    { label: 'Close', onClick: (c) => c() },
  ] });
  const r = await api('GET', `/api/v1/files/read?path=${encodeURIComponent(path)}`).catch(e => ({ error: e.message }));
  if (r.error) {
    body.innerHTML = emptyState('Cannot preview', r.error + ' - use Download instead');
    return;
  }
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:12.5px;color:var(--text-dim)">
      <span>${fmtBytes(r.size)} - UTF-8 text</span>
      <span>saved on Ctrl+S</span>
    </div>
    <textarea id="file-editor" class="mono" style="width:100%;min-height:50vh" spellcheck="false"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn btn-primary btn-sm" id="file-save">Save</button>
      <button class="btn btn-sm btn-ghost" id="file-search">Search in file</button>
    </div>`;
  const ta = $('#file-editor', body);
  ta.value = r.content;
  $('#file-save', body).onclick = async () => {
    await api('PUT', '/api/v1/files/write', { path, content: ta.value });
    toast('Saved', path, 'ok');
  };
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#file-save', body).click(); } });
  $('#file-search', body).onclick = () => {
    const q = prompt('Search string:');
    if (!q) return;
    const idx = ta.value.indexOf(q);
    if (idx >= 0) { ta.focus(); ta.setSelectionRange(idx, idx + q.length); }
    else toast('Not found', q, 'warn');
  };
}

function fileContext(name, dir) {
  const full = dir === '/' ? '/' + name : dir + '/' + name;
  openModal({
    title: name,
    body: `<div class="grid" style="gap:8px">
      <button class="btn" id="ctx-rename">Rename</button>
      <button class="btn" id="ctx-download">Download</button>
      <button class="btn btn-danger" id="ctx-delete">Delete</button>
    </div>`,
    actions: [{ label: 'Close', onClick: (c) => c() }],
  });
  $('#ctx-rename').onclick = async () => {
    const n = prompt('New name:', name);
    if (!n) return;
    await api('POST', '/api/v1/files/rename', { from: full, to: dir === '/' ? '/' + n : dir + '/' + n });
    toast('Renamed', '', 'ok'); closeModal(); renderView('files');
  };
  $('#ctx-download').onclick = () => window.open(`/api/v1/files/download?path=${encodeURIComponent(full)}`, '_blank');
  $('#ctx-delete').onclick = async () => {
    if (await confirmDialog('Delete', `Delete ${esc(full)}? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' })) {
      await api('DELETE', '/api/v1/files/remove', { path: full });
      toast('Deleted', name, 'ok'); closeModal(); renderView('files');
    }
  };
}

/* ---- Processes ---- */
VIEWS.processes = {
  async load(root) {
    const d = await api('GET', '/api/v1/system/processes');
    root.innerHTML = `
      <div class="view-head"><h2>Processes</h2><div class="spacer"></div>
        <div class="search-box"><svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="proc-search" type="search" placeholder="Filter processes..." aria-label="Filter processes"></div>
        <button class="btn btn-sm" id="proc-refresh">Refresh</button>
      </div>
      <div id="proc-table"></div>`;
    const t = sortableTable($('#proc-table'), {
      columns: [
        { key: 'pid', label: 'PID', mono: true },
        { key: 'name', label: 'Name', render: r => esc(r.name) },
        { key: 'cmd', label: 'Command', render: r => `<span class="mono" title="${esc(r.cmd)}">${esc(r.cmd.slice(0, 70))}</span>` },
        { key: 'cpu', label: 'CPU%', render: r => Number(r.cpu).toFixed(1) },
        { key: 'mem', label: 'Memory', render: r => fmtBytes(r.mem) },
        { key: 'actions', label: '', sortable: false, render: r => `<button class="btn btn-sm btn-ghost" data-kill="${r.pid}" style="color:var(--err)">Kill</button>
          <button class="btn btn-sm btn-ghost" data-sig="${r.pid}">Signal</button>` },
      ],
      rows: () => procs,
      rowKey: 'pid',
    });
    let procs = d.processes;
    const setProcs = (p) => { procs = p; t.refresh(); };
    setProcs(d.processes);
    $('#proc-refresh').onclick = async () => { const r = await api('GET', '/api/v1/system/processes'); setProcs(r.processes); };
    $('#proc-search').oninput = debounce((e) => {
      const q = e.target.value.toLowerCase();
      setProcs(d.processes.filter(p => p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q)));
    }, 200);
    root.addEventListener('click', async (e) => {
      const killBtn = e.target.closest('[data-kill]');
      const sigBtn = e.target.closest('[data-sig]');
      if (killBtn) {
        if (await confirmDialog('Kill process', `Kill PID ${killBtn.dataset.kill}?`, { danger: true, confirmLabel: 'Kill' })) {
          await api('DELETE', `/api/v1/system/processes/${killBtn.dataset.kill}`);
          toast('Process killed', '', 'ok');
          const r = await api('GET', '/api/v1/system/processes'); setProcs(r.processes);
        }
      }
      if (sigBtn) {
        const sig = prompt('Signal (TERM, KILL, HUP, STOP, CONT):', 'TERM');
        if (!sig) return;
        await api('POST', `/api/v1/system/processes/${sigBtn.dataset.sig}/signal`, { signal: sig });
        toast('Signal sent', sig, 'ok');
      }
    });
  },
};

/* ---- Services ---- */
VIEWS.services = {
  async load(root) {
    const d = await api('GET', '/api/v1/system/services');
    root.innerHTML = `
      <div class="view-head"><h2>Services (systemd)</h2><div class="spacer"></div><button class="btn btn-sm" id="svc-refresh">Refresh</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Unit</th><th>Status</th><th>Sub</th><th>Description</th><th>Actions</th></tr></thead>
      <tbody>${d.services.map(s => `<tr>
        <td class="mono">${esc(s.unit)}</td>
        <td><span class="pill ${s.active === 'active' ? 'ok' : s.active === 'failed' ? 'err' : 'warn'}">${esc(s.active)}</span></td>
        <td>${esc(s.sub)}</td><td>${esc(s.desc)}</td>
        <td style="display:flex;gap:4px">
          <button class="btn btn-sm btn-ghost" data-act="start" data-unit="${esc(s.unit)}">Start</button>
          <button class="btn btn-sm btn-ghost" data-act="stop" data-unit="${esc(s.unit)}">Stop</button>
          <button class="btn btn-sm btn-ghost" data-act="restart" data-unit="${esc(s.unit)}">Restart</button>
          <button class="btn btn-sm btn-ghost" data-act="status" data-unit="${esc(s.unit)}">Status</button>
        </td></tr>`).join('')}</tbody></table></div></div>`;
    $('#svc-refresh').onclick = () => renderView('services');
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const { act, unit } = b.dataset;
      if (act === 'status') {
        const r = await api('GET', `/api/v1/system/services/${encodeURIComponent(unit)}`);
        openModal({ title: `${unit} - status`, wide: true, body: `<div class="code-block">${esc(r.output || r.error || '')}</div>`, actions: [{ label: 'Close', onClick: (c) => c() }] });
      } else {
        const r = await api('POST', `/api/v1/system/services/${encodeURIComponent(unit)}/${act}`).catch(e => ({ error: e.message }));
        if (r.error) toast('Error', r.error, 'err');
        else { toast('Service', `${act} ${unit}`, 'ok'); setTimeout(() => renderView('services'), 600); }
      }
    });
  },
};

/* ---- Network ---- */
VIEWS.network = {
  async load(root) {
    const d = await api('GET', '/api/v1/system/overview');
    root.innerHTML = `
      <div class="view-head"><h2>Network</h2></div>
      <div class="grid cols-2">
        <div class="card"><div class="card-head"><h3>Interfaces</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Name</th><th>Family</th><th>Address</th><th>Internal</th></tr></thead>
          <tbody>${d.network.interfaces.map(i => `<tr><td>${esc(i.name)}</td><td>${i.family}</td><td class="mono">${esc(i.address)}</td><td>${i.internal ? 'yes' : 'no'}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><div class="card-head"><h3>Listening ports</h3></div>
          <div class="table-wrap"><table><thead><tr><th>State</th><th>Local</th><th>Process</th></tr></thead>
          <tbody>${d.network.listening.map(l => `<tr><td>${esc(l[0])}</td><td class="mono">${esc(l[3] || l[4] || '')}</td><td></td></tr>`).join('')}</tbody></table></div></div>
      </div>`;
  },
};

/* ---- Disks ---- */
VIEWS.disks = {
  async load(root) {
    const d = await api('GET', '/api/v1/system/overview');
    root.innerHTML = `
      <div class="view-head"><h2>Disks</h2></div>
      <div class="grid cols-2">
        ${d.disks.map(x => `<div class="card card-pad">
          <div style="display:flex;justify-content:space-between;margin-bottom:10px">
            <strong class="mono">${esc(x.device)}</strong><span class="pill ${x.usage > 90 ? 'err' : x.usage > 75 ? 'warn' : 'ok'}">${fmtPct(x.usage)}</span>
          </div>
          <div class="progress ${x.usage > 90 ? 'err' : x.usage > 75 ? 'warn' : ''}" style="margin-bottom:10px"><div style="width:${Math.min(100, x.usage)}%"></div></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12.5px;color:var(--text-dim)">
            <div>Mount: <strong class="mono">${esc(x.mount)}</strong></div>
            <div>FS: <strong>${esc(x.fs)}</strong></div>
            <div>Used: <strong>${fmtBytes(x.used)}</strong></div>
            <div>Total: <strong>${fmtBytes(x.total)}</strong></div>
          </div></div>`).join('')}
      </div>`;
  },
};

/* ---- Panel users ---- */
VIEWS.users = {
  async load(root) {
    const d = await api('GET', '/api/v1/users');
    root.innerHTML = `
      <div class="view-head"><h2>Panel Users</h2><div class="spacer"></div>
        <button class="btn btn-sm btn-primary" id="u-add">Add user</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Username</th><th>Email</th><th>Role</th><th>2FA</th><th>Last login</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${d.users.map(u => `<tr>
        <td><strong>${esc(u.username)}</strong></td><td>${esc(u.email)}</td>
        <td><span class="pill ${u.role === 'admin' ? 'err' : u.role === 'viewer' ? 'info' : 'ok'}">${u.role}</span></td>
        <td>${u.totpEnabled ? '<span class="pill ok">on</span>' : '<span style="color:var(--text-faint)">off</span>'}</td>
        <td>${fmtAgo(u.lastLogin)}</td><td>${new Date(u.createdAt).toLocaleDateString()}</td>
        <td style="display:flex;gap:4px">
          <button class="btn btn-sm btn-ghost" data-role="${u.id}" data-r="admin">Make admin</button>
          <button class="btn btn-sm btn-ghost" data-del="${u.id}" style="color:var(--err)">Delete</button>
        </td></tr>`).join('')}</tbody></table></div></div>`;
    $('#u-add').onclick = () => {
      openModal({
        title: 'Add panel user',
        body: `<form id="u-form">
          <label class="field"><span class="field-label">Username</span><input name="username" required minlength="3" maxlength="32"></label>
          <label class="field"><span class="field-label">Email</span><input name="email" type="email" required></label>
          <label class="field"><span class="field-label">Password</span><input name="password" type="password" required minlength="12"></label>
          <label class="field"><span class="field-label">Role</span><select name="role"><option value="user">user</option><option value="viewer">viewer</option></select></label>
        </form>`,
        actions: [{ label: 'Create', kind: 'btn-primary', onClick: async (c) => {
          const f = $('#u-form');
          try { await api('POST', '/api/v1/users', { username: f.username.value, email: f.email.value, password: f.password.value, role: f.role.value }); toast('User created', '', 'ok'); c(); renderView('users'); }
          catch (e) { toast('Error', e.message, 'err'); }
        } }, { label: 'Cancel', onClick: (c) => c() }],
      });
    };
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      const role = e.target.closest('[data-role]');
      if (del && await confirmDialog('Delete user', `Delete user ${del.dataset.del}?`, { danger: true })) {
        await api('DELETE', `/api/v1/users/${del.dataset.del}`); toast('User deleted', '', 'ok'); renderView('users');
      }
      if (role) { await api('PUT', `/api/v1/users/${role.dataset.role}/role`, { role: role.dataset.r }); toast('Role updated', '', 'ok'); renderView('users'); }
    });
  },
};

/* ---- System users ---- */
VIEWS.sysusers = {
  async load(root) {
    const d = await api('GET', '/api/v1/system/users');
    root.innerHTML = `
      <div class="view-head"><h2>System Users (/etc/passwd)</h2><div class="spacer"></div>
        <button class="btn btn-sm btn-primary" id="su-add">Add system user</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>UID</th><th>GID</th><th>Home</th><th>Shell</th><th>Actions</th></tr></thead>
      <tbody>${d.users.map(u => `<tr><td><strong>${esc(u.name)}</strong></td><td class="mono">${u.uid}</td><td class="mono">${u.gid}</td><td class="mono">${esc(u.home)}</td><td class="mono">${esc(u.shell)}</td>
      <td>${u.uid > 999 ? `<button class="btn btn-sm btn-ghost" data-del="${esc(u.name)}" style="color:var(--err)">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
    $('#su-add').onclick = async () => {
      const name = prompt('Username (lowercase, 3-32):');
      if (!name) return;
      const shell = prompt('Shell:', '/bin/bash');
      const r = await api('POST', '/api/v1/system/users', { username: name, shell }).catch(e => ({ error: e.message }));
      if (r.error) toast('Error', r.error, 'err'); else { toast('User created', name, 'ok'); renderView('sysusers'); }
    };
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del && await confirmDialog('Delete system user', `Delete ${del.dataset.del} and home dir?`, { danger: true })) {
        const r = await api('DELETE', `/api/v1/system/users/${encodeURIComponent(del.dataset.del)}`).catch(e => ({ error: e.message }));
        if (r.error) toast('Error', r.error, 'err'); else { toast('User deleted', '', 'ok'); renderView('sysusers'); }
      }
    });
  },
};

/* ---- Firewall ---- */
VIEWS.firewall = {
  async load(root) {
    const d = await api('GET', '/api/v1/firewall/status').catch(e => ({ error: e.message }));
    root.innerHTML = `
      <div class="view-head"><h2>Firewall</h2><div class="spacer"></div>
        <button class="btn btn-sm" id="fw-refresh">Refresh</button></div>
      <div class="grid cols-2">
        <div class="card card-pad">
          <h3 style="margin-top:0">Add rule</h3>
          <form id="fw-form" style="display:grid;gap:10px">
            <div style="display:flex;gap:10px">
              <input name="port" type="number" min="1" max="65535" placeholder="Port" required style="width:120px">
              <select name="proto"><option>tcp</option><option>udp</option></select>
            </div>
            <input name="comment" placeholder="Comment (optional)">
            <div style="display:flex;gap:8px">
              <button type="submit" class="btn btn-primary btn-sm" data-fw="allow">Allow</button>
              <button type="button" class="btn btn-sm" data-fw="deny" style="border-color:var(--err);color:var(--err)">Deny</button>
              <button type="button" class="btn btn-sm btn-ghost" data-fw="delete">Delete allow rule</button>
            </div>
          </form>
          <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-sm btn-ghost" data-fw="enable">Enable firewall</button>
            <button class="btn btn-sm btn-ghost" data-fw="disable">Disable</button>
            <button class="btn btn-sm btn-ghost" data-fw="reset" style="color:var(--err)">Reset</button>
          </div>
        </div>
        <div class="card"><div class="card-head"><h3>Status</h3></div>
          <div class="card-pad"><div class="code-block" style="max-height:400px;overflow:auto">${esc(d.output || d.error || 'no data')}</div></div></div>
      </div>`;
    const act = async (action, body = {}) => {
      const r = await api('POST', `/api/v1/firewall/${action}`, body).catch(e => ({ error: e.message }));
      if (r.error) toast('Firewall error', r.error, 'err');
      else { toast('Firewall', `${action} ${body.port || ''}`, 'ok'); setTimeout(() => renderView('firewall'), 700); }
    };
    $('#fw-form').onsubmit = (e) => { e.preventDefault(); act('allow', { port: +e.target.port.value, proto: e.target.proto.value, comment: e.target.comment.value }); };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fw]');
      if (!b) return;
      const a = b.dataset.fw;
      if (['allow', 'deny', 'delete'].includes(a)) {
        if (a === 'allow') { $('#fw-form').requestSubmit(); return; }
        const port = prompt('Port:');
        if (port) act(a, { port: +port, proto: 'tcp' });
      } else act(a);
    });
    $('#fw-refresh').onclick = () => renderView('firewall');
  },
};

/* ---- Packages ---- */
VIEWS.packages = {
  async load(root) {
    root.innerHTML = `
      <div class="view-head"><h2>Packages</h2><div class="spacer"></div>
        <div class="search-box"><svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="pkg-search" type="search" placeholder="Filter packages..."></div>
        <button class="btn btn-sm btn-primary" id="pkg-install">Install</button>
        <button class="btn btn-sm" id="pkg-update">apt update</button>
      </div>
      <div class="card" style="padding:12px"><div class="search-box" style="margin-bottom:10px"></div><div id="pkg-list" class="table-wrap"></div></div>`;
    const d = await api('GET', '/api/v1/packages');
    let page = 1;
    const render = (q = '') => {
      const filtered = d.packages.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
      const pg = paginate(filtered, page);
      $('#pkg-list').innerHTML = `
        <table><thead><tr><th>Package</th><th>Version</th><th>Status</th></tr></thead>
        <tbody>${pg.items.map(p => `<tr><td class="mono"><strong>${esc(p.name)}</strong></td><td class="mono">${esc(p.version)}</td><td>${esc(p.status)}</td></tr>`).join('')}</tbody></table>
        <div class="pagination" style="padding:12px">
          <button data-pg="prev" ${pg.page <= 1 ? 'disabled' : ''}>‹</button>
          <span style="padding:0 10px;align-self:center">page ${pg.page} / ${pg.total} (${filtered.length} packages)</span>
          <button data-pg="next" ${pg.page >= pg.total ? 'disabled' : ''}>›</button>
        </div>`;
      $$('#pkg-list [data-pg]').forEach(b => b.onclick = () => { page += b.dataset.pg === 'next' ? 1 : -1; render(q); });
    };
    render();
    $('#pkg-search').oninput = debounce(e => { page = 1; render(e.target.value); }, 250);
    $('#pkg-update').onclick = async () => {
      toast('Running package index update...', '', 'info');
      const r = await api('POST', '/api/v1/packages/update').catch(e => ({ error: e.message }));
      r.error ? toast('Error', r.error, 'err') : toast('Package index updated', '', 'ok');
    };
    $('#pkg-install').onclick = async () => {
      const names = prompt('Package names (space separated):');
      if (!names) return;
      const pkgs = names.split(/\s+/).filter(Boolean);
      if (!await confirmDialog('Install packages', `Install: ${pkgs.join(', ')}?`, { confirmLabel: 'Install' })) return;
      const r = await api('POST', '/api/v1/packages/install', { packages: pkgs }).catch(e => ({ error: e.message }));
      r.error ? toast('Error', r.error, 'err') : toast('Installed', pkgs.join(', '), 'ok');
    };
  },
};

/* ---- Cron ---- */
VIEWS.cron = {
  async load(root) {
    const d = await api('GET', '/api/v1/cron');
    root.innerHTML = `
      <div class="view-head"><h2>Cron Jobs</h2><div class="spacer"></div>
        <button class="btn btn-sm btn-primary" id="c-add">Add job</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>#</th><th>Schedule</th><th>Command</th><th></th></tr></thead>
      <tbody>${d.jobs.map((j, i) => { const m = j.line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/); return `<tr>
        <td class="mono">${i}</td><td class="mono">${esc(m ? m[1] : '')}</td><td class="mono">${esc(m ? m[2] : j.line)}</td>
        <td><button class="btn btn-sm btn-ghost" data-del="${j.id}" style="color:var(--err)">Delete</button></td></tr>`; }).join('') || `<tr><td colspan="4">${emptyState('No cron jobs')}</td></tr>`}</tbody></table></div></div>`;
    $('#c-add').onclick = async () => {
      openModal({
        title: 'Add cron job',
        body: `<form id="c-form">
          <label class="field"><span class="field-label">Schedule (cron: m h dom mon dow)</span><input name="schedule" placeholder="*/15 * * * *" required></label>
          <label class="field"><span class="field-label">Command</span><input name="command" placeholder="/home/backup.sh" required></label>
        </form>`,
        actions: [{ label: 'Add', kind: 'btn-primary', onClick: async (c) => {
          const f = $('#c-form');
          try { await api('POST', '/api/v1/cron', { schedule: f.schedule.value, command: f.command.value }); toast('Cron job added', '', 'ok'); c(); renderView('cron'); }
          catch (e) { toast('Error', e.message, 'err'); }
        } }, { label: 'Cancel', onClick: (c) => c() }],
      });
    };
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del && await confirmDialog('Delete cron job', 'Remove this job?', { danger: true })) {
        await api('DELETE', `/api/v1/cron/${del.dataset.del}`); toast('Job removed', '', 'ok'); renderView('cron');
      }
    });
  },
};

/* ---- Logs ---- */
VIEWS.logs = {
  async load(root) {
    root.innerHTML = `
      <div class="view-head"><h2>Logs</h2><div class="spacer"></div>
        <select id="log-src" class="btn btn-sm" style="border:1px solid var(--border)"><option value="">journalctl (all)</option></select>
        <input id="log-lines" type="number" value="200" min="10" max="5000" style="width:90px" aria-label="Lines">
        <button class="btn btn-sm" id="log-load">Load</button>
        <button class="btn btn-sm btn-ghost" id="log-follow">Follow (SSE)</button>
      </div>
      <div class="card"><div class="card-pad"><div class="code-block" id="log-out" style="min-height:50vh;max-height:70vh;overflow:auto">loading...</div></div></div>`;
    // unit selector from services
    try {
      const s = await api('GET', '/api/v1/system/services');
      $('#log-src').innerHTML = `<option value="">journalctl (all)</option>` + s.services.slice(0, 200).map(x => `<option value="${esc(x.unit)}">${esc(x.unit)}</option>`).join('');
    } catch { /* ignore */ }
    const load = async () => {
      const unit = $('#log-src').value;
      const n = $('#log-lines').value;
      const q = unit ? `unit=${encodeURIComponent(unit)}&` : '';
      const r = await api('GET', `/api/v1/system/logs?${q}lines=${n}`);
      $('#log-out').textContent = r.content || '(empty)';
      $('#log-out').scrollTop = $('#log-out').scrollHeight;
    };
    $('#log-load').onclick = load;
    load();
    let evtSrc = null;
    $('#log-follow').onclick = () => {
      if (evtSrc) { evtSrc.close(); evtSrc = null; $('#log-follow').textContent = 'Follow (SSE)'; return; }
      const unit = $('#log-src').value || 'system';
      $('#log-follow').textContent = 'Stop following';
      evtSrc = new EventSource(`/api/v1/system/logs/tail/${encodeURIComponent(unit)}`);
      evtSrc.onmessage = (e) => {
        const out = $('#log-out');
        out.textContent += e.data;
        out.scrollTop = out.scrollHeight;
      };
      evtSrc.onerror = () => { evtSrc.close(); evtSrc = null; $('#log-follow').textContent = 'Follow (SSE)'; };
    };
  },
};

/* ---- Backups ---- */
VIEWS.backups = {
  async load(root) {
    const d = await api('GET', '/api/v1/backups');
    root.innerHTML = `
      <div class="view-head"><h2>Backups</h2><div class="spacer"></div>
        <button class="btn btn-sm btn-primary" id="b-create">Create now</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Size</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${d.backups.map(b => `<tr><td class="mono">${esc(b.name)}</td><td>${fmtBytes(b.size)}</td><td>${new Date(b.createdAt).toLocaleString()}</td>
        <td style="display:flex;gap:4px">
          <a class="btn btn-sm btn-ghost" href="/api/v1/backups/${encodeURIComponent(b.name)}/download">Download</a>
          <button class="btn btn-sm btn-ghost" data-restore="${esc(b.name)}">Restore</button>
          <button class="btn btn-sm btn-ghost" data-del="${esc(b.name)}" style="color:var(--err)">Delete</button>
        </td></tr>`).join('') || `<tr><td colspan="4">${emptyState('No backups yet')}</td></tr>`}</tbody></table></div></div>
      <div class="card card-pad"><h3 style="margin-top:0">Automatic backups</h3>
        <p style="color:var(--text-dim);font-size:13px">Daily backups run at <strong>${esc((await api('GET', '/api/v1/settings')).defaults.backupTime)}</strong> and are kept for 7 days. Backups include the panel database and config (not home directories).</p></div>`;
    $('#b-create').onclick = async () => {
      toast('Creating backup...', '', 'info');
      const r = await api('POST', '/api/v1/backups/create').catch(e => ({ error: e.message }));
      r.error ? toast('Error', r.error, 'err') : toast('Backup created', r.name, 'ok');
      setTimeout(() => renderView('backups'), 800);
    };
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      const res = e.target.closest('[data-restore]');
      if (del && await confirmDialog('Delete backup', `Delete ${del.dataset.del}?`, { danger: true })) {
        await api('DELETE', `/api/v1/backups/${encodeURIComponent(del.dataset.del)}`); toast('Deleted', '', 'ok'); renderView('backups');
      }
      if (res && await confirmDialog('Restore backup', `This replaces current panel data with ${res.dataset.restore}. Panel restart recommended after. Continue?`, { danger: true, confirmLabel: 'Restore' })) {
        const r = await api('POST', `/api/v1/backups/${encodeURIComponent(res.dataset.restore)}/restore`).catch(e => ({ error: e.message }));
        r.error ? toast('Error', r.error, 'err') : toast('Restored', r.message, 'ok');
      }
    });
  },
};

/* ---- Docker ---- */
VIEWS.docker = {
  async load(root) {
    const d = await api('GET', '/api/v1/docker/ps');
    root.innerHTML = `
      <div class="view-head"><h2>Docker</h2></div>
      ${d.installed === false ? emptyState('Docker not installed', 'Install docker to use this view') : `
      <div class="card"><div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Image</th><th>Status</th><th>Ports</th><th>Actions</th></tr></thead>
      <tbody>${(d.containers || []).map(c => `<tr>
        <td class="mono">${esc(c.id.slice(0, 12))}</td><td>${esc(c.name)}</td><td class="mono">${esc(c.image)}</td>
        <td><span class="pill ${c.Status.includes('Up') ? 'ok' : 'warn'}">${esc(c.Status.split(' ')[0])}</span></td>
        <td class="mono">${esc(c.ports)}</td>
        <td style="display:flex;gap:4px;flex-wrap:wrap">
          ${['start', 'stop', 'restart', 'kill'].map(a => `<button class="btn btn-sm btn-ghost" data-act="${a}" data-id="${esc(c.id)}">${a}</button>`).join('')}
          <button class="btn btn-sm btn-ghost" data-logs="${esc(c.id)}">Logs</button>
        </td></tr>`).join('')}</tbody></table></div></div>`}`;
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      const lg = e.target.closest('[data-logs]');
      if (b) {
        await api('POST', `/api/v1/docker/${b.dataset.act}/${encodeURIComponent(b.dataset.id)}`);
        toast('Docker', `${b.dataset.act} ${b.dataset.id.slice(0, 12)}`, 'ok');
        setTimeout(() => renderView('docker'), 600);
      }
      if (lg) {
        const r = await api('GET', `/api/v1/docker/logs/${encodeURIComponent(lg.dataset.logs)}`);
        openModal({ title: `Container ${lg.dataset.logs.slice(0, 12)} logs`, wide: true, body: `<div class="code-block" style="max-height:60vh;overflow:auto">${esc(r.content || '(no output)')}</div>`, actions: [{ label: 'Close', onClick: (c) => c() }] });
      }
    });
  },
};

/* ---- Nginx ---- */
VIEWS.nginx = {
  async load(root) {
    const d = await api('GET', '/api/v1/nginx/configs').catch(e => ({ error: e.message }));
    root.innerHTML = `
      <div class="view-head"><h2>Nginx</h2><div class="spacer"></div>
        <button class="btn btn-sm" id="ng-test">nginx -t</button>
        <button class="btn btn-sm btn-primary" id="ng-reload">Reload</button>
        <button class="btn btn-sm" id="ng-new">New config</button></div>
      ${d.error ? emptyState('Nginx configs not accessible', d.error) : `
      <div class="grid cols-2">${d.configs.map(c => `
        <div class="card"><div class="card-head"><h3 class="mono">${esc(c.name)}</h3>
          <div style="display:flex;gap:6px"><button class="btn btn-sm btn-ghost" data-edit="${esc(c.name)}">Edit</button></div></div>
          <div class="card-pad"><div class="code-block" style="max-height:260px;overflow:auto">${esc(c.content)}</div></div></div>`).join('')}</div>`}`;
    const run = async (path) => {
      const r = await api('POST', path).catch(e => ({ error: e.message }));
      if (r.error) toast('Error', r.error, 'err');
      else openModal({ title: 'Result', body: `<div class="code-block">${esc(r.output || 'ok')}</div>`, actions: [{ label: 'Close', onClick: (c) => c() }] });
    };
    $('#ng-test').onclick = () => run('/api/v1/nginx/test');
    $('#ng-reload').onclick = () => run('/api/v1/nginx/reload');
    $('#ng-new').onclick = () => editNginxConfig('new-site.conf', 'server {\n    listen 80;\n    server_name example.com;\n    root /var/www/html;\n}\n');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-edit]');
      if (b) {
        const cfg = d.configs.find(x => x.name === b.dataset.edit);
        editNginxConfig(b.dataset.edit, cfg ? cfg.content : '');
      }
    });
    function editNginxConfig(name, content) {
      openModal({
        title: `Edit ${name}`, wide: true,
        body: `<textarea id="ng-editor" class="mono" style="width:100%;min-height:45vh" spellcheck="false">${esc(content)}</textarea>`,
        actions: [{ label: 'Save', kind: 'btn-primary', onClick: async (c) => {
          const r = await api('PUT', `/api/v1/nginx/configs/${encodeURIComponent(name)}`, { content: $('#ng-editor').value }).catch(e => ({ error: e.message }));
          r.error ? toast('Error', r.error, 'err') : toast('Config saved', name, 'ok');
          c();
        } }, { label: 'Cancel', onClick: (c) => c() }],
      });
    }
  },
};

/* ---- SSL ---- */
VIEWS.ssl = {
  async load(root) {
    const d = await api('GET', '/api/v1/ssl/certs');
    root.innerHTML = `
      <div class="view-head"><h2>SSL / Let's Encrypt</h2></div>
      <div class="grid cols-2">
        <div class="card card-pad">
          <h3 style="margin-top:0">Issue certificate</h3>
          <form id="ssl-form" style="display:grid;gap:10px">
            <label class="field"><span class="field-label">Domain</span><input name="domain" placeholder="example.com" required></label>
            <label class="field"><span class="field-label">Email (recovery notices)</span><input name="email" type="email" placeholder="admin@example.com"></label>
            <button class="btn btn-primary btn-sm" type="submit">Issue via certbot (nginx)</button>
          </form>
          <p style="font-size:12px;color:var(--text-dim)">Requires: domain DNS pointing to this server, port 80 free, nginx installed, sudo -n configured.</p>
        </div>
        <div class="card"><div class="card-head"><h3>Certificates</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Domain</th><th>Expires</th><th>Days left</th></tr></thead>
          <tbody>${(d.certs || []).map(c => { const days = c.expires ? Math.ceil((new Date(c.expires) - Date.now()) / 864e5) : null; return `<tr>
            <td class="mono"><strong>${esc(c.domain)}</strong></td>
            <td>${c.expires ? new Date(c.expires).toLocaleDateString() : '-'}</td>
            <td>${days != null ? `<span class="pill ${days < 14 ? 'err' : days < 30 ? 'warn' : 'ok'}">${days}d</span>` : '-'}</td></tr>`; }).join('') || `<tr><td colspan="3">${emptyState('No certificates')}</td></tr>`}</tbody></table></div></div>
      </div>`;
    $('#ssl-form').onsubmit = async (e) => {
      e.preventDefault();
      const r = await api('POST', '/api/v1/ssl/issue', { domain: e.target.domain.value, email: e.target.email.value }).catch(err => ({ error: err.message }));
      r.error ? toast('Error', r.error, 'err') : toast('Certificate issued', r.domain, 'ok');
    };
  },
};

/* ---- Audit ---- */
VIEWS.audit = {
  async load(root) {
    const d = await api('GET', '/api/v1/audit?limit=200');
    root.innerHTML = `
      <div class="view-head"><h2>Audit Log</h2><div class="spacer"></div>
        <div class="search-box"><svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="au-search" type="search" placeholder="Filter by action..."></div></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Result</th><th>IP</th></tr></thead>
      <tbody id="au-body">${d.audit.map(a => auditRow(a)).join('')}</tbody></table></div></div>`;
    $('#au-search').oninput = debounce(async (e) => {
      const q = e.target.value;
      const r = await api('GET', `/api/v1/audit?limit=200&action=${encodeURIComponent(q)}`);
      $('#au-body').innerHTML = r.audit.map(auditRow).join('') || `<tr><td colspan="6">${emptyState('No matches')}</td></tr>`;
    }, 250);
  },
};
function auditRow(a) {
  return `<tr><td class="mono" style="font-size:11.5px">${new Date(a.ts).toLocaleString()}</td>
    <td>${a.userId ? esc(a.userId.slice(0, 8)) : '-'}</td>
    <td class="mono">${esc(a.action)}</td><td class="mono">${esc(String(a.target).slice(0, 40))}</td>
    <td><span class="pill ${a.result === 'ok' ? 'ok' : 'err'}">${esc(a.result)}</span></td>
    <td class="mono">${esc(a.ip)}</td></tr>`;
}

/* ---- Settings ---- */
VIEWS.settings = {
  async load(root) {
    const d = await api('GET', '/api/v1/settings');
    root.innerHTML = `
      <div class="view-head"><h2>Settings</h2></div>
      <div class="grid cols-2">
        <div class="card card-pad">
          <h3 style="margin-top:0">Appearance</h3>
          <label class="field"><span class="field-label">Theme (${THEMES.length} themes)</span>
            <select id="set-theme">${THEMES.map(t => `<option value="${t}" ${document.documentElement.dataset.theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <div id="theme-preview" style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:8px">
            ${THEMES.map(t => `<button class="theme-swatch" data-t="${t}" style="height:34px;border-radius:8px;border:2px solid ${document.documentElement.dataset.theme === t ? 'var(--text)' : 'transparent'}" aria-label="theme ${t}"></button>`).join('')}
          </div>
        </div>
        <div class="card card-pad">
          <h3 style="margin-top:0">Panel</h3>
          <form id="set-form" style="display:grid;gap:12px">
            <label class="field"><span class="field-label">Backup time (HH:MM)</span><input name="backupTime" value="${esc(d.defaults.backupTime)}" pattern="([01]\\d|2[0-3]):[0-5]\\d"></label>
            <label class="field" style="flex-direction:row;align-items:center;gap:10px">
              <span class="switch"><input type="checkbox" name="twoFactorRequired" ${d.defaults.twoFactorRequired ? 'checked' : ''}><span class="track"></span></span>
              <span>Require 2FA for all users</span></label>
            <label class="field"><span class="field-label">Notification webhook URL</span><input name="notifyWebhook" type="url" placeholder="https://hooks.example.com/..."></label>
            <button class="btn btn-primary btn-sm" type="submit">Save settings</button>
          </form>
        </div>
      </div>`;
    // theme swatch preview colors
    $$('.theme-swatch', root).forEach(sw => {
      const t = sw.dataset.t;
      const colors = { midnight: '#0b1020', dark: '#0a0c10', light: '#f4f6fa', solarized: '#002b36', nord: '#242933', monokai: '#272822', dracula: '#282a36', contrast: '#000', sunset: '#1c1220', paper: '#f5efe0', matrix: '#020a02' };
      sw.style.background = colors[t] || '#333';
      sw.onclick = () => { applyTheme(t); renderView('settings'); };
    });
    $('#set-theme').onchange = (e) => { applyTheme(e.target.value); renderView('settings'); };
    $('#set-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { backupTime: f.backupTime.value };
      if (f.notifyWebhook.value) body.notifyWebhook = f.notifyWebhook.value;
      body.twoFactorRequired = f.twoFactorRequired.checked;
      await api('PUT', '/api/v1/settings', body);
      toast('Settings saved', '', 'ok');
    };
  },
};

/* ---- About ---- */
VIEWS.about = {
  load(root) {
    root.innerHTML = `
      <div class="view-head"><h2>About</h2></div>
      <div class="grid cols-2">
        <div class="card card-pad" style="text-align:center">
          <svg viewBox="0 0 32 32" width="72" height="72" style="margin-bottom:12px"><rect width="32" height="32" rx="7" fill="var(--brand)"/><path d="M9 10l7 6-7 6" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><line x1="18" y1="22" x2="25" y2="22" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>
          <h2 style="margin:0 0 4px">VPS Panel</h2>
          <p style="color:var(--text-dim)">Version 1.0.0</p>
          <p style="font-size:13px;color:var(--text-dim)">Self-hosted web control panel for your VPS:<br>real PTY terminal, file manager, process & service control, firewall, packages, cron, backups, SSL and more.</p>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap">
            <button class="btn btn-sm" id="about-update">Check updates</button>
            <button class="btn btn-sm" id="about-health">Health check</button>
            <button class="btn btn-sm" id="about-konami">Easter egg</button>
          </div>
        </div>
        <div class="card card-pad">
          <h3 style="margin-top:0">Stack</h3>
          <table style="font-size:13px">
            <tr><td style="color:var(--text-dim)">Backend</td><td>Node.js 20 LTS + Fastify 4</td></tr>
            <tr><td style="color:var(--text-dim)">Terminal</td><td>node-pty (real PTY) + ws (WebSocket)</td></tr>
            <tr><td style="color:var(--text-dim)">Frontend</td><td>Vanilla ES2022 + xterm.js 5.5.0</td></tr>
            <tr><td style="color:var(--text-dim)">Auth</td><td>JWT + bcrypt (cost 12) + TOTP 2FA</td></tr>
            <tr><td style="color:var(--text-dim)">Database</td><td>Atomic JSON store (no native deps)</td></tr>
            <tr><td style="color:var(--text-dim)">License</td><td>MIT</td></tr>
          </table>
          <h3 style="margin-top:18px">Keyboard shortcuts</h3>
          <table style="font-size:13px">
            <tr><td style="color:var(--text-dim)">Terminal copy</td><td><span class="kbd">Ctrl+Shift+C</span></td></tr>
            <tr><td style="color:var(--text-dim)">Terminal paste</td><td><span class="kbd">Ctrl+Shift+V</span></td></tr>
            <tr><td style="color:var(--text-dim)">New terminal session</td><td><span class="kbd">Ctrl+Shift+T</span></td></tr>
            <tr><td style="color:var(--text-dim)">Toggle sidebar</td><td><span class="kbd">Ctrl+B</span></td></tr>
          </table>
        </div>
      </div>`;
    $('#about-health').onclick = async () => {
      const r = await fetch('/health').then(r => r.json());
      toast('Health', `status: ${r.status}, uptime ${Math.round(r.uptime)}s`, 'ok');
    };
    $('#about-update').onclick = async () => {
      const r = await api('GET', '/api/v1/update/check');
      toast('Update check', r.updateAvailable ? `Update available: ${r.latest}` : 'You are on the latest version', r.updateAvailable ? 'warn' : 'ok');
    };
    // Konami code easter egg
    const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let ki = 0;
    const handler = (e) => {
      ki = e.key === KONAMI[ki] ? ki + 1 : (e.key === KONAMI[0] ? 1 : 0);
      if (ki === KONAMI.length) {
        ki = 0;
        document.removeEventListener('keydown', handler);
        document.body.animate([{ transform: 'hue-rotate(0deg)' }, { transform: 'hue-rotate(360deg)' }], { duration: 2000, iterations: 1 });
        toast('Konami!', 'You found the easter egg. 30 extra lives granted (not really).', 'ok', 6000);
      }
    };
    $('#about-konami').onclick = () => { document.addEventListener('keydown', handler); toast('Konami', 'Press: up up down down left right left right B A', 'info'); };
  },
};

/* ---------- Global keyboard shortcuts ---------- */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
});

/* ---------- Sidebar / drawer ---------- */
function toggleSidebar() {
  const sb = $('#sidebar');
  if (window.innerWidth <= 900) {
    sb.classList.toggle('mobile-open');
    $('#drawer-backdrop').hidden = !sb.classList.contains('mobile-open');
  } else {
    sb.classList.toggle('collapsed');
  }
}

/* ---------- Boot ---------- */
async function boot() {
  initTheme();
  $('#theme-toggle').onclick = cycleTheme;
  $('#menu-toggle').onclick = toggleSidebar;
  $('#sidebar-collapse').onclick = toggleSidebar;
  $('#drawer-backdrop').onclick = toggleSidebar;
  initUserMenu();
  await initAuth();

  if (store.token && store.user) {
    // validate token
    try {
      await api('GET', '/api/v1/system/overview');
      enterApp();
    } catch {
      logout();
    }
  }

  setTimeout(() => $('#splash').classList.add('done'), 900);
  setInterval(refreshNotifications, 60000);
}

// admin-only nav entries
function applyRoleVisibility() {
  const isAdmin = (store.user && store.user.role) === 'admin';
  $$('.admin-only').forEach(el => { el.hidden = !isAdmin; });
  if (!isAdmin) {
    // a non-admin must never land on an admin view
    const v = location.hash.replace('#/', '');
    if (['invites', 'audit', 'settings', 'users', 'firewall', 'sysusers', 'nginx', 'ssl'].includes(v)) {
      location.hash = '/terminal';
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
