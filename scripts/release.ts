// Prepares a release (P8-05). Runs the checks, sets the version everywhere it lives (package.json, package-lock.json,
// the Claude Code plugin's manifest) and makes sure CHANGELOG.md has a section for it. Tagging and publishing stay
// manual on purpose: the script prints the commands.
//
//   npm run release -- 0.2.0            # checks, bumps, then prints the git commands
//   npm run release -- 0.2.0 --no-checks
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Files whose top-level "version" follows the release. */
export const VERSION_FILES = ['package.json', 'plugins/agent-office-messages/.claude-plugin/plugin.json'];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The JSON text with its top-level "version" set (formatting kept: two-space JSON, trailing newline). */
export function withVersion(json: string, version: string): string {
  const data = JSON.parse(json) as Record<string, unknown>;
  data.version = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** package-lock.json: the root package's version, in both places npm keeps it. */
export function lockWithVersion(json: string, version: string): string {
  const data = JSON.parse(json) as { version?: string; packages?: Record<string, { version?: string }> };
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Does CHANGELOG.md have a section for this version? */
export function hasChangelogSection(changelog: string, version: string): boolean {
  return new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?\\b`, 'm').test(changelog);
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === 0;
}

function main(): number {
  const version = process.argv[2];
  if (!version || !SEMVER.test(version)) {
    console.error('Usage: npm run release -- <version>   (e.g. 0.2.0)');
    return 1;
  }
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (!hasChangelogSection(changelog, version)) {
    console.error(`CHANGELOG.md has no "## ${version}" section yet: write the release notes first.`);
    return 1;
  }
  if (!process.argv.includes('--no-checks')) {
    for (const [cmd, args] of [['npm', ['run', 'typecheck']], ['npm', ['test']], ['npm', ['run', 'build']], ['npm', ['run', 'theme:check']]] as const) {
      if (!run(cmd, [...args])) {
        console.error(`✗ ${cmd} ${args.join(' ')} failed: nothing was changed.`);
        return 1;
      }
    }
  }
  for (const f of VERSION_FILES) writeFileSync(join(ROOT, f), withVersion(readFileSync(join(ROOT, f), 'utf8'), version));
  writeFileSync(join(ROOT, 'package-lock.json'), lockWithVersion(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'), version));
  console.log(`✓ Version ${version} set in ${[...VERSION_FILES, 'package-lock.json'].join(', ')}.`);
  console.log(`Next: commit, merge to main, then tag the merge commit:\n  git tag -a v${version} -m "Agent Office ${version}"\n  git push origin v${version}`);
  return 0;
}

if (process.argv[1] && /release\.ts$/.test(process.argv[1])) process.exit(main());
