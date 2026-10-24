// Gemini CLI: the hook shim's body, the chat-file parser, and P0-04's real captures (test/fixtures/gemini-cli/)
// replayed through the shim's transformation, the adapter and the office reducer.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentStatus } from '../../../shared/protocol';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../../shared/model/office';
import { tempDir } from '../../test/helpers';
import { AdapterSet } from '../adapter';
import { GeminiCliAdapter } from './adapter';
import { createChatState, parseChatLine, type ChatItem } from './chat';
import { isGeminiChatPath, parseHookBody } from './hook';

setQuiet(true);

const FIXTURES = resolve(__dirname, '../../../test/fixtures/gemini-cli');

interface ShimModule {
  buildBody(input: Record<string, unknown>, resolvePid?: () => number): Record<string, unknown> | undefined;
  toolResult(response: unknown): Record<string, unknown>;
}
const shim = (await import(pathToFileURL(resolve(__dirname, '../../../hooks/gemini-cli.mjs')).href)) as ShimModule;

function lines(file: string): string[] {
  return readFileSync(join(FIXTURES, file), 'utf8').split('\n').filter((l) => l.trim());
}

function hooks(file: string): Array<{ receivedAt: string; payload: Record<string, unknown> }> {
  return lines(file).map((l) => JSON.parse(l) as { receivedAt: string; payload: Record<string, unknown> });
}

describe('hook shim body (hooks/gemini-cli.mjs)', () => {
  it('keeps what the office needs and drops conversation content', () => {
    const all = hooks('hooks-headless-work.jsonl').map((h) => shim.buildBody(h.payload, () => 4242)!);
    const text = JSON.stringify(all);
    // File contents written by write_file, replace's old/new strings, tool output and the model's reply never leave.
    expect(text).not.toContain('FAKEFAKEFAKE');
    expect(text).not.toContain('hello from the probe');
    expect(text).not.toContain('old_string');
    expect(text).not.toContain('prompt_response');
    const start = all.find((b) => b.hook_event_name === 'SessionStart')!;
    expect(start).toMatchObject({ source: 'startup', pid: 4242, session_id: expect.any(String), transcript_path: expect.stringContaining('chats') });
    // The PID lookup (1–3 s on Windows) runs on SessionStart only.
    expect(all.filter((b) => 'pid' in b)).toHaveLength(1);
    const bg = all.find((b) => b.hook_event_name === 'AfterTool' && (b.tool_input as { is_background?: boolean })?.is_background);
    expect(bg?.tool_result).toEqual({ ok: true, background_pid: 11512 });
    expect(all.find((b) => b.hook_event_name === 'BeforeTool' && b.tool_name === 'write_file')?.tool_input).toEqual({ file_path: 'config.env' });
  });

  it('derives ok from the error type and the shell exit code (no `error` on shell failures)', () => {
    const fail = hooks('hooks-headless-fail.jsonl').map((h) => shim.buildBody(h.payload, () => 1)!).filter((b) => b.hook_event_name === 'AfterTool');
    expect(fail.map((b) => b.tool_result)).toEqual([
      { ok: false, error_type: 'file_not_found' },
      { ok: false, exit_code: 3 },
    ]);
    expect(shim.toolResult({ llmContent: 'Exit Code: 0' })).toEqual({ ok: true, exit_code: 0 });
  });

  it('Notification keeps only type, title, fileName and command', () => {
    const n = hooks('hooks-tui-allow-deny.jsonl').map((h) => shim.buildBody(h.payload, () => 1)!).find((b) => b.hook_event_name === 'Notification')!;
    expect(n.details).toEqual({ type: 'edit', title: 'Confirm Write: allowed.txt', fileName: 'allowed.txt' });
    expect(JSON.stringify(n)).not.toContain('newContent');
  });
});

