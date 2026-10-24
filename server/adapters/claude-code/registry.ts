// Ported from habblaud server/sources/registry.ts (MIT, © 2026 Márcio Junior)
// Claude Code's registry of OPEN sessions: <configDir>/sessions/<pid>.json. The file exists while the process lives.
// Outside Docker the PID is confirmed too (a file can be left behind when the process dies without cleaning up), and
// since 2.1.30x so is the process start (`procStart`), which a reused PID doesn't match (P0-05).
//
// Only `*.json` is opened: the same folder holds `<pid>.<hash>.key` files, which are never read.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WaitingReason } from '../../../shared/protocol';
import { describeClaudeWaitingFor } from '../../../shared/tools/claude-code';
import { pidAlive } from '../adapter';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  /** Process start as a Windows FILETIME string (2.1.30x), the same as Get-Process's StartTime.ToFileTimeUtc(). */
  procStart?: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  /** 'busy' | 'idle' | 'waiting' | 'shell' (old versions have none; 'shell' = idle with a background shell). */
  status?: string;
  waitingFor?: string;
  /** The session's custom agent (`claude --agent reviewer`). */
  agent?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Validates a registry file's JSON. Missing essential fields -> undefined. */
export function parseRegistryEntry(raw: string): RegistryEntry | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const pid = num(j.pid);
  const sessionId = str(j.sessionId);
  const cwd = str(j.cwd);
  if (pid === undefined || !sessionId || !cwd) return undefined;
  const e: RegistryEntry = { pid, sessionId, cwd };
  const procStart = str(j.procStart) ?? (typeof j.procStart === 'number' ? String(j.procStart) : undefined);
  const optional: Array<[keyof RegistryEntry, unknown]> = [
    ['startedAt', num(j.startedAt)],
    ['procStart', procStart && /^\d{1,20}$/.test(procStart) ? procStart : undefined],
    ['version', str(j.version)],
    ['kind', str(j.kind)],
    ['entrypoint', str(j.entrypoint)],
    ['name', str(j.name)],
    ['status', str(j.status)],
    ['waitingFor', str(j.waitingFor)],
    ['agent', str(j.agent)],
    ['updatedAt', num(j.updatedAt)],
    ['statusUpdatedAt', num(j.statusUpdatedAt)],
  ];
  for (const [k, v] of optional) if (v !== undefined) (e as unknown as Record<string, unknown>)[k] = v;
  return e;
}

/**
 * First Claude Code version known to write "shell" to the registry (idle with a background shell). From it on,
 * "idle" is the final word on shells: nothing is running in the background.
 */
export const SHELL_STATUS_VERSION = '2.1.292';

/** Compares "x.y.z" versions (suffixes like "-beta" are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export type RegistryStatus = 'working' | 'idle' | 'shell' | 'waiting';

/** Registry status -> agent status (undefined = unknown; the transcript decides). */
export function registryStatus(e: RegistryEntry): { status?: RegistryStatus; waiting?: { reason: WaitingReason; text: string } } {
  switch (e.status) {
    case 'busy':
      return { status: 'working' };
    case 'idle':
      return { status: 'idle' };
    // Idle, but with background shell(s) running (monitors don't count): waiting for the shell.
    case 'shell':
      return { status: 'shell' };
    case 'waiting': {
      const raw = e.waitingFor?.toLowerCase() ?? '';
      const reason: WaitingReason = raw === 'input needed' ? 'question' : /permission|approve|allow|request|trust/.test(raw) ? 'permission' : 'input';
      return { status: 'waiting', waiting: { reason, text: describeClaudeWaitingFor(e.waitingFor) } };
    }
    default:
      return {};
  }
}

/** Windows FILETIME (100 ns ticks since 1601) -> epoch ms. */
export function filetimeToMs(ft: string): number | undefined {
  if (!/^\d{1,20}$/.test(ft)) return undefined;
  return Number(BigInt(ft) / 10_000n) - 11_644_473_600_000;
}

/**
 * Checks a registry entry's `procStart` against the live process, once per (pid, procStart): asynchronous, because on
 * Windows the lookup is a PowerShell spawn (~0.5 s). Until the answer arrives the entry counts as alive. Only Windows
 * is checked (procStart is a FILETIME there); elsewhere the PID probe stands alone.
 */
export class ProcStartChecker {
  private verdicts = new Map<string, boolean | 'pending'>();

  constructor(private readonly lookup: (pid: number) => Promise<string | undefined> = windowsProcStart) {}

  /** false = the PID now belongs to another process. */
  matches(pid: number, procStart: string | undefined): boolean {
    if (!procStart || process.platform !== 'win32') return true;
    const key = `${pid}:${procStart}`;
    const v = this.verdicts.get(key);
    if (v === undefined) {
      this.verdicts.set(key, 'pending');
      if (this.verdicts.size > 256) this.verdicts.delete(this.verdicts.keys().next().value as string);
      this.lookup(pid).then(
        (actual) => this.verdicts.set(key, actual === undefined || actual === procStart),
        () => this.verdicts.set(key, true),
      );
      return true;
    }
    return v !== false;
  }
}

/** Process start of `pid` as a FILETIME string (Windows), or undefined when it can't be told. */
export function windowsProcStart(pid: number): Promise<string | undefined> {
  return new Promise((ok) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        const v = String(stdout).trim();
        // An error (no such process, access denied) says nothing about reuse: the PID probe decides.
        ok(!err && /^\d+$/.test(v) ? v : undefined);
      },
    );
  });
}

export interface RegistryPoll {
  entries: RegistryEntry[];
  ok: boolean;
  error?: string;
}

interface Cached {
  mtimeMs: number;
  size: number;
  entry: RegistryEntry | undefined;
}

export class RegistryReader {
  private cache = new Map<string, Cached>();
  private readonly sessionsDir: string;
  private readonly isAlive: (e: RegistryEntry) => boolean;

  constructor(
    readonly configDir: string,
    private readonly opts: { checkPid: boolean; isAlive?: (e: RegistryEntry) => boolean },
  ) {
    this.sessionsDir = join(configDir, 'sessions');
    this.isAlive = opts.isAlive ?? ((e) => pidAlive(e.pid));
  }

  poll(): RegistryPoll {
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir);
    } catch (err) {
      this.cache.clear();
      const code = (err as NodeJS.ErrnoException).code;
      return { entries: [], ok: false, error: code === 'ENOENT' ? 'sessions/ folder not found' : `sessions/ unreadable (${code ?? 'error'})` };
    }
    const seen = new Set<string>();
    const entries: RegistryEntry[] = [];
    for (const name of names) {
      // `<pid>.json` only: never `<pid>.<hash>.key`.
      if (!/^\d+\.json$/.test(name)) continue;
      const file = join(this.sessionsDir, name);
      seen.add(file);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      let cached = this.cache.get(file);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        let entry: RegistryEntry | undefined;
        try {
          entry = parseRegistryEntry(readFileSync(file, 'utf8'));
        } catch {
          entry = undefined;
        }
        if (entry) cached = { mtimeMs: st.mtimeMs, size: st.size, entry };
        // Invalid JSON (the file is being written): keep the last good version and try again next round.
        else cached = cached ? { ...cached } : { mtimeMs: 0, size: -1, entry: undefined };
        this.cache.set(file, cached);
      }
      const e = cached.entry;
      if (!e) continue;
      if (this.opts.checkPid && !this.isAlive(e)) continue;
      entries.push(e);
    }
    for (const file of [...this.cache.keys()]) if (!seen.has(file)) this.cache.delete(file);
    return { entries, ok: true };
  }
}
