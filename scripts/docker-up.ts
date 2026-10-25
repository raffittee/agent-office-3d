// Starts (or stops) Agent Office in Docker on this machine (P8-05). Runs on the HOST, with tsx:
//
//   npm run docker:up                 # finds the folders, writes the override, builds and starts
//   npm run docker:up -- --no-build   # starts without rebuilding the image
//   npm run docker:up -- --dry-run    # prints the override and does nothing else
//   npm run docker:down               # stops the container
//
// The override mounts, READ-ONLY and at the same absolute path as on the host, only what the office reads:
// - Claude Code (~/.claude*, CLAUDE_CONFIG_DIR or AGENT_OFFICE_CLAUDE_DIRS): <dir>/projects and <dir>/sessions;
// - Codex (~/.codex*, CODEX_HOME or AGENT_OFFICE_CODEX_DIRS): sessions/, archived_sessions/, thread-writer-locks/;
// - Gemini CLI (GEMINI_CLI_HOME or ~): .gemini/tmp;
// - ~/.agent-office/usage (plan usage), at /data/usage.
// Never a whole config folder: credentials, auth.json, config.toml and oauth_creds.json stay out of the container.
// Ported in spirit from habblaud scripts/docker-up.ts (MIT, © 2026 Márcio Junior).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeAccounts, discoverCodexHomes } from '../server/adapters/accounts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OVERRIDE = join(ROOT, 'docker-compose.override.yml');

export interface MountPlan {
  /** host path → container path (the same), read-only. */
  mounts: string[];
  env: Record<string, string>;
  /** Run as the host user (uid:gid) so it can read the user's files; undefined on Windows. */
  user?: string;
}

/** Only these subfolders of an agent's config folder are ever mounted. */
export const CLAUDE_SUBDIRS = ['projects', 'sessions'] as const;
export const CODEX_SUBDIRS = ['sessions', 'archived_sessions', 'thread-writer-locks'] as const;

/** The mounts and environment for the folders found (pure: `exists` decides which subfolders are there). */
export function planMounts(o: { home: string; claudeDirs: string[]; codexDirs: string[]; geminiHome?: string; user?: string; exists: (p: string) => boolean }): MountPlan {
  const mounts: string[] = [];
  const add = (p: string, target = p) => {
    if (o.exists(p)) mounts.push(`${p}:${target}:ro`);
  };
  for (const d of o.claudeDirs) for (const s of CLAUDE_SUBDIRS) add(join(d, s));
  for (const d of o.codexDirs) for (const s of CODEX_SUBDIRS) add(join(d, s));
  add(join(o.geminiHome ?? o.home, '.gemini', 'tmp'));
  add(join(o.home, '.agent-office', 'usage'), '/data/usage');
  const env: Record<string, string> = { HOME: o.home };
  if (o.claudeDirs.length) env.AGENT_OFFICE_CLAUDE_DIRS = o.claudeDirs.join(',');
  if (o.codexDirs.length) env.AGENT_OFFICE_CODEX_DIRS = o.codexDirs.join(',');
  if (o.geminiHome) env.GEMINI_CLI_HOME = o.geminiHome;
  return { mounts, env, ...(o.user ? { user: o.user } : {}) };
}

/** The docker-compose.override.yml text. */
export function overrideYaml(plan: MountPlan): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = ['# Written by npm run docker:up: read-only mounts of only what Agent Office reads. Not versioned.', 'services:', '  agent-office:'];
  if (plan.user) lines.push(`    user: ${q(plan.user)}`);
  lines.push('    environment:');
  for (const [k, v] of Object.entries(plan.env)) lines.push(`      ${k}: ${q(v)}`);
  if (plan.mounts.length) {
    lines.push('    volumes:');
    for (const m of plan.mounts) lines.push(`      - ${q(m)}`);
  }
  return `${lines.join('\n')}\n`;
}

function compose(args: string[]): number {
  const r = spawnSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'down') return compose(['down']);
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const plan = planMounts({
    home,
    claudeDirs: discoverClaudeAccounts(process.env, home).map((a) => a.dir),
    codexDirs: discoverCodexHomes(process.env, home).map((h) => h.dir),
    ...(process.env.GEMINI_CLI_HOME?.trim() ? { geminiHome: process.env.GEMINI_CLI_HOME.trim() } : {}),
    ...(process.getuid && process.getgid ? { user: `${process.getuid()}:${process.getgid()}` } : {}),
    exists: existsSync,
  });
  const yaml = overrideYaml(plan);
  if (argv.includes('--dry-run')) {
    process.stdout.write(yaml);
    return 0;
  }
  if (process.platform === 'win32') console.warn('! On Windows the host paths do not exist inside the Linux container; run npm start instead (docs: README › Try it).');
  mkdirSync(join(home, '.agent-office', 'usage'), { recursive: true });
  writeFileSync(OVERRIDE, yaml);
  console.log(`Wrote ${OVERRIDE} (${plan.mounts.length} read-only mounts).`);
  const code = compose(['up', '-d', ...(argv.includes('--no-build') ? [] : ['--build'])]);
  if (code === 0) console.log(`Agent Office: http://127.0.0.1:${process.env.AGENT_OFFICE_PORT ?? 4848}`);
  return code;
}

if (process.argv[1] && /docker-up\.ts$/.test(process.argv[1])) void main().then((c) => process.exit(c));
