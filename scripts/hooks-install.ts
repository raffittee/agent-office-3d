// Ported from habblaud scripts/hooks-install.ts (MIT, © 2026 Márcio Junior)
// Installs (or removes) Agent Office's hook shim into a CLI's settings. Runs on the host, with tsx:
//
//   npm run hooks:install -- --provider gemini-cli [--profile light|full] [--port <n>] [--dry-run]
//   npm run hooks:uninstall -- --provider gemini-cli
//   npm run hooks:status -- --provider gemini-cli
//
// Settings with the `hooks: { <Event>: [{ matcher, hooks: [{ type: "command", command, ... }] }] }` shape (Gemini
// CLI, Claude Code) are merged idempotently: only Agent Office's entries change; everything else stays. A backup
// goes to <file>.agent-office-backup-<date> before any write. The port goes to ~/.agent-office/hooks.json, where
// the shims read it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4848;

export type Settings = Record<string, unknown>;
type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Targets: one per provider
// ---------------------------------------------------------------------------------------------

export interface Target {
  id: string;
  label: string;
  /** The shim this provider runs. */
  script: string;
  /** Settings files to manage (one per account). */
  settingsFiles(env: NodeJS.ProcessEnv, home: string): string[];
  profiles: readonly string[];
  defaultProfile(platform: NodeJS.Platform): string;
  events(profile: string): string[];
  /** Every event this target may own (stale ones are removed when the profile changes). */
  allEvents: readonly string[];
  matcher: string;
  entry(command: string): Rec;
  /** A warning about the installed CLI version, or undefined. */
  versionWarning?(): string | undefined;
}

const GEMINI_LIGHT = ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'Notification'];
const GEMINI_FULL = [...GEMINI_LIGHT, 'BeforeTool', 'AfterTool'];
export const GEMINI_MIN_VERSION = '0.65.0';

/** Compares "x.y.z" versions (suffixes ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * The npm-installed Gemini CLI's version, read from its package.json next to the `gemini` launcher on PATH (Windows:
 * <dir>/node_modules/...; elsewhere <dir>/../lib/node_modules/...). Running `gemini --version` instead can hang when
 * stdin isn't a terminal, so nothing is started.
 */
export function installedGeminiVersion(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | undefined {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir || !['gemini', 'gemini.cmd'].some((f) => exists(join(dir, f)))) continue;
    for (const pkg of [join(dir, 'node_modules', '@google', 'gemini-cli', 'package.json'), join(dir, '..', 'lib', 'node_modules', '@google', 'gemini-cli', 'package.json')]) {
      try {
        const v = (JSON.parse(read(pkg)) as { version?: unknown }).version;
        if (typeof v === 'string') return v;
      } catch {
        // not this layout
      }
    }
  }
  return undefined;
}

