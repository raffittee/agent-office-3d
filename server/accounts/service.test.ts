// Accounts and plan usage (P5-04): the statusline tap's file, Claude identity (email and organization only), Codex
// rate limits, and the snapshot's account list.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderMeta } from '../../shared/protocol';
import { accountSlug } from '../adapters/accounts';
import { tempDir } from '../test/helpers';
import { AccountsService, claudeIdentity, meaningfulOrganization, parseUsageFile, STALE_MS, usageFromCodex, type ProviderAccount } from './service';

interface TapModule {
  usageRecord(input: unknown, now: number, env?: Record<string, string>, home?: string): Record<string, unknown> | undefined;
  tap(stdin: string, env?: Record<string, string>, now?: number): boolean;
  accountSlug(dir: string, defaultDir: string, platform?: string): string;
  originalCommand(argv: string[]): string;
}
const tapMod = (await import(pathToFileURL(resolve(__dirname, '../../hooks/statusline-tap.mjs')).href)) as TapModule;

const NOW = Date.parse('2026-10-25T00:00:00Z');
const PROVIDERS: ProviderMeta[] = [
  { id: 'claude-code', label: 'Claude Code', color: '#d97757', capabilities: { transcript: true, approve: false, message: false, usage: true, subagents: true } },
  { id: 'gemini-cli', label: 'Gemini CLI', color: '#4285f4', capabilities: { transcript: false, approve: false, message: false, usage: false, subagents: true } },
  { id: 'codex', label: 'Codex', color: '#10a37f', capabilities: { transcript: false, approve: false, message: false, usage: true, subagents: true } },
];

describe('statusline tap (hooks/statusline-tap.mjs)', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => (tmp = tempDir()));
  afterEach(() => tmp.cleanup());

  it('keeps only the rate limits, filed under the same account slug the server uses', () => {
    const home = join(tmp.dir, 'home');
    const input = { session_id: 's', transcript_path: join(home, '.claude-work', 'projects', 'p', 's.jsonl'), model: { id: 'x' }, rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1792900000 }, seven_day: { used_percentage: '15' } } };
    const rec = tapMod.usageRecord(input, NOW, {}, home)!;
    expect(rec).toEqual({ provider: 'claude-code', account: accountSlug(join(home, '.claude-work'), join(home, '.claude')), fetchedAt: NOW, five_hour: { utilization: 42.4, resets_at: 1792900000 }, seven_day: { utilization: 15 } });
    expect(tapMod.usageRecord({ ...input, transcript_path: join(home, '.claude', 'projects', 'p', 's.jsonl') }, NOW, {}, home)!.account).toBe('default');
    expect(tapMod.usageRecord({ session_id: 's' }, NOW, {}, home)).toBeUndefined();
    expect(tapMod.originalCommand(['--', 'bash', '~/.claude/statusline.sh'])).toBe('bash ~/.claude/statusline.sh');
  });

  it('writes the file atomically; the server reads it back', () => {
    const data = join(tmp.dir, 'data');
    const input = JSON.stringify({ transcript_path: '/home/x/.claude/projects/p/s.jsonl', rate_limits: { five_hour: { used_percentage: 80 } } });
    expect(tapMod.tap(input, { AGENT_OFFICE_DATA_DIR: data, HOME: '/home/x' }, NOW)).toBe(true);
    expect(tapMod.tap(input, { AGENT_OFFICE_DATA_DIR: data, HOME: '/home/x' }, NOW + 1000)).toBe(false); // unchanged, too soon
    const files = readdirSync(join(data, 'usage'));
    expect(files).toEqual(['claude-code-default.json']);
    const parsed = parseUsageFile(readFileSync(join(data, 'usage', files[0]!), 'utf8'), NOW)!;
    expect(parsed).toEqual({ provider: 'claude-code', account: 'default', usage: { source: 'statusline', fetchedAt: NOW, fiveHour: { utilization: 80 } } });
    expect(tapMod.tap('not json', {}, NOW)).toBe(false);
  });
});

describe('usage sources', () => {
  it('Codex windows by duration; no quota is not 0%', () => {
    expect(usageFromCodex({ windows: [{ minutes: 10080, usedPercent: 31 }, { minutes: 300, usedPercent: 67, resetsAt: 5 }] }, NOW)).toEqual({ source: 'codex', fetchedAt: NOW, fiveHour: { utilization: 67, resetsAt: 5 }, sevenDay: { utilization: 31 } });
    expect(usageFromCodex({ windows: [], reached: 'usage_limit' }, NOW).noQuota).toBe(true);
  });

  it('tap files are validated (no path accounts, no future times)', () => {
    expect(parseUsageFile('{"provider":"claude-code","account":"../x","fetchedAt":1,"five_hour":{"utilization":1}}', NOW)).toBeUndefined();
    expect(parseUsageFile(JSON.stringify({ provider: 'claude-code', account: 'default', fetchedAt: NOW + 1e9, five_hour: { utilization: 5 } }), NOW)!.usage.fetchedAt).toBe(NOW);
    expect(parseUsageFile(JSON.stringify({ provider: 'claude-code', account: 'default', fetchedAt: NOW }), NOW)).toBeUndefined();
  });

  it("Claude identity: only the email and a meaningful organization", () => {
    const tmp = tempDir();
    try {
      const home = join(tmp.dir, 'home');
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com', organizationName: "dev@example.com's Organization", accountUuid: 'secret-ish' }, primaryApiKey: 'sk-ant-xxx' }));
      expect(claudeIdentity(join(home, '.claude'), home)).toEqual({ email: 'dev@example.com' });
      expect(meaningfulOrganization('Acme Inc', 'dev@acme.com')).toBe('Acme Inc');
      expect(claudeIdentity(join(home, '.claude-other'), home)).toEqual({});
    } finally {
      tmp.cleanup();
    }
  });
});

