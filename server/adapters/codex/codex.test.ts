// Codex (P5-01): the hook shim's body, the rollout parser, and P5-01's real captures (Codex 0.164.0 driven offline
// against a stub model; test/fixtures/codex/) replayed through the adapter and the office reducer: rollouts only,
// hooks only, and both together (each fact once).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Office } from '../../../shared/model/office';
import type { AgentEvent } from '../../../shared/protocol';
import { describeCodexTool } from '../../../shared/tools/codex';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { tempDir } from '../../test/helpers';
import { AdapterSet } from '../adapter';
import { CodexAdapter, findRollout, LOCKS_DIR } from './adapter';
import { isRolloutPath, parseHookBody } from './hook';
import { createRolloutState, parseRateLimits, parseRolloutLine, type RolloutItem } from './rollout';

setQuiet(true);

const FIXTURES = resolve(__dirname, '../../../test/fixtures/codex');
const MAIN = '01a16fe8-b06f-7d41-b4b5-b9df82fd2dff';
const SUB = '01a16fe8-befb-75c0-b045-ff998862404c';

interface ShimModule {
  buildBody(input: Record<string, unknown>, resolvePid?: () => number, env?: Record<string, string>): Record<string, unknown> | undefined;
  toolResult(name: string, response: unknown): Record<string, unknown>;
}
const shim = (await import(pathToFileURL(resolve(__dirname, '../../../hooks/codex.mjs')).href)) as ShimModule;

function lines(file: string): string[] {
  return readFileSync(join(FIXTURES, file), 'utf8').split('\n').filter((l) => l.trim());
}

function items(file: string): RolloutItem[] {
  const s = createRolloutState();
  return lines(file).flatMap((l) => parseRolloutLine(s, l, 0));
}

const hookPayloads = () => lines('hooks.jsonl').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('hook shim body (hooks/codex.mjs)', () => {
  it('keeps what the office needs and drops content', () => {
    const all = hookPayloads().map((p) => shim.buildBody(p, () => 4242, {})!);
    const text = JSON.stringify(all);
    expect(text).not.toContain('+hello'); // apply_patch file contents
    expect(text).not.toContain('There are 3 files'); // the subagent's reply (last_assistant_message)
    expect(text).not.toContain('All done.');
    expect(all.filter((b) => 'pid' in b)).toHaveLength(2); // SessionStart only (two sessions captured)
    const patch = all.find((b) => b.hook_event_name === 'PreToolUse' && b.tool_name === 'apply_patch')!;
    expect(patch.tool_input).toEqual({ files: ['notes.md', 'x.txt'] });
    const spawn = all.find((b) => b.hook_event_name === 'PostToolUse' && b.tool_name === 'spawn_agent')!;
    expect(spawn.tool_result).toEqual({ agent_id: SUB, nickname: 'Einstein' });
    const sub = all.find((b) => b.hook_event_name === 'PreToolUse' && b.agent_id === SUB)!;
    expect(sub).toMatchObject({ session_id: MAIN, tool_name: 'Bash', tool_input: { command: 'ls | wc -l' } });
  });

  it('reads exit codes, background exec sessions and rejections from the tool output', () => {
    expect(shim.toolResult('Bash', 'Chunk ID: 1\nProcess exited with code 2\nOutput:\n')).toEqual({ exit_code: 2 });
    expect(shim.toolResult('Bash', 'Process running with session ID 21802\n')).toEqual({ exec_session: 21802 });
    expect(shim.toolResult('apply_patch', 'Exit code: 0\nWall time: 0 seconds')).toEqual({ exit_code: 0 });
    expect(shim.toolResult('Bash', 'approval policy is Never; reject command — x')).toEqual({ rejected: true });
  });

  it('the server accepts only real-looking ids and rollout paths', () => {
    const body = shim.buildBody(hookPayloads()[0]!, () => 1, {})!;
    expect(parseHookBody(body, 0)).toMatchObject({ event: 'SessionStart', sessionId: MAIN, pid: 1, transcriptPath: expect.stringContaining('rollout-') });
    expect(parseHookBody({ ...body, session_id: '../../etc' }, 0)).toBeUndefined();
    expect(parseHookBody({ ...body, transcript_path: '/etc/passwd' }, 0)?.transcriptPath).toBeUndefined();
    expect(isRolloutPath('/home/u/.codex/sessions/2026/10/24/rollout-2026-10-24T21-54-42-x.jsonl')).toBe(true);
    expect(isRolloutPath('/home/u/.codex/sessions/2026/10/24/../../../../.ssh/rollout-x.jsonl')).toBe(false);
    expect(isRolloutPath('/home/u/.codex/archived_sessions/rollout-x.jsonl')).toBe(true);
    expect(isRolloutPath('relative/sessions/2026/10/24/rollout-x.jsonl')).toBe(false);
  });
});

