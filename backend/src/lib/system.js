// lib/system.js - Real system introspection: CPU/mem/disk/process/service/network (reads /proc, no fake data)
'use strict';
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

function cpuInfo() {
  const stat = safe(() => fs.readFileSync('/proc/stat', 'utf8'), '');
  const lines = stat.split('\n').filter(l => l.startsWith('cpu'));
  const cpus = lines.map(l => {
    const p = l.trim().split(/\s+/);
    const name = p[0];
    const v = p.slice(1).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    return { name, user: v[0], nice: v[1], system: v[2], idle, total };
  });
  return cpus;
}

// delta-based CPU usage %
let lastCpu = null;
function cpuUsage() {
  const cpus = cpuInfo();
  if (!lastCpu) { lastCpu = cpus; return { usage: 0, perCore: cpus.map(() => 0) }; }
  const perCore = cpus.map((c, i) => {
    const p = lastCpu[i];
    if (!p) return 0;
    const dt = c.total - p.total;
    if (dt <= 0) return 0;
    return Math.min(100, ((c.total - c.idle - (p.total - p.idle)) / dt) * 100);
  });
  lastCpu = cpus;
  const agg = perCore.reduce((a, b) => a + b, 0) / (perCore.length || 1);
  return { usage: Math.round(agg * 10) / 10, perCore: perCore.map(x => Math.round(x * 10) / 10) };
}

function memInfo() {
  const mi = safe(() => fs.readFileSync('/proc/meminfo', 'utf8'), '');
  const m = {};
  for (const line of mi.split('\n')) {
    const mm = line.match(/^(\w+):\s+(\d+) kB/);
    if (mm) m[mm[1]] = parseInt(mm[2], 10) * 1024;
  }
  const total = m.MemTotal || os.totalmem();
  const avail = m.MemAvailable || (total - (m.MemFree || 0));
  const used = total - avail;
  const swapTotal = m.SwapTotal || 0;
  const swapFree = m.SwapFree || 0;
  return {
    total, used, available: avail, usage: total ? (used / total) * 100 : 0,
    swapTotal, swapUsed: swapTotal - swapFree, swapUsage: swapTotal ? ((swapTotal - swapFree) / swapTotal) * 100 : 0,
  };
}

function diskInfo() {
  return safe(() => {
    const df = fs.readFileSync('/proc/mounts', 'utf8');
    const seen = new Set();
    const disks = [];
    for (const line of df.split('\n')) {
      const [dev, mount, fstype] = line.split(' ');
      if (!dev || seen.has(dev) || !dev.startsWith('/')) continue;
      if (['proc', 'sysfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'mqueue', 'overlay', 'shm'].includes(fstype)) continue;
      if (mount.startsWith('/proc') || mount.startsWith('/sys') || mount.startsWith('/dev')) continue;
      seen.add(dev);
      try {
        const st = fs.statfsSync(mount);
        const total = st.blocks * st.bsize;
        const free = st.bfree * st.bsize;
        disks.push({ device: dev, mount, fs: fstype, total, used: total - free, usage: total ? ((total - free) / total) * 100 : 0 });
      } catch { /* skip */ }
    }
    return disks;
  }, []);
}

function loadAvg() {
  const l = safe(() => fs.readFileSync('/proc/loadavg', 'utf8'), '0 0 0');
  const [a, b, c] = l.split(' ').map(Number);
  return { '1m': a, '5m': b, '15m': c };
}

function uptime() {
  const u = safe(() => parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]), os.uptime());
  return Math.round(u);
}

function processList() {
  return safe(() => {
    const out = [];
    const statFiles = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
    for (const pid of statFiles) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const open = stat.indexOf('(');
        const close = stat.lastIndexOf(')');
        const comm = stat.slice(open + 1, close);
        const rest = stat.slice(close + 2).split(' ');
        const ppid = parseInt(rest[1], 10);
        const utime = parseInt(rest[11], 10);
        const stime = parseInt(rest[12], 10);
        const rssPages = parseInt(rest[21], 10) || 0;
        let cmd = comm;
        try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || comm; } catch { /* kernel thread */ }
        out.push({
          pid: parseInt(pid, 10), ppid, name: comm, cmd: cmd.slice(0, 512),
          cpu: (utime + stime) * (100 / os.cpus().length), // jiffies, relative
          mem: rssPages * 4096,
          user: safe(() => fs.statSync(`/proc/${pid}`).uid, 0),
        });
      } catch { /* process gone */ }
    }
    return out.sort((a, b) => b.cpu - a.cpu).slice(0, 500);
  }, []);
}

function usersOnline() {
  return safe(() => {
    const w = fs.readFileSync('/var/run/utmp', 'utf8');
    return []; // utmp parsing is fragile; use who command instead
  }, []);
}

async function run(cmd, args = [], opts = {}) {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 1024 * 1024, env: { ...process.env, LANG: 'C' } });
    return { ok: true, stdout: stdout.toString() };
  } catch (e) {
    return { ok: false, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString(), code: e.code };
  }
}

async function services() {
  // real systemctl list-units
  const r = await run('systemctl', ['list-units', '--type=service', '--no-legend', '--no-pager', '--plain']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const p = line.trim().split(/\s+/);
    return { unit: p[0], active: p[2], sub: p[3], desc: p.slice(4).join(' ') };
  });
}

async function serviceAction(name, action) {
  if (!/^[a-zA-Z0-9@._-]+$/.test(name)) return { ok: false, error: 'invalid unit name' };
  if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'status'].includes(action)) return { ok: false, error: 'invalid action' };
  if (action === 'status') {
    const r = await run('systemctl', ['status', name, '--no-pager']);
    return { ok: r.ok, output: r.stdout + r.stderr };
  }
  const r = await run('sudo', ['-n', 'systemctl', action, name]);
  return r.ok ? { ok: true, output: r.stdout } : { ok: false, error: r.stderr || 'need sudo (panel service must run with sudo -n for systemctl)' };
}

async function networkInfo() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      list.push({ name, family: a.family, address: a.address, internal: a.internal, mac: a.mac });
    }
  }
  const ss = await run('ss', ['-tuln']);
  const ports = ss.ok ? ss.stdout.split('\n').slice(1).filter(Boolean).map(l => l.trim().split(/\s+/)) : [];
  return { interfaces: list, listening: ports };
}

module.exports = { cpuUsage, cpuInfo, memInfo, diskInfo, loadAvg, uptime, processList, services, serviceAction, networkInfo, run };
