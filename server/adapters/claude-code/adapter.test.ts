// Ported from habblaud server/sources/watcher.test.ts (MIT, © 2026 Márcio Junior), rewritten for events: a fake
// Claude Code config folder, the adapter, and the real office reducer behind AdapterSet's validating context.
import { cpSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../shared/protocol';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { appendLines, L, writeLines } from '../../test/claude-lines';
import { tempDir } from '../../test/helpers';
import { AdapterSet } from '../adapter';
import { ClaudeCodeAdapter, encodeCwd } from './adapter';

setQuiet(true);

const T0 = Date.parse('2026-10-24T18:00:00Z');
const CWD = 'C:\\Users\\dev\\code\\shop';
const SID = 'sess-1';
const MAIN = `claude-code:default:${SID}`;
const FIXTURES = resolve(__dirname, '../../../test/fixtures/claude-code');

function setup() {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  let clock = T0;
  const alive = new Set<number>();
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: T0, now: () => clock });
  const set = new AdapterSet();
  const adapter = new ClaudeCodeAdapter({
    accounts: () => [{ dir, slug: 'default' }],
    now: () => clock,
    watch: false,
    isAlive: (e) => alive.has(e.pid),
  });
  set.add(adapter);
  const sent: AgentEvent[] = [];
  const ctx = set.context(office);
  const recording = { ...ctx, emit: (e: AgentEvent) => (sent.push(e), ctx.emit(e)) };
  const transcript = (sid = SID) => join(dir, 'projects', encodeCwd(CWD), `${sid}.jsonl`);
  const registry = (pid: number, fields: Record<string, unknown>) => {
    alive.add(pid);
    writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SID, cwd: CWD, startedAt: T0 - 60_000, version: '2.1.310', kind: 'interactive', status: 'idle', ...fields }));
  };
  return {
    tmp,
    dir,
    office,
    adapter,
    sent,
    transcript,
    registry,
    alive,
    boot: () => adapter.start(recording),
    poll: () => adapter.poll(),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    types: () => sent.map((e) => (e.agent ? `${e.type}@${e.agent}` : e.type)),
  };
}

type Env = ReturnType<typeof setup>;

