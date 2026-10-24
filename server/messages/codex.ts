// Ported from habblaud server/messages/codex.ts (MIT, © 2026 Márcio Junior)
// Messages to Codex sessions (P7-04): `codex queue --thread=<threadId> --message=<text>` puts the message in the
// thread's queue (it goes in when the session is idle; the thread's owner checks the queue every ~10 s). The server
// runs it with the account's CODEX_HOME (the binary from AGENT_OFFICE_CODEX_BIN, else `codex` on PATH). No shell
// (execFile), a deadline, and never -c, --enable, --disable or --remote (they would change the session's
// configuration or server). Exit 0 = queued, even if nobody has the thread open right now; anything else failed, and
// the first stderr line says why. Verified against codex-cli 0.164.0 (docs/providers/codex.md).
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Deadline of one `codex queue`. */
export const QUEUE_TIMEOUT_MS = 20_000;
/** A Codex thread id (a UUID; `--thread` also takes names, but the office only sends ids). */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 300;

export interface CodexQueueJob {
  /** The account's CODEX_HOME. */
  codexHome: string;
  /** The thread id (AgentInfo.sessionId of the Codex agent). */
  thread: string;
  /** The text as typed. */
  text: string;
}

export type CodexQueueResult = { ok: true } | { ok: false; error: string };
export type CodexQueueRunner = (job: CodexQueueJob) => Promise<CodexQueueResult>;

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** On Windows only `codex.exe`: the `codex` and `codex.cmd` npm puts next to it are scripts execFile can't run. */
export const CODEX_BIN_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

/** The Codex binary: AGENT_OFFICE_CODEX_BIN (an executable's path) or `codex` on PATH; undefined = not found. */
export function findCodexBin(env: NodeJS.ProcessEnv, isExecutable: (p: string) => boolean = canExecute): string | undefined {
  const explicit = env.AGENT_OFFICE_CODEX_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, CODEX_BIN_NAME);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/** `codex queue` arguments (with "=": a text starting with "-" never becomes an option). */
export function queueArgs(thread: string, text: string): string[] {
  return ['queue', `--thread=${thread}`, `--message=${text}`];
}

/**
 * The line that says why (Codex writes it as "Error: ..."; 0.164 may print a WARNING line before it), else the first
 * non-empty line, cut.
 */
export function errorLine(s: string | undefined): string | undefined {
  const lines = (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^error\b/i.test(l)) ?? lines.find((l) => !/^warning\b/i.test(l)) ?? lines[0];
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** Runs `codex queue` with the given binary. Never rejects: a failure is `{ok: false, error}`. */
export function createCodexQueueRunner(bin: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CodexQueueRunner {
  const timeoutMs = opts.timeoutMs ?? QUEUE_TIMEOUT_MS;
  return (job) =>
    new Promise<CodexQueueResult>((done) => {
      if (!THREAD_ID.test(job.thread)) return done({ ok: false, error: 'invalid Codex thread id' });
      if (!isAbsolute(job.codexHome)) return done({ ok: false, error: 'invalid Codex account folder' });
      const env = { ...(opts.env ?? process.env), CODEX_HOME: job.codexHome };
      try {
        execFile(bin, queueArgs(job.thread, job.text), { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' }, (err, _stdout, stderr) => {
          if (!err) return done({ ok: true });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) return done({ ok: false, error: `codex queue did not answer in ${Math.round(timeoutMs / 1_000)} s (the message may be queued anyway)` });
          if (e.code === 'ENOENT' || e.code === 'EACCES') return done({ ok: false, error: `could not run Codex (${bin})` });
          done({ ok: false, error: errorLine(stderr) ?? `codex queue failed (code ${String(e.code ?? '?')})` });
        });
      } catch {
        // an argument a process can't take (a NUL character in the text)
        done({ ok: false, error: 'the message has characters that cannot be sent to Codex' });
      }
    });
}
