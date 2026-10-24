// Ported from habblaud server/model/model.test.ts (MIT, © 2026 Márcio Junior), rewritten for the AgentEvent reducer.
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/protocol';
import { setQuiet } from '../log';
import { NameStore } from './names';
import { DONE_GRACE_MS, OFFLINE_GRACE_MS, Office, SNAPSHOT_RECENT, UNKNOWN_ROOM } from '../../shared/model/office';

setQuiet(true);

const START = 1_000_000;

function makeOffice() {
  let clock = START;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: clock,
    accounts: (s) => [{ id: 'default', provider: 'gemini-cli', short: 'G', name: 'Gemini', color: '#4285f4', sessions: s.get('gemini-cli|default') ?? 0, usageStatus: 'disabled' }],
    accountName: () => 'Gemini',
    now: () => clock,
  });
  const ev = (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}): AgentEvent => ({
    v: 1,
    provider: 'gemini-cli',
    account: 'default',
    session: 's1',
    cwd: 'C:\\Users\\dev\\code\\Shop',
    at: clock,
    type,
    ...extra,
  });
  return {
    office,
    ev,
    apply: (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}) => office.apply(ev(type, extra)),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

const ID = 'gemini-cli:default:s1';

describe('status machine', () => {
  it('session.start → idle, with room and arrival notices', () => {
    const { office, apply } = makeOffice();
    apply('session.start');
    const a = office.get(ID)!;
    expect(a).toMatchObject({ kind: 'main', provider: 'gemini-cli', status: 'idle', roomId: 'c:/users/dev/code/shop', role: 'Main agent' });
    const r = office.commit();
    expect(r.notices.map((n) => n.text)).toEqual(['🏗️ New room: Shop', `👋 ${a.name} arrived in Shop (Gemini)`]);
    expect(r.snapshot.rooms).toMatchObject([{ id: 'c:/users/dev/code/shop', name: 'Shop', path: 'C:\\Users\\dev\\code\\Shop', slot: 0 }]);
    expect(r.snapshot.accounts[0]!.sessions).toBe(1);
  });

  it('turn.start → working, with the prompt as an activity (masked)', () => {
    const { office, apply } = makeOffice();
    apply('session.start');
    apply('turn.start', { prompt: 'use the key sk-proj-0123456789abcdef to deploy' });
    const a = office.get(ID)!;
    expect(a.status).toBe('working');
    expect(a.activity).toMatchObject({ kind: 'prompt' });
    expect(a.activity!.detail).toBe('use the key sk-*** to deploy');
  });

  it('tool.start → working, described by the provider table, and counted', () => {
    const { office, apply } = makeOffice();
    apply('session.start');
    apply('tool.start', { tool: { name: 'read_file', input: { file_path: 'notes.txt' } } });
    const a = office.get(ID)!;
    expect(a.status).toBe('working');
    expect(a.activity).toMatchObject({ kind: 'read', text: 'Reading notes.txt', tool: 'read_file' });
    expect(a.stats.toolCalls).toBe(1);
  });

  it('waiting → waiting with a "Needs you" bubble and an alert (deduped for 10 s); a tool.end ends it', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    apply('turn.start');
    apply('tool.start', { tool: { name: 'write_file', input: { file_path: 'allowed.txt' } } });
    office.commit();
    apply('waiting', { waiting: { reason: 'permission', text: 'Confirm Write: allowed.txt' } });
    let a = office.get(ID)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'Confirm Write: allowed.txt' });
    expect(a.activity).toMatchObject({ kind: 'wait', text: 'Needs you: Confirm Write: allowed.txt' });
    expect(office.commit().notices.filter((n) => n.level === 'alert')).toHaveLength(1);
    // Allowed: AfterTool. Back to working, showing the tool again.
    apply('tool.end', { tool: { name: 'write_file', ok: true } });
    a = office.get(ID)!;
    expect(a.status).toBe('working');
    expect(a.activity).toMatchObject({ text: 'Writing allowed.txt' });
    // Another wait within 10 s: no second alert; after 10 s, a new one.
    apply('waiting', { waiting: { reason: 'permission' } });
    expect(office.commit().notices.filter((n) => n.level === 'alert')).toHaveLength(0);
    apply('turn.start');
    advance(11_000);
    apply('waiting', { waiting: { reason: 'question' } });
    expect(office.get(ID)!.waitingFor).toBe('answer a question');
    expect(office.commit().notices.filter((n) => n.level === 'alert')).toHaveLength(1);
  });

  it('waiting also ends on turn.* and tool.start', () => {
    const { office, apply } = makeOffice();
    apply('session.start');
    apply('waiting', { waiting: { reason: 'input' } });
    apply('tool.start', { tool: { name: 'glob', input: { pattern: '*.ts' } } });
    expect(office.get(ID)!.status).toBe('working');
    apply('waiting', { waiting: { reason: 'input' } });
    apply('turn.end');
    expect(office.get(ID)!.status).toBe('idle');
  });

  it('turn.end → idle with a synthesized "Done in X" and a notice', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    apply('turn.start');
    advance(30_000);
    office.commit();
    apply('turn.end');
    const a = office.get(ID)!;
    expect(a.status).toBe('idle');
    expect(a.activity).toMatchObject({ kind: 'done', text: 'Done in 30s', durationMs: 30_000 });
    expect(office.commit().notices.map((n) => n.text)).toEqual([`✅ ${a.name} finished in Shop`]);
  });

  it('a denied permission: tool.end {ok:false, denied} + turn.end → idle without "Done"', () => {
    const { office, apply } = makeOffice();
    apply('session.start');
    apply('turn.start');
    apply('tool.start', { tool: { name: 'write_file', input: { file_path: 'denied2.txt' } } });
    apply('waiting', { waiting: { reason: 'permission' } });
    apply('tool.end', { tool: { name: 'write_file', ok: false, error: 'denied' } });
    expect(office.get(ID)!.status).toBe('working');
    apply('turn.end');
    const a = office.get(ID)!;
    expect(a.status).toBe('idle');
    expect(a.activity).toMatchObject({ kind: 'wait', text: 'You declined: write_file' });
    expect(a.recent.some((x) => x.kind === 'done')).toBe(false);
  });

  it('tool.end {ok:false} with another error marks an error activity with its duration', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    apply('tool.start', { tool: { name: 'run_shell_command', input: { command: 'exit 3' } } });
    advance(1_500);
    apply('tool.end', { tool: { name: 'run_shell_command', ok: false, error: 'exit_3' } });
    expect(office.get(ID)!.activity).toMatchObject({ kind: 'error', text: 'Error in run_shell_command', detail: 'exit_3', error: true, durationMs: 1_500 });
  });

  it('turn.end with background jobs → shell; the bubble waits for the shell; the last job.end → idle', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    const name = office.get(ID)!.name;
    office.commit();
    apply('turn.start');
    apply('job.start', { job: { id: '62152', label: 'Wait a bit', command: 'ping -n 4 127.0.0.1' } });
    apply('job.start', { job: { id: '62153', command: 'npm run build' } });
    apply('turn.end');
    expect(office.get(ID)!.status).toBe('shell');
    office.tick();
    expect(office.get(ID)!.activity).toMatchObject({ text: 'Waiting for 2 shells: Wait a bit', detail: 'ping -n 4 127.0.0.1', tool: 'JobWait' });
    let r = office.commit();
    expect(r.notices.map((n) => n.text)).toEqual([`⏳ ${name} is waiting for the shell in Shop: Wait a bit`]);
    expect(r.notices.some((n) => n.text.includes('finished in Shop'))).toBe(false);
    advance(63_000);
    apply('job.end', { job: { id: '62152', ok: true } });
    expect(office.get(ID)!.status).toBe('shell');
    expect(office.get(ID)!.activity).toMatchObject({ tool: 'JobDone', text: 'Shell finished: Wait a bit (1min 3s)' });
    apply('job.end', { job: { id: '62153', ok: false } });
    expect(office.get(ID)!.status).toBe('idle');
    r = office.commit();
    expect(r.notices.map((n) => [n.level, n.text])).toEqual([
      ['success', `✅ ${name}: shell finished in Shop — Wait a bit`],
      ['warn', `❌ ${name}: shell failed in Shop — Building the project`],
    ]);
    // The same job.end again (replay) changes nothing.
    apply('job.end', { job: { id: '62153', ok: false } });
    expect(office.commit().notices).toEqual([]);
  });

  it('subagent.start → a working subagent; subagent.end → done, delivered, gone after the grace period', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    apply('subagent.start', { agent: 'sub-1', subagent: { role: 'generalist', title: 'List the files' } });
    const sub = office.get(`${ID}:sub-1`)!;
    expect(sub).toMatchObject({ kind: 'sub', parentId: ID, status: 'working', role: 'generalist', title: 'List the files', provider: 'gemini-cli' });
    expect(office.get(ID)!.stats.subagents).toBe(1);
    apply('tool.start', { agent: 'sub-1', tool: { name: 'list_directory', input: { dir_path: '.' } } });
    expect(office.get(`${ID}:sub-1`)!.activity).toMatchObject({ kind: 'read' });
    office.commit();
    apply('subagent.end', { agent: 'sub-1', subagent: { ok: true } });
    expect(office.get(`${ID}:sub-1`)!.status).toBe('done');
    expect(office.commit().notices.at(-1)?.text).toBe(`📦 ${sub.name} delivered “List the files” to ${office.get(ID)!.name}`);
    // A finished subagent doesn't go back to working on a stray event.
    apply('tool.start', { agent: 'sub-1', tool: { name: 'glob' } });
    expect(office.get(`${ID}:sub-1`)!.status).toBe('done');
    advance(DONE_GRACE_MS + 1);
    office.tick();
    expect(office.has(`${ID}:sub-1`)).toBe(false);
  });

  it('events from an unknown subagent create it under the main agent', () => {
    const { office, apply } = makeOffice();
    apply('tool.start', { agent: 'x', tool: { name: 'read_file', input: { file_path: 'a.ts' } } });
    expect(office.get(ID)).toBeDefined();
    expect(office.get(`${ID}:x`)).toMatchObject({ kind: 'sub', parentId: ID, role: 'Subagent' });
    // subagent.end for an unknown one is ignored.
    apply('subagent.end', { agent: 'never-seen' });
    expect(office.has(`${ID}:never-seen`)).toBe(false);
  });

  it('session.end → offline (twice is harmless); subagents leave too; removed with the room after the grace period', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    apply('subagent.start', { agent: 'bg', subagent: { background: true } });
    office.commit();
    apply('session.end');
    apply('session.end');
    expect(office.get(ID)!.status).toBe('offline');
    expect(office.get(`${ID}:bg`)!.status).toBe('done');
    expect(office.commit().notices.filter((n) => n.text.includes('ended the session'))).toHaveLength(1);
    advance(OFFLINE_GRACE_MS + 1);
    office.tick();
    const snap = office.commit().snapshot;
    expect(snap.agents).toEqual([]);
    expect(snap.rooms).toEqual([]);
  });

  it('liveness lost → offline; any later event brings the agent back', () => {
    const { office, apply } = makeOffice();
    apply('session.start', { pid: 14152, procStart: '134372522336881641' });
    expect(office.livenessTargets()).toEqual([{ id: ID, provider: 'gemini-cli', pid: 14152, procStart: '134372522336881641', lastEventAt: START }]);
    office.markOffline(ID);
    expect(office.get(ID)!.status).toBe('offline');
    expect(office.livenessTargets()).toEqual([]);
    apply('heartbeat');
    expect(office.get(ID)!.status).toBe('idle');
  });

  it('an agent first seen mid-session is created on its first event; no cwd → the "(no project)" room', () => {
    const { office } = makeOffice();
    office.apply({ v: 1, provider: 'custom:bot', account: 'default', session: 'x', at: START, type: 'turn.start' });
    expect(office.get('custom:bot:default:x')).toMatchObject({ status: 'working', roomId: UNKNOWN_ROOM });
  });
});