describe('ClaudeCodeAdapter', () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => {
    env.adapter.stop();
    env.tmp.cleanup();
  });

  it('boot: an open session becomes a main agent with its room, title, activity and status, without notices', () => {
    env.registry(100, { status: 'busy', procStart: '134373347303285078' });
    writeLines(env.transcript(), [
      L.raw('ai-title', { aiTitle: 'Fix checkout' }),
      L.prompt('Fix the checkout total', { at: T0 - 5_000, sessionId: SID }),
      L.assistant([L.tool('r1', 'Read', { file_path: 'C:\\Users\\dev\\code\\shop\\cart.ts' })], { at: T0 - 4_000, sessionId: SID, model: 'claude-opus-5-5' }),
    ]);
    env.boot();
    const a = env.office.get(MAIN)!;
    expect(a).toMatchObject({ provider: 'claude-code', status: 'working', title: 'Fix checkout', model: 'claude-opus-5-5', roomId: 'c:/users/dev/code/shop' });
    expect(a.activity).toMatchObject({ kind: 'read', tool: 'Read' });
    expect(a.stats.tokensIn).toBeGreaterThan(0);
    expect(env.office.commit().notices).toEqual([]);
    // Every event carries the PID and the process start, for liveness.
    expect(env.sent.every((e) => e.pid === 100 && e.procStart === '134373347303285078')).toBe(true);
    expect(env.adapter.alive({ id: MAIN, provider: 'claude-code', lastEventAt: 0 })).toBe(true);
    expect(env.adapter.sources()).toEqual([{ provider: 'claude-code', label: 'default', path: env.dir, sessions: 1, ok: true }]);
  });

  it("follows the transcript's appends and the registry's status", () => {
    env.registry(100, { status: 'idle' });
    writeLines(env.transcript(), [L.prompt('hello', { at: T0 - 9_000 })]);
    env.boot();
    expect(env.office.get(MAIN)!.status).toBe('idle');

    env.registry(100, { status: 'busy' });
    appendLines(env.transcript(), [L.prompt('Run the tests', { at: T0 + 1 }), L.assistant([L.tool('b1', 'Bash', { command: 'npm test' })], { at: T0 + 2 })]);
    env.advance(1_000);
    env.poll();
    expect(env.office.get(MAIN)).toMatchObject({ status: 'working', activity: { kind: 'test' } });

    env.registry(100, { status: 'waiting', waitingFor: 'Allow Bash(rm -rf dist)?' });
    env.advance(1_000);
    env.poll();
    expect(env.office.get(MAIN)).toMatchObject({ status: 'waiting', waitingFor: 'approve a permission' });

    // The permission was granted: the tool's result ends the wait.
    appendLines(env.transcript(), [L.result('b1', 'ok', { at: T0 + 3_000 })]);
    env.registry(100, { status: 'busy' });
    env.advance(1_000);
    env.poll();
    expect(env.office.get(MAIN)!.status).toBe('working');

    env.registry(100, { status: 'idle' });
    env.advance(1_000);
    env.poll();
    expect(env.office.get(MAIN)!.status).toBe('idle');
    // Each change went out once.
    expect(env.types().filter((t) => t === 'waiting')).toHaveLength(1);
  });

  it('a denied tool is reported as a denial', () => {
    env.registry(100, { status: 'busy' });
    writeLines(env.transcript(), []);
    env.boot();
    appendLines(env.transcript(), [
      L.assistant([L.tool('w1', 'Write', { file_path: 'C:\\x\\a.ts', content: 'secret file body' })], { at: T0 + 1 }),
      L.result('w1', 'Permission denied', { error: true, at: T0 + 2, extra: { permissionDecision: { decision: 'reject', source: 'config' } } }),
    ]);
    env.advance(1_000);
    env.poll();
    expect(env.office.get(MAIN)!.activity).toMatchObject({ tool: 'Write', text: 'You declined: Write' });
    // File contents never leave the adapter.
    expect(JSON.stringify(env.sent)).not.toContain('secret file body');
  });

  it('a session gone from the registry leaves (offline); a dead PID with the file still there too', () => {
    env.registry(100, { status: 'idle' });
    env.registry(200, { status: 'idle', sessionId: 'sess-2' });
    env.boot();
    expect(env.office.get('claude-code:default:sess-2')?.status).toBe('idle');
    rmSync(join(env.dir, 'sessions', '100.json'));
    env.alive.delete(200);
    env.advance(1_000);
    env.poll();
    // Missing for less than 1.5 s: maybe being rewritten.
    expect(env.office.get(MAIN)!.status).toBe('idle');
    env.advance(1_600);
    env.poll();
    expect(env.office.get(MAIN)!.status).toBe('offline');
    expect(env.office.get('claude-code:default:sess-2')!.status).toBe('offline');
  });

  it('/clear: same process, new session: the same character, continuing', () => {
    env.registry(100, { status: 'idle' });
    writeLines(env.transcript(), [L.assistant([L.tool('t', 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] })], { at: T0 - 1_000 })]);
    env.boot();
    const name = env.office.get(MAIN)!.name;
    expect(env.office.get(MAIN)!.tasks).toHaveLength(1);
    env.registry(100, { status: 'idle', sessionId: 'sess-new' });
    env.advance(1_000);
    env.poll();
    expect(env.sent.find((e) => e.type === 'session.start' && e.session === 'sess-new')).toMatchObject({ continues: SID });
    const a = env.office.get(MAIN)!;
    expect(a).toMatchObject({ name, sessionId: 'sess-new', status: 'idle', tasks: [] });
  });

  it('a foreground subagent: comes in, works and delivers when done', () => {
    env.registry(100, { status: 'busy' });
    writeLines(env.transcript(), [L.assistant([L.tool('toolu_a', 'Agent', { description: 'Review the cart', subagent_type: 'Explore', prompt: '…' })], { at: T0 - 1_000 })]);
    env.boot();
    const subFile = join(env.transcript().replace(/\.jsonl$/, ''), 'subagents', 'agent-abc.jsonl');
    writeLines(subFile, [L.prompt('Review the cart', { at: T0 + 1, agentId: 'abc' }), L.assistant([L.tool('g1', 'Grep', { pattern: 'total' })], { at: T0 + 2, agentId: 'abc' })]);
    writeFileSync(subFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Review the cart', toolUseId: 'toolu_a' }));
    env.advance(1_000);
    env.poll();
    const SUB = `${MAIN}:abc`;
    expect(env.office.get(SUB)).toMatchObject({ kind: 'sub', parentId: MAIN, role: 'Explore', title: 'Review the cart', status: 'working', activity: { kind: 'search' } });
    appendLines(env.transcript(), [L.result('toolu_a', 'summary', { at: T0 + 5_000, toolUseResult: { status: 'completed', agentId: 'abc' } })]);
    env.advance(1_000);
    env.poll();
    expect(env.office.get(SUB)!.status).toBe('done');
    expect(env.office.commit().notices.map((n) => n.text)).toContainEqual(expect.stringContaining('delivered'));
  });

  it('a real background subagent (2.1.310 capture): appears when its file does, works, and leaves with the task-notification', () => {
    const real = join(FIXTURES, 'subagent', '4bd404c0-6074-4cb6-87d4-24a3e34253c1');
    const parentLines = readFileSync(`${real}.jsonl`, 'utf8').split('\n').filter(Boolean);
    // Parent: the Agent call and its async launch; later the notifications.
    env.registry(100, { status: 'busy' });
    writeLines(env.transcript(), parentLines.slice(0, 2));
    env.boot();
    const subs = join(env.transcript().replace(/\.jsonl$/, ''), 'subagents');
    mkdirSync(subs, { recursive: true });
    cpSync(join(real, 'subagents', 'agent-a5ed65274bd2cc256.jsonl'), join(subs, 'agent-a5ed65274bd2cc256.jsonl'));
    // While it runs, the meta has no `finished` yet.
    const meta = JSON.parse(readFileSync(join(real, 'subagents', 'agent-a5ed65274bd2cc256.meta.json'), 'utf8')) as Record<string, unknown>;
    delete meta.finished;
    writeFileSync(join(subs, 'agent-a5ed65274bd2cc256.meta.json'), JSON.stringify(meta));
    env.advance(1_000);
    env.poll();
    const SUB = `${MAIN}:a5ed65274bd2cc256`;
    expect(env.office.get(SUB)).toMatchObject({ role: 'Explore', title: 'List the ADR files', background: true });
    expect(env.office.detail(SUB)!.history.map((h) => h.tool).filter(Boolean)).toEqual(['Glob', 'Read', 'SubagentHandback']);
    appendLines(env.transcript(), parentLines.slice(2));
    env.advance(1_000);
    env.poll();
    expect(env.office.get(SUB)!.status).toBe('done');
  });

  it("a finished subagent's meta (finished: true) is enough to end it", () => {
    env.registry(100, { status: 'busy' });
    writeLines(env.transcript(), []);
    env.boot();
    const subFile = join(env.transcript().replace(/\.jsonl$/, ''), 'subagents', 'agent-x1.jsonl');
    writeLines(subFile, [L.prompt('go', { at: T0 + 1, agentId: 'x1' })]);
    const metaFile = subFile.replace(/\.jsonl$/, '.meta.json');
    writeFileSync(metaFile, JSON.stringify({ agentType: 'Explore' }));
    env.advance(1_000);
    env.poll();
    expect(env.office.get(`${MAIN}:x1`)!.status).toBe('working');
    writeFileSync(metaFile, JSON.stringify({ agentType: 'Explore', finished: true }));
    env.advance(1_000);
    env.poll();
    expect(env.office.get(`${MAIN}:x1`)!.status).toBe('done');
  });

  it('at boot only subagents written in the last 90 s and not finished come in', () => {
    env.registry(100, { status: 'busy' });
    writeLines(env.transcript(), []);
    const dir = join(env.transcript().replace(/\.jsonl$/, ''), 'subagents');
    writeLines(join(dir, 'agent-old.jsonl'), [L.prompt('old', { at: T0 - 600_000 })]);
    writeLines(join(dir, 'agent-new.jsonl'), [L.prompt('new', { at: T0 - 1_000 })]);
    const past = new Date(T0 - 600_000);
    utimesSync(join(dir, 'agent-old.jsonl'), past, past);
    utimesSync(join(dir, 'agent-new.jsonl'), new Date(T0 - 1_000), new Date(T0 - 1_000));
    env.boot();
    expect(env.office.has(`${MAIN}:old`)).toBe(false);
    expect(env.office.get(`${MAIN}:new`)?.status).toBe('working');
  });

  describe('waiting for the shell', () => {
    it('a background shell becomes a job; registry "shell" keeps the agent waiting for it; the notification ends it', () => {
      env.registry(100, { status: 'busy' });
      writeLines(env.transcript(), []);
      env.boot();
      appendLines(env.transcript(), [
        L.assistant([L.tool('toolu_bg', 'Bash', { command: 'npm run build', description: 'Build the app', run_in_background: true })], { at: T0 + 1 }),
        L.bgLaunched('toolu_bg', 'bbuild1', { at: T0 + 2 }),
        L.system('turn_duration', { durationMs: 10 }, { at: T0 + 3 }),
      ]);
      env.registry(100, { status: 'shell' });
      env.advance(1_000);
      env.poll();
      expect(env.office.get(MAIN)).toMatchObject({ status: 'shell', jobs: [{ id: 'toolu_bg', label: 'Build the app', background: true }] });
      appendLines(env.transcript(), [L.shellNotification('queue', { taskId: 'bbuild1', toolUseId: 'toolu_bg', status: 'completed', summary: 'Background command "Build the app" completed (exit code 0)' }, { at: T0 + 60_000 })]);
      env.registry(100, { status: 'idle' });
      env.advance(1_000);
      env.poll();
      const a = env.office.get(MAIN)!;
      expect(a.status).toBe('idle');
      expect(a.jobs).toBeUndefined();
      expect(env.office.commit().notices.map((n) => n.text)).toContainEqual(expect.stringContaining('shell finished'));
    });

    it('a failed background shell ends as a failure', () => {
      env.registry(100, { status: 'busy' });
      writeLines(env.transcript(), []);
      env.boot();
      appendLines(env.transcript(), [L.assistant([L.tool('bg', 'PowerShell', { command: 'npm test', run_in_background: true })], { at: T0 + 1 }), L.bgLaunched('bg', 'btest', { at: T0 + 2 })]);
      env.registry(100, { status: 'shell' });
      env.advance(1_000);
      env.poll();
      appendLines(env.transcript(), [L.shellNotification('queue', { taskId: 'btest', toolUseId: 'bg', status: 'completed', summary: 'Background command "npm test" completed (exit code 1)' }, { at: T0 + 9_000 })]);
      env.advance(1_000);
      env.poll();
      expect(env.sent.find((e) => e.type === 'job.end')).toMatchObject({ job: { id: 'bg', ok: false } });
    });

    it('registry "shell" without a known shell gets a stand-in job', () => {
      env.registry(100, { status: 'shell' });
      writeLines(env.transcript(), []);
      env.boot();
      expect(env.office.get(MAIN)).toMatchObject({ status: 'shell', jobs: [{ id: 'registry-shell' }] });
      env.registry(100, { status: 'idle' });
      env.advance(1_000);
      env.poll();
      expect(env.office.get(MAIN)!.status).toBe('idle');
    });
  });
});

describe('real session on this machine (smoke, read-only)', () => {
  it.runIf(!!process.env.AGENT_OFFICE_SMOKE_CLAUDE)('the open Claude Code sessions show up', () => {
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now() });
    const set = new AdapterSet();
    const adapter = new ClaudeCodeAdapter({ watch: false });
    set.add(adapter);
    adapter.start(set.context(office));
    adapter.stop();
    expect(office.list().filter((a) => a.provider === 'claude-code').length).toBeGreaterThan(0);
  });
});
