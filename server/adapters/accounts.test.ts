import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/helpers';
import { accountSlug, discoverClaudeAccounts, isCodexHome } from './accounts';

describe('accounts', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  it("slug: 'default' for the default folder, otherwise 8 hex characters (never the path)", () => {
    const home = tmp.dir;
    expect(accountSlug(join(home, '.claude'), join(home, '.claude'))).toBe('default');
    const other = accountSlug(join(home, '.claude-work'), join(home, '.claude'));
    expect(other).toMatch(/^[0-9a-f]{8}$/);
    expect(accountSlug(join(home, '.claude-work'), join(home, '.claude'))).toBe(other);
    if (process.platform === 'win32') expect(accountSlug(join(home, '.CLAUDE-WORK'), join(home, '.claude'))).toBe(other);
  });

  it('finds ~/.claude* folders with projects/ or sessions/, plus CLAUDE_CONFIG_DIR; skips Codex homes and plain folders', () => {
    const home = tmp.dir;
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-work', 'sessions'), { recursive: true });
    mkdirSync(join(home, '.claude-empty'), { recursive: true });
    mkdirSync(join(home, '.claude-codex', 'thread-writer-locks'), { recursive: true });
    const extra = join(home, 'elsewhere');
    mkdirSync(join(extra, 'projects'), { recursive: true });
    const found = discoverClaudeAccounts({ CLAUDE_CONFIG_DIR: extra }, home);
    expect(found.map((a) => a.dir)).toEqual([join(home, '.claude'), join(home, '.claude-work'), extra]);
    expect(found[0]!.slug).toBe('default');
    expect(isCodexHome(join(home, '.claude-codex'))).toBe(true);
  });

  it('a Codex home is told by layout only: auth.json is never opened', () => {
    const home = tmp.dir;
    mkdirSync(join(home, 'codex'), { recursive: true });
    writeFileSync(join(home, 'codex', 'auth.json'), 'not even json');
    expect(isCodexHome(join(home, 'codex'))).toBe(true);
  });

  it('AGENT_OFFICE_CLAUDE_DIRS overrides discovery', () => {
    const home = tmp.dir;
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    const only = join(home, 'only');
    mkdirSync(only);
    expect(discoverClaudeAccounts({ AGENT_OFFICE_CLAUDE_DIRS: only }, home).map((a) => a.dir)).toEqual([only]);
  });
});