describe('/clear and continuity', () => {
  it('SessionEnd(clear) then SessionStart(clear, continues): same character and id, new session', () => {
    const { office, apply } = makeOffice();
    apply('session.start');
    apply('turn.start', { prompt: 'first task' });
    apply('tasks', { tasks: [{ id: '1', title: 'Write tests', status: 'in_progress' }] });
    const before = office.get(ID)!;
    apply('session.end');
    expect(office.get(ID)!.status).toBe('offline');
    apply('session.start', { session: 's2', continues: 's1' });
    const a = office.get(ID)!;
    expect(a).toMatchObject({ id: ID, name: before.name, sessionId: 's2', status: 'idle', tasks: [] });
    expect(a.activity).toMatchObject({ kind: 'compact', text: 'Started a new conversation (/clear)' });
    // Later events of the new session reach the same agent.
    apply('turn.start', { session: 's2', prompt: 'after clear' });
    expect(office.get(ID)!.status).toBe('working');
    expect(office.has('gemini-cli:default:s2')).toBe(false);
    expect(office.resolve({ provider: 'gemini-cli', account: 'default', session: 's2', agent: 'a' })).toBe(`${ID}:a`);
  });

  it('continues with an unknown session just starts a new agent', () => {
    const { office, apply } = makeOffice();
    apply('session.start', { session: 's9', continues: 'never-seen' });
    expect(office.has('gemini-cli:default:s9')).toBe(true);
  });
});