describe('hook body validation', () => {
  it('accepts only chat paths under .gemini/tmp/<slug>/chats/', () => {
    const root = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
    const sep = process.platform === 'win32' ? '\\' : '/';
    const p = (...x: string[]) => [root, ...x].join(sep);
    expect(isGeminiChatPath(p('.gemini', 'tmp', 'project', 'chats', 'session-2026-10-23T18-30-8743044f.jsonl'))).toBe(true);
    expect(isGeminiChatPath(p('.gemini', 'tmp', 'project', 'chats', '8743044f-aaaa', 'b2356ac0-bbbb.jsonl'))).toBe(true);
    expect(isGeminiChatPath(p('.gemini', 'tmp', 'project', 'chats', '..', '..', 'oauth_creds.json'))).toBe(false);
    expect(isGeminiChatPath(p('.ssh', 'id_rsa'))).toBe(false);
    expect(isGeminiChatPath(p('.gemini', 'tmp', 'project', 'chats', 'notes.txt'))).toBe(false);
    expect(isGeminiChatPath('relative/.gemini/tmp/x/chats/session-a.jsonl')).toBe(false);
  });

  it('rejects unknown events and bad session ids; drops a refused transcript path', () => {
    expect(parseHookBody({ hook_event_name: 'BeforeModel', session_id: 's' }, 0)).toBeUndefined();
    expect(parseHookBody({ hook_event_name: 'BeforeAgent', session_id: '../x' }, 0)).toBeUndefined();
    expect(parseHookBody({ hook_event_name: 'BeforeAgent', session_id: 's', transcript_path: '/etc/passwd' }, 5)).toEqual({ event: 'BeforeAgent', sessionId: 's', at: 5 });
  });
});

describe('chat files', () => {
  it('the main chat: context skipped, tokens counted once per message, tool calls once, the cancel', () => {
    const s = createChatState();
    const items = lines('chat-tui-allow-deny.jsonl').flatMap((l) => parseChatLine(s, l, 0));
    expect(s).toMatchObject({ sessionId: 'bff65525-81ae-46a0-b714-52fd2223867c', kind: 'main', model: 'gemini-3.8-flash' });
    expect(items.filter((i) => i.type === 'prompt').map((i) => (i.type === 'prompt' ? i.text : ''))).toEqual(['SCENARIO ask2: write two files', 'SCENARIO hello: after deny']);
    const tools = items.filter((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool').map((i) => [i.call.name, i.call.status]);
    expect(tools).toEqual([
      ['write_file', 'success'],
      ['write_file', 'cancelled'],
    ]);
    expect(items.filter((i) => i.type === 'cancelled')).toHaveLength(1);
    const usage = items.filter((i): i is Extract<ChatItem, { type: 'usage' }> => i.type === 'usage');
    // Three model messages, each re-appended once: three usage items. Input includes the cached part.
    expect(usage).toHaveLength(3);
    expect(usage[0]!.tokens).toEqual({ in: 400, cached: 800, out: 34 });
    // File contents in tool args are dropped.
    expect(JSON.stringify(items)).not.toContain('should be denied');
  });

  it('the headless chat: a background command and invoke_agent naming its subagent', () => {
    const s = createChatState();
    const calls = lines('chat-headless-work.jsonl')
      .flatMap((l) => parseChatLine(s, l, 0))
      .flatMap((i) => (i.type === 'tool' ? [i.call] : []));
    expect(calls.find((c) => c.backgroundPid)).toMatchObject({ name: 'run_shell_command', backgroundPid: 11512 });
    expect(calls.find((c) => c.name === 'invoke_agent')).toMatchObject({ agentId: 'b2356ac0-a978-43d9-906c-9b5b94ddfd59', goal: true, status: 'success' });
  });

  it("a subagent's chat: kind subagent, its task as the first prompt, complete_task", () => {
    const s = createChatState();
    const items = lines('chat-headless-work-subagent.jsonl').flatMap((l) => parseChatLine(s, l, 0));
    expect(s.kind).toBe('subagent');
    expect(s.firstPrompt).toBe('SCENARIO sub: list the files here and report back.');
    expect(items.flatMap((i) => (i.type === 'tool' ? [i.call.name] : []))).toEqual(['list_directory', 'complete_task']);
  });
});

// ------------------------------------------------------------------ replays

/** When a chat line was (about to be) written: its latest timestamp. */
function writeTime(line: string, prev: number): number {
  const j = JSON.parse(line) as Record<string, unknown>;
  const times = [prev];
  const add = (v: unknown) => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) times.push(t);
  };
  add(j.timestamp);
  add(j.lastUpdated);
  if (j.$set && typeof j.$set === 'object') add((j.$set as Record<string, unknown>).lastUpdated);
  if (Array.isArray(j.toolCalls)) for (const c of j.toolCalls as Array<Record<string, unknown>>) add(c.timestamp);
  return Math.max(...times);
}

