# ProcDeck

A local web UI for the processes your dev tools leave behind: Vite and Next servers you forgot about, watchers started by an AI agent that has since exited, and whatever is sitting on port 3000.

It runs on macOS, Linux (WSL too) and Windows 10 or newer. It needs Node 18 or newer and has no npm dependencies.

## Run it

```bash
node server.js            # opens http://127.0.0.1:4949 in your browser
node server.js --port 5050
node server.js --no-open
```

Or `npm link` once in this folder, then run `procdeck` from anywhere.

On Linux, install `lsof` if it's missing (`sudo apt install lsof`). Without it ProcDeck falls back to `ss` for ports. macOS ships with `lsof`.

On Windows, ProcDeck uses the built-in Windows PowerShell 5.1 and `netstat`, so there is nothing to install. At startup it starts one hidden PowerShell process (`windows-helper.ps1`) and keeps it running. The first refresh takes a few seconds while that helper compiles its C# code. The helper reads the process list from WMI and reads the working folder and environment of each process directly from its memory. It stops when ProcDeck stops.

## What it shows

- Every process, filtered to dev tools by default (node, bun, deno, npm/pnpm/yarn, python, vite, esbuild, claude, codex and friends). Other filters: listening on ports, orphaned, from AI sessions, all of mine, everything.
- Friendly names: `node …/node_modules/vite/bin/vite.js dev` shows as `vite dev`.
- Ports, working folder, CPU, memory and how long it has been running.
- **Started from**: walks the parent chain to the nearest editor, terminal or agent (Claude Code, Codex, Cursor, VS Code, tmux, a terminal app). On Linux and Windows it also checks environment variables such as `CLAUDECODE=1`, so it can still label an orphan whose parent has exited.
- **Orphaned**: dev processes whose parent is gone (re-parented to PID 1 or `systemd --user`, or on Windows, a parent PID that no longer exists or now belongs to a newer process). These are the usual leftovers.

Click a row for the detail panel: full command, folder, ports (with links), the ancestry chain, children, where stdout/stderr go (and the last lines when they go to a file), environment variables with secrets masked, and open files.

## Stopping things

- **Stop** sends SIGTERM. **Stop with children** signals the whole tree, parent first, so supervisors like nodemon don't restart what you just killed. **Force kill** sends SIGKILL.
- Every action goes through a confirmation dialog that lists exactly what will be signalled and warns about: processes that aren't recognised dev tools, the terminal running ProcDeck itself, other users' processes, running AI agent sessions, children left behind, and ports that will be freed. The riskier warnings need a tick before the button unlocks.
- If something ignores SIGTERM you get a toast offering to force kill it.
- The server re-checks each PID's command line before signalling, so a PID that was reused by a different process in the meantime is skipped.
- PID 1 (PIDs 0 and 4 on Windows) and ProcDeck itself are never signalled.
- On Windows, **Stop** and **Force kill** do the same thing: they end the process immediately. Windows has no SIGTERM, and console programs such as Node can't receive a clean-shutdown request from another process. The confirmation dialog says this.

Keyboard: `/` search, `r` refresh, `Delete` stop the selection, `Esc` close. Typing `:3000` in search finds whatever holds that port.

## Security

The server binds to 127.0.0.1 only. Every API call needs a random token that is generated at startup and embedded in the page, and requests with a foreign `Host` header are refused. That stops other websites open in your browser (including DNS-rebinding tricks) from calling the kill endpoint.

It runs with your user's permissions. It can't stop root-owned processes unless you run it with sudo, and you shouldn't need to. On Windows the same applies to processes that run as administrator or as SYSTEM.

## Limits

- macOS: environment variables come from `ps -E`, which only works for your own processes and may split oddly when values contain spaces. Origin detection there relies on the parent chain alone.
- Output that went to a terminal or a pipe can't be read back. Only output redirected to a file can.
- Windows:
  - ProcDeck can't show where stdout and stderr go, or list open files. Windows has no supported way to read another process's handles. Use Resource Monitor or Sysinternals Process Explorer for those.
  - The working folder and environment are readable only for your own 64-bit processes that don't run as administrator. 32-bit programs show neither.
  - There is no process state (running, paused), so the State row is hidden.
  - CPU is the average since the previous refresh, where 100% is one full core, like Linux `ps`.

## Files

- `server.js`: HTTP server and all process inspection
- `index.html`: the whole UI (vanilla JS, no build step)
- `windows-helper.ps1`: the PowerShell and C# helper that `server.js` uses on Windows
