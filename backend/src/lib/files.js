// lib/files.js - File manager with root-jail (path traversal prevention), validation, compression
'use strict';
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const crypto = require('crypto');

// File manager root jail. Resolution order per request:
//   1. explicit root (used for panel uploads / admin browsing)
//   2. the requesting user's own Linux home  <- multi-tenant default
//   3. PANEL_FILE_ROOT
//   4. the invoking user's home (developer fallback)
function defaultFileRoot() {
  if (process.env.PANEL_FILE_ROOT) return process.env.PANEL_FILE_ROOT;
  try {
    const os = require('os');
    const h = os.userInfo().homedir;
    if (h && fs.existsSync(h) && fs.accessSync(h, fs.constants.W_OK)) return h;
  } catch { /* fall through */ }
  return '/home';
}

const FILE_ROOT = defaultFileRoot();

// Home directory of a panel user, used as the jail root for their file browser.
function userRoot(user) {
  if (user && typeof user.uid === 'number' && user.uid > 0 && user.home) {
    if (fs.existsSync(user.home)) return user.home;
  }
  return FILE_ROOT;
}
const MAX_TEXT_SIZE = 2 * 1024 * 1024;      // 2MB text read limit
const MAX_UPLOAD = parseInt(process.env.PANEL_MAX_UPLOAD_MB || '200', 10) * 1024 * 1024;
const ALLOWED_EXEC = new Set(['sh', 'bash', 'tar', 'gzip', 'gunzip', 'unzip', 'zip']);
const BLOCKED_NAMES = new Set(['', '.', '..']);

class PathTraversalError extends Error {}

function resolveSafe(relPath, root = FILE_ROOT) {
  const p = String(relPath || '/');
  const base = path.resolve(root);
  const abs = path.resolve(base, '.' + p);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new PathTraversalError('path escapes root');
  return abs;
}

async function stat(relPath, root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  const st = await fsp.stat(abs);
  return {
    path: relPath, name: path.basename(abs), type: st.isDirectory() ? 'dir' : 'file',
    size: st.size, mode: (st.mode & 0o777).toString(8),
    modified: st.mtimeMs, accessed: st.atimeMs,
    owner: st.uid, group: st.gid,
  };
}

async function list(relPath, root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    try {
      const st = await fsp.stat(path.join(abs, e.name));
      out.push({
        name: e.name, type: e.isDirectory() ? 'dir' : 'file',
        size: st.size, mode: (st.mode & 0o777).toString(8),
        modified: st.mtimeMs, owner: st.uid, group: st.gid,
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

async function readFile(relPath, root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  const st = await fsp.stat(abs);
  if (st.size > MAX_TEXT_SIZE) throw new Error(`file too large to view (${st.size} bytes) - use download`);
  const buf = await fsp.readFile(abs);
  return { content: buf.toString('utf8'), size: st.size, encoding: 'utf8' };
}

async function writeFile(relPath, content, root = FILE_ROOT) {
  if (typeof content !== 'string') throw new Error('content must be string');
  if (Buffer.byteLength(content) > MAX_TEXT_SIZE) throw new Error('content too large');
  const abs = resolveSafe(relPath, root);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, { mode: 0o644 });
  return { ok: true, bytes: Buffer.byteLength(content) };
}

async function mkdir(relPath, root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  await fsp.mkdir(abs, { recursive: true });
  return { ok: true };
}

async function rename(oldRel, newRel, root = FILE_ROOT) {
  const a = resolveSafe(oldRel, root), b = resolveSafe(newRel, root);
  await fsp.rename(a, b);
  return { ok: true };
}

async function remove(relPath, root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  await fsp.rm(abs, { recursive: true, force: true });
  return { ok: true };
}

async function compress(relPath, format = 'tar.gz', root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  const out = `${abs}.${format}`;
  const base = path.basename(abs);
  if (format === 'tar.gz') await execFileP('tar', ['-czf', out, '-C', path.dirname(abs), base]);
  else if (format === 'zip') await execFileP('zip', ['-r', out, base], { cwd: path.dirname(abs) });
  else throw new Error('unsupported format');
  return { ok: true, output: out.replace(FILE_ROOT, '') };
}

async function extract(relPath, destRel, root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  const dest = destRel ? resolveSafe(destRel, root) : path.dirname(abs);
  const ext = path.extname(abs).replace('.', '');
  if (['gz', 'tgz'].includes(ext) || abs.endsWith('.tar.gz')) await execFileP('tar', ['-xzf', abs, '-C', dest]);
  else if (ext === 'zip') await execFileP('unzip', ['-o', abs, '-d', dest]);
  else if (ext === 'tar') await execFileP('tar', ['-xf', abs, '-C', dest]);
  else throw new Error('unsupported archive');
  return { ok: true };
}

async function saveUpload(relPath, buffer, originalName, root = FILE_ROOT) {
  const abs = resolveSafe(relPath, root);
  if (buffer.length > MAX_UPLOAD) throw new Error('file exceeds upload limit');
  // name sanitization
  const safeName = path.basename(String(originalName || 'upload')).replace(/[^\w.\- ]/g, '_').slice(0, 200);
  // treat the target as a directory when it is one (or ends with a separator)
  let finalPath = abs;
  if (abs.endsWith('/') || abs.endsWith(path.sep)) {
    finalPath = path.join(abs, safeName);
  } else {
    try {
      if (fs.statSync(abs).isDirectory()) finalPath = path.join(abs, safeName);
    } catch { /* non-existent path -> use as file */ }
  }
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await fsp.writeFile(finalPath, buffer, { mode: 0o644 });
  return { ok: true, name: path.basename(finalPath), size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

module.exports = { list, stat, readFile, writeFile, mkdir, rename, remove, compress, extract, saveUpload, resolveSafe, userRoot, FILE_ROOT, MAX_UPLOAD, PathTraversalError };
