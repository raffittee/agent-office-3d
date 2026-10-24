#!/usr/bin/env node
// Modeled on habblaud mod/habblaud-codex/hook.mjs (MIT, © 2026 Márcio Junior): the same safety rules.
// Shared kit for Agent Office's hook shims (hooks/<provider>.mjs), and a generic shim when run directly:
//
//   node "<agent-office>/hooks/shim.mjs" <provider>     # forwards stdin as-is to POST /api/hooks/<provider>
//
// Rules (CLAUDE.md › Hook shim rules):
// - plain Node ≥ 22, `node:*` imports only, no dependencies;
// - never break or slow the agent: every error means exit 0 with nothing on stdout (some CLIs feed stdout to the
//   model, and exit code 2 blocks the action); posting takes at most 1.5 s;
// - talk only to 127.0.0.1:<port>; the port comes from ~/.agent-office/hooks.json, then AGENT_OFFICE_PORT;
// - strings are cut to 8 KB and the body to 200 KB before sending;
// - the agent's PID goes in `pid`: process.ppid, or its parent when the parent is a shell wrapper (Gemini CLI runs
//   every hook through pwsh / bash -c). That lookup is slow on Windows (~0.3 s), so shims ask for it only on
//   session start.
// AGENT_OFFICE_HOOK_DEBUG=1 writes what happens to stderr.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4848;
export const CONFIG_FILE = 'hooks.json';
export const POST_TIMEOUT_MS = 1_500;
export const STDIN_TIMEOUT_MS = 3_000;
export const MAX_STDIN = 8 * 1024 * 1024;
export const MAX_STRING = 8 * 1024;
export const MAX_BODY = 200_000;
/** Shell wrappers a hook may run under; the agent is their parent. */
export const SHELLS = new Set(['pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh', 'dash', 'fish']);

const debug = process.env.AGENT_OFFICE_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[agent-office hook] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

export function homeOf(env = process.env) {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Port: ~/.agent-office/hooks.json ({port}); else AGENT_OFFICE_PORT; else 4848. */
export function readConfig(env = process.env) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(homeOf(env), '.agent-office', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const filePort = Number(isObject(file) ? file.port : undefined);
  const envPort = Number.parseInt(env.AGENT_OFFICE_PORT ?? '', 10);
  return { port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT };
}

/** Cuts long strings (command output, huge patches) everywhere in a JSON value. */
export function trimDeep(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimDeep(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimDeep(x, max, depth + 1);
  return out;
}

/** The value with strings cut; cut shorter while the JSON body is still too large. */
export function fitBody(v) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimDeep(v, max);
    if (JSON.stringify(out).length <= MAX_BODY) return out;
  }
  return out;
}

export function readStdin(stdin = process.stdin, timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stdin.on('error', () => finish(undefined));
  });
}

/** POST to the local Agent Office. Returns the status, or null when it's down, slow or refused. */
export async function post(port, path, body, timeoutMs = POST_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    return res.status;
  } catch (err) {
    debug(`POST ${path}: ${err?.name ?? 'error'} ${err?.message ?? ''}`);
    return null;
  }
}

/** [parentPid, name] of a process, or undefined. Platform-specific and best-effort. */
export function processInfo(pid, platform = process.platform, timeoutMs = 3_000) {
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const m = /^\d+ \((.*)\) \S (\d+)/s.exec(stat);
      return m ? [Number(m[2]), m[1]] : undefined;
    }
    if (platform === 'win32') return windowsProcessInfo(Number(pid), timeoutMs);
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 1_000 }).trim();
    const m = /^(\d+)\s+(.+)$/.exec(out);
    return m ? [Number(m[1]), m[2]] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Windows has no fast built-in way: `wmic` (deprecated, ~1 s) first, then a CIM query through PowerShell (~2-3 s).
 * Measured on Windows 11 in P1-08; shims only ask on session start. Each step is capped (3 s by default) so a slow
 * machine can't stall the agent; the shim then falls back to its parent PID.
 */
function windowsProcessInfo(pid, timeoutMs) {
  const opts = { encoding: 'utf8', timeout: timeoutMs, windowsHide: true };
  try {
    const csv = execFileSync('wmic', ['process', 'where', `processid=${pid}`, 'get', 'parentprocessid,name', '/format:csv'], opts);
    // Node,Name,ParentProcessId / HOST,node.exe,32152
    const row = csv.trim().split(/\r?\n/).filter((l) => l.trim()).pop()?.split(',');
    if (row && row.length >= 3 && /^\d+$/.test(row[row.length - 1].trim())) return [Number(row[row.length - 1].trim()), row[row.length - 2]];
  } catch {
    // no wmic (removed in newer Windows builds): fall through
  }
  const ps = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { "$($p.ParentProcessId) $($p.Name)" }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], opts).trim();
  const m = /^(\d+) (.+)$/.exec(out);
  return m ? [Number(m[1]), m[2]] : undefined;
}

/** A shell wrapper's process name? ("pwsh.exe", "/bin/bash", "-zsh"...) */
export function isShellName(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
  return SHELLS.has(base);
}

/** The agent's PID: our parent, or the parent's parent when the parent is a shell wrapper. */
export function agentPid(ppid = process.ppid, info = processInfo) {
  const parent = info(ppid);
  if (parent && isShellName(parent[1]) && parent[0] > 1) return parent[0];
  return ppid;
}

/**
 * Runs a shim: reads stdin, lets `build` turn it into the body (undefined = send nothing), posts it to
 * /api/hooks/<provider>. Never throws, never writes to stdout.
 */
export async function runShim({ provider, build, env = process.env, stdinText }) {
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return null;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isObject(input)) return null;
    const body = build ? await build(input) : input;
    if (body === undefined) return null;
    const { port } = readConfig(env);
    const status = await post(port, `/api/hooks/${encodeURIComponent(provider)}`, fitBody(body));
    debug(`${provider}: ${status ?? 'Agent Office is not running'}`);
    return status;
  } catch (err) {
    debug(`error: ${err?.message ?? err}`);
    return null;
  }
}

/** Runs `fn` as the process's main and always exits 0 (a safety timer covers anything that hangs). */
export function mainOf(fn) {
  setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS + POST_TIMEOUT_MS + 3_000).unref();
  Promise.resolve()
    .then(fn)
    .catch(() => {})
    // No process.exit right after fetch on Windows (nodejs/node#56645): let the loop drain, exit 1 s later at most.
    .finally(() => setTimeout(() => process.exit(0), 1_000).unref());
}

export function isMain(url) {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const provider = process.argv[2];
  mainOf(async () => {
    if (!provider || !/^[a-z0-9:._-]{1,60}$/.test(provider)) return;
    await runShim({ provider });
  });
}