function replayEnv() {
  const tmp = tempDir();
  const home = join(tmp.dir, 'home');
  const chats = join(home, '.gemini', 'tmp', 'project', 'chats');
  mkdirSync(chats, { recursive: true });
  let clock = 0;
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, now: () => clock });
  const adapter = new GeminiCliAdapter({ now: () => clock, home, isAlive: () => false });
  const set = new AdapterSet([adapter]);
  const ctx = set.context(office);
  const sent: AgentEvent[] = [];
  const apply = (events: AgentEvent[]) => {
    for (const e of events) {
      sent.push(e);
      ctx.emit(e);
    }
  };
  return { tmp, home, chats, office, adapter, sent, apply, setClock: (t: number) => (clock = t) };
}

/**
 * Replays a hook capture: each payload goes through the real shim transformation (buildBody) and the adapter; chat
 * lines (if any) are appended when they were written, and the adapter polls like it does every second. Returns the
 * main agent's status after each hook (consecutive repeats folded).
 */
function replay(env: ReturnType<typeof replayEnv>, hookFile: string, chat: Array<{ file: string; into: (sessionId: string) => string }> = []) {
  const hs = hooks(hookFile);
  const pending = chat.flatMap(({ file, into }) => {
    let t = 0;
    return lines(file).map((line) => ({ line, into, at: (t = writeTime(line, t)) }));
  });
  pending.sort((a, b) => a.at - b.at);
  const statuses: string[] = [];
  const ids = new Set<string>();
  for (const h of hs) {
    const p = { ...h.payload };
    const at = Date.parse(String(p.timestamp));
    env.setClock(at);
    if (typeof p.transcript_path === 'string') p.transcript_path = join(env.chats, basename(p.transcript_path));
    while (pending.length && pending[0]!.at <= at) {
      const c = pending.shift()!;
      const file = c.into(String(p.session_id));
      mkdirSync(resolve(file, '..'), { recursive: true });
      appendFileSync(file, `${c.line}\n`);
    }
    env.apply(env.adapter.poll());
    const body = shim.buildBody(p, () => 4242);
    env.apply(env.adapter.onHook(JSON.parse(JSON.stringify(body))));
    const main = `gemini-cli:default:${String(p.session_id)}`;
    ids.add(main);
    const a = env.office.get(main) ?? [...ids].map((id) => env.office.get(id)).find(Boolean);
    const s = a?.status ?? 'none';
    if (statuses.at(-1) !== s) statuses.push(s);
  }
  // Whatever is left in the chat, then a last poll.
  for (const c of pending) appendFileSync(c.into(''), `${c.line}\n`);
  env.apply(env.adapter.poll());
  return statuses;
}

