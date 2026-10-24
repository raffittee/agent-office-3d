// Ported from habblaud server/accounts/detect.ts (MIT, © 2026 Márcio Junior)
// Config folders ("accounts") of the CLIs on this machine, and the slug that names an account in AgentEvents.
// Only the folders' layout is checked (existence of subfolders); no file inside is opened here. Credentials
// (`.credentials*`, `auth.json`, `config.toml`) are never read, not even to tell folders apart.
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expands `~`, `$HOME` and `${HOME}` and returns the absolute path without a trailing separator. */
export function expandHome(p: string, home: string): string {
  const expanded = p.replace(/^~(?=$|[\\/])/, home).replace(/^\$\{?HOME\}?(?=$|[\\/])/, home);
  return resolve(expanded);
}

/** Same folder? Case-insensitive on Windows (drive letters and folders come in either case). */
export function samePath(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Account slug for AgentEvent.account: 'default' for the tool's default folder, otherwise 8 hex characters of the
 * SHA-256 of the (normalized) folder path. Never the path itself: it would name the user's home in every event.
 */
export function accountSlug(dir: string, defaultDir: string): string {
  if (samePath(dir, defaultDir)) return 'default';
  const key = process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir);
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

const YEAR_DIR = /^\d{4}$/;

/**
 * A Codex home (`CODEX_HOME`), told apart from a Claude config folder by layout only: `thread-writer-locks/`,
 * `archived_sessions/`, `sessions/<year>/`, or the presence (never the contents) of `config.toml` / `auth.json`.
 * A folder with `projects/` (which Codex doesn't create) is always Claude's.
 */
export function isCodexHome(p: string): boolean {
  if (isDir(resolve(p, 'projects'))) return false;
  if (isDir(resolve(p, 'thread-writer-locks')) || isDir(resolve(p, 'archived_sessions'))) return true;
  if (isFile(resolve(p, 'config.toml')) || isFile(resolve(p, 'auth.json'))) return true;
  try {
    return readdirSync(resolve(p, 'sessions'), { withFileTypes: true }).some((e) => e.isDirectory() && YEAR_DIR.test(e.name));
  } catch {
    return false;
  }
}

function hasClaudeLayout(p: string): boolean {
  return isDir(resolve(p, 'projects')) || isDir(resolve(p, 'sessions'));
}

export interface ClaudeAccount {
  /** Absolute config folder. */
  dir: string;
  /** AgentEvent.account. */
  slug: string;
}

/**
 * Claude Code config folders: `AGENT_OFFICE_CLAUDE_DIRS` (comma-separated) when set; otherwise every `$HOME/.claude*`
 * folder with `projects/` or `sessions/`, plus `CLAUDE_CONFIG_DIR`. Codex homes are left out. Stable order: the
 * default account first, then alphabetical.
 */
export function discoverClaudeAccounts(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || env.USERPROFILE || homedir()): ClaudeAccount[] {
  const defaultDir = resolve(home, '.claude');
  const found: string[] = [];
  const override = splitList(env.AGENT_OFFICE_CLAUDE_DIRS);
  if (override.length) found.push(...override.map((p) => expandHome(p, home)));
  else {
    try {
      for (const ent of readdirSync(home, { withFileTypes: true })) {
        if (!ent.name.startsWith('.claude')) continue;
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const p = resolve(home, ent.name);
        if (hasClaudeLayout(p)) found.push(p);
      }
    } catch {
      // unreadable $HOME (a container without one): the other sources still count
    }
    for (const p of splitList(env.CLAUDE_CONFIG_DIR)) {
      const abs = expandHome(p, home);
      if (isDir(abs)) found.push(abs);
    }
  }
  const dirs: string[] = [];
  for (const d of found) if (!isCodexHome(d) && !dirs.some((x) => samePath(x, d))) dirs.push(d);
  dirs.sort((a, b) => {
    const da = samePath(a, defaultDir) ? 0 : 1;
    const db = samePath(b, defaultDir) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
  return dirs.map((dir) => ({ dir, slug: accountSlug(dir, defaultDir) }));
}