export const TARGETS: Record<string, Target> = {
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    script: join(ROOT, 'hooks', 'gemini-cli.mjs'),
    // GEMINI_CLI_HOME relocates the whole .gemini folder (docs/providers/gemini-cli.md).
    settingsFiles: (env, home) => [join(env.GEMINI_CLI_HOME?.trim() || home, '.gemini', 'settings.json')],
    profiles: ['light', 'full'],
    // Each hook costs ~0.4 s on Windows (PowerShell): no per-tool hooks there by default (P0-04).
    defaultProfile: (platform) => (platform === 'win32' ? 'light' : 'full'),
    events: (profile) => (profile === 'full' ? GEMINI_FULL : GEMINI_LIGHT),
    allEvents: [...GEMINI_FULL, 'PreCompress'],
    // "*" matches every event; ".*" would never match SessionStart/SessionEnd (exact-string triggers, P0-04).
    matcher: '*',
    entry: (command) => ({ name: 'agent-office', type: 'command', command, timeout: 5_000 }),
    versionWarning: () => {
      const v = installedGeminiVersion(process.env);
      if (!v) return 'Gemini CLI not found on PATH (the hooks are written anyway).';
      return compareVersions(v, GEMINI_MIN_VERSION) < 0 ? `Gemini CLI ${v} is older than ${GEMINI_MIN_VERSION}: hooks are off by default there. Upgrade with npm i -g @google/gemini-cli@latest.` : undefined;
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/hooks-install.test.ts)
// ---------------------------------------------------------------------------------------------

/** Double quotes (readable); single quotes when the path has `"`, `$` or a backtick (bash and PowerShell). */
export function quotePath(p: string): string {
  return /^[^"$`]*$/.test(p) ? `"${p}"` : `'${p.replace(/'/g, "''")}'`;
}

/**
 * `node "<script>"`. The command must work in bash and PowerShell (Gemini runs hooks through either): a quoted
 * executable first needs PowerShell's call operator, so a custom node path is written as `& "<node>"` on Windows.
 */
export function hookCommand(script: string, nodeCmd = 'node', platform: NodeJS.Platform = process.platform): string {
  const node = /^[\w.-]+$/.test(nodeCmd) ? nodeCmd : platform === 'win32' ? `& ${quotePath(nodeCmd)}` : quotePath(nodeCmd);
  return `${node} ${quotePath(script)}`;
}

/** Our hook entry: its command runs `hooks/<provider>.mjs` (any folder: a moved checkout is still ours). */
export function isOurHook(h: unknown, target: Target): boolean {
  const r = rec(h);
  if (!r || typeof r.command !== 'string') return false;
  const file = target.script.split(/[\\/]/).pop()!.replace(/\./g, '\\.');
  return new RegExp(`[\\\\/]hooks[\\\\/]${file}`).test(r.command);
}

export type PlanAction =
  | { action: 'install'; settings: Settings; message: string }
  | { action: 'uninstall'; settings: Settings; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

/** `hooks` in an editable shape, or why not to touch it. */
function hooksOf(settings: Settings, events: readonly string[]): Rec | string {
  if (settings.hooks !== undefined && !rec(settings.hooks)) return '"hooks" has an unknown shape; nothing was changed';
  const hooks = rec(settings.hooks) ?? {};
  for (const ev of events) if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) return `"hooks.${ev}" has an unknown shape; nothing was changed`;
  return hooks;
}

/** The event's list without our hooks (groups left empty go away); `removed` = how many went. */
function withoutOurs(list: unknown[], target: Target): { list: unknown[]; removed: number } {
  let removed = 0;
  const out: unknown[] = [];
  for (const g of list) {
    const group = rec(g);
    if (!group || !Array.isArray(group.hooks)) {
      out.push(g);
      continue;
    }
    const kept = group.hooks.filter((h) => !isOurHook(h, target));
    removed += group.hooks.length - kept.length;
    if (kept.length === group.hooks.length) out.push(g);
    else if (kept.length) out.push({ ...group, hooks: kept });
  }
  return { list: out, removed };
}

/** Events where our hook is installed, with the entry found. */
export function installedEvents(settings: Settings, target: Target): Map<string, Rec> {
  const out = new Map<string, Rec>();
  const hooks = rec(settings.hooks);
  if (!hooks) return out;
  for (const ev of target.allEvents) {
    const list = hooks[ev];
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      const h = (rec(g)?.hooks as unknown[] | undefined)?.find((x) => isOurHook(x, target));
      if (h) {
        out.set(ev, h as Rec);
        break;
      }
    }
  }
  return out;
}

/** Install plan for one settings file (writes nothing). */
export function planInstall(settings: Settings, target: Target, events: readonly string[], entry: Rec): PlanAction {
  const hooks = hooksOf(settings, target.allEvents);
  if (typeof hooks === 'string') return { action: 'skip', message: hooks };
  const current = installedEvents(settings, target);
  const sameSet = current.size === events.length && events.every((ev) => current.has(ev));
  const sameEntry = [...current.values()].every((h) => JSON.stringify(h) === JSON.stringify(entry));
  const groupsOk = () =>
    events.every((ev) => {
      const groups = ((hooks[ev] as unknown[] | undefined) ?? []).filter((g) => (rec(g)?.hooks as unknown[] | undefined)?.some((h) => isOurHook(h, target)));
      return groups.length === 1 && rec(groups[0])!.matcher === target.matcher && (rec(groups[0])!.hooks as unknown[]).length === 1;
    });
  if (sameSet && sameEntry && groupsOk()) return { action: 'none', message: 'already installed' };
  const next: Rec = { ...hooks };
  for (const ev of target.allEvents) {
    if (!Array.isArray(next[ev])) continue;
    const { list } = withoutOurs(next[ev] as unknown[], target);
    if (list.length) next[ev] = list;
    else delete next[ev];
  }
  for (const ev of events) next[ev] = [...((next[ev] as unknown[] | undefined) ?? []), { matcher: target.matcher, hooks: [entry] }];
  return { action: 'install', settings: { ...settings, hooks: next }, message: current.size ? 'updated (new path, events or options)' : 'installed' };
}

/** Uninstall plan: removes only our hooks (and whatever that leaves empty). */
export function planUninstall(settings: Settings, target: Target): PlanAction {
  const hooks = hooksOf(settings, target.allEvents);
  if (typeof hooks === 'string') return { action: 'skip', message: hooks };
  let removed = 0;
  const next: Rec = { ...hooks };
  for (const ev of target.allEvents) {
    if (!Array.isArray(next[ev])) continue;
    const r = withoutOurs(next[ev] as unknown[], target);
    removed += r.removed;
    if (r.list.length) next[ev] = r.list;
    else delete next[ev];
  }
  if (!removed) return { action: 'none', message: 'was not installed' };
  const out: Settings = { ...settings };
  if (Object.keys(next).length) out.hooks = next;
  else delete out.hooks;
  return { action: 'uninstall', settings: out, message: 'Agent Office hooks removed' };
}

// ---------------------------------------------------------------------------------------------
// Effects (files, the CLI, the server's /api/health)
// ---------------------------------------------------------------------------------------------

export function readSettings(file: string): { settings: Settings; raw?: string } | { error: string } {
  if (!existsSync(file)) return { settings: {} };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { error: `could not read (${(err as Error).message})` };
  }
  if (!raw.trim()) return { settings: {}, raw };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!rec(parsed)) return { error: 'not a JSON object; nothing was changed' };
    return { settings: parsed as Settings, raw };
  } catch {
    return { error: 'invalid JSON; nothing was changed' };
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Backup + atomic write keeping the file's mode. Returns the backup path. */
export function writeSettings(file: string, settings: Settings, raw: string | undefined, now: Date): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  let mode = 0o600;
  if (raw !== undefined) mode = statSync(file).mode & 0o777;
  const tmp = `${file}.agent-office-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  // Re-read now: the backup is what the rename replaces. If it changed since reading, abort (no merge).
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      unlinkSync(tmp);
      throw err;
    }
  }
  if (current !== raw) {
    unlinkSync(tmp);
    throw new Error('the file changed since it was read; nothing was changed, run the command again');
  }
  let backup: string | undefined;
  if (current !== undefined) {
    backup = `${file}.agent-office-backup-${stamp(now)}`;
    for (let i = 2; existsSync(backup); i++) backup = `${file}.agent-office-backup-${stamp(now)}-${i}`;
    writeFileSync(backup, current, { mode: 0o600 });
  }
  renameSync(tmp, file);
  return backup;
}

/** Writes the port to ~/.agent-office/hooks.json (keeping other keys). */
export function writeHookConfig(home: string, port: number): string {
  const file = join(home, '.agent-office', 'hooks.json');
  let cfg: Rec = {};
  try {
    cfg = rec(JSON.parse(readFileSync(file, 'utf8'))) ?? {};
  } catch {
    cfg = {};
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...cfg, port }, null, 2)}\n`);
  return file;
}

