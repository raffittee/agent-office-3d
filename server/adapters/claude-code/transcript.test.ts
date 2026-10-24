// Ported from habblaud server/sources/transcript.test.ts (MIT, © 2026 Márcio Junior), re-shaped for events, plus
// replays of the real (redacted) Claude Code files in test/fixtures/claude-code/.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { L } from '../../test/claude-lines';
import { tempDir } from '../../test/helpers';
import { FileTail } from '../tail';
import {
  applyTaskOp,
  createTranscriptState,
  forkDirective,
  mergePrefix,
  parseLine,
  parseTaskNotification,
  scanPrefix,
  skipRaw,
  slimInput,
  titleOf,
  type LineResult,
  type TranscriptState,
} from './transcript';

const T0 = Date.parse('2026-10-06T10:00:00Z');
const FIXTURES = resolve(__dirname, '../../../test/fixtures/claude-code');

function feed(state: TranscriptState, lines: string[]): LineResult[] {
  return lines.map((l) => parseLine(state, l, T0));
}

function events(results: LineResult[]) {
  return results.flatMap((r) => r.events);
}

function fixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim());
}

describe('parseLine: events', () => {
  it('prompt, tools and end of turn', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.prompt('Fix the failing test', { at: T0 }),
      L.assistant([L.thinking(), L.tool('r1', 'Read', { file_path: '/p/a.ts' })], { at: T0 + 1 }),
      L.result('r1', 'contents', { at: T0 + 2 }),
      L.assistant([L.text('Done.')], { at: T0 + 3, stop: 'end_turn' }),
      L.system('turn_duration', { durationMs: 4_000 }, { at: T0 + 4 }),
    ]);
    expect(events(r)).toEqual([
      { type: 'turn.start', at: T0, prompt: 'Fix the failing test' },
      { type: 'tool.start', at: T0 + 1, tool: { id: 'r1', name: 'Read', input: { file_path: '/p/a.ts' } } },
      { type: 'tool.end', at: T0 + 2, tool: { id: 'r1', name: 'Read', ok: true } },
      { type: 'turn.end', at: T0 + 4 },
    ]);
    expect(s.ended).toBe(true);
    expect(s.lastPrompt).toBe('Fix the failing test');
  });

  it('ignores meta, local commands, reminders, peer messages and unknown types', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.meta('Caveat: the messages below...'),
      L.prompt('<command-name>/clear</command-name><command-args></command-args>'),
      L.prompt('<system-reminder>be nice</system-reminder>'),
      L.prompt('<agent-message from="abc">report</agent-message>'),
      L.prompt('<local-command-stdout>ok</local-command-stdout>'),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued...' } }),
      'not json',
    ]);
    expect(events(r)).toEqual([]);
  });

  it('a work slash command becomes a prompt; secrets in prompts are masked', () => {
    const s = createTranscriptState();
    const r = feed(s, [L.prompt('<command-name>/review</command-name><command-args>PR 12</command-args>'), L.prompt('deploy with sk-proj-0123456789abcdefghij')]);
    expect(events(r).map((e) => (e.type === 'turn.start' ? e.prompt : e.type))).toEqual(['/review PR 12', expect.not.stringContaining('0123456789abcdefghij')]);
  });

  it('interruption and denial', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('a', 'Edit', { file_path: '/x/a.ts', old_string: 'secret body', new_string: 'other body' })], { at: T0 }),
      L.result('a', "The user doesn't want to proceed with this tool use.", { error: true, extraText: '[Request interrupted by user for tool use]', at: T0 + 1 }),
      L.assistant([L.tool('b', 'Write', { file_path: '/x/b.ts', content: 'file body' })], { at: T0 + 10 }),
      L.result('b', "The user doesn't want to proceed with this tool use. The tool use was rejected", { error: true, at: T0 + 11 }),
      L.assistant([L.tool('c', 'Bash', { command: 'rm -rf build' })], { at: T0 + 20 }),
      L.result('c', 'Permission to use Bash has been denied.', { error: true, at: T0 + 21, extra: { permissionDecision: { decision: 'reject', source: 'config' } } }),
      L.assistant([L.tool('d', 'PowerShell', { command: 'npm test' })], { at: T0 + 30 }),
      L.result('d', 'Exit code 3\nfailed', { error: true, at: T0 + 31 }),
    ]);
    const ev = events(r);
    // File contents never leave the adapter.
    expect(ev[0]).toEqual({ type: 'tool.start', at: T0, tool: { id: 'a', name: 'Edit', input: { file_path: '/x/a.ts' } } });
    expect(ev.slice(1)).toEqual([
      { type: 'tool.end', at: T0 + 1, tool: { id: 'a', name: 'Edit', ok: false, error: 'denied' } },
      { type: 'turn.end', at: T0 + 1, interrupted: true },
      { type: 'tool.start', at: T0 + 10, tool: { id: 'b', name: 'Write', input: { file_path: '/x/b.ts' } } },
      { type: 'tool.end', at: T0 + 11, tool: { id: 'b', name: 'Write', ok: false, error: 'denied' } },
      { type: 'tool.start', at: T0 + 20, tool: { id: 'c', name: 'Bash', input: { command: 'rm -rf build' } } },
      { type: 'tool.end', at: T0 + 21, tool: { id: 'c', name: 'Bash', ok: false, error: 'denied' } },
      { type: 'tool.start', at: T0 + 30, tool: { id: 'd', name: 'PowerShell', input: { command: 'npm test' } } },
      { type: 'tool.end', at: T0 + 31, tool: { id: 'd', name: 'PowerShell', ok: false, error: 'exit_3' } },
    ]);
  });

  it('an interrupted tool (not a refusal) is cancelled', () => {
    const s = createTranscriptState();
    const r = feed(s, [L.assistant([L.tool('a', 'Bash', { command: 'sleep 99' })]), L.result('a', 'Interrupted', { error: true, extraText: '[Request interrupted by user for tool use]' })]);
    expect(events(r)[1]).toMatchObject({ type: 'tool.end', tool: { ok: false, error: 'cancelled' } });
  });

  it('compaction, API records and credential_org are skipped or mapped', () => {
    const s = createTranscriptState();
    const api = JSON.stringify({ type: 'api-request', sessionId: 's', params: { messages: [{ role: 'user', content: 'whole conversation' }] } });
    const cred = JSON.stringify({ parentUuid: 'p', attachment: { type: 'credential_org', organization: 'x' }, type: 'attachment' });
    expect(skipRaw(api)).toBe(true);
    expect(skipRaw(cred)).toBe(true);
    // A message that merely mentions them isn't skipped.
    expect(skipRaw(L.prompt('what is "type":"credential_org"?'))).toBe(false);
    const r = feed(s, [api, cred, L.system('compact_boundary', { compactMetadata: { trigger: 'auto' } }, { at: T0 })]);
    expect(events(r)).toEqual([{ type: 'compact', at: T0 }]);
  });

  it('slimInput drops file contents and cuts long strings', () => {
    expect(slimInput({ file_path: '/a', content: 'x', edits: [{}], n: 3, flag: true, long: 'y'.repeat(600) })).toEqual({ file_path: '/a', n: 3, flag: true, long: `${'y'.repeat(499)}…` });
  });
});

