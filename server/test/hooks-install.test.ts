// Ported from habblaud server/test/hooks-install.test.ts (MIT, © 2026 Márcio Junior)
// The installer's pure plans, and the real command on settings files in a FAKE home (never touches ~/.gemini).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TARGETS, compareVersions, hookCommand, installedEvents, installedGeminiVersion, isOurHook, parseArgs, planInstall, planUninstall, quotePath, run, type RunOptions } from '../../scripts/hooks-install';
import { tempDir } from './helpers';

const gemini = TARGETS['gemini-cli']!;
const SCRIPT = '/repo/agent-office/hooks/gemini-cli.mjs';
const entry = gemini.entry(hookCommand(SCRIPT, 'node', 'linux'));
const LIGHT = gemini.events('light');
const FULL = gemini.events('full');

describe('hooks-install (pure)', () => {
  it('commands work in bash and PowerShell', () => {
    expect(hookCommand('/r/hooks/gemini-cli.mjs')).toBe('node "/r/hooks/gemini-cli.mjs"');
    expect(hookCommand('C:\\Users\\dev\\agent office\\hooks\\gemini-cli.mjs', 'node', 'win32')).toBe('node "C:\\Users\\dev\\agent office\\hooks\\gemini-cli.mjs"');
    expect(hookCommand('/r/hooks/gemini-cli.mjs', 'C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe('& "C:\\Program Files\\nodejs\\node.exe" "/r/hooks/gemini-cli.mjs"');
    expect(hookCommand('/r/hooks/gemini-cli.mjs', '/opt/node bin/node', 'linux')).toBe('"/opt/node bin/node" "/r/hooks/gemini-cli.mjs"');
    expect(quotePath('/a/$x/it\'s.mjs')).toBe("'/a/$x/it''s.mjs'");
    expect(entry).toEqual({ name: 'agent-office', type: 'command', command: `node "${SCRIPT}"`, timeout: 5000 });
  });

  it('our hook is recognized by its script path, in any folder', () => {
    expect(isOurHook(entry, gemini)).toBe(true);
    expect(isOurHook({ command: 'node "C:\\moved\\checkout\\hooks\\gemini-cli.mjs"' }, gemini)).toBe(true);
    expect(isOurHook({ command: 'node my-gemini-cli.mjs' }, gemini)).toBe(false);
    expect(isOurHook({ command: 'echo hi' }, gemini)).toBe(false);
  });

  it('profiles: light skips per-tool hooks; matcher is "*" for every event', () => {
    expect(LIGHT).toEqual(['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'Notification']);
    expect(FULL).toEqual([...LIGHT, 'BeforeTool', 'AfterTool']);
    expect(FULL).not.toContain('PreCompress');
    expect(gemini.defaultProfile('win32')).toBe('light');
    expect(gemini.defaultProfile('linux')).toBe('full');
    expect(gemini.matcher).toBe('*');
  });

  it('install adds one group per event without touching other hooks; idempotent; switching profile updates in place', () => {
    const other = { matcher: 'write_file', hooks: [{ type: 'command', command: 'my-linter' }] };
    const settings = { theme: 'dark', hooks: { BeforeTool: [other], Stop: [{ hooks: [] }] } };
    const p = planInstall(settings, gemini, FULL, entry);
    expect(p.action).toBe('install');
    const next = p.action === 'install' ? p.settings : {};
    const hooks = next.hooks as Record<string, unknown[]>;
    expect(hooks.BeforeTool).toEqual([other, { matcher: '*', hooks: [entry] }]);
    expect(hooks.Stop).toEqual([{ hooks: [] }]);
    for (const ev of FULL) expect(hooks[ev]).toContainEqual({ matcher: '*', hooks: [entry] });
    expect(next.theme).toBe('dark');
    expect(planInstall(next, gemini, FULL, entry)).toEqual({ action: 'none', message: 'already installed' });
    const light = planInstall(next, gemini, LIGHT, entry);
    expect(light.action).toBe('install');
    const lh = (light.action === 'install' ? light.settings.hooks : {}) as Record<string, unknown[]>;
    expect(lh.BeforeTool).toEqual([other]);
    expect(lh.AfterTool).toBeUndefined();
    expect([...installedEvents(light.action === 'install' ? light.settings : {}, gemini).keys()]).toEqual(LIGHT);
    // A moved checkout: the new path replaces the old one, no duplicates.
    const moved = gemini.entry(hookCommand('/new/place/hooks/gemini-cli.mjs'));
    const upd = planInstall(next, gemini, FULL, moved);
    const uh = (upd.action === 'install' ? upd.settings.hooks : {}) as Record<string, unknown[]>;
    expect(uh.SessionStart).toEqual([{ matcher: '*', hooks: [moved] }]);
    expect(upd.message).toMatch(/updated/);
  });

  it('a stale PreCompress hook from an older install is removed', () => {
    const stale = { hooks: { PreCompress: [{ matcher: '.*', hooks: [entry] }] } };
    const p = planInstall(stale, gemini, LIGHT, entry);
    expect(p.action === 'install' && (p.settings.hooks as Record<string, unknown>).PreCompress).toBeUndefined();
  });

  it('uninstall removes only our hooks; unknown shapes are never touched', () => {
    const mixed = { matcher: '*', hooks: [{ type: 'command', command: 'mine' }, entry] };
    const p = planUninstall({ hooks: { SessionStart: [mixed], BeforeAgent: [{ matcher: '*', hooks: [entry] }] } }, gemini);
    expect(p.action === 'uninstall' && p.settings).toEqual({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine' }] }] } });
    expect(planUninstall({ theme: 'dark' }, gemini)).toEqual({ action: 'none', message: 'was not installed' });
    expect(planInstall({ hooks: [] }, gemini, LIGHT, entry).action).toBe('skip');
    expect(planInstall({ hooks: { SessionStart: {} } }, gemini, LIGHT, entry).action).toBe('skip');
  });

  it('parseArgs and versions', () => {
    expect(parseArgs(['install', '--provider', 'gemini-cli'], {})).toEqual({ command: 'install', provider: 'gemini-cli', port: 4848, dryRun: false });
    expect(parseArgs(['status', '--provider', 'gemini-cli', '--port', '4851', '--profile', 'full', '--dry-run'], {})).toMatchObject({ port: 4851, profile: 'full', dryRun: true });
    expect(parseArgs(['status', '--provider', 'codex', '--no-version-check'], {})).toMatchObject({ noVersionCheck: true });
    expect(parseArgs(['install', '--provider', 'x'], { AGENT_OFFICE_PORT: '5000' })).toMatchObject({ port: 5000 });
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(() => parseArgs(['install'], {})).toThrow(/--provider/);
    expect(() => parseArgs([], {})).toThrow(/install, uninstall or status/);
    expect(() => parseArgs(['install', '--provider', 'g', '--port', 'x'], {})).toThrow(/--port/);
    const files: Record<string, string> = {
      [join('/npm', 'gemini.cmd')]: '',
      [join('/npm', 'node_modules', '@google', 'gemini-cli', 'package.json')]: '{"version":"0.15.1"}',
      [join('/usr/local/bin', 'gemini')]: '',
      [join('/usr/local/bin', '..', 'lib', 'node_modules', '@google', 'gemini-cli', 'package.json')]: '{"version":"0.65.0"}',
    };
    const fake = (p: string) => p in files;
    const read = (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    };
    const { delimiter } = path;
    expect(installedGeminiVersion({ PATH: ['/nothing', '/npm'].join(delimiter) }, fake, read)).toBe('0.15.1');
    expect(installedGeminiVersion({ PATH: '/usr/local/bin' }, fake, read)).toBe('0.65.0');
    expect(installedGeminiVersion({ PATH: '/nothing' }, fake, read)).toBeUndefined();
    expect(compareVersions('0.15.1', '0.65.0')).toBeLessThan(0);
    expect(compareVersions('0.65.0', '0.65.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '0.65.0')).toBeGreaterThan(0);
  });
});

describe('hooks-install (files, fake home)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let out: string[];
  const settingsFile = () => join(home, '.gemini', 'settings.json');
  const original = { security: { auth: { selectedType: 'oauth-personal' } }, hooks: { AfterAgent: [{ matcher: '*', hooks: [{ type: 'command', command: 'notify-send done' }] }] } };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    out = [];
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(settingsFile(), `${JSON.stringify(original, null, 2)}\n`);
  });
  afterEach(() => tmp.cleanup());

  const exec = (command: RunOptions['command'], extra: Partial<RunOptions> = {}, opts: { env?: NodeJS.ProcessEnv; health?: unknown } = {}) =>
    run(
      { command, provider: 'gemini-cli', port: 4848, dryRun: false, ...extra },
      { env: opts.env ?? {}, home, now: new Date(2026, 9, 25, 9, 30, 0), platform: 'linux', out: (l) => out.push(l), health: async () => opts.health, skipVersionCheck: true },
    );
  const read = () => JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;

  it('install: backup, only our hooks added, port saved; again = nothing to do', async () => {
    expect(await exec('install', { profile: 'light', port: 4851 })).toBe(0);
    const s = read();
    expect(s.security).toEqual(original.security);
    const hooks = s.hooks as Record<string, unknown[]>;
    expect(hooks.AfterAgent).toHaveLength(2);
    expect(Object.keys(hooks).sort()).toEqual([...LIGHT].sort());
    expect(JSON.parse(readFileSync(`${settingsFile()}.agent-office-backup-20261025-093000`, 'utf8'))).toEqual(original);
    expect(JSON.parse(readFileSync(join(home, '.agent-office', 'hooks.json'), 'utf8'))).toEqual({ port: 4851 });
    expect(out.join('\n')).toContain('Done.');
    out = [];
    expect(await exec('install', { profile: 'light', port: 4851 })).toBe(0);
    expect(out.join('\n')).toContain('already installed');
    expect(readdirSync(join(home, '.gemini')).filter((f) => f.includes('backup'))).toHaveLength(1);
  });

  it('GEMINI_CLI_HOME relocates the settings; a missing file is created without a backup', async () => {
    const alt = join(tmp.dir, 'alt-home');
    expect(await exec('install', {}, { env: { GEMINI_CLI_HOME: alt } })).toBe(0);
    const s = JSON.parse(readFileSync(join(alt, '.gemini', 'settings.json'), 'utf8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(s.hooks).sort()).toEqual([...FULL].sort());
    expect(readdirSync(join(alt, '.gemini')).some((f) => f.includes('backup'))).toBe(false);
    expect(read()).toEqual(original);
  });

  it('status and uninstall bring everything back as it was', async () => {
    await exec('install');
    out = [];
    await exec('status', {}, { health: { ok: true } });
    expect(out.join('\n')).toMatch(/installed for SessionStart, SessionEnd, BeforeAgent, AfterAgent, Notification, BeforeTool, AfterTool/);
    expect(out.join('\n')).toContain('running');
    out = [];
    await exec('status');
    expect(out.join('\n')).toContain('not running');
    expect(await exec('uninstall')).toBe(0);
    expect(read()).toEqual(original);
    out = [];
    await exec('uninstall');
    expect(out.join('\n')).toContain('was not installed');
  });

  it('--dry-run writes nothing; invalid JSON is never overwritten; unknown provider or profile fails', async () => {
    const before = readFileSync(settingsFile(), 'utf8');
    await exec('install', { dryRun: true });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
    expect(existsSync(join(home, '.agent-office', 'hooks.json'))).toBe(false);
    expect(out.join('\n')).toContain('dry run');
    writeFileSync(settingsFile(), '{ broken');
    expect(await exec('install')).toBe(1);
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ broken');
    expect(out.join('\n')).toContain('invalid JSON');
    expect(await exec('install', { provider: 'nope' })).toBe(1);
    expect(await exec('install', { profile: 'heavy' })).toBe(1);
  });
});

describe('hooks-install: Codex', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let out: string[];
  const codexHome = () => join(home, '.codex');
  const file = () => join(codexHome(), 'hooks.json');
  const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'orca-notify' }] }] } };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    out = [];
    mkdirSync(join(codexHome(), 'sessions', '2026'), { recursive: true });
    writeFileSync(file(), `${JSON.stringify(theirs, null, 2)}\n`);
  });
  afterEach(() => tmp.cleanup());

  const exec = (command: RunOptions['command'], env: NodeJS.ProcessEnv = {}) =>
    run({ command, provider: 'codex', port: 4848, dryRun: false }, { env, home, now: new Date(2026, 9, 25, 9, 30, 0), platform: 'linux', out: (l) => out.push(l), health: async () => undefined, skipVersionCheck: true });
  const read = () => JSON.parse(readFileSync(file(), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };

  it('appends one group per event after the others, async where Codex allows it, and says how to trust them', async () => {
    expect(await exec('install')).toBe(0);
    const hooks = read().hooks;
    expect(Object.keys(hooks).sort()).toEqual([...TARGETS.codex!.allEvents].sort());
    // other apps' groups keep their place (Codex trusts hooks by position)
    expect(hooks.Stop![0]).toEqual(theirs.hooks.Stop[0]);
    expect(hooks.Stop![1]!.matcher).toBeUndefined();
    expect(hooks.PreToolUse![0]!.hooks[0]).toMatchObject({ type: 'command', async: true, timeout: 5 });
    expect(hooks.SessionEnd![0]!.hooks[0]).toEqual({ type: 'command', command: expect.stringContaining('codex.mjs'), timeout: 1 });
    expect(hooks.PermissionRequest![0]!.hooks[0]!.async).toBeUndefined();
    // the command carries no options: Codex's trust hash survives a port change
    expect(String(hooks.PreToolUse![0]!.hooks[0]!.command)).toMatch(/^node "[^"]+codex\.mjs"$/);
    expect(out.join('\n')).toContain('/hooks');
    out = [];
    expect(await exec('install')).toBe(0);
    expect(out.join('\n')).toContain('already installed');
    expect(await exec('uninstall')).toBe(0);
    expect(read()).toEqual(theirs);
  });

  it('every Codex home gets its hooks (AGENT_OFFICE_CODEX_DIRS overrides discovery)', async () => {
    const other = join(tmp.dir, 'work-codex');
    mkdirSync(join(other, 'thread-writer-locks'), { recursive: true });
    expect(await exec('install', { AGENT_OFFICE_CODEX_DIRS: other })).toBe(0);
    expect(existsSync(join(other, 'hooks.json'))).toBe(true);
    expect(read()).toEqual(theirs);
  });
});