describe('replays of the real captures (P0-04)', () => {
  let env: ReturnType<typeof replayEnv>;
  beforeEach(() => {
    env = replayEnv();
  });
  afterEach(() => {
    env.adapter.stop();
    env.tmp.cleanup();
  });

  it('TUI allow and deny: waiting twice; the deny shows only in the chat and ends the turn', () => {
    const statuses = replay(env, 'hooks-tui-allow-deny.jsonl', [{ file: 'chat-tui-allow-deny.jsonl', into: () => join(env.chats, 'session-2026-10-23T18-34-bff65525.jsonl') }]);
    expect(statuses).toEqual(['idle', 'working', 'waiting', 'working', 'waiting', 'working', 'idle', 'offline']);
    const id = 'gemini-cli:default:bff65525-81ae-46a0-b714-52fd2223867c';
    const history = env.office.detail(id)!.history;
    expect(history.some((a) => a.tool === 'write_file' && a.text === 'Request cancelled')).toBe(true);
    // Every event names the agent's process (resolved by the shim through the shell), for liveness.
    expect(env.sent.every((e) => e.pid === 4242)).toBe(true);
    expect(env.office.get(id)).toMatchObject({ model: 'gemini-3.8-flash' });
    expect(env.office.get(id)!.stats.tokensOut).toBeGreaterThan(0);
  });

  it('headless work: tools pair by name (parallel calls too), a background job, a subagent from its chat file', () => {
    const SID = '8743044f';
    const statuses = replay(env, 'hooks-headless-work.jsonl', [
      { file: 'chat-headless-work.jsonl', into: () => join(env.chats, `session-2026-10-23T18-30-${SID}.jsonl`) },
      { file: 'chat-headless-work-subagent.jsonl', into: (sid) => join(env.chats, sid || 'none', 'b2356ac0-a978-43d9-906c-9b5b94ddfd59.jsonl') },
    ]);
    expect(statuses).toEqual(['idle', 'working', 'idle', 'offline']);
    const main = env.sent.find((e) => e.type === 'session.start')!;
    const mainId = `gemini-cli:default:${main.session}`;
    // Tool starts and ends pair up, including the parallel glob + grep_search.
    const starts = env.sent.filter((e) => e.type === 'tool.start' && !e.agent).map((e) => e.tool!.id);
    const ends = env.sent.filter((e) => e.type === 'tool.end' && !e.agent).map((e) => e.tool!.id);
    expect(new Set(ends)).toEqual(new Set(starts));
    // The subagent's own tool hooks (parent session id) are not the parent's tools.
    expect(env.sent.some((e) => !e.agent && e.tool?.name === 'list_directory')).toBe(false);
    const subStart = env.sent.find((e) => e.type === 'subagent.start')!;
    expect(subStart).toMatchObject({ agent: 'b2356ac0-a978-43d9-906c-9b5b94ddfd59', subagent: { role: 'generalist', title: 'SCENARIO sub: list the files here and report back.' } });
    expect(env.sent.filter((e) => e.agent === subStart.agent && e.type === 'tool.start').map((e) => e.tool!.name)).toEqual(['list_directory', 'complete_task']);
    expect(env.sent.some((e) => e.type === 'subagent.end' && e.agent === subStart.agent)).toBe(true);
    // The background command became a job; its PID is gone (isAlive false), so it ended.
    expect(env.sent.find((e) => e.type === 'job.start')).toMatchObject({ job: { id: 'pid:11512', label: 'Wait a bit' } });
    expect(env.sent.some((e) => e.type === 'job.end')).toBe(true);
    expect(env.office.get(mainId)!.stats.subagents).toBe(1);
  });

  it('a failed read and a shell exit code are errors', () => {
    replay(env, 'hooks-headless-fail.jsonl');
    const ends = env.sent.filter((e) => e.type === 'tool.end').map((e) => [e.tool!.name, e.tool!.ok, e.tool!.error]);
    expect(ends).toEqual([
      ['read_file', false, 'file_not_found'],
      ['run_shell_command', false, 'exit_3'],
    ]);
  });

  it('resume: the same session id comes back', () => {
    replay(env, 'hooks-headless-fail.jsonl');
    const sid = env.sent[0]!.session;
    const statuses = replay(env, 'hooks-headless-resume.jsonl');
    expect(env.sent.filter((e) => e.type === 'session.start').map((e) => e.session)).toEqual([sid, sid]);
    expect(statuses.at(-1)).toBe('offline');
  });

  it('Esc on a permission and /clear: the same character continues under the new id', () => {
    const statuses = replay(env, 'hooks-tui-cancel-clear.jsonl');
    const starts = env.sent.filter((e) => e.type === 'session.start');
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ continues: starts[0]!.session });
    // One character all along: the old id stays the office's id for the new session.
    expect(env.office.list().filter((a) => a.provider === 'gemini-cli')).toHaveLength(1);
    expect(statuses).toEqual(['idle', 'working', 'waiting', 'working', 'idle', 'offline']);
    // SessionEnd(clear) is not an exit.
    expect(env.sent.filter((e) => e.type === 'session.end').map((e) => e.session)).toEqual([starts[1]!.session]);
  });

  it('ACP mode (no SessionStart, no tool hooks): the session still appears and works', () => {
    const statuses = replay(env, 'hooks-acp.jsonl');
    expect(statuses[0]).toBe('working');
    expect(statuses.at(-1)).toBe('offline');
  });

  it('a /clear without the following SessionStart ends the old session after 10 s', () => {
    const [start] = hooks('hooks-tui-cancel-clear.jsonl');
    const p = { ...start!.payload, transcript_path: join(env.chats, 'session-x.jsonl') };
    env.setClock(1_000);
    env.apply(env.adapter.onHook(shim.buildBody(p, () => 77)));
    env.apply(env.adapter.onHook(shim.buildBody({ ...p, hook_event_name: 'SessionEnd', reason: 'clear' }, () => 77)));
    expect(env.adapter.poll()).toEqual([]);
    env.setClock(12_000);
    expect(env.adapter.poll().map((e) => e.type)).toEqual(['session.end']);
  });

  it('light profile (no tool hooks): tools come from the chat file, and a late read leaves the agent idle', () => {
    const file = join(env.chats, 'session-2026-10-23T18-34-bff65525.jsonl');
    const light = hooks('hooks-tui-allow-deny.jsonl').filter((h) => !['BeforeTool', 'AfterTool'].includes(String(h.payload.hook_event_name)));
    writeFileSync(join(env.tmp.dir, 'light.jsonl'), light.map((h) => JSON.stringify(h)).join('\n'));
    const hookPath = join(env.tmp.dir, 'light.jsonl');
    // Hooks from the custom file, chat as usual.
    const statuses: string[] = [];
    let chatAt = 0;
    const chat = lines('chat-tui-allow-deny.jsonl').map((line) => ({ line, at: (chatAt = writeTime(line, chatAt)) }));
    for (const h of readFileSync(hookPath, 'utf8').split('\n').map((l) => JSON.parse(l) as { payload: Record<string, unknown> })) {
      const at = Date.parse(String(h.payload.timestamp));
      env.setClock(at);
      while (chat.length && chat[0]!.at <= at) appendFileSync(file, `${chat.shift()!.line}\n`);
      env.apply(env.adapter.poll());
      env.apply(env.adapter.onHook(shim.buildBody({ ...h.payload, transcript_path: file }, () => 4242)));
      const s = env.office.get('gemini-cli:default:bff65525-81ae-46a0-b714-52fd2223867c')?.status as AgentStatus;
      if (statuses.at(-1) !== s) statuses.push(s);
    }
    const tools = env.sent.filter((e) => e.type === 'tool.end').map((e) => [e.tool!.name, e.tool!.ok, e.tool!.error]);
    expect(tools).toEqual([
      ['write_file', true, undefined],
      ['write_file', false, 'cancelled'],
    ]);
    expect(statuses.at(-1)).toBe('offline');
    expect(statuses).toContain('waiting');
  });
});
