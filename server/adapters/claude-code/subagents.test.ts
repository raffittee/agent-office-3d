import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concludedByIdle, END_TURN_QUIET_MS, IDLE_TIMEOUT_MS, listSubagentFiles, parseJournal, parseSubagentMeta, subagentRole } from './subagents';

const SESSION = resolve(__dirname, '../../../test/fixtures/claude-code/subagent/4bd404c0-6074-4cb6-87d4-24a3e34253c1');

describe('subagent files', () => {
  it('reads the real meta.json (2.1.310), including the finished flag and the model', () => {
    const meta = parseSubagentMeta(readFileSync(join(SESSION, 'subagents', 'agent-a5ed65274bd2cc256.meta.json'), 'utf8'));
    expect(meta).toEqual({
      agentType: 'Explore',
      description: 'List the ADR files',
      toolUseId: 'toolu_01UgnRJRcB9vP1DirnduMqJN',
      spawnDepth: 1,
      requestShape: 'background',
      model: 'haiku',
      finished: true,
    });
    expect(subagentRole(meta)).toBe('Explore');
    expect(subagentRole(undefined)).toBe('Subagent');
    expect(subagentRole({ agentType: 'workflow-subagent' })).toBe('Workflow');
    expect(parseSubagentMeta('{')).toBeUndefined();
  });

  it('lists agent files, workflows included', () => {
    expect(listSubagentFiles(`${SESSION}-missing`)).toEqual([]);
    expect(listSubagentFiles(SESSION)).toEqual([
      { agentId: 'a5ed65274bd2cc256', path: join(SESSION, 'subagents', 'agent-a5ed65274bd2cc256.jsonl'), metaPath: join(SESSION, 'subagents', 'agent-a5ed65274bd2cc256.meta.json') },
    ]);
  });

  it("parses a workflow's journal: labels and which agents are done", () => {
    const j = parseJournal(['{"agentId":"a1","type":"started","label":"Lint"}', '{"agentId":"a1","type":"completed"}', '{"agentId":"a2","type":"started"}', 'not json'].join('\n'));
    expect(j.get('a1')).toEqual({ label: 'Lint', done: true });
    expect(j.get('a2')).toEqual({ done: false });
  });

  it('concludes by idleness: end of turn + quiet, or a long quiet', () => {
    const now = 1_000_000;
    expect(concludedByIdle({ now, lastWriteAt: now - END_TURN_QUIET_MS, ended: true, pendingTool: false })).toBe(true);
    expect(concludedByIdle({ now, lastWriteAt: now - 1_000, ended: true, pendingTool: false })).toBe(false);
    expect(concludedByIdle({ now, lastWriteAt: now - IDLE_TIMEOUT_MS, ended: false, pendingTool: false })).toBe(true);
    expect(concludedByIdle({ now, lastWriteAt: now - IDLE_TIMEOUT_MS, ended: false, pendingTool: true })).toBe(false);
  });
});
