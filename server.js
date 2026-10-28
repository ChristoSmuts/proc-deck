#!/usr/bin/env node
// ProcDeck: see and stop the processes your dev tools and AI agents leave behind.
// Runs on macOS and Linux with no npm dependencies. It shells out to ps and lsof
// (falling back to ss on Linux) and reads /proc directly where it can.

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';
if (!IS_LINUX && !IS_MAC) {
  console.error('ProcDeck runs on macOS and Linux (WSL included). Native Windows is not supported.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const PORT = Number(argValue('--port') || process.env.PROCDECK_PORT || 4949);
const HOST = '127.0.0.1';
const NO_OPEN = argv.includes('--no-open');
// Every API call has to carry this token. Without it, any web page open in your
// browser could POST to 127.0.0.1:4949/api/kill and stop your processes.
const TOKEN = crypto.randomBytes(24).toString('hex');
const SELF_PID = process.pid;
const MY_UID = process.getuid();
const MY_USER = os.userInfo().username;
const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- helpers

async function sh(cmd, args) {
  try {
    const { stdout } = await execFileP(cmd, args, {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' }, // keeps decimal points as "." in ps output
    });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') return null; // tool not installed
    // lsof exits 1 when nothing matches and ps does the same for a vanished PID.
    // The output is still usable, so hand it back.
    return typeof err.stdout === 'string' ? err.stdout : '';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ps prints elapsed time as [[dd-]hh:]mm:ss. macOS has no etimes, so parse it.
function parseEtime(s) {
  let days = 0;
  if (s.includes('-')) {
    const [d, rest] = s.split('-');
    days = Number(d);
    s = rest;
  }
  const parts = s.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// ---------------------------------------------------------- classification

const RUNTIME_RE = /^(node|nodejs|bun|deno|python[\d.]*|ruby|php)$/;
const PKG_MANAGER_RE = /^(npm|npx|pnpm|pnpx|yarn|bunx)$/;
const DEV_RE =
  /^(node|nodejs|bun|bunx|deno|npm|npx|pnpm|pnpx|yarn|tsx|ts-node|esbuild|vite|nodemon|next-server|turbo|nx|ng|python[\d.]*|uvicorn|gunicorn|flask|ruby|rails|puma|php|cargo|dotnet|hugo|air|watchman|claude|codex|aider)$/;
const SUBCOMMAND_RE = /^(dev|serve|start|build|watch|preview|run|test|exec)$/;

// Which programs a process "is": its executable, the first token of its command
// line and, for runtimes like node, the script it runs. Matching on these names
// instead of the raw command line stops a path like ~/projects/claude/ from
// being mistaken for the Claude CLI.
function commandNames(exe, args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  const names = new Set([exe, path.basename(tokens[0] || '')]);
  if (RUNTIME_RE.test(exe) || RUNTIME_RE.test(path.basename(tokens[0] || ''))) {
    const script = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (script) names.add(path.basename(script).replace(/\.(m|c)?js$/, ''));
  }
  names.delete('');
  return names;
}

const AGENT_NAMES = ['claude', 'codex', 'aider'];
const AGENT_PATH_RE = /node_modules\/@anthropic-ai\/claude-code\/|node_modules\/@openai\/codex\//;

// Checked against each ancestor, nearest first. The first hit is "who launched it",
// so a Vite server started by Claude Code inside a VS Code terminal reports Claude Code.
// `names` match program names exactly; `re` matches install paths that are unambiguous.
const ORIGINS = [
  { label: 'Claude Code', kind: 'ai', names: ['claude'], re: /node_modules\/@anthropic-ai\/claude-code\// },
  { label: 'Claude app', kind: 'ai', re: /Claude\.app\// },
  { label: 'Codex', kind: 'ai', names: ['codex'], re: /node_modules\/@openai\/codex\// },
  { label: 'Aider', kind: 'ai', names: ['aider'] },
  { label: 'Cursor', kind: 'editor', names: ['cursor'], re: /Cursor\.app\/|\.cursor-server\// },
  { label: 'Windsurf', kind: 'editor', names: ['windsurf'], re: /Windsurf\.app\// },
  {
    label: 'VS Code',
    kind: 'editor',
    names: ['code', 'code-insiders'],
    re: /Visual Studio Code\.app\/|\/usr\/share\/code\/|\/snap\/code\/|\.vscode-server\//,
  },
  { label: 'Zed', kind: 'editor', names: ['zed', 'zed-editor'], re: /Zed\.app\// },
  { label: 'JetBrains IDE', kind: 'editor', re: /\/(WebStorm|IntelliJ IDEA|PyCharm)[^/]*\.app\/|JetBrains\/Toolbox\/apps\// },
  { label: 'tmux', kind: 'terminal', names: ['tmux', 'tmux:'] },
  {
    label: 'Terminal',
    kind: 'terminal',
    names: ['gnome-terminal-server', 'gnome-terminal', 'kitty', 'alacritty', 'wezterm-gui', 'ghostty', 'konsole',
      'xfce4-terminal', 'mate-terminal', 'tilix', 'terminator', 'foot', 'iTerm2'],
    re: /Terminal\.app\/|iTerm\.app\//,
  },
];

const matchesOrigin = (o, names, args) => (o.names || []).some((n) => names.has(n)) || (o.re ? o.re.test(args) : false);

function exeName(comm, args) {
  // macOS reports comm as the full executable path, which may contain spaces.
  // Linux reports a short name that programs can overwrite (npm sets "npm run dev").
  const raw = IS_MAC ? path.basename(comm) : comm.split(' ')[0] || '';
  return raw || path.basename(args.split(/\s+/)[0] || '');
}

// Turns "node /x/node_modules/vite/bin/vite.js dev" into "vite dev".
function displayName(exe, args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  const first = path.basename(tokens[0] || '');
  if (PKG_MANAGER_RE.test(exe) || PKG_MANAGER_RE.test(first)) {
    const pm = PKG_MANAGER_RE.test(exe) ? exe : first;
    return [pm, ...tokens.slice(1, 3).filter((t) => !t.includes('/'))].join(' ');
  }
  if (RUNTIME_RE.test(exe) || RUNTIME_RE.test(first)) {
    const runtime = RUNTIME_RE.test(exe) ? exe : first;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-e' || t === '--eval' || t === '-p' || t === '-c') return `${runtime} ${t}`;
      if (t === '-m') return `${runtime} -m ${tokens[i + 1] || ''}`.trim();
      if (/^(-r|--require|--import|--loader)$/.test(t)) {
        i++;
        continue;
      }
      if (t.startsWith('-')) continue;
      const sub = SUBCOMMAND_RE.test(tokens[i + 1] || '') ? ` ${tokens[i + 1]}` : '';
      const pkg = t.match(/node_modules\/(?:\.bin\/([^/]+)|((?:@[^/]+\/)?[^/]+)\/)/);
      if (pkg) return (pkg[1] || pkg[2].replace(/^@[^/]+\//, '')) + sub;
      const base = path.basename(t).replace(/\.(m|c)?[jt]sx?$|\.py$|\.rb$|\.php$/, '');
      if (/^(index|server|main|app|cli|start|run)$/.test(base) && t.includes('/')) {
        return `${path.basename(path.dirname(t))}/${base}${sub}`;
      }
      return base + sub;
    }
    return runtime;
  }
  return exe || first || '?';
}

function originFromAncestors(p, map) {
  let cur = map.get(p.ppid);
  for (let hops = 0; cur && hops < 64; hops++) {
    for (const o of ORIGINS) {
      if (matchesOrigin(o, cur.names, cur.args)) return { label: o.label, kind: o.kind, pid: cur.pid, via: 'parent chain' };
    }
    if (cur.pid <= 1 || cur.ppid === cur.pid) break;
    cur = map.get(cur.ppid);
  }
  return null;
}

// Environment variables survive after the parent dies, so they can still say
// where an orphan came from. Claude Code sets CLAUDECODE=1 in the shells it spawns.
function originFromEnv(env) {
  if (!env) return null;
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return { label: 'Claude Code', kind: 'ai' };
  if (env.CURSOR_TRACE_ID) return { label: 'Cursor', kind: 'editor' };
  if (env.TERM_PROGRAM === 'vscode') return { label: 'VS Code', kind: 'editor' };
  if (env.TMUX) return { label: 'tmux', kind: 'terminal' };
  if (env.TERM_PROGRAM) return { label: env.TERM_PROGRAM.replace(/\.app$/, ''), kind: 'terminal' };
  return null;
}

function isOrphaned(p, map) {
  if (p.ppid <= 1) return true;
  const parent = map.get(p.ppid);
  if (!parent) return true;
  // Linux desktops re-parent orphans to the per-user systemd, not to PID 1.
  return /systemd --user|(^|\/)init(\s|$)/.test(parent.args);
}

// ------------------------------------------------------------- collectors

async function listeningPorts() {
  const byPid = new Map();
  const add = (pid, addr) => {
    const i = addr.lastIndexOf(':');
    const port = Number(addr.slice(i + 1));
    if (!pid || !Number.isInteger(port) || port <= 0) return;
    const host = addr.slice(0, i) || '*';
    const list = byPid.get(pid) || [];
    if (!list.some((x) => x.port === port && x.host === host)) list.push({ port, host });
    byPid.set(pid, list);
  };

  const out = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  if (out !== null) {
    let pid = 0;
    for (const line of out.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n') add(pid, line.slice(1));
    }
    return { byPid, tool: 'lsof' };
  }
  if (IS_LINUX) {
    const ss = await sh('ss', ['-Hltnp']);
    if (ss !== null) {
      for (const line of ss.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        for (const m of line.matchAll(/pid=(\d+)/g)) add(Number(m[1]), cols[3]);
      }
      return { byPid, tool: 'ss' };
    }
  }
  return { byPid, tool: null };
}

async function cwdMap(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (IS_LINUX) {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          out.set(pid, await fs.readlink(`/proc/${pid}/cwd`));
        } catch {
          // another user's process, or it already exited
        }
      }),
    );
    return out;
  }
  const res = await sh('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  let pid = 0;
  for (const line of (res || '').split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

function toEnvObject(entries) {
  const env = {};
  for (const e of entries) {
    const i = e.indexOf('=');
    if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
  }
  return env;
}

async function readEnv(pid) {
  if (IS_LINUX) {
    try {
      return toEnvObject((await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0'));
    } catch {
      return null;
    }
  }
  // macOS: `ps -E` appends the environment to the command line. It only works for
  // your own processes, and splitting is best effort since both are space-separated.
  const [plain, withEnv] = await Promise.all([
    sh('ps', ['-ww', '-o', 'command=', '-p', String(pid)]),
    sh('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]),
  ]);
  const a = (plain || '').replace(/\n+$/, '');
  const b = (withEnv || '').replace(/\n+$/, '');
  if (!a || !b.startsWith(a) || b.length === a.length) return null;
  return toEnvObject(b.slice(a.length).trim().split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/));
}

// --------------------------------------------------------------- snapshot

let cache = null;

async function snapshot(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 1500) return cache;

  const [psOut, metaOut, portInfo] = await Promise.all([
    sh('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,pcpu=,pmem=,rss=,etime=,stat=,args=']),
    sh('ps', ['-A', '-o', 'pid=,user=,comm=']),
    listeningPorts(),
  ]);

  const meta = new Map();
  for (const line of (metaOut || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (m) meta.set(Number(m[1]), { user: m[2], comm: m[3].trim() });
  }

  const map = new Map();
  const children = new Map();
  for (const line of (psOut || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (ppid === SELF_PID) continue; // our own ps/lsof helpers
    const info = meta.get(pid) || { user: '', comm: '' };
    const args = m[9] || `[${info.comm}]`;
    const exe = exeName(info.comm, args);
    const p = {
      pid,
      ppid,
      uid: Number(m[3]),
      user: info.user || m[3],
      mine: Number(m[3]) === MY_UID,
      cpu: Number(m[4]),
      mem: Number(m[5]),
      rssKb: Number(m[6]),
      ageSec: parseEtime(m[7]),
      stat: m[8],
      args,
      exe,
      name: displayName(exe, args).slice(0, 48),
      ports: portInfo.byPid.get(pid) || [],
      cwd: null,
    };
    const names = commandNames(exe, args);
    Object.defineProperty(p, 'names', { value: names, enumerable: false }); // internal, not sent to the UI
    p.isAgent = AGENT_NAMES.some((n) => names.has(n)) || AGENT_PATH_RE.test(args);
    p.isDev = p.isAgent || [...names].some((n) => DEV_RE.test(n));
    map.set(pid, p);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }

  const interesting = [];
  for (const p of map.values()) {
    p.childCount = (children.get(p.pid) || []).length;
    p.origin = originFromAncestors(p, map);
    p.orphan = p.isDev && isOrphaned(p, map);
    if ((p.isDev || p.ports.length) && p.mine) interesting.push(p.pid);
  }

  const cwds = await cwdMap(interesting);
  for (const [pid, cwd] of cwds) map.get(pid).cwd = cwd;

  if (IS_LINUX) {
    // Reading /proc/<pid>/environ is cheap on Linux, so use it to label orphans too.
    await Promise.all(
      interesting.map(async (pid) => {
        const p = map.get(pid);
        const fromEnv = originFromEnv(await readEnv(pid));
        if (fromEnv && (!p.origin || (fromEnv.kind === 'ai' && p.origin.kind !== 'ai'))) {
          p.origin = { ...fromEnv, pid: null, via: 'environment' };
        }
      }),
    );
  }

  const selfAncestors = [];
  let cur = map.get(SELF_PID);
  while (cur && cur.ppid && !selfAncestors.includes(cur.ppid)) {
    selfAncestors.push(cur.ppid);
    cur = map.get(cur.ppid);
  }

  cache = { at: Date.now(), map, children, selfAncestors, portTool: portInfo.tool };
  return cache;
}

// Top-down order (parent before children), so a supervisor like nodemon is
// stopped before it gets a chance to restart the child we kill next.
function descendantsOf(snap, pid) {
  const out = [];
  const queue = [...(snap.children.get(pid) || [])];
  const seen = new Set([pid]);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(snap.children.get(id) || []));
  }
  return out;
}

// ------------------------------------------------------------------ detail

const STD_NAMES = ['stdin', 'stdout', 'stderr'];

async function describeTarget(fd, target, type) {
  const base = { fd, label: STD_NAMES[fd], target };
  if (!target) return { ...base, kind: 'unknown' };
  if (target === '/dev/null') return { ...base, kind: 'discarded' };
  if (/^\/dev\/(pts\/|tty)/.test(target)) return { ...base, kind: 'terminal' };
  if (/^pipe:|^->0x/.test(target) || type === 'PIPE') return { ...base, kind: 'pipe' };
  if (/^socket:/.test(target) || ['unix', 'IPv4', 'IPv6'].includes(type)) return { ...base, kind: 'socket' };
  if (target.endsWith(' (deleted)')) return { ...base, kind: 'deleted' };
  if (target.startsWith('/')) {
    try {
      const st = await fs.stat(target);
      if (st.isFile()) return { ...base, kind: 'file', size: st.size };
    } catch {
      // unreadable
    }
  }
  return { ...base, kind: 'other' };
}

async function stdioTargets(pid) {
  const result = [];
  if (IS_LINUX) {
    for (const fd of [0, 1, 2]) {
      let target = null;
      try {
        target = await fs.readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        // not ours, or closed
      }
      result.push(await describeTarget(fd, target, null));
    }
    return result;
  }
  const out = await sh('lsof', ['-a', '-p', String(pid), '-d', '0,1,2', '-Fftn']);
  const found = new Map();
  let fd = null;
  let type = null;
  for (const line of (out || '').split('\n')) {
    if (line[0] === 'f') {
      fd = Number(line.slice(1));
      type = null;
    } else if (line[0] === 't') type = line.slice(1);
    else if (line[0] === 'n' && fd !== null) found.set(fd, { name: line.slice(1), type });
  }
  for (const n of [0, 1, 2]) {
    const f = found.get(n);
    result.push(await describeTarget(n, f?.name ?? null, f?.type ?? null));
  }
  return result;
}

async function exePathOf(pid, p) {
  if (IS_LINUX) {
    try {
      return await fs.readlink(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }
  const out = await sh('ps', ['-o', 'comm=', '-p', String(pid)]);
  const comm = (out || '').trim();
  return comm.startsWith('/') ? comm : p.exe;
}

const brief = (p) => ({ pid: p.pid, name: p.name, args: p.args, user: p.user, isDev: p.isDev, isAgent: p.isAgent });

async function processDetail(pid) {
  const snap = await snapshot();
  const p = snap.map.get(pid);
  if (!p) return null;
  const ancestry = [];
  let cur = snap.map.get(p.ppid);
  while (cur && ancestry.length < 64) {
    ancestry.unshift(brief(cur));
    if (cur.pid <= 1) break;
    cur = snap.map.get(cur.ppid);
  }
  const kids = (snap.children.get(pid) || []).map((id) => snap.map.get(id)).filter(Boolean).map(brief);
  const [cwds, stdio, exePath] = await Promise.all([cwdMap([pid]), stdioTargets(pid), exePathOf(pid, p)]);
  return {
    process: p,
    ancestry,
    children: kids,
    descendantCount: descendantsOf(snap, pid).length,
    cwd: cwds.get(pid) || null,
    stdio,
    exePath,
    startedAt: new Date(Date.now() - p.ageSec * 1000).toISOString(),
    isSelf: pid === SELF_PID,
    isSelfAncestor: snap.selfAncestors.includes(pid),
  };
}

async function openFiles(pid) {
  const LIMIT = 500;
  const files = [];
  if (IS_LINUX) {
    let fds;
    try {
      fds = await fs.readdir(`/proc/${pid}/fd`);
    } catch {
      throw httpError(403, "Can't read this process's open files. It probably belongs to another user.");
    }
    for (const fd of fds.slice(0, LIMIT)) {
      let name = '?';
      try {
        name = await fs.readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        // closed while we were reading
      }
      const type = name.startsWith('socket:')
        ? 'socket'
        : name.startsWith('pipe:')
          ? 'pipe'
          : name.startsWith('anon_inode:')
            ? 'anon'
            : name.startsWith('/dev/')
              ? 'device'
              : 'file';
      files.push({ fd, type, name });
    }
    return { total: fds.length, files };
  }
  const out = await sh('lsof', ['-p', String(pid), '-Fftn']);
  let cur = null;
  for (const line of (out || '').split('\n')) {
    if (line[0] === 'f') {
      cur = { fd: line.slice(1), type: '', name: '' };
      files.push(cur);
    } else if (cur && line[0] === 't') cur.type = line.slice(1);
    else if (cur && line[0] === 'n') cur.name = line.slice(1);
  }
  return { total: files.length, files: files.slice(0, LIMIT) };
}

async function tailOutput(pid, fd) {
  const t = (await stdioTargets(pid)).find((x) => x.fd === fd);
  if (!t || t.kind !== 'file') {
    throw httpError(400, 'That stream is not a regular file, so there is nothing to read back.');
  }
  const fh = await fs.open(t.target, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let lines = buf
      .toString('utf8')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // strip colour codes from dev-server logs
      .split('\n');
    if (len < size) lines = lines.slice(1); // the first line was probably cut in half
    return { path: t.target, size, lines: lines.slice(-400) };
  } finally {
    await fh.close();
  }
}

const SECRET_KEY_RE =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|SIGNING|(^|_)DSN$|(^|_)AUTH(_|$)/i;
const looksSecret = (key, value) => SECRET_KEY_RE.test(key) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
const mask = (value) => (value ? `•••••••• (${value.length} chars)` : '');

// -------------------------------------------------------------------- kill

const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']);

async function killProcesses({ targets = [], signal = 'SIGTERM', tree = false, allowAncestors = false }) {
  if (!SIGNALS.has(signal)) throw httpError(400, `Unsupported signal ${signal}`);
  if (!Array.isArray(targets)) throw httpError(400, 'targets must be a list');
  const snap = await snapshot(true);
  const skipped = [];
  const order = [];
  const seen = new Set();

  for (const t of targets) {
    const pid = Number(t?.pid);
    const p = snap.map.get(pid);
    if (!Number.isInteger(pid) || pid <= 1) {
      skipped.push({ pid, reason: 'Protected system process' });
      continue;
    }
    if (pid === SELF_PID) {
      skipped.push({ pid, reason: 'That is ProcDeck itself. Stop it with Ctrl+C in its terminal.' });
      continue;
    }
    if (!p) {
      skipped.push({ pid, reason: 'Already gone' });
      continue;
    }
    // PIDs get reused. If this PID now runs a different command, leave it alone.
    if (typeof t.args === 'string' && t.args !== p.args) {
      skipped.push({ pid, reason: 'The PID now belongs to a different process' });
      continue;
    }
    if (snap.selfAncestors.includes(pid) && !allowAncestors) {
      skipped.push({ pid, reason: 'It is running ProcDeck and the warning was not confirmed' });
      continue;
    }
    for (const id of tree ? [pid, ...descendantsOf(snap, pid)] : [pid]) {
      if (id > 1 && id !== SELF_PID && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }

  const signalled = [];
  const errors = [];
  for (const pid of order) {
    try {
      process.kill(pid, signal);
      signalled.push(pid);
    } catch (e) {
      errors.push({
        pid,
        name: snap.map.get(pid)?.name,
        error:
          e.code === 'EPERM'
            ? 'Permission denied (owned by another user)'
            : e.code === 'ESRCH'
              ? 'Already gone'
              : e.message,
      });
    }
  }

  let survived = [];
  if (signalled.length) {
    // Give SIGTERM handlers a moment to close servers and flush logs.
    await sleep(signal === 'SIGKILL' ? 500 : 1500);
    const after = await snapshot(true);
    survived = signalled
      .map((pid) => after.map.get(pid))
      .filter((p) => p && !p.stat.startsWith('Z')) // zombies are dead, just not yet reaped
      .map((p) => ({ pid: p.pid, name: p.name, args: p.args }));
  }
  return { signal, signalled: signalled.length, survived, skipped, errors };
}

async function openFolder(pid) {
  const cwd = (await cwdMap([pid])).get(pid);
  if (!cwd) throw httpError(404, "Couldn't read that process's working directory.");
  const child = spawn(IS_MAC ? 'open' : 'xdg-open', [cwd], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { opened: cwd };
}

// -------------------------------------------------------------------- http

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1e6) throw httpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // Only answer to our own address. This stops a DNS-rebinding page from
    // loading the UI under its own hostname and reading the token out of it.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
      return sendJson(res, 403, { error: 'Unexpected Host header' });
    }
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = (await fs.readFile(path.join(HERE, 'index.html'), 'utf8')).replace('__PROCDECK_TOKEN__', TOKEN);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'",
      });
      return res.end(html);
    }

    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.headers['x-procdeck-token'] !== TOKEN) {
      return sendJson(res, 401, { error: 'Missing or wrong token. Reload the page.' });
    }

    const pid = Number(url.searchParams.get('pid'));
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/processes': {
        const snap = await snapshot();
        return sendJson(res, 200, {
          platform: process.platform,
          hostname: os.hostname(),
          user: MY_USER,
          home: HOME,
          selfPid: SELF_PID,
          selfAncestors: snap.selfAncestors,
          portTool: snap.portTool,
          generatedAt: snap.at,
          processes: [...snap.map.values()],
        });
      }
      case 'GET /api/process': {
        const detail = await processDetail(pid);
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'That process has exited.' });
      }
      case 'GET /api/env': {
        const env = await readEnv(pid);
        if (!env) {
          throw httpError(403, "Can't read this process's environment. It probably belongs to another user.");
        }
        const reveal = url.searchParams.get('reveal') === '1';
        const vars = Object.entries(env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => {
            const secret = looksSecret(key, value);
            return { key, secret, value: secret && !reveal ? mask(value) : value };
          });
        return sendJson(res, 200, { vars });
      }
      case 'GET /api/files':
        return sendJson(res, 200, await openFiles(pid));
      case 'GET /api/tail':
        return sendJson(res, 200, await tailOutput(pid, Number(url.searchParams.get('fd'))));
      case 'POST /api/kill':
        return sendJson(res, 200, await killProcesses(await readJson(req)));
      case 'POST /api/open': {
        const body = await readJson(req);
        return sendJson(res, 200, await openFolder(Number(body.pid)));
      }
      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    if (!err.status) console.error(err);
    sendJson(res, err.status || 500, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (is ProcDeck already running?). Try: node server.js --port ${PORT + 1}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`ProcDeck is running at ${url}  (PID ${SELF_PID}, Ctrl+C to stop)`);
  if (!NO_OPEN) {
    const child = spawn(IS_MAC ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
});