describe('boot', () => {
  it('no notices while booting; the feed comes out in order; a waiting agent gets its bubble at the end', () => {
    const { office, apply, now } = makeOffice();
    office.beginBoot();
    office.beginBoot();
    apply('session.start');
    apply('tool.start', { at: now() - 1_000, tool: { name: 'read_file', id: 'late', input: { file_path: 'b.ts' } } });
    apply('tool.start', { at: now() - 5_000, tool: { name: 'read_file', id: 'early', input: { file_path: 'a.ts' } } });
    apply('waiting', { waiting: { reason: 'question', text: 'Which database?' } });
    office.endBoot();
    expect(office.isBooting()).toBe(true);
    expect(office.commit().notices).toEqual([]);
    office.endBoot();
    expect(office.isBooting()).toBe(false);
    expect(office.recentFeed(10).map((f) => f.id)).toEqual([`${ID}#tool:early`, `${ID}#tool:late`]);
    const r = office.commit();
    expect(r.notices).toEqual([]);
    expect(r.snapshot.agents[0]!.activity).toMatchObject({ kind: 'wait', text: 'Needs you: Which database?' });
    // Extra endBoot is ignored.
    office.endBoot();
    expect(office.isBooting()).toBe(false);
  });
});

describe('snapshot, feed and history', () => {
  it('rev changes only when something changed', () => {
    const { office } = makeOffice();
    const r1 = office.commit();
    const r2 = office.commit();
    expect(r2.changed).toBe(false);
    expect(r2.snapshot.rev).toBe(r1.snapshot.rev);
  });

  it('the snapshot carries the last activities, the detail the long history; feed items carry the provider', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    for (let i = 0; i < 20; i++) {
      advance(1_000);
      apply('tool.start', { tool: { id: `t${i}`, name: 'read_file', input: { file_path: `f${i}.ts` } } });
    }
    const r = office.commit();
    expect(r.feed.every((f) => f.provider === 'gemini-cli' && f.account === 'default')).toBe(true);
    const snap = r.snapshot.agents[0]!;
    expect(snap.recent).toHaveLength(SNAPSHOT_RECENT);
    expect(snap.recent.at(-1)!.text).toBe('Reading f19.ts');
    expect(office.detail(ID)!.history).toHaveLength(20);
  });

  it('replaying an event with ids does not duplicate activities', () => {
    const { office, ev } = makeOffice();
    const e = ev('tool.start', { tool: { id: 'abc', name: 'read_file', input: { file_path: 'a.ts' } } });
    office.apply(e);
    office.apply(e);
    expect(office.detail(ID)!.history.filter((a) => a.tool === 'read_file')).toHaveLength(1);
  });

  it('usage adds tokens up and sets the model; title and branch are kept', () => {
    const { office, apply } = makeOffice();
    apply('usage', { model: 'gemini-3.8-flash', tokens: { in: 1200, out: 34, cached: 800 } });
    apply('usage', { tokens: { in: 100, out: 10 } });
    apply('heartbeat', { title: 'Fix the login bug', gitBranch: 'main' });
    expect(office.get(ID)).toMatchObject({ model: 'gemini-3.8-flash', title: 'Fix the login bug', gitBranch: 'main', stats: { tokensIn: 2100, tokensOut: 44 } });
  });

  it('working with a stale "Done": the filler bubble shows thinking (never in the feed)', () => {
    const { office, apply, advance } = makeOffice();
    apply('session.start');
    apply('turn.start');
    apply('turn.end');
    office.commit();
    apply('turn.start');
    advance(20_000);
    office.tick();
    expect(office.get(ID)!.activity).toMatchObject({ kind: 'think', text: 'Thinking…' });
    expect(office.commit().feed).toEqual([]);
  });
});