describe('rollout parser', () => {
  it('turns the main thread into turns, tools, a background job, a spawned subagent and tokens', () => {
    const all = items('rollout-main.jsonl');
    const kinds = all.map((i) => i.type);
    expect(kinds[0]).toBe('meta');
    expect(all.find((i) => i.type === 'turn.start')).toMatchObject({ prompt: 'do the work' });
    expect(all.filter((i) => i.type === 'tool.start').map((i) => (i as { name: string }).name)).toEqual(['exec_command', 'exec_command', 'write_stdin', 'spawn_agent', 'wait_agent', 'exec_command']);
    expect(all.find((i) => i.type === 'job.start')).toMatchObject({ jobId: 'exec:21802', command: 'sleep 3; echo built' });
    expect(all.find((i) => i.type === 'job.end')).toMatchObject({ jobId: 'exec:21802' });
    expect(all.find((i) => i.type === 'spawned')).toMatchObject({ agentId: SUB, nickname: 'Einstein', task: 'SUBTASK: count the files in this folder' });
    const rejected = all.filter((i) => i.type === 'tool.end').pop();
    expect(rejected).toMatchObject({ ok: false, error: 'rejected' });
    expect(all.filter((i) => i.type === 'usage')[0]).toMatchObject({ tokens: { in: 1200, out: 50, cached: 300 } });
    expect(kinds[kinds.length - 1]).toBe('turn.end');
  });

  it("reads a subagent's parent from its session_meta, and apply_patch's files", () => {
    const meta = items('rollout-subagent.jsonl').find((i) => i.type === 'meta');
    expect(meta).toMatchObject({ meta: { threadId: SUB, parentThreadId: MAIN, nickname: 'Einstein', internal: false } });
    const patch = items('rollout-patch.jsonl').find((i) => i.type === 'tool.start')!;
    expect(describeCodexTool('apply_patch', (patch as { input: unknown }).input).text).toBe('Editing 2 files');
  });

  it('plan usage from rate_limits (only the default codex limit)', () => {
    expect(parseRateLimits({ limit_id: 'codex', primary: { used_percent: 42, window_minutes: 300, resets_at: 1792900000 }, secondary: { used_percent: 7, window_minutes: 10080 }, plan_type: 'plus' })).toEqual({
      windows: [
        { minutes: 300, usedPercent: 42, resetsAt: 1792900000000 },
        { minutes: 10080, usedPercent: 7 },
      ],
      planType: 'plus',
    });
    expect(parseRateLimits({ limit_id: 'codex', primary: null, rate_limit_reached_type: 'usage_limit' })).toEqual({ windows: [], reached: 'usage_limit' });
    expect(parseRateLimits({ limit_id: 'other', primary: { used_percent: 1, window_minutes: 300 } })).toBeUndefined();
    // the stub's rollouts carry an empty rate_limits: no usage
    expect(items('rollout-main.jsonl').some((i) => i.type === 'usage' && i.rateLimits)).toBe(false);
  });
});

describe('the Codex tool table', () => {
  it('describes the tools Codex 0.164 offers, under the names rollouts and hooks use', () => {
    expect(describeCodexTool('exec_command', { cmd: 'npm test' }).kind).toBe('test');
    expect(describeCodexTool('Bash', { command: 'git status' }).kind).toBe('git');
    expect(describeCodexTool('multi_agent_v1wait_agent', {}).text).toBe('Waiting for the subagents');
    expect(describeCodexTool('spawn_agent', { message: 'count files' })).toMatchObject({ kind: 'delegate', detail: 'count files' });
    expect(describeCodexTool('apply_patch', { files: ['src/a.ts'] }).text).toBe('Editing a.ts');
    expect(describeCodexTool('apply_patch', { input: '*** Begin Patch\n*** Add File: b.md\n+x\n*** End Patch' }).text).toBe('Writing b.md');
    expect(describeCodexTool('request_user_input', {}).kind).toBe('ask');
    expect(describeCodexTool('mcp__github__create_issue', {}).text).toBe('Using create issue');
  });
});