describe('AccountsService', () => {
  let tmp: ReturnType<typeof tempDir>;
  let clock: number;
  beforeEach(() => {
    tmp = tempDir();
    clock = NOW;
  });
  afterEach(() => tmp.cleanup());

  const service = (accounts: Record<string, ProviderAccount[]>) =>
    new AccountsService({ usageDir: join(tmp.dir, 'usage'), home: join(tmp.dir, 'home'), providers: () => PROVIDERS, accountsOf: (id) => accounts[id] ?? [], now: () => clock });

  it('lists accounts with sessions or usage, labels them, and marks old usage stale', () => {
    mkdirSync(join(tmp.dir, 'usage'));
    writeFileSync(join(tmp.dir, 'usage', 'claude-code-default.json'), JSON.stringify({ provider: 'claude-code', account: 'default', fetchedAt: NOW, five_hour: { utilization: 42 } }));
    const codexUsage = usageFromCodex({ windows: [{ minutes: 300, usedPercent: 10 }] }, NOW);
    const s = service({
      'claude-code': [{ id: 'default', dir: join(tmp.dir, 'home', '.claude') }, { id: 'ab12cd34', dir: join(tmp.dir, 'home', '.claude-work') }],
      codex: [{ id: 'default', dir: '/h/.codex', usage: codexUsage, plan: 'plus' }],
    });
    const list = s.accounts(new Map([['claude-code|ab12cd34', 2], ['gemini-cli|default', 1]]));
    expect(list.map((a) => [a.provider, a.id, a.short, a.name, a.sessions, a.usageStatus])).toEqual([
      ['claude-code', 'default', 'C', 'Claude Code', 0, 'ok'],
      ['claude-code', 'ab12cd34', 'C2', 'Claude Code (.claude-work)', 2, 'disabled'],
      ['gemini-cli', 'default', 'G', 'Gemini CLI', 1, 'disabled'],
      ['codex', 'default', 'X', 'Codex', 0, 'ok'],
    ]);
    expect(list.find((a) => a.provider === 'codex')?.plan).toBe('plus');
    // no folder path ever reaches the snapshot
    expect(JSON.stringify(list)).not.toContain(tmp.dir);
    clock = NOW + STALE_MS + 1;
    expect(s.accounts(new Map())[0]?.usageStatus).toBe('stale');
    const key = s.usageKey();
    writeFileSync(join(tmp.dir, 'usage', 'claude-code-default.json'), JSON.stringify({ provider: 'claude-code', account: 'default', fetchedAt: NOW + 5000, five_hour: { utilization: 43 } }));
    expect(s.usageKey()).not.toBe(key);
  });
});

describe('usage:install (scripts/usage-install.ts)', async () => {
  const { planInstall, planUninstall, originalOf, shQuote } = await import('../../scripts/usage-install');
  const TAP = 'node "/repo/hooks/statusline-tap.mjs"';

  it("goes in front of the user's statusline and gives it back on uninstall", () => {
    const mine = { statusLine: { type: 'command', command: `bash -c 'echo "$(pwd)"'`, padding: 0 }, theme: 'dark' };
    const p = planInstall(mine, TAP);
    expect(p.action).toBe('write');
    const installed = (p as { settings: Record<string, unknown> }).settings;
    expect((installed.statusLine as { command: string }).command).toBe(`${TAP} -- ${shQuote(`bash -c 'echo "$(pwd)"'`)}`);
    expect(originalOf((installed.statusLine as { command: string }).command)).toBe(`bash -c 'echo "$(pwd)"'`);
    expect(planInstall(installed, TAP).action).toBe('none');
    expect((planUninstall(installed) as { settings: unknown }).settings).toEqual(mine);
    // no statusline before: the tap alone, removed on uninstall
    const bare = (planInstall({ theme: 'dark' }, TAP) as { settings: Record<string, unknown> }).settings;
    expect(bare.statusLine).toEqual({ type: 'command', command: TAP });
    expect((planUninstall(bare) as { settings: unknown }).settings).toEqual({ theme: 'dark' });
    expect(planInstall({ statusLine: 'weird' }, TAP).action).toBe('skip');
    expect(planUninstall({ theme: 'dark' }).action).toBe('none');
  });
});