describe('parseLine: titles, tasks and numbers', () => {
  it('title: custom-title > agent-name > ai-title > last prompt', () => {
    const s = createTranscriptState();
    feed(s, [L.prompt('Refactor the cart')]);
    expect(titleOf(s)).toBe('Refactor the cart');
    feed(s, [L.raw('ai-title', { aiTitle: 'Cart refactor' })]);
    expect(titleOf(s)).toBe('Cart refactor');
    feed(s, [L.raw('agent-name', { agentName: 'cart-bot' })]);
    expect(titleOf(s)).toBe('cart-bot');
    feed(s, [L.raw('custom-title', { customTitle: 'Checkout v2' })]);
    expect(titleOf(s)).toBe('Checkout v2');
  });

  it('TodoWrite replaces the list; TaskCreate/TaskUpdate edit it (id from the result)', () => {
    const s = createTranscriptState();
    feed(s, [
      L.assistant([
        L.tool('t1', 'TodoWrite', {
          todos: [
            { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
            { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' },
          ],
        }),
      ]),
    ]);
    expect(s.tasks.map((t) => [t.id, t.title, t.status])).toEqual([
      ['1', 'Read code', 'completed'],
      ['2', 'Fix', 'in_progress'],
    ]);
    const s2 = createTranscriptState();
    feed(s2, [
      L.assistant([L.tool('c1', 'TaskCreate', { subject: 'Write tests', activeForm: 'Writing tests' })]),
      L.result('c1', 'Task #7 created successfully', { toolUseResult: { task: { id: '7', subject: 'Write tests' } } }),
      L.assistant([L.tool('c2', 'TaskCreate', { subject: 'Review' })]),
      L.result('c2', 'Task #8 created successfully: Review'),
      L.assistant([L.tool('u1', 'TaskUpdate', { taskId: '7', status: 'in_progress' })]),
      L.assistant([L.tool('u2', 'TaskUpdate', { taskId: '8', status: 'deleted' })]),
    ]);
    expect(s2.tasks).toEqual([{ id: '7', title: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }]);
  });

  it("tokens: a message's lines count once (with the final usage)", () => {
    const s = createTranscriptState();
    feed(s, [
      L.assistant([L.thinking()], { msgId: 'm1', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } }),
      L.assistant([L.tool('x', 'Bash', { command: 'ls' })], { msgId: 'm1', usage: { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } }),
      L.assistant([L.text('ok')], { msgId: 'm2', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    ]);
    expect(s.tokens).toEqual({ in: 52 + 5, cached: 1000, out: 40 + 7 });
  });

  it('model, branch and permission mode', () => {
    const s = createTranscriptState();
    feed(s, [L.assistant([L.text('x')], { model: 'claude-opus-5-5', gitBranch: 'feature/x' }), L.raw('mode', { mode: 'plan' })]);
    expect(s).toMatchObject({ model: 'claude-opus-5-5', gitBranch: 'feature/x', permissionMode: 'plan' });
  });
});

describe('parseLine: subagent signals', () => {
  it('a foreground Agent: spawn and end', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('toolu_a', 'Agent', { description: 'Review code', subagent_type: 'Explore', prompt: '...' })]),
      L.result('toolu_a', 'summary', { toolUseResult: { status: 'completed', agentId: 'abc123', totalTokens: 10 } }),
    ]);
    expect(r[0]!.signals).toEqual([
      { type: 'spawn', spawn: expect.objectContaining({ toolUseId: 'toolu_a', tool: 'Agent', description: 'Review code', subagentType: 'Explore', background: false }) },
    ]);
    expect(r[1]!.signals).toEqual([{ type: 'finished', toolUseId: 'toolu_a', agentId: 'abc123', error: false }]);
  });

  it('in the background: launched (not finished), then a notification', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('toolu_b', 'Agent', { description: 'Research', subagent_type: 'fork', run_in_background: 'true' })]),
      L.result('toolu_b', 'launched', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'bg1' } }),
      L.assistant([L.tool('toolu_w', 'Workflow', { scriptPath: '/x.js' })]),
      L.result('toolu_w', 'ok', { toolUseResult: { status: 'async_launched', taskId: 'w1', runId: 'wf_1' } }),
      L.assistant([L.tool('toolu_s', 'TaskStop', { task_id: 'w1' })]),
      L.result('toolu_s', 'stopped'),
    ]);
    expect(r[0]!.signals[0]).toMatchObject({ type: 'spawn', spawn: { background: true } });
    expect(r[1]!.signals).toEqual([{ type: 'launched', toolUseId: 'toolu_b', agentId: 'bg1' }]);
    expect(r[3]!.signals).toEqual([{ type: 'launched', toolUseId: 'toolu_w', runId: 'wf_1', taskId: 'w1' }]);
    expect(r[5]!.signals).toEqual([{ type: 'stopped', taskId: 'w1' }]);
  });

  it("a fork: the inherited copy of the Agent call is neither a spawn nor an end; the directive is the prompt", () => {
    const s = createTranscriptState();
    const r = feed(s, [...L.forkStart('fk1', 'toolu_fk', 'Draw the new poses', { agentId: 'fk1' }), L.assistant([L.tool('r1', 'Read', { file_path: '/projects/demo/a.ts' })], { agentId: 'fk1' })]);
    expect(r.flatMap((x) => x.signals)).toEqual([]);
    expect(events(r).map((e) => e.type)).toEqual(['turn.start', 'tool.start']);
    expect(s.lastPrompt).toBe('Draw the new poses');
    expect(s.pendingTools.has('toolu_fk')).toBe(false);
    expect(forkDirective('<fork-boilerplate>\nrules\n</fork-boilerplate>\n\nYour directive: Do X')).toBe('Do X');
  });

  it('a queued notification (queue-operation) signals too, without events', () => {
    const s = createTranscriptState();
    const r = parseLine(s, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><tool-use-id>toolu_q</tool-use-id><status>completed</status></task-notification>' }), T0);
    expect(r.events).toEqual([]);
    expect(r.signals).toEqual([{ type: 'notification', toolUseId: 'toolu_q', status: 'completed' }]);
  });

  it('parseTaskNotification', () => {
    expect(parseTaskNotification('<task-notification><task-id>x</task-id><status>killed</status></task-notification>')).toEqual({ taskId: 'x', status: 'killed' });
  });
});

