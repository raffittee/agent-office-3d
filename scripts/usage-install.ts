// Ported from habblaud scripts/statusline-install.ts (MIT, © 2026 Márcio Junior)
// Puts the statusline tap (hooks/statusline-tap.mjs) in front of each Claude Code account's statusline, so the office
// can show the plan usage Claude Code hands its statusline (P5-04). No credentials are read.
//
//   npm run usage:install     # each Claude config folder's settings.json (backup first)
//   npm run usage:uninstall   # puts the original statusline back
//   npm run usage:status
//   (options: --dry-run)
//
// The user's own statusline keeps working: the tap runs it with the same input and prints its output. It's kept as a
// single quoted argument after `--`, so its quoting survives.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeAccounts } from '../server/adapters/accounts';
import { hookCommand, readSettings, tildify, writeSettings, type Settings } from './hooks-install';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const TAP_SCRIPT = join(ROOT, 'hooks', 'statusline-tap.mjs');
const TAP_MARK = /statusline-tap\.mjs/;

type Rec = Record<string, unknown>;

/** POSIX single quotes (Claude Code runs statuslines through sh, or Git Bash on Windows). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Undoes shQuote for the argument after `--` (undefined when there's none). */
export function originalOf(command: string): string | undefined {
  const i = command.indexOf(' -- ');
  if (i < 0) return undefined;
  const rest = command.slice(i + 4).trim();
  const m = /^'((?:[^']|'\\'')*)'$/.exec(rest);
  return m ? m[1]!.replace(/'\\''/g, "'") : rest;
}

export function isTapped(settings: Settings): boolean {
  const sl = settings.statusLine as Rec | undefined;
  return typeof sl?.command === 'string' && TAP_MARK.test(sl.command);
}

export type UsagePlan = { action: 'write'; settings: Settings; message: string } | { action: 'none'; message: string } | { action: 'skip'; message: string };

export function planInstall(settings: Settings, tapCommand: string): UsagePlan {
  const sl = settings.statusLine;
  if (sl !== undefined && (typeof sl !== 'object' || sl === null || Array.isArray(sl))) return { action: 'skip', message: '"statusLine" has an unknown shape; nothing was changed' };
  const cur = (sl ?? {}) as Rec;
  if (cur.type !== undefined && cur.type !== 'command') return { action: 'skip', message: `statusLine type "${String(cur.type)}" isn't a command; nothing was changed` };
  const existing = typeof cur.command === 'string' ? cur.command : undefined;
  const original = existing && TAP_MARK.test(existing) ? originalOf(existing) : existing;
  const command = original ? `${tapCommand} -- ${shQuote(original)}` : tapCommand;
  if (existing === command) return { action: 'none', message: 'already installed' };
  return { action: 'write', settings: { ...settings, statusLine: { ...cur, type: 'command', command } }, message: original ? 'installed in front of your statusline' : 'installed' };
}

export function planUninstall(settings: Settings): UsagePlan {
  if (!isTapped(settings)) return { action: 'none', message: 'was not installed' };
  const cur = settings.statusLine as Rec;
  const original = originalOf(String(cur.command));
  const out: Settings = { ...settings };
  if (original) out.statusLine = { ...cur, command: original };
  else delete out.statusLine;
  return { action: 'write', settings: out, message: original ? 'your statusline is back as it was' : 'removed' };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dryRun = argv.includes('--dry-run');
  if (cmd !== 'install' && cmd !== 'uninstall' && cmd !== 'status') {
    console.log('Usage: npm run usage:<install|uninstall|status> [-- --dry-run]');
    process.exitCode = 1;
    return;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const accounts = discoverClaudeAccounts();
  if (!accounts.length) console.log('No Claude Code config folder found (~/.claude*, CLAUDE_CONFIG_DIR, AGENT_OFFICE_CLAUDE_DIRS).');
  const tap = hookCommand(TAP_SCRIPT);
  for (const a of accounts) {
    const file = join(a.dir, 'settings.json');
    const label = tildify(file, home);
    const read = readSettings(file);
    if ('error' in read) {
      console.log(`✗ ${label}: ${read.error}`);
      process.exitCode = 1;
      continue;
    }
    if (cmd === 'status') {
      console.log(`• ${label}: ${isTapped(read.settings) ? 'installed' : 'not installed'}`);
      continue;
    }
    const plan = cmd === 'install' ? planInstall(read.settings, tap) : planUninstall(read.settings);
    if (plan.action !== 'write') {
      console.log(`${plan.action === 'skip' ? '✗' : '='} ${label}: ${plan.message}`);
      continue;
    }
    if (dryRun) {
      console.log(`~ ${label}: ${plan.message} (dry run: nothing written)`);
      continue;
    }
    const backup = writeSettings(file, plan.settings, read.raw, new Date());
    console.log(`✓ ${label}: ${plan.message}${backup ? ` · backup at ${tildify(backup, home)}` : ''}`);
  }
  if (cmd === 'install' && !dryRun) console.log('The plan usage appears in the office once Claude Code next draws its statusline (in an open session).');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