export function tildify(p: string, home: string): string {
  if (p !== home && !p.startsWith(`${home}/`) && !p.startsWith(`${home}${sep}`)) return p;
  return `~${p.slice(home.length).split(sep).join('/')}`;
}

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  provider: string;
  profile?: string;
  port: number;
  dryRun: boolean;
  nodeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  platform: NodeJS.Platform;
  out: (line: string) => void;
  /** Override the targets (tests). */
  targets?: Record<string, Target>;
  /** The server's /api/health (tests inject a fake). */
  health?: (port: number) => Promise<unknown>;
  /** Skip the CLI version check (tests). */
  skipVersionCheck?: boolean;
}

export class UsageError extends Error {}

const USAGE = `Usage: npm run hooks:<install|uninstall|status> -- --provider <id> [options]

  install     adds Agent Office's hooks to the CLI's settings (backs the file up first)
  uninstall   removes only Agent Office's hooks
  status      shows what's installed and whether Agent Office is running

Options:
  --provider <id>   ${Object.keys(TARGETS).join(', ')}
  --profile <name>  gemini-cli: light (default on Windows) or full (adds per-tool hooks)
  --port <n>        Agent Office's port (default: AGENT_OFFICE_PORT or ${DEFAULT_PORT})
  --node <cmd>      node command used in the hook (default: node)
  --dry-run         show what would change, write nothing
  -h, --help        this help`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let provider: string | undefined;
  let profile: string | undefined;
  let nodeCmd: string | undefined;
  let dryRun = false;
  const envPort = Number.parseInt(env.AGENT_OFFICE_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--provider') provider = argv[++i];
    else if (a === '--profile') profile = argv[++i];
    else if (a === '--node') {
      nodeCmd = argv[++i];
      if (!nodeCmd) throw new UsageError('--node needs a command.');
    } else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new UsageError('--port needs a number from 1 to 65535.');
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new UsageError(`unknown option: ${a}\n\n${USAGE}`);
  }
  if (!command) throw new UsageError(`say what to do: install, uninstall or status.\n\n${USAGE}`);
  if (!provider) throw new UsageError(`--provider is required (${Object.keys(TARGETS).join(', ')}).`);
  return { command, provider, ...(profile ? { profile } : {}), port, dryRun, ...(nodeCmd ? { nodeCmd } : {}) };
}