describe('parseLine: shell signals', () => {
  it('a background shell: start (label, command), launch with the task id, end by queue and by message', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('toolu_bg', 'Bash', { command: 'vendor/bin/phpunit', description: 'Run the full suite in groups with phpunit', run_in_background: true })], { at: T0 }),
      L.bgLaunched('toolu_bg', 'bo0ov3q3l', { at: T0 + 500 }),
      L.shellNotification('queue', { taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed', summary: 'Background command "x" completed (exit code 0)' }, { at: T0 + 60_000 }),
      L.shellNotification('message', { taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed' }, { at: T0 + 60_100 }),
    ]);
    expect(r[0]!.events[0]).toMatchObject({ type: 'tool.start', tool: { name: 'Bash', background: true } });
    expect(r[0]!.signals).toEqual([
      { type: 'shellStart', shell: { toolUseId: 'toolu_bg', label: 'Run the full suite in groups with phpunit', command: 'vendor/bin/phpunit', background: true, kind: 'shell', at: T0 } },
    ]);
    expect(r[1]!.signals).toEqual([{ type: 'shellResult', toolUseId: 'toolu_bg', taskId: 'bo0ov3q3l', error: false }]);
    expect(r[2]!.signals).toEqual([{ type: 'notification', taskId: 'bo0ov3q3l', toolUseId: 'toolu_bg', status: 'completed', summary: 'Background command "x" completed (exit code 0)' }]);
    expect(r[3]!.signals[0]).toMatchObject({ type: 'notification', taskId: 'bo0ov3q3l' });
    expect(r[3]!.events).toEqual([]);
  });

  it('PowerShell is a shell like Bash (P0-05)', () => {
    const s = createTranscriptState();
    const r = feed(s, [L.assistant([L.tool('ps', 'PowerShell', { command: 'npm run dev', run_in_background: true })]), L.bgLaunched('ps', 'bps1')]);
    expect(r[0]!.signals[0]).toMatchObject({ type: 'shellStart', shell: { toolUseId: 'ps', background: true, kind: 'shell' } });
    expect(r[1]!.signals).toEqual([{ type: 'shellResult', toolUseId: 'ps', taskId: 'bps1', error: false }]);
  });

  it("a foreground command's output isn't mistaken for a background id", () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('fg', 'Bash', { command: 'cat log' })]),
      L.result('fg', 'line 1\nCommand running in background with ID: bzzzz'),
      L.assistant([L.tool('bg', 'Bash', { command: 'sleep 99', run_in_background: true })]),
      // Versions without toolUseResult.backgroundTaskId: the id comes from Claude Code's own text.
      L.result('bg', 'Command running in background with ID: b7x2k9. Output is being written to: /tmp/x'),
    ]);
    expect(r[1]!.signals).toEqual([{ type: 'shellResult', toolUseId: 'fg', error: false }]);
    expect(r[3]!.signals).toEqual([{ type: 'shellResult', toolUseId: 'bg', taskId: 'b7x2k9', error: false }]);
  });

  it('Monitor is a monitor job; KillShell/TaskStop stop the id; end of turn and interruption', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('mon', 'Monitor', { description: 'errors in deploy.log', command: 'tail -f deploy.log', timeout_ms: 600000 })]),
      L.result('mon', 'Monitor started with ID: m4k2z9', { toolUseResult: { taskId: 'm4k2z9' } }),
      L.assistant([L.tool('k1', 'KillShell', { shell_id: 'bo0ov3q3l' })]),
      L.result('k1', 'killed'),
      L.system('turn_duration', { durationMs: 1_000 }),
      L.prompt('[Request interrupted by user]'),
    ]);
    expect(r[0]!.signals).toEqual([{ type: 'shellStart', shell: expect.objectContaining({ kind: 'monitor', background: true, label: 'errors in deploy.log', timeoutMs: 600000 }) }]);
    expect(r[1]!.signals).toEqual([{ type: 'shellResult', toolUseId: 'mon', taskId: 'm4k2z9', error: false }]);
    expect(r[3]!.signals).toEqual([{ type: 'stopped', taskId: 'bo0ov3q3l' }]);
    expect(r[4]!.signals).toEqual([{ type: 'turnEnd' }]);
    expect(r[5]!.signals).toEqual([{ type: 'turnEnd' }]);
  });
});

