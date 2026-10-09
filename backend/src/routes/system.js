// routes/system.js - Dashboard, monitor, processes, services, users, firewall, packages, cron, disk, network, logs
'use strict';
const os = require('os');
const system = require('../lib/system');
const db = require('../db');
const { clientIp, requireRole } = require('../lib/middleware');

async function systemRoutes(app, opts) {
  // ---- overview dashboard ----
  app.get('/system/overview', async (req) => {
    const cpu = system.cpuUsage();
    const mem = system.memInfo();
    const disks = system.diskInfo();
    const [net, svcs] = await Promise.all([system.networkInfo(), system.services()]);
    return {
      ok: true,
      server: {
        hostname: os.hostname(),
        kernel: os.release(),
        os: readOsRelease(),
        arch: os.arch(),
        cpus: os.cpus().length,
        cpuModel: (os.cpus()[0] || {}).model || '',
        uptime: system.uptime(),
        load: system.loadAvg(),
      },
      cpu, mem, disks,
      network: { interfaces: net.interfaces, listening: net.listening.slice(0, 50) },
      services: svcs.slice(0, 60),
      panel: { version: '1.0.0', node: process.version, pid: process.pid, startedAt: process.startTime },
    };
  });

  // ---- realtime monitor snapshot ----
  app.get('/system/monitor', async (req) => {
    return {
      ok: true, ts: Date.now(),
      cpu: system.cpuUsage(),
      mem: system.memInfo(),
      load: system.loadAvg(),
      disks: system.diskInfo().map(d => ({ mount: d.mount, usage: d.usage })),
      processes: system.processList().slice(0, 20).map(p => ({ pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem })),
    };
  });

  // ---- chart history (in-memory ring, real data) ----
  app.get('/system/history', async (req) => {
    return { ok: true, series: opts.metrics.history() };
  });

  // ---- processes ----
  app.get('/system/processes', async (req) => {
    return { ok: true, processes: system.processList() };
  });

  app.post('/system/processes/:pid/signal', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const pid = parseInt(req.params.pid, 10);
    const sig = String(req.body?.signal || 'SIGTERM').toUpperCase();
    if (!Number.isInteger(pid) || pid <= 0) return reply.code(400).send({ error: 'invalid pid' });
    if (!/^(SIG)?(TERM|KILL|HUP|INT|STOP|CONT|USR1|USR2)$/.test(sig)) return reply.code(400).send({ error: 'invalid signal' });
    // kill pid 1 or kernel threads: not allowed
    if (pid === 1) return reply.code(403).send({ error: 'cannot signal init' });
    const r = await system.run('kill', ['-' + sig.replace(/^SIG/, ''), String(pid)]);
    db.audit(req.user.id, 'process.signal', String(pid), r.ok ? 'ok' : 'fail', { signal: sig }, clientIp(req.raw || req));
    return r.ok ? { ok: true } : reply.code(400).send({ error: r.stderr || 'kill failed (need sudo for other users\' processes)' });
  });

  app.delete('/system/processes/:pid', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const pid = parseInt(req.params.pid, 10);
    if (!Number.isInteger(pid) || pid <= 1) return reply.code(400).send({ error: 'invalid pid' });
    const r = await system.run('kill', [String(pid)]);
    db.audit(req.user.id, 'process.kill', String(pid), r.ok ? 'ok' : 'fail', {}, clientIp(req.raw || req));
    return r.ok ? { ok: true } : reply.code(400).send({ error: r.stderr || 'kill failed' });
  });

  // ---- services (systemd) ----
  app.get('/system/services', { preHandler: [opts.authMw] }, async (req) => {
    const list = await system.services();
    return { ok: true, services: list };
  });

  app.get('/system/services/:name', { preHandler: [opts.authMw] }, async (req, reply) => {
    const r = await system.serviceAction(req.params.name, 'status');
    return { ok: r.ok, name: req.params.name, output: r.output || r.error };
  });

  app.post('/system/services/:name/:action', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const r = await system.serviceAction(req.params.name, req.params.action);
    db.audit(req.user.id, 'service.' + req.params.action, req.params.name, r.ok ? 'ok' : 'fail', {}, clientIp(req.raw || req));
    return r.ok ? { ok: true, output: r.output } : reply.code(400).send({ error: r.error });
  });

  // ---- system users ----
  app.get('/system/users', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const fs = require('fs');
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    const users = passwd.split('\n').filter(Boolean).map(line => {
      const [name, x, uid, gid, gecos, home, shell] = line.split(':');
      return { name, uid: parseInt(uid), gid: parseInt(gid), gecos, home, shell };
    }).filter(u => u.uid >= 0);
    return { ok: true, users };
  });

  app.post('/system/users', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const { username, shell = '/bin/bash', createHome = true } = req.body || {};
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username || '')) return reply.code(400).send({ error: 'invalid username' });
    if (!['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/sbin/nologin'].includes(shell)) return reply.code(400).send({ error: 'invalid shell' });
    const args = ['useradd', '-m', '-s', shell];
    if (!createHome) args[1] = 'M';
    args.push(username);
    const r = await system.run('sudo', ['-n'].concat(args));
    db.audit(req.user.id, 'system.user.add', username, r.ok ? 'ok' : 'fail', {}, clientIp(req.raw || req));
    return r.ok ? { ok: true, user: username } : reply.code(400).send({ error: r.stderr || 'useradd failed (needs sudo -n)' });
  });

  app.delete('/system/users/:name', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const name = req.params.name;
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(name)) return reply.code(400).send({ error: 'invalid username' });
    if (['root', 'admin', 'nobody'].includes(name)) return reply.code(403).send({ error: 'protected user' });
    const r = await system.run('sudo', ['-n', 'userdel', '-r', name]);
    db.audit(req.user.id, 'system.user.delete', name, r.ok ? 'ok' : 'fail', {}, clientIp(req.raw || req));
    return r.ok ? { ok: true } : reply.code(400).send({ error: r.stderr || 'userdel failed' });
  });

  // ---- firewall (ufw / firewalld) ----
  app.get('/firewall/status', { preHandler: [opts.authMw, requireRole('admin')] }, async (req) => {
    const ufw = await system.run('sudo', ['-n', 'ufw', 'status', 'verbose']);
    if (ufw.ok) return { ok: true, backend: 'ufw', output: ufw.stdout };
    const fw = await system.run('sudo', ['-n', 'firewall-cmd', '--list-all']);
    if (fw.ok) return { ok: true, backend: 'firewalld', output: fw.stdout };
    return reply.code(400).send({ error: 'no supported firewall backend (ufw/firewalld) or sudo -n not configured' });
  });

  app.post('/firewall/:action', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const { action } = req.params; // allow | deny | delete | reset | enable | disable
    const { port, proto = 'tcp', comment } = req.body || {};
    const ip = clientIp(req.raw || req);
    const sudo = ['sudo', '-n'];
    let r;
    const backend = (await system.run('which', ['ufw'])).ok ? 'ufw' : 'firewalld';
    if (backend === 'ufw') {
      if (action === 'allow' || action === 'deny') {
        if (!/^\d{1,5}$/.test(String(port))) return reply.code(400).send({ error: 'invalid port' });
        const args = sudo.concat(['ufw', action, `${port}/${proto}`]);
        if (comment) args.push('comment', String(comment).slice(0, 100));
        r = await system.run('sudo', ['-n', 'ufw', action, `${port}/${proto}`]);
      } else if (action === 'delete') {
        if (!/^\d{1,5}$/.test(String(port))) return reply.code(400).send({ error: 'invalid port' });
        r = await system.run('sudo', ['-n', 'ufw', 'delete', 'allow', `${port}/${proto}`]);
      } else if (['enable', 'disable', 'reset'].includes(action)) {
        r = await system.run('sudo', ['-n', 'ufw', action]);
      } else {
        return reply.code(400).send({ error: 'invalid action' });
      }
    } else {
      if (action === 'allow' || action === 'deny') {
        if (!/^\d{1,5}$/.test(String(port))) return reply.code(400).send({ error: 'invalid port' });
        const zone = req.body?.zone || 'public';
        r = await system.run('sudo', ['-n', 'firewall-cmd', '--permanent', `--zone=${zone}`, `--${action === 'allow' ? 'add' : 'remove'}-port=${port}/${proto}`]);
        if (r.ok) await system.run('sudo', ['-n', 'firewall-cmd', '--reload']);
      } else if (action === 'enable') {
        r = await system.run('sudo', ['-n', 'systemctl', 'enable', '--now', 'firewalld']);
      } else if (action === 'disable') {
        r = await system.run('sudo', ['-n', 'systemctl', 'disable', '--now', 'firewalld']);
      } else {
        return reply.code(400).send({ error: 'invalid action for firewalld' });
      }
    }
    db.audit(req.user.id, 'firewall.' + action, `${port || ''}/${proto}`, r.ok ? 'ok' : 'fail', {}, ip);
    return r.ok ? { ok: true, backend, output: r.stdout } : reply.code(400).send({ error: r.stderr || 'firewall command failed' });
  });

  // ---- packages (apt/dnf) ----
  app.get('/packages', { preHandler: [opts.authMw, requireRole('user')] }, async (req) => {
    const q = String(req.query?.q || '');
    if (q && !/^[a-z0-9.\-+_]+$/i.test(q)) return { ok: true, packages: [] };
    const apt = (await system.run('which', ['apt-get'])).ok;
    let out;
    if (apt) {
      const r = await system.run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Status}\n']);
      out = r.ok ? r.stdout.split('\n').filter(Boolean).map(l => { const [n, v, s] = l.split('\t'); return { name: n, version: v, status: s }; }) : [];
    } else {
      const r = await system.run('rpm', ['-qa', '--queryformat', '%{NAME}\t%{VERSION}-%{RELEASE}\n']);
      out = r.ok ? r.stdout.split('\n').filter(Boolean).map(l => { const [n, v] = l.split('\t'); return { name: n, version: v, status: 'installed' }; }) : [];
    }
    const filtered = q ? out.filter(p => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 200) : out.slice(0, 500);
    return { ok: true, backend: apt ? 'apt' : 'dnf', packages: filtered };
  });

  app.post('/packages/:action', { preHandler: [opts.authMw, requireRole('admin')] }, async (req, reply) => {
    const { action } = req.params; // install | remove | update | upgrade
    const pkgs = (req.body?.packages || []).filter(p => /^[a-z0-9.\-+_]+$/i.test(p)).slice(0, 50);
    const apt = (await system.run('which', ['apt-get'])).ok;
    let r;
    if (action === 'update') {
      r = await system.run('sudo', ['-n', apt ? 'apt-get' : 'dnf', apt ? 'update' : 'check-update'], { timeout: 120000 });
    } else if (action === 'install' || action === 'remove') {
      if (!pkgs.length) return reply.code(400).send({ error: 'no packages' });
      const tool = apt ? 'apt-get' : 'dnf';
      const sub = action === 'install' ? 'install' : apt ? 'remove' : 'remove';
      r = await system.run('sudo', ['-n', tool, sub, '-y'].concat(pkgs), { timeout: 300000 });
    } else if (action === 'upgrade') {
      r = await system.run('sudo', ['-n', apt ? 'apt-get' : 'dnf', apt ? 'upgrade' : 'upgrade', apt ? '-y' : '-y'], { timeout: 300000 });
    } else {
      return reply.code(400).send({ error: 'invalid action' });
    }
    db.audit(req.user.id, 'package.' + action, pkgs.join(','), r.ok ? 'ok' : 'fail', {}, clientIp(req.raw || req));
    return r.ok ? { ok: true, output: (r.stdout || '').slice(-4000) } : reply.code(400).send({ error: (r.stderr || r.stdout || 'failed').slice(-2000) });
  });

  // ---- cron jobs ----
  app.get('/cron', { preHandler: [opts.authMw, requireRole('user')] }, async (req) => {
    const r = await system.run('crontab', ['-l']);
    const jobs = r.ok ? r.stdout.split('\n').filter(l => l.trim() && !l.startsWith('#')).map((l, i) => ({ id: 'job-' + i, line: l })) : [];
    return { ok: true, jobs, raw: r.ok ? r.stdout : '' };
  });

  app.post('/cron', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const { schedule, command } = req.body || {};
    if (!/^[*\/\d,\s-]+$/.test(String(schedule || '')) || !schedule.trim()) return reply.code(400).send({ error: 'invalid cron schedule' });
    const cmd = String(command || '').replace(/[\n\r]/g, ' ').slice(0, 500);
    if (!cmd) return reply.code(400).send({ error: 'empty command' });
    const cur = await system.run('crontab', ['-l']);
    if (!cur.ok && /not found/i.test(cur.stderr || '')) {
      return reply.code(400).send({ error: 'crontab is not installed (apt-get install cron)' });
    }
    const base = cur.ok ? cur.stdout : '';
    const line = `${schedule.trim()} ${cmd}\n`;
    // write via stdin and check the exit code - never report success on failure
    const { execFile } = require('child_process');
    const written = await new Promise((resolve) => {
      const cp = execFile('crontab', ['-'], (err, so, se) => resolve({ ok: !err, err: se || '' }));
      cp.stdin.end(base + line);
    });
    if (!written.ok) {
      db.audit(req.user.id, 'cron.add', cmd, 'fail', {}, clientIp(req.raw || req));
      return reply.code(400).send({ error: `could not write crontab: ${written.err.trim() || 'unknown error'}` });
    }
    db.audit(req.user.id, 'cron.add', cmd, 'ok');
    return { ok: true, line };
  });

  app.delete('/cron/:id', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const idx = parseInt(String(req.params.id).replace('job-', ''), 10);
    const cur = await system.run('crontab', ['-l']);
    if (!cur.ok) return reply.code(400).send({ error: 'no crontab' });
    const lines = cur.stdout.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) return reply.code(400).send({ error: 'invalid job id' });
    const removed = lines.splice(idx, 1)[0];
    const { execFile } = require('child_process');
    const written = await new Promise((resolve) => {
      const cp = execFile('crontab', ['-'], (err, so, se) => resolve({ ok: !err, err: se || '' }));
      cp.stdin.end(lines.join('\n') + '\n');
    });
    if (!written.ok) return reply.code(400).send({ error: `could not write crontab: ${written.err.trim()}` });
    db.audit(req.user.id, 'cron.remove', removed, 'ok');
    return { ok: true };
  });

  // ---- logs ----
  app.get('/system/logs', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const { unit, path, lines = 200, follow = '0' } = req.query || {};
    const n = Math.min(parseInt(lines, 10) || 200, 5000);
    if (unit) {
      if (!/^[a-zA-Z0-9@._-]+$/.test(unit)) return reply.code(400).send({ error: 'invalid unit' });
      const r = await system.run('journalctl', ['-u', unit, '-n', String(n), '--no-pager']);
      return { ok: r.ok, source: `journalctl -u ${unit}`, content: r.ok ? r.stdout : r.stderr };
    }
    if (path) {
      // path jail: only allow known log locations
      const allowed = ['/var/log/', '/opt/vps-panel/'];
      if (!allowed.some(a => path.startsWith(a))) return reply.code(400).send({ error: 'path not allowed (only /var/log/* and panel dir)' });
      const fs = require('fs');
      try {
        const content = fs.readFileSync(path, 'utf8').split('\n').slice(-n).join('\n');
        return { ok: true, source: path, content };
      } catch (e) {
        return reply.code(400).send({ error: 'cannot read file' });
      }
    }
    const r = await system.run('journalctl', ['-n', String(n), '--no-pager']);
    return { ok: r.ok, source: 'journalctl', content: r.ok ? r.stdout : r.stderr };
  });

  // ---- realtime log tail via SSE (no WS overhead) ----
  app.get('/system/logs/tail/:unit', { preHandler: [opts.authMw, requireRole('user')] }, async (req, reply) => {
    const unit = req.params.unit;
    if (!/^[a-zA-Z0-9@._-]+$/.test(unit)) return reply.code(400).send({ error: 'invalid unit' });
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const { spawn } = require('child_process');
    const p = spawn('journalctl', ['-u', unit, '-f', '--no-pager']);
    p.stdout.on('data', d => reply.raw.write(`data: ${d.toString()}\n\n`));
    p.stderr.on('data', d => reply.raw.write(`data: ${d.toString()}\n\n`));
    req.raw.on('close', () => p.kill());
  });
}

function readOsRelease() {
  try {
    const fs = require('fs');
    const s = fs.readFileSync('/etc/os-release', 'utf8');
    const o = {};
    for (const line of s.split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m) o[m[1]] = m[2].replace(/"/g, '');
    }
    return o;
  } catch { return {}; }
}

module.exports = systemRoutes;