async function fetchHealth(port: number): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** Runs the command for every settings file of the provider. Returns the exit code. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const target = (ctx.targets ?? TARGETS)[opts.provider];
  if (!target) {
    out(`Unknown provider "${opts.provider}". Known: ${Object.keys(ctx.targets ?? TARGETS).join(', ')}.`);
    return 1;
  }
  const profile = opts.profile ?? target.defaultProfile(ctx.platform);
  if (!target.profiles.includes(profile)) {
    out(`Unknown profile "${profile}" for ${target.label}. Known: ${target.profiles.join(', ')}.`);
    return 1;
  }
  const events = target.events(profile);
  const entry = target.entry(hookCommand(target.script, opts.nodeCmd, ctx.platform));
  let failures = 0;
  let changed = 0;
  for (const file of target.settingsFiles(env, home)) {
    const label = tildify(file, home);
    const read = readSettings(file);
    if ('error' in read) {
      out(`✗ ${label}: ${read.error}`);
      failures++;
      continue;
    }
    if (opts.command === 'status') {
      const installed = installedEvents(read.settings, target);
      if (!installed.size) out(`• ${label}: not installed`);
      else out(`• ${label}: installed for ${[...installed.keys()].join(', ')}`);
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(read.settings, target, events, entry) : planUninstall(read.settings, target);
    if (plan.action === 'none') {
      out(`= ${label}: ${plan.message}`);
      continue;
    }
    if (plan.action === 'skip') {
      out(`✗ ${label}: ${plan.message}`);
      failures++;
      continue;
    }
    if (opts.dryRun) {
      out(`~ ${label}: ${plan.message} (dry run: nothing written)`);
      continue;
    }
    try {
      const backup = writeSettings(file, plan.settings, read.raw, ctx.now);
      out(`✓ ${label}: ${plan.message}${opts.command === 'install' ? ` (${profile} profile: ${events.join(', ')})` : ''}${backup ? ` · backup at ${tildify(backup, home)}` : ''}`);
      changed++;
    } catch (err) {
      out(`✗ ${label}: could not write (${(err as Error).message})`);
      failures++;
    }
  }
  if (opts.command === 'install' && !opts.dryRun) out(`Port ${opts.port} saved to ${tildify(writeHookConfig(home, opts.port), home)}.`);
  if (opts.command !== 'uninstall' && !ctx.skipVersionCheck) {
    const warning = target.versionWarning?.();
    if (warning) out(`! ${warning}`);
  }
  if (opts.command === 'status') {
    const health = await (ctx.health ?? fetchHealth)(opts.port);
    out(health ? `Agent Office at http://127.0.0.1:${opts.port}: running.` : `Agent Office at http://127.0.0.1:${opts.port}: not running (the hooks then exit right away; ${target.label} is unaffected).`);
  }
  if (opts.command === 'install' && changed) out(`Done. Restart open ${target.label} sessions so they load the hooks. To undo: npm run hooks:uninstall -- --provider ${target.id}`);
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  process.exitCode = await run(parsed, { env: process.env, home, now: new Date(), platform: process.platform, out: (l) => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof UsageError ? `[hooks] ${err.message}` : `[hooks] unexpected error: ${String(err)}`);
    process.exitCode = 1;
  });
}
