// Ported from habblaud shared/github.ts and server/sources/github.ts (MIT, © 2026 Márcio Junior)
// Room effects (P6-04), provider-neutral: a tool call that opens or merges a PR, publishes a release or watches CI
// becomes a party or an alarm in the project's room. Habblaud read these from Claude Code transcripts (including tool
// output); here they come from the tool's name and input at `tool.start` and its `ok` at `tool.end`, so they work the
// same for every provider: shell calls (`Bash`, `PowerShell`, `run_shell_command`, `exec_command`…) running `gh`, and
// GitHub MCP tools (`mcp__github__merge_pull_request`, `github__create_pull_request`…). No token, no network.
// Only success celebrates; when in doubt, no effect. Pure.
import { maskSecrets, shellWords, splitShell, truncate } from './activity';
import { t } from './i18n';

/** How long a party lasts. */
export const PARTY_MS = 12_000;
/** A red-CI alarm ends with a green CI in the room, or after this. */
export const ALARM_MS = 600_000;

export type RoomSignalKind = 'pr_opened' | 'pr_merged' | 'release' | 'ci_passed' | 'ci_failed';

/** What a finished tool call means for the room. */
export interface RoomSignal {
  kind: RoomSignalKind;
  number?: number;
  tag?: string;
}

/** What a tool call might mean, decided at `tool.start`; the outcome (`ok`) at `tool.end` settles it. */
export interface RoomSignalCandidate {
  /** On success. */
  ok?: RoomSignal;
  /** On failure (only CI watchers whose exit code is the CI's). */
  fail?: RoomSignal;
}

const SHELL_TOOL = /^(bash|powershell|shell|local_shell|shell_command|exec_command|run_shell_command|terminal|run_terminal_cmd)$/i;

function commandOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const c = o.command ?? o.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const words = c.filter((w): w is string => typeof w === 'string');
    // ["bash", "-lc", "<script>"]: the script
    const i = words.findIndex((w) => w === '-c' || w === '-lc');
    return i >= 0 && words[i + 1] ? words[i + 1]! : words.join(' ');
  }
  return '';
}

/** First PR number in the arguments: "12", "#12" or the PR's URL. */
function prNumberIn(args: string[]): number | undefined {
  for (const a of args) {
    const m = /^#?(\d{1,7})$/.exec(a) ?? /\/pull\/(\d{1,7})\b/.exec(a);
    if (m) return Number(m[1]);
  }
  return undefined;
}

const has = (args: string[], ...flags: string[]): boolean => args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));

/** Drops `VAR=1` assignments and wrappers (`sudo`, `timeout 600`) in front of a command. */
function stripPrefix(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(w) || w === 'sudo' || w === 'nohup' || w === 'command' || w === 'env' || w === 'time') i++;
    else if (w === 'timeout') i += 2;
    else break;
  }
  return words.slice(i);
}

/** Strips heredoc bodies (commit and PR texts are not commands). */
function withoutHeredocs(script: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const line of script.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (m) end = m[2]!;
  }
  return out.join('\n');
}

/** A `gh` script → candidate. Only the last `gh` command that means something counts. */
export function shellCandidate(script: string, ps = false): RoomSignalCandidate | null {
  const lines = withoutHeredocs(script.slice(0, 20_000)).split(/\r?\n/);
  const segs = lines.flatMap((l) => splitShell(l, ps));
  let out: RoomSignalCandidate | null = null;
  segs.forEach((seg, idx) => {
    const w = stripPrefix(shellWords(seg.trim(), ps));
    if (w[0] !== 'gh' && !/[\\/]gh(\.exe)?$/.test(w[0] ?? '')) return;
    const [, group, verb, ...args] = w;
    // Only the last command decides the exit code, so failure counts only there.
    const last = idx === segs.length - 1;
    if (group === 'pr' && verb === 'create' && !has(args, '--dry-run')) out = { ok: { kind: 'pr_opened' } };
    else if (group === 'pr' && verb === 'merge' && !has(args, '--auto', '--disable-auto')) out = { ok: { kind: 'pr_merged', ...num(prNumberIn(args)) } };
    else if (group === 'release' && verb === 'create' && !has(args, '--draft', '-d')) {
      const tag = args.find((a) => !a.startsWith('-'));
      out = { ok: { kind: 'release', ...(tag ? { tag: truncate(maskSecrets(tag), 24) } : {}) } };
    } else if (group === 'pr' && verb === 'checks' && has(args, '--watch')) {
      const n = num(prNumberIn(args));
      out = { ok: { kind: 'ci_passed', ...n }, ...(last ? { fail: { kind: 'ci_failed', ...n } } : {}) };
    } else if (group === 'run' && (verb === 'watch' || verb === 'view') && has(args, '--exit-status')) {
      out = { ok: { kind: 'ci_passed' }, ...(last ? { fail: { kind: 'ci_failed' } } : {}) };
    }
  });
  return out;
}

const num = (n: number | undefined): { number?: number } => (n === undefined ? {} : { number: n });

/** A GitHub MCP tool (any server prefix) → candidate. */
function mcpCandidate(name: string, input: unknown): RoomSignalCandidate | null {
  if (!/github/i.test(name)) return null;
  const op = name.split(/__|[./:]/).pop()?.toLowerCase() ?? '';
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const n = typeof o.pullNumber === 'number' ? o.pullNumber : typeof o.pull_number === 'number' ? o.pull_number : undefined;
  if (op === 'create_pull_request') return { ok: { kind: 'pr_opened' } };
  if (op === 'merge_pull_request') return { ok: { kind: 'pr_merged', ...num(n) } };
  if (op === 'create_release') return { ok: { kind: 'release', ...(typeof o.tag_name === 'string' ? { tag: truncate(maskSecrets(o.tag_name), 24) } : {}) } };
  return null;
}

/** What this tool call could mean for its room, or null (almost always). */
export function roomSignalCandidate(toolName: string, input: unknown): RoomSignalCandidate | null {
  if (SHELL_TOOL.test(toolName)) {
    const cmd = commandOf(input);
    return cmd.includes('gh') ? shellCandidate(cmd, /powershell/i.test(toolName)) : null;
  }
  return mcpCandidate(toolName, input);
}

/** The candidate settled by the outcome. A missing `ok` counts as success (some providers only report failures). */
export function settleSignal(c: RoomSignalCandidate | null | undefined, ok: boolean | undefined): RoomSignal | null {
  if (!c) return null;
  return (ok === false ? c.fail : c.ok) ?? null;
}

/** The banner text of a signal. */
export function signalText(s: RoomSignal): string {
  const pr = s.number !== undefined ? ` #${s.number}` : '';
  switch (s.kind) {
    case 'pr_opened':
      return t('🎉 PR{0} opened!', [pr]);
    case 'pr_merged':
      return t('🎉 PR{0} merged!', [pr]);
    case 'release':
      return s.tag ? t('🚀 Release {0}!', [s.tag]) : t('🚀 New release!');
    case 'ci_passed':
      return t('✅ CI green{0}', [pr ? ` (PR${pr})` : '']);
    case 'ci_failed':
      return t('🚨 CI failed{0}', [pr ? ` (PR${pr})` : '']);
  }
}
