// routes/files.js - File manager: list/read/write/upload/download/mkdir/rename/remove/compress/extract
'use strict';
const fsm = require('../lib/files');
const { clientIp, requireRole } = require('../lib/middleware');
const crypto = require('crypto');
const db = require('../db');

async function fileRoutes(app, opts) {
  // Multi-tenant: every request is jailed to the caller's own home directory.
  // Admins may pass ?root=/ to browse the whole filesystem (admin only).
  const rootFor = (req) => {
    if (req.role === 'admin' && req.query && req.query.root === '/') return '/';
    return fsm.userRoot(req.user);
  };
  app.get('/files/list', { preHandler: [opts.authMw] }, async (req, reply) => {
    const p = String(req.query?.path || '/');
    try {
      const items = await fsm.list(p, rootFor(req));
      return { ok: true, path: p, root: rootFor(req), items };
    } catch (e) {
      if (e instanceof fsm.PathTraversalError) return reply.code(400).send({ error: 'invalid path' });
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/files/stat', { preHandler: [opts.authMw] }, async (req, reply) => {
    try { return { ok: true, ...(await fsm.stat(String(req.query?.path || '/'), rootFor(req))) }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.get('/files/read', { preHandler: [opts.authMw] }, async (req, reply) => {
    try {
      const r = await fsm.readFile(String(req.query?.path || '/'), rootFor(req));
      return { ok: true, path: req.query.path, content: r.content, size: r.size };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.put('/files/write', { preHandler: [opts.authMw, requireRole('user'), opts.csrfMw] }, async (req, reply) => {
    const { path, content } = req.body || {};
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content must be string' });
    try {
      const r = await fsm.writeFile(String(path || '/'), content, rootFor(req));
      db.audit(req.user.id, 'file.write', path, 'ok', { bytes: r.bytes }, clientIp(req.raw));
      return { ok: true, ...r };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.post('/files/mkdir', { preHandler: [opts.authMw, requireRole('user'), opts.csrfMw] }, async (req, reply) => {
    try { await fsm.mkdir(String(req.body?.path || '/'), rootFor(req)); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.post('/files/rename', { preHandler: [opts.authMw, requireRole('user'), opts.csrfMw] }, async (req, reply) => {
    try {
      await fsm.rename(String(req.body?.from || '/'), String(req.body?.to || '/'), rootFor(req));
      db.audit(req.user.id, 'file.rename', req.body.from + ' -> ' + req.body.to, 'ok');
      return { ok: true };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.delete('/files/remove', { preHandler: [opts.authMw, requireRole('user'), opts.csrfMw] }, async (req, reply) => {
    try {
      await fsm.remove(String(req.body?.path || '/'), rootFor(req));
      db.audit(req.user.id, 'file.remove', req.body.path, 'ok');
      return { ok: true };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.post('/files/compress', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    try {
      const r = await fsm.compress(String(req.body?.path || '/'), String(req.body?.format || 'tar.gz'), rootFor(req));
      db.audit(req.user.id, 'file.compress', req.body.path, 'ok');
      return { ok: true, ...r };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.post('/files/extract', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    try {
      const r = await fsm.extract(String(req.body?.path || '/'), req.body?.dest ? String(req.body.dest) : null, rootFor(req));
      db.audit(req.user.id, 'file.extract', req.body.path, 'ok');
      return { ok: true, ...r };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // upload (multipart, size limit, name sanitization, hash)
  app.post('/files/upload', { preHandler: [opts.authMw, requireRole('user'), opts.csrfMw] }, async (req, reply) => {
    const parts = req.parts();
    let targetDir = '/';
    let saved = null;
    for await (const part of parts) {
      if (part.fieldname === 'path') { targetDir = await part.value; continue; }
      if (part.fieldname === 'root' && req.role === 'admin') { await part.value; continue; }
      if (part.file) {
        if (part.file.truncated) return reply.code(413).send({ error: 'file too large' });
        const chunks = [];
        for await (const c of part.file) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (buf.length > fsm.MAX_UPLOAD) return reply.code(413).send({ error: 'file exceeds upload limit' });
        saved = await fsm.saveUpload(targetDir, buf, part.filename, rootFor(req));
      }
    }
    if (!saved) return reply.code(400).send({ error: 'no file provided' });
    db.insert('files', { name: saved.name, path: saved.name, size: saved.size, sha256: saved.sha256, uploadedBy: req.user.id, uploadedAt: Date.now(), ip: clientIp(req.raw) });
    db.audit(req.user.id, 'file.upload', saved.name, 'ok', { size: saved.size }, clientIp(req.raw));
    return { ok: true, ...saved };
  });

  // download (streaming, Content-Disposition attachment)
  app.get('/files/download', { preHandler: [opts.authMw] }, async (req, reply) => {
    const rel = String(req.query?.path || '');
    let abs;
    try { abs = fsm.resolveSafe(rel, rootFor(req)); } catch { return reply.code(400).send({ error: 'invalid path' }); }
    const fs = require('fs');
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return reply.code(400).send({ error: 'not a file' });
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(require('path').basename(abs))}"`);
      reply.header('Content-Length', String(st.size));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.type('application/octet-stream');
      return reply.send(fs.createReadStream(abs));
    } catch { return reply.code(404).send({ error: 'not found' }); }
  });

  // search inside text files (grep)
  app.get('/files/search', { preHandler: [opts.authMw] }, async (req, reply) => {
    const { path: p, q } = req.query || {};
    if (!q || q.length > 128) return reply.code(400).send({ error: 'invalid query' });
    const fs = require('fs');
    const pathMod = require('path');
    let abs;
    try { abs = fsm.resolveSafe(String(p || '/'), rootFor(req)); } catch { return reply.code(400).send({ error: 'invalid path' }); }
    const results = [];
    const walk = (dir, depth) => {
      if (depth > 5 || results.length >= 100) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= 100) return;
        const full = pathMod.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile() && fs.statSync(full).size < 1024 * 1024) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
              if (line.includes(q) && results.length < 100) {
                results.push({ path: full.replace(fsm.FILE_ROOT, ''), line: i + 1, snippet: line.slice(0, 200) });
              }
            });
          } catch { /* binary/unreadable */ }
        }
      }
    };
    walk(abs, 0);
    return { ok: true, query: q, results };
  });
}

module.exports = fileRoutes;
