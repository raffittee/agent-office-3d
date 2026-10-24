// Room effects (P6-04): detection from tool calls, and the reducer's party and alarm.
import { describe, expect, it } from 'vitest';
import { NameStore } from './names';
import { setQuiet } from '../log';
import { Office } from '../../shared/model/office';
import type { AgentEvent } from '../../shared/protocol';
import { ALARM_MS, PARTY_MS, roomSignalCandidate, settleSignal, signalText } from '../../shared/room-effects';

setQuiet(true);

const sig = (tool: string, input: unknown, ok?: boolean) => settleSignal(roomSignalCandidate(tool, input), ok);

describe('detection', () => {
  it('gh in a shell call: PR, merge, release', () => {
    expect(sig('Bash', { command: 'gh pr create --title x --body y' }, true)).toEqual({ kind: 'pr_opened' });
    expect(sig('Bash', { command: 'git push -u origin feat && gh pr merge 42 --squash' }, true)).toEqual({ kind: 'pr_merged', number: 42 });
    expect(sig('run_shell_command', { command: 'gh pr merge https://github.com/o/r/pull/7' }, true)).toEqual({ kind: 'pr_merged', number: 7 });
    expect(sig('exec_command', { cmd: ['bash', '-lc', 'gh release create v1.2.0 --notes x'] }, true)).toEqual({ kind: 'release', tag: 'v1.2.0' });
    expect(sig('PowerShell', { command: 'gh pr create --fill' }, true)).toEqual({ kind: 'pr_opened' });
  });

  it('only success celebrates; auto merges, drafts and heredoc text don’t', () => {
    expect(sig('Bash', { command: 'gh pr merge 3' }, false)).toBeNull();
    expect(sig('Bash', { command: 'gh pr merge 3 --auto' }, true)).toBeNull();
    expect(sig('Bash', { command: 'gh release create v2 --draft' }, true)).toBeNull();
    expect(sig('Bash', { command: "git commit -F - <<'EOF'\ngh pr merge 9\nEOF" }, true)).toBeNull();
    expect(sig('Bash', { command: 'echo "gh pr merge 9"' }, true)).toBeNull();
    expect(sig('Read', { file_path: 'gh' }, true)).toBeNull();
  });

  it('CI watchers: green or red, but red only when gh decides the exit code', () => {
    expect(sig('Bash', { command: 'gh pr checks 12 --watch' }, true)).toEqual({ kind: 'ci_passed', number: 12 });
    expect(sig('Bash', { command: 'gh pr checks 12 --watch' }, false)).toEqual({ kind: 'ci_failed', number: 12 });
    expect(sig('Bash', { command: 'gh run watch 123 --exit-status' }, false)).toEqual({ kind: 'ci_failed' });
    expect(sig('Bash', { command: 'gh run watch 123 --exit-status | tail -5' }, false)).toBeNull();
    expect(sig('Bash', { command: 'gh run watch 123' }, false)).toBeNull();
  });

  it('GitHub MCP tools from any server prefix', () => {
    expect(sig('mcp__github__merge_pull_request', { pullNumber: 5 }, true)).toEqual({ kind: 'pr_merged', number: 5 });
    expect(sig('github__create_pull_request', {}, undefined)).toEqual({ kind: 'pr_opened' });
    expect(sig('mcp__github__create_release', { tag_name: 'v3' }, true)).toEqual({ kind: 'release', tag: 'v3' });
    expect(sig('mcp__github__get_file_contents', {}, true)).toBeNull();
    expect(sig('mcp__gitlab__merge_pull_request', {}, true)).toBeNull();
  });

  it('banners', () => {
    expect(signalText({ kind: 'pr_merged', number: 4 })).toBe('🎉 PR #4 merged!');
    expect(signalText({ kind: 'ci_failed' })).toBe('🚨 CI failed');
    expect(signalText({ kind: 'release', tag: 'v1' })).toBe('🚀 Release v1!');
  });
});

describe('in the office', () => {
  function setup() {
    let clock = 5_000_000;
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: clock, now: () => clock });
    let n = 0;
    const apply = (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}) =>
      office.apply({ v: 1, provider: 'claude-code', account: 'default', session: 's1', cwd: '/w/shop', at: clock, type, ...extra });
    const tool = (command: string, ok: boolean) => {
      const id = `t${++n}`;
      apply('tool.start', { tool: { id, name: 'Bash', input: { command } } });
      apply('tool.end', { tool: { id, name: 'Bash', ok } });
    };
    apply('session.start');
    office.commit();
    return { office, apply, tool, advance: (ms: number) => (clock += ms), room: () => office.commit().snapshot.rooms[0]! };
  }

  it('a merge throws a party that ends after PARTY_MS', () => {
    const s = setup();
    s.tool('gh pr merge 8 --squash', true);
    const r = s.office.commit();
    expect(r.snapshot.rooms[0]!.effect).toMatchObject({ kind: 'party', text: '🎉 PR #8 merged!' });
    expect(r.notices.some((x) => x.level === 'success' && x.text.includes('PR #8 merged'))).toBe(true);
    s.advance(PARTY_MS + 1);
    s.office.tick();
    expect(s.room().effect).toBeUndefined();
  });

  it('red CI raises the alarm; green CI ends it with a party; plain green CI does nothing', () => {
    const s = setup();
    s.tool('gh pr checks --watch', true);
    expect(s.room().effect).toBeUndefined();
    s.tool('gh pr checks --watch', false);
    expect(s.room().effect).toMatchObject({ kind: 'alarm', text: '🚨 CI failed' });
    s.advance(60_000);
    s.office.tick();
    expect(s.room().effect?.kind).toBe('alarm');
    s.tool('gh pr checks --watch', true);
    expect(s.room().effect).toMatchObject({ kind: 'party', text: '✅ CI green' });
  });

  it('the alarm times out; old events never fire', () => {
    const s = setup();
    s.tool('gh run watch 1 --exit-status', false);
    s.advance(ALARM_MS + 1);
    s.office.tick();
    expect(s.room().effect).toBeUndefined();
    const at = 5_000_000; // long ago
    s.apply('tool.start', { at, tool: { id: 'old', name: 'Bash', input: { command: 'gh pr merge 1' } } });
    s.apply('tool.end', { at, tool: { id: 'old', name: 'Bash', ok: true } });
    expect(s.room().effect).toBeUndefined();
  });
});