describe('hooks-install: Claude Code (P7 permission hook)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let out: string[];
  const settings = () => join(home, '.claude', 'settings.json');
  const theirs = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    out = [];
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    writeFileSync(settings(), `${JSON.stringify(theirs, null, 2)}\n`);
  });
  afterEach(() => tmp.cleanup());

  const exec = (command: RunOptions['command']) =>
    run({ command, provider: 'claude-code', port: 4848, dryRun: false }, { env: {}, home, now: new Date(2026, 9, 25, 9, 30, 0), platform: 'linux', out: (l) => out.push(l), health: async () => undefined, skipVersionCheck: true });

  it('adds only PermissionRequest (matcher "*", a long timeout), keeps everything else, and uninstalls cleanly', async () => {
    expect(await exec('install')).toBe(0);
    const read = () => JSON.parse(readFileSync(settings(), 'utf8')) as typeof theirs & { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };
    const s = read();
    expect(s.model).toBe('opus');
    expect(Object.keys(s.hooks).sort()).toEqual(['PermissionRequest', 'Stop']);
    expect(s.hooks.PermissionRequest![0]!.matcher).toBe('*');
    expect(s.hooks.PermissionRequest![0]!.hooks[0]).toMatchObject({ type: 'command', command: expect.stringMatching(/claude-permission\.mjs"$/), timeout: 86_430 });
    expect(out.join('\n')).toContain('AGENT_OFFICE_INTERACTIVE=1');
    expect(await exec('uninstall')).toBe(0);
    expect(read()).toEqual(theirs);
  });
});