describe('the end window + the start in the background', () => {
  it('merges titles, tasks and tokens without counting twice', async () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 's.jsonl');
      const older = [
        L.raw('custom-title', { customTitle: 'Old title' }),
        L.assistant([L.tool('t', 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] })], { msgId: 'm1', usage: { input_tokens: 100, output_tokens: 10 } }),
        L.assistant([L.tool('b', 'Bash', { command: 'npm run dev', run_in_background: true })], { msgId: 'm2', usage: { input_tokens: 1, output_tokens: 1 } }),
        L.bgLaunched('b', 'bdev1'),
      ];
      const recent = [L.assistant([L.text('hi')], { msgId: 'm3', usage: { input_tokens: 5, output_tokens: 5 } }), L.assistant([L.tool('u', 'TaskUpdate', { taskId: '1', status: 'completed' })], { msgId: 'm3', usage: { input_tokens: 5, output_tokens: 6 } })];
      const head = older.map((l) => `${l}\n`).join('');
      writeFileSync(file, head + recent.map((l) => `${l}\n`).join(''));
      const tail = new FileTail(file);
      const start = tail.seekTail(Buffer.byteLength(recent.map((l) => `${l}\n`).join('')));
      expect(start).toBe(Buffer.byteLength(head));
      const state = createTranscriptState({ trackPrefix: true });
      for (const line of tail.read().lines) parseLine(state, line, T0);
      expect(state.tasks).toEqual([]);
      const prefix = await scanPrefix(file, start, new Set(state.firstMsgIds ?? []));
      mergePrefix(state, prefix.state);
      expect(titleOf(state)).toBe('Old title');
      expect(state.tasks).toEqual([{ id: '1', title: 'A', status: 'completed' }]);
      expect(state.tokens).toEqual({ in: 101 + 5, out: 11 + 6, cached: 0 });
      expect(prefix.shellEvents.map((e) => e.signal.type)).toEqual(['shellStart', 'shellResult']);
    } finally {
      tmp.cleanup();
    }
  });

  it('applyTaskOp ignores an update of an unknown task', () => {
    expect(applyTaskOp([], { op: 'update', id: 'x', status: 'completed' })).toEqual([]);
  });
});

