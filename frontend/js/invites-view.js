/* invites-view.js - Admin screen: create shareable signup links */
'use strict';
(function () {
  const api = window.__api;
  const esc = window.__esc;

  function linkRow(inv) {
    const state = inv.revoked ? 'revoked' : inv.expired ? 'expired' : inv.exhausted ? 'used up' : 'active';
    const cls = state === 'active' ? 'ok' : state === 'used up' ? 'info' : 'err';
    return `<tr data-id="${inv.id}">
      <td class="mono" style="max-width:280px;word-break:break-all">
        <span id="lnk-${inv.id}">${esc(inv.link)}</span>
      </td>
      <td><span class="pill ${cls}">${state}</span></td>
      <td>${inv.email ? esc(inv.email) : '<span style="color:var(--text-faint)">anyone</span>'}</td>
      <td><span class="pill info">${inv.role}</span></td>
      <td class="mono">${inv.uses}/${inv.maxUses}</td>
      <td>${new Date(inv.createdAt).toLocaleDateString()}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn btn-sm btn-ghost" data-copy="${esc(inv.link)}">Copy link</button>
        ${inv.exhausted ? `<button class="btn btn-sm btn-ghost" data-reset="${inv.id}">Reset</button>` : ''}
        <button class="btn btn-sm btn-ghost" data-del="${inv.id}" style="color:var(--err)">Delete</button>
      </td>
    </tr>`;
  }

  window.VIEWS = window.VIEWS || {};

  window.VIEWS.invites = {
    async load(root) {
      const wrap = document.createElement('div');
      wrap.className = 'view-root';
      wrap.innerHTML = `
        <div class="view-head">
          <h2>Invite Links</h2>
          <div class="spacer"></div>
          <button class="btn btn-primary btn-sm" id="inv-create">+ New invite link</button>
        </div>

        <div class="card card-pad" style="display:grid;gap:12px">
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <input name="email" type="email" placeholder="Restrict to email (optional)" style="flex:2;min-width:200px">
            <input name="maxUses" type="number" min="1" max="500" value="1" style="width:110px" aria-label="Max uses">
            <select name="role" style="width:150px"><option value="user">user</option><option value="viewer">viewer</option></select>
            <input name="note" placeholder="Note (optional)" style="flex:1;min-width:150px">
          </div>
          <p style="margin:0;font-size:12.5px;color:var(--text-dim)">
            Share the link with anyone. Opening it shows the sign-up page with the invitation attached -
            they get their own account and their own isolated system user (terminal runs as them, never root).
          </p>
        </div>

        <div id="inv-table"></div>
        <div id="inv-last"></div>`;
      root.replaceWith(wrap);
      const refresh = async () => {
        const r = await api('GET', '/api/v1/invites');
        const host = $('#inv-table');
        if (!r.invites.length) {
          host.innerHTML = `<div class="card"><div class="empty-state">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 19a6 6 0 100-12 6 6 0 000 12z"/><path d="M19 8v6M16 11h6" stroke-linecap="round"/></svg>
            <div><strong>No invite links yet</strong><div>Create one above to let other people sign up.</div></div>
          </div></div>`;
          return;
        }
        host.innerHTML = `<div class="card"><div class="table-wrap"><table>
          <thead><tr><th>Link</th><th>State</th><th>Email</th><th>Role</th><th>Uses</th><th>Created</th><th></th></tr></thead>
          <tbody>${r.invites.map(linkRow).join('')}</tbody></table></div></div>`;

        host.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
          const url = b.dataset.copy;
          try { await navigator.clipboard.writeText(url); toast('Copied', 'Invite link on your clipboard', 'ok'); }
          catch {
            // clipboard blocked: select the text so it can be copied manually
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(document.getElementById('lnk-' + b.closest('tr').dataset.id));
            sel.removeAllRanges(); sel.addRange(range);
            toast('Copy manually', 'Text selected - press Ctrl+C', 'warn');
          }
        });
        host.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
          if (!await confirmDialog('Delete invite', 'Anyone holding this link will no longer be able to sign up.', { danger: true, confirmLabel: 'Delete' })) return;
          await api('DELETE', '/api/v1/invites/' + b.dataset.del);
          toast('Invite deleted', '', 'ok');
          refresh();
        });
        host.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
          await api('POST', '/api/v1/invites/' + b.dataset.reset + '/reset');
          toast('Invite reset', 'It can be used again', 'ok');
          refresh();
        });
      };

      $('#inv-create').onclick = async () => {
        const email = wrap.querySelector('[name=email]').value.trim();
        const maxUses = parseInt(wrap.querySelector('[name=maxUses]').value, 10) || 1;
        const role = wrap.querySelector('[name=role]').value;
        const note = wrap.querySelector('[name=note]').value.trim();
        try {
          const r = await api('POST', '/api/v1/invites', { email, maxUses, role, note });
          const last = $('#inv-last');
          last.innerHTML = `<div class="card card-pad" style="border-color:var(--brand)">
            <strong style="display:block;margin-bottom:8px">New invite link - copy it now</strong>
            <div class="code-block" id="inv-new">${esc(r.invite.link)}</div>
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn btn-sm btn-primary" id="inv-copy">Copy link</button>
              <a class="btn btn-sm" href="${esc(r.invite.link)}" target="_blank" rel="noopener">Open sign-up page</a>
            </div></div>`;
          $('#inv-copy').onclick = async () => {
            try { await navigator.clipboard.writeText(r.invite.link); toast('Copied', '', 'ok'); } catch { toast('Copy failed', 'Select the text manually', 'warn'); }
          };
          wrap.querySelector('[name=email]').value = '';
          wrap.querySelector('[name=note]').value = '';
          await refresh();
        } catch (e) {
          toast('Could not create invite', e.message, 'err');
        }
      };

      await refresh();
    },
  };
})();