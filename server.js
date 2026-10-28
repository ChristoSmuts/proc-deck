#!/usr/bin/env node
// ProcDeck: see and stop the processes your dev tools and AI agents leave behind.
// Runs on macOS, Linux and Windows with no npm dependencies. On macOS and Linux it
// shells out to ps and lsof (falling back to ss on Linux) and reads /proc directly
// where it can. On Windows it asks a long-running PowerShell helper and netstat.

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
const IS_WIN = process.platform === 'win32';
if (!IS_LINUX && !IS_MAC && !IS_WIN) {
  console.error(`ProcDeck runs on macOS, Linux and Windows. It does not support ${process.platform}.`);
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
const MY_UID = IS_WIN ? null : process.getuid(); // Windows has no numeric UIDs
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

// PID 1 is init on macOS and Linux. On Windows, 0 is the idle process and 4 is the kernel.
const isProtectedPid = (pid) => pid <= (IS_WIN ? 4 : 1);

// Opens a URL or folder with the desktop's default handler.
function openWithDesktop(target) {
  const cmd = IS_MAC ? 'open' : IS_WIN ? 'explorer.exe' : 'xdg-open';
  const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// ------------------------------------------------------- windows helper

// One PowerShell process serves every request, because starting a new one costs
// about a second. windows-helper.ps1 describes the line protocol.
let winHelper = null;

function startWinHelper() {
  const script = path.join(HERE, 'windows-helper.ps1').replace(/'/g, "''");
  // The execution policy blocks unsigned .ps1 files on many machines. It does not
  // apply to a script block made from the file's text.
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `& ([scriptblock]::Create([IO.File]::ReadAllText('${script}')))`],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const helper = { child, pending: [], buffer: '', stderr: '', alive: true };
  let markReady;
  helper.ready = new Promise((resolve) => (markReady = resolve));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    helper.buffer += chunk;
    let i;
    while ((i = helper.buffer.indexOf('\n')) >= 0) {
      const line = helper.buffer.slice(0, i).replace(/\r$/, '');
      helper.buffer = helper.buffer.slice(i + 1);
      if (line === 'ready') markReady();
      else helper.pending.shift()?.resolve(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (helper.stderr = (helper.stderr + chunk).slice(-4000)));
  const stop = (reason) => {
    if (!helper.alive) return;
    helper.alive = false;
    if (winHelper === helper) winHelper = null;
    const message = `The Windows helper stopped (${reason}). ${helper.stderr.trim()}`.trim();
    for (const p of helper.pending.splice(0)) p.reject(httpError(500, message));
    markReady();
  };
  child.on('error', (err) => stop(err.message));
  child.on('exit', (code) => stop(`exit code ${code}`));
  return helper;
}

async function winRequest(line) {
  if (!winHelper) winHelper = startWinHelper();
  const helper = winHelper;
  await helper.ready;
  if (!helper.alive) throw httpError(500, `The Windows helper did not start. ${helper.stderr.trim()}`);
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(httpError(504, 'The Windows helper did not answer within 20 seconds. ProcDeck restarts it on the next request.'));
      helper.child.kill();
    }, 20000);
    helper.pending.push({
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    helper.child.stdin.write(line + '\n');
  });
  const data = JSON.parse(reply);
  if (data && data.error) throw httpError(500, `Windows helper: ${data.error}`);
  return data;
}

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

// Windows command lines use backslashes and put quotes around paths with spaces,
// such as "C:\Program Files\nodejs\node.exe". Classification works on a copy with
// forward slashes, so the same regexes and path.posix calls serve every platform.
const matchArgsOf = (args) => (IS_WIN ? args.replace(/\\/g, '/') : args);

function tokenize(args) {
  if (!IS_WIN) return args.split(/\s+/).filter(Boolean);
  return (args.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/"/g, ''));
}

// "C:/x/Node.exe" gives "node" on Windows. Elsewhere it is a plain basename.
function progName(token) {
  const base = path.posix.basename(token || '');
  return IS_WIN ? base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() : base;
}

// Which programs a process "is": its executable, the first token of its command
// line and, for runtimes like node, the script it runs. Matching on these names
// instead of the raw command line stops a path like ~/projects/claude/ from
// being mistaken for the Claude CLI.
function commandNames(exe, args) {
  const tokens = tokenize(args);
  const names = new Set([exe, progName(tokens[0])]);
  if (RUNTIME_RE.test(exe) || RUNTIME_RE.test(progName(tokens[0]))) {
    const script = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (script) names.add(path.posix.basename(script).replace(/\.(m|c)?js$/, ''));
  }
  names.delete('');
  return names;
}

const AGENT_NAMES = ['claude', 'codex', 'aider'];
// The Claude desktop app on Windows (installer or Microsoft Store) runs as claude.exe,
// helper processes included. Without this check they all look like Claude Code.
const CLAUDE_DESKTOP_WIN_RE = /\/AnthropicClaude\/|\/WindowsApps\/Claude_/i;
const AGENT_PATH_RE = /node_modules\/@anthropic-ai\/claude-code\/|node_modules\/@openai\/codex\//;

// Checked against each ancestor, nearest first. The first hit is "who launched it",
// so a Vite server started by Claude Code inside a VS Code terminal reports Claude Code.
// `names` match program names exactly; `re` matches install paths that are unambiguous.
const ORIGINS = [
  { label: 'Claude app', kind: 'ai', re: CLAUDE_DESKTOP_WIN_RE },
  { label: 'Claude Code', kind: 'ai', names: ['claude'], re: /node_modules\/@anthropic-ai\/claude-code\// },
  { label: 'Claude app', kind: 'ai', re: /Claude\.app\// },
  { label: 'Codex', kind: 'ai', names: ['codex'], re: /node_modules\/@openai\/codex\// },
  { label: 'Aider', kind: 'ai', names: ['aider'] },
  { label: 'Cursor', kind: 'editor', names: ['cursor'], re: /Cursor\.app\/|\.cursor-server\/|\/Programs\/cursor\//i },
  { label: 'Windsurf', kind: 'editor', names: ['windsurf'], re: /Windsurf\.app\// },
  {
    label: 'VS Code',
    kind: 'editor',
    names: ['code', 'code-insiders'],
    re: /Visual Studio Code\.app\/|\/usr\/share\/code\/|\/snap\/code\/|\.vscode-server\/|\/Microsoft VS Code( Insiders)?\//,
  },
  { label: 'Zed', kind: 'editor', names: ['zed', 'zed-editor'], re: /Zed\.app\// },
  {
    label: 'JetBrains IDE',
    kind: 'editor',
    names: ['webstorm64', 'idea64', 'pycharm64', 'rider64', 'goland64', 'phpstorm64'],
    re: /\/(WebStorm|IntelliJ IDEA|PyCharm)[^/]*\.app\/|JetBrains\/Toolbox\/apps\/|\/Program Files\/JetBrains\//,
  },
  { label: 'tmux', kind: 'terminal', names: ['tmux', 'tmux:'] },
  {
    label: 'Terminal',
    kind: 'terminal',
    names: ['gnome-terminal-server', 'gnome-terminal', 'kitty', 'alacritty', 'wezterm-gui', 'ghostty', 'konsole',
      'xfce4-terminal', 'mate-terminal', 'tilix', 'terminator', 'foot', 'iTerm2', 'windowsterminal', 'mintty', 'conemu64'],
    re: /Terminal\.app\/|iTerm\.app\//,
  },
];

const matchesOrigin = (o, names, args) => (o.names || []).some((n) => names.has(n)) || (o.re ? o.re.test(args) : false);

function exeName(comm, args) {
  // macOS reports comm as the full executable path, which may contain spaces.
  // Linux reports a short name that programs can overwrite (npm sets "npm run dev").
  // Windows reports the image name, such as "node.exe".
  if (IS_WIN) return progName(comm) || progName(tokenize(args)[0]);
  const raw = IS_MAC ? path.basename(comm) : comm.split(' ')[0] || '';
  return raw || path.basename(args.split(/\s+/)[0] || '');
}

// Turns "node /x/node_modules/vite/bin/vite.js dev" into "vite dev".
function displayName(exe, args) {
  const tokens = tokenize(matchArgsOf(args));
  const first = progName(tokens[0]);
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
      // npx on Windows runs "node .../npm/bin/npx-cli.js <package>".
      if (/\/npm\/bin\/npx-cli\.js$/.test(t)) return ['npx', tokens[i + 1] || ''].join(' ').trim();
      // Windows shims run paths such as node_modules/.bin/../@playwright/mcp/cli.js.
      const pkg = (t.includes('/..') ? path.posix.normalize(t) : t).match(/node_modules\/(?:\.bin\/([^/]+)|((?:@[^/]+\/)?[^/]+)\/)/);
      if (pkg) return (pkg[1] || pkg[2].replace(/^@[^/]+\//, '')) + sub;
      const base = path.posix.basename(t).replace(/\.(m|c)?[jt]sx?$|\.py$|\.rb$|\.php$/, '');
      if (/^(index|server|main|app|cli|start|run)$/.test(base) && t.includes('/')) {
        return `${path.posix.basename(path.posix.dirname(t))}/${base}${sub}`;
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
      if (matchesOrigin(o, cur.names, cur.matchArgs)) return { label: o.label, kind: o.kind, pid: cur.pid, via: 'parent chain' };
    }
    if (isProtectedPid(cur.pid) || cur.ppid === cur.pid) break;
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
  if (env.WT_SESSION) return { label: 'Windows Terminal', kind: 'terminal' };
  return null;
}

function isOrphaned(p, map) {
  // Windows never re-parents. windowsProcesses() sets ppid to 0 when the parent is gone.
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

  if (IS_WIN) {
    const [v4, v6] = await Promise.all([sh('netstat', ['-ano', '-p', 'TCP']), sh('netstat', ['-ano', '-p', 'TCPv6'])]);
    if (v4 === null) return { byPid, tool: null };
    // Windows translates the state column ("LISTENING") on non-English systems.
    // A listening socket is the only kind with an all-zero foreign address.
    for (const line of `${v4}\n${v6 || ''}`.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length === 5 && /^TCP/i.test(cols[0]) && /^(0\.0\.0\.0|\[::\]):0$/.test(cols[2])) {
        add(Number(cols[4]), cols[1]);
      }
    }
    return { byPid, tool: 'netstat' };
  }
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
  if (IS_WIN) {
    for (const [pid, cwd] of Object.entries(await winRequest(`cwd ${pids.join(' ')}`))) out.set(Number(pid), cwd);
    return out;
  }
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

// Returns a Map of pid to environment object. PIDs we can't read are left out.
async function readEnvs(pids) {
  const out = new Map();
  if (IS_WIN) {
    if (!pids.length) return out;
    for (const [pid, block] of Object.entries(await winRequest(`env ${pids.join(' ')}`))) {
      out.set(Number(pid), toEnvObject(block.split('\0')));
    }
    return out;
  }
  await Promise.all(
    pids.map(async (pid) => {
      const env = await readEnv(pid);
      if (env) out.set(pid, env);
    }),
  );
  return out;
}

async function readEnv(pid) {
  if (IS_WIN) return (await readEnvs([pid])).get(pid) || null;
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

// Each collector returns one row per process:
// { pid, ppid, uid, user, mine, cpu, mem, rssKb, ageSec, stat, args, comm, exePath }
async function posixProcesses() {
  const [psOut, metaOut] = await Promise.all([
    sh('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,pcpu=,pmem=,rss=,etime=,stat=,args=']),
    sh('ps', ['-A', '-o', 'pid=,user=,comm=']),
  ]);

  const meta = new Map();
  for (const line of (metaOut || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (m) meta.set(Number(m[1]), { user: m[2], comm: m[3].trim() });
  }

  const rows = [];
  for (const line of (psOut || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const info = meta.get(Number(m[1])) || { user: '', comm: '' };
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      user: info.user || m[3],
      mine: Number(m[3]) === MY_UID,
      cpu: Number(m[4]),
      mem: Number(m[5]),
      rssKb: Number(m[6]),
      ageSec: parseEtime(m[7]),
      stat: m[8],
      args: m[9] || `[${info.comm}]`,
      comm: info.comm,
      exePath: null,
    });
  }
  return rows;
}

// CPU time of each process at the previous snapshot, to work out recent CPU use.
let winCpuPrev = new Map();

async function windowsProcesses() {
  const list = await winRequest('list');
  const now = Date.now();
  const byPid = new Map(list.map((r) => [r.pid, r]));
  const totalMem = os.totalmem();
  const cpuNext = new Map();
  const rows = [];
  for (const r of list) {
    if (r.pid === 0) continue; // the idle process: its "CPU time" is idle time
    // Windows keeps the PID of a parent that has exited, and can give that PID to
    // a newer process. A parent that started after its child is a stranger.
    const parent = byPid.get(r.ppid);
    const ppid = parent && parent.start <= r.start && r.ppid !== r.pid ? r.ppid : 0;
    // Like Linux ps, 100% means one full core. Processes that are new since the
    // last snapshot get their lifetime average instead.
    const prev = winCpuPrev.get(r.pid);
    const cpuMs = r.cpu / 1e4; // WMI counts in 100 ns units
    const cpu =
      prev && prev.start === r.start && now > prev.at
        ? ((cpuMs - prev.cpuMs) / (now - prev.at)) * 100
        : r.start && now > r.start
          ? (cpuMs / (now - r.start)) * 100
          : 0;
    cpuNext.set(r.pid, { start: r.start, cpuMs, at: now });
    const owner = r.owner || '';
    const user = owner.split('\\').pop() || (r.session === 0 ? 'SYSTEM' : '?');
    rows.push({
      pid: r.pid,
      ppid,
      uid: null,
      user,
      mine: user.toLowerCase() === MY_USER.toLowerCase(),
      cpu: Math.max(0, Math.round(cpu * 10) / 10),
      mem: Math.round((r.ws / totalMem) * 1000) / 10,
      rssKb: Math.round(r.ws / 1024),
      ageSec: r.start ? Math.max(0, Math.round((now - r.start) / 1000)) : 0,
      stat: '', // Windows has no ps-style state letter
      args: r.cmd || `[${r.name}]`,
      comm: r.name || '',
      exePath: r.exe,
    });
  }
  winCpuPrev = cpuNext;
  return rows;
}

async function snapshot(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 1500) return cache;

  const [rows, portInfo] = await Promise.all([IS_WIN ? windowsProcesses() : posixProcesses(), listeningPorts()]);

  const map = new Map();
  const children = new Map();
  const helperPid = winHelper?.child.pid;
  for (const row of rows) {
    const { pid, ppid, args } = row;
    // Our own ps/lsof/netstat runs, the Windows helper and its console host.
    if (ppid === SELF_PID || (helperPid && ppid === helperPid)) continue;
    const matchArgs = matchArgsOf(args);
    const exe = exeName(row.comm, args);
    const p = {
      pid,
      ppid,
      uid: row.uid,
      user: row.user,
      mine: row.mine,
      cpu: row.cpu,
      mem: row.mem,
      rssKb: row.rssKb,
      ageSec: row.ageSec,
      stat: row.stat,
      args,
      exe,
      name: displayName(exe, args).slice(0, 48),
      ports: portInfo.byPid.get(pid) || [],
      cwd: null,
    };
    const names = commandNames(exe, matchArgs);
    if (IS_WIN && CLAUDE_DESKTOP_WIN_RE.test(matchArgs)) names.delete('claude');
    // Internal fields, not sent to the UI.
    Object.defineProperty(p, 'names', { value: names, enumerable: false });
    Object.defineProperty(p, 'matchArgs', { value: matchArgs, enumerable: false });
    Object.defineProperty(p, 'exePath', { value: row.exePath, enumerable: false });
    p.isAgent = AGENT_NAMES.some((n) => names.has(n)) || AGENT_PATH_RE.test(matchArgs);
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

  if (!IS_MAC) {
    // Reading the environment is cheap on Linux and Windows, so use it to label orphans too.
    for (const [pid, env] of await readEnvs(interesting)) {
      const p = map.get(pid);
      const fromEnv = originFromEnv(env);
      if (fromEnv && (!p.origin || (fromEnv.kind === 'ai' && p.origin.kind !== 'ai'))) {
        p.origin = { ...fromEnv, pid: null, via: 'environment' };
      }
    }
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
  // Windows has no supported way to see where another process's handles point.
  // An empty list tells the UI to say so.
  if (IS_WIN) return result;
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
  if (IS_WIN) return p.exePath;
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
    if (isProtectedPid(cur.pid)) break;
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
  if (IS_WIN) {
    throw httpError(501, 'Windows has no built-in way to list the files another process has open. Use Resource Monitor or Sysinternals Process Explorer.');
  }
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
    if (!Number.isInteger(pid) || isProtectedPid(pid)) {
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
      if (!isProtectedPid(id) && id !== SELF_PID && !seen.has(id)) {
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
    // Give SIGTERM handlers a moment to close servers and flush logs. On Windows
    // every signal ends the process at once, so there is nothing to wait for.
    await sleep(signal === 'SIGKILL' || IS_WIN ? 500 : 1500);
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
  openWithDesktop(cwd);
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
          throw httpError(
            403,
            IS_WIN
              ? "Can't read this process's environment. It probably belongs to another user, runs as administrator, or is a 32-bit program."
              : "Can't read this process's environment. It probably belongs to another user.",
          );
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
  if (!NO_OPEN) openWithDesktop(url);
  // Start the Windows helper now, so its one-time compile does not delay the first page load.
  if (IS_WIN) winRequest('list').catch((err) => console.error(err.message));
});
