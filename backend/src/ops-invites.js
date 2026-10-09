// ops-invites.js - Shared invite helpers (extracted so both routes can use them)
'use strict';
const crypto = require('crypto');
const db = require('./db');

// Create a shareable invite link so other people can register on this panel.
function newInvite({ email = '', role = 'user', maxUses = 1, note = '' } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  return db.insert('invites', {
    token, email, role, maxUses, note,
    uses: 0, createdAt: Date.now(), createdBy: null, revoked: false,
    expiresAt: Date.now() + 30 * 864e5,
  });
}

// Validate + consume an invite token. Returns { ok, invite } or { ok:false, error }.
function consumeInvite(token, username) {
  if (!token) return { ok: false, error: 'invite link required (this panel is invite-only)' };
  const inv = db.findBy('invites', 'token', String(token).trim().toLowerCase());
  if (!inv || inv.revoked) return { ok: false, error: 'invalid invite link' };
  if (inv.expiresAt && inv.expiresAt < Date.now()) return { ok: false, error: 'invite link expired' };
  if (inv.uses >= inv.maxUses) return { ok: false, error: 'invite link has already been used' };
  if (inv.email && inv.email.toLowerCase() !== String(username).toLowerCase()) {
    return { ok: false, error: `this invite is reserved for ${inv.email}` };
  }
  inv.uses++;
  inv.usedBy = username;
  inv.usedAt = Date.now();
  db.save();
  return { ok: true, invite: inv };
}

module.exports = { newInvite, consumeInvite };