describe('Codex adapter', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let day: string;
  let clock: number;
  let office: Office;
  let adapter: CodexAdapter;
  let emitted: AgentEvent[];

  const lock = (id: string) => writeFileSync(join(home, LOCKS_DIR, `${id}.lock`), '');
  const unlock = (id: string) => rmSync(join(home, LOCKS_DIR, `${id}.lock`));
  const copy = (file: string, name: string) => copyFileSync(join(FIXTURES, file), join(day, name));
  const make = () => {
    office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, now: () => clock });
    adapter = new CodexAdapter({ now: () => clock, homes: [{ dir: home, slug: 'default' }], home: tmp.dir, pollMs: 1e9 });
    const set = new AdapterSet([adapter]);
    const ctx = set.context(office);
    emitted = [];
    adapter.start({
      emit: (e) => {
        emitted.push(e);
        ctx.emit(e);
      },
      beginBoot: ctx.beginBoot,
      endBoot: ctx.endBoot,
    });
    adapter.stop();
  };
  const poll = () => {
    clock += 3_000;
    for (const e of adapter.poll()) {
      emitted.push(e);
      office.apply(e);
    }
  };
  const hook = (p: Record<string, unknown>) => {
    // the home as a JSON string's inside (Windows paths have backslashes)
    const body = shim.buildBody(JSON.parse(JSON.stringify(p).replaceAll('/home/dev/.codex', JSON.stringify(home).slice(1, -1))), () => 777, {});
    for (const e of adapter.onHook(body)) {
      emitted.push(e);
      office.apply(e);
    }
  };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, '.codex');
    day = join(home, 'sessions', '2026', '10', '24');
    mkdirSync(day, { recursive: true });
    mkdirSync(join(home, LOCKS_DIR));
    clock = Date.parse('2026-10-24T21:55:00Z');
  });
  afterEach(() => tmp.cleanup());

  it('finds a thread’s rollout by id', () => {
    copy('rollout-main.jsonl', `rollout-2026-10-24T21-54-42-${MAIN}.jsonl`);
    expect(findRollout(home, MAIN)).toContain(MAIN);
    expect(findRollout(home, SUB)).toBeUndefined();
    expect(findRollout(home, '../x')).toBeUndefined();
  });

  it('without hooks: locks find the sessions, rollouts rebuild them (subagent included), a lock gone ends one', () => {
    copy('rollout-main.jsonl', `rollout-2026-10-24T21-54-42-${MAIN}.jsonl`);
    copy('rollout-subagent.jsonl', `rollout-2026-10-24T21-54-46-${SUB}.jsonl`);
    lock(MAIN);
    lock(SUB);
    make();
    const types = emitted.map((e) => `${e.agent ? 'sub:' : ''}${e.type}`);
    expect(types.filter((t) => t === 'session.start')).toHaveLength(1);
    expect(types).toContain('sub:subagent.start');
    expect(types).toContain('sub:subagent.end');
    expect(types).toContain('job.start');
    expect(types).toContain('job.end');
    expect(emitted.find((e) => e.type === 'turn.start' && !e.agent)?.prompt).toBe('do the work');
    const sub = emitted.find((e) => e.type === 'subagent.start')!;
    expect(sub).toMatchObject({ session: MAIN, agent: SUB, cwd: '/home/dev/shop', subagent: { role: 'Einstein', title: 'SUBTASK: count the files in this folder' } });
    // each tool once
    const starts = emitted.filter((e) => e.type === 'tool.start').map((e) => e.tool!.id);
    expect(new Set(starts).size).toBe(starts.length);
    const main = office.commit().snapshot.agents.find((a) => a.kind === 'main')!;
    expect(main).toMatchObject({ provider: 'codex', status: 'idle' });
    expect(main.stats.tokensIn).toBeGreaterThan(0);
    // the session closes when Codex releases its lock
    expect(adapter.alive({ id: `codex:default:${MAIN}`, provider: 'codex', lastEventAt: clock })).toBe(true);
    unlock(MAIN);
    unlock(SUB);
    poll();
    expect(emitted[emitted.length - 1]).toMatchObject({ type: 'session.end', session: MAIN });
    expect(adapter.alive({ id: `codex:default:${MAIN}`, provider: 'codex', lastEventAt: clock })).toBe(false);
  });

  it('with hooks and rollouts: each turn, tool and subagent is reported once, with the PID', () => {
    make();
    copy('rollout-main.jsonl', `rollout-2026-10-24T21-54-42-${MAIN}.jsonl`);
    copy('rollout-subagent.jsonl', `rollout-2026-10-24T21-54-46-${SUB}.jsonl`);
    for (const p of hookPayloads().filter((p) => p.session_id === MAIN)) hook(p);
    poll();
    const turnStarts = emitted.filter((e) => e.type === 'turn.start' && !e.agent);
    expect(turnStarts).toHaveLength(1);
    const ids = emitted.filter((e) => e.type === 'tool.start').map((e) => e.tool!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(emitted.filter((e) => e.type === 'subagent.start')).toHaveLength(1);
    expect(emitted.filter((e) => e.type === 'subagent.end')).toHaveLength(1);
    expect(emitted.every((e) => e.pid === 777)).toBe(true);
    // the subagent's own tool came from its hooks, filed under it
    expect(emitted.find((e) => e.type === 'tool.start' && e.agent === SUB)?.tool).toMatchObject({ id: 'call_6', name: 'Bash' });
    expect(emitted.filter((e) => e.type === 'session.end')).toHaveLength(1);
    const snap = office.commit().snapshot;
    expect(snap.agents.find((a) => a.kind === 'main')?.status).toBe('offline');
  });

  it('a permission request waits; an apply_patch never carries file contents', () => {
    make();
    const patchHooks = hookPayloads().filter((p) => p.session_id !== MAIN);
    for (const p of patchHooks.slice(0, 3)) hook(p);
    const sid = patchHooks[0]!.session_id as string;
    hook({ hook_event_name: 'PermissionRequest', session_id: sid, turn_id: 't1', cwd: '/home/dev/shop', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    const waiting = emitted.find((e) => e.type === 'waiting')!;
    expect(waiting.waiting).toEqual({ reason: 'permission', text: 'rm -rf build' });
    expect(office.commit().snapshot.agents[0]?.status).toBe('waiting');
    expect(JSON.stringify(emitted)).not.toContain('+hello');
  });
});