describe('real files (redacted, test/fixtures/claude-code)', () => {
  it('session start: attachments, credential_org and API records produce nothing; tools pair up; two human prompts', () => {
    const s = createTranscriptState();
    const ev = events(feed(s, fixture('transcript-session-start.jsonl')));
    const starts = ev.filter((e) => e.type === 'tool.start');
    const ends = ev.filter((e) => e.type === 'tool.end');
    expect(starts.length).toBeGreaterThan(0);
    expect(ends.map((e) => (e.type === 'tool.end' ? e.tool.id : ''))).toEqual(starts.map((e) => (e.type === 'tool.start' ? e.tool.id : '')).slice(0, ends.length));
    // The slice holds the session's first two prompts (turnPosition.promptIndex 1 and 2).
    expect(ev.filter((e) => e.type === 'turn.start')).toHaveLength(2);
  });

  it('a denial by a permission rule is a denied tool.end', () => {
    const s = createTranscriptState();
    const ends = events(feed(s, fixture('transcript-denied.jsonl'))).filter((e) => e.type === 'tool.end');
    expect(ends.some((e) => e.type === 'tool.end' && e.tool.ok === false && e.tool.error === 'denied')).toBe(true);
  });

  it('a background shell launches and ends by notification', () => {
    const s = createTranscriptState();
    const sigs = feed(s, fixture('transcript-background-shell.jsonl')).flatMap((r) => r.signals);
    const launched = sigs.find((x) => x.type === 'shellResult' && x.taskId);
    expect(launched).toBeDefined();
    const taskId = launched?.type === 'shellResult' ? launched.taskId : undefined;
    expect(sigs.some((x) => x.type === 'notification' && x.taskId === taskId && x.status === 'completed')).toBe(true);
  });

  it('TaskStop stops a background shell', () => {
    const s = createTranscriptState();
    const sigs = feed(s, fixture('transcript-task-stop.jsonl')).flatMap((r) => r.signals);
    expect(sigs.some((x) => x.type === 'stopped')).toBe(true);
  });

  it('compaction: the boundary is an event; neither the summary record nor the /compact command is a prompt', () => {
    const s = createTranscriptState();
    const ev = events(feed(s, fixture('transcript-compact.jsonl')));
    expect(ev.filter((e) => e.type === 'compact')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'turn.start')).toHaveLength(0);
  });

  it('AskUserQuestion: the question is a tool, the answer its end', () => {
    const s = createTranscriptState();
    const ev = events(feed(s, fixture('transcript-ask-user-question.jsonl')));
    const ask = ev.find((e) => e.type === 'tool.start' && e.tool.name === 'AskUserQuestion');
    expect(ask).toBeDefined();
    expect(ev.some((e) => e.type === 'tool.end' && ask?.type === 'tool.start' && e.tool.id === ask.tool.id)).toBe(true);
  });

  it('a real subagent (2.1.310): async launch with the agent id, a task-notification; its own transcript ends with SubagentHandback', () => {
    const parent = createTranscriptState();
    const session = join(FIXTURES, 'subagent', '4bd404c0-6074-4cb6-87d4-24a3e34253c1');
    const sigs = feed(parent, readFileSync(`${session}.jsonl`, 'utf8').split('\n').filter(Boolean)).flatMap((r) => r.signals);
    expect(sigs).toContainEqual({ type: 'spawn', spawn: expect.objectContaining({ toolUseId: 'toolu_01UgnRJRcB9vP1DirnduMqJN', tool: 'Agent', subagentType: 'Explore' }) });
    expect(sigs).toContainEqual({ type: 'launched', toolUseId: 'toolu_01UgnRJRcB9vP1DirnduMqJN', agentId: 'a5ed65274bd2cc256' });
    expect(sigs).toContainEqual(expect.objectContaining({ type: 'notification', taskId: 'a5ed65274bd2cc256', toolUseId: 'toolu_01UgnRJRcB9vP1DirnduMqJN', status: 'completed' }));
    const sub = createTranscriptState();
    const ev = events(feed(sub, readFileSync(join(session, 'subagents', 'agent-a5ed65274bd2cc256.jsonl'), 'utf8').split('\n').filter(Boolean)));
    expect(ev.filter((e) => e.type === 'tool.start').map((e) => (e.type === 'tool.start' ? e.tool.name : ''))).toEqual(['Glob', 'Read', 'SubagentHandback']);
    expect(sub.ended).toBe(true);
    expect(sub.pendingTools.size).toBe(0);
    expect(sub.model).toBeDefined();
  });
});
