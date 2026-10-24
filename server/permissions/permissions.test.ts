// Answering from the office (P7-01, P7-02): the registry's rules, the routes' gates, and the Claude Code hook end to end
// against a real server.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Office } from '../../shared/model/office';
import type { AgentEvent, OfficeSnapshot, PermissionRequestInfo } from '../../shared/protocol';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { createPermissionRoutes } from './http';
import { ORPHAN_MS, parseDecision, PermissionRegistry, pickSuggestions, type WaitResult } from './registry';

setQuiet(true);

const SESSION = 's1';
const MAIN = `claude-code:default:${SESSION}`;
const ev = (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}): AgentEvent => ({ v: 1, provider: 'claude-code', account: 'default', session: SESSION, cwd: '/p/shop', at: Date.now(), type, ...extra });
const ASK = {
  questions: [
    { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { question: 'Which tests?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'E2E' }] },
  ],
};

function setup(opts: { viewers?: number } = {}) {
  let clock = 1_000_000;
  let viewers = opts.viewers ?? 1;
  // eslint-disable-next-line prefer-const
  let registry: PermissionRegistry;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: clock,
    now: () => clock,
    interactive: true,
    permissions: () => registry.snapshot(),
    onToolEnd: (id, tool, at) => registry.toolEnded(id, tool, at),
  });
  registry = new PermissionRegistry({ office, viewers: () => viewers, now: () => clock });
  office.apply(ev('session.start', { at: clock }));
  office.apply(ev('turn.start', { at: clock, prompt: 'go' }));
  const body = (extra: Record<string, unknown> = {}) => ({ provider: 'claude-code', session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'npm test' }, timeout_ms: 60_000, ...extra });
  return { office, registry, body, advance: (ms: number) => (clock += ms), setViewers: (n: number) => (viewers = n), now: () => clock };
}

const idOf = (r: ReturnType<PermissionRegistry['register']>) => {
  if ('skip' in r) throw new Error(`skipped: ${r.skip}`);
  return r.id;
};

describe('permission registry', () => {
  it('leaves requests to the terminal when nobody watches, the session is unknown or the provider unsupported', () => {
    const s = setup({ viewers: 0 });
    expect(s.registry.register(s.body())).toEqual({ skip: 'no-viewers' });
    s.setViewers(1);
    expect(s.registry.register(s.body({ session_id: 'nope' }))).toEqual({ skip: 'unknown-session' });
    expect(s.registry.register(s.body({ provider: 'gemini-cli' }))).toEqual({ skip: 'unsupported-provider' });
    // a question the office can't show completely (more questions than it shows)
    const five = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, options: [{ label: 'a' }] }));
    expect(s.registry.register(s.body({ tool_name: 'AskUserQuestion', tool_input: { questions: five } }))).toEqual({ skip: 'unsupported-tool' });
    expect(() => s.registry.register({ tool_name: 'Bash' })).toThrow();
  });

  it('a request shows on the agent (waiting, notice, no arguments in the snapshot) and an approval reaches the hook', async () => {
    const s = setup();
    const id = idOf(s.registry.register(s.body({ permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }] })));
    const r = s.office.commit();
    const a = r.snapshot.agents.find((x) => x.id === MAIN)!;
    expect(a.status).toBe('waiting');
    expect(a.waitingFor).toBe('approve a permission');
    expect(a.permission).toMatchObject({ id, tool: 'Bash', title: 'Bash(npm test)', suggestions: [{ index: 0, rules: ['Bash(npm test:*)'], destination: 'localSettings' }] });
    expect(a.permission!.input).toBeUndefined();
    expect(s.registry.detail(id)!.input).toBe('npm test');
    expect(r.notices.some((n) => n.level === 'alert' && n.text.includes('asks permission'))).toBe(true);

    const w = s.registry.wait(id, 10_000)!;
    expect(s.registry.decide(id, { behavior: 'allow', suggestion: 3 })).toBe('invalid');
    expect(s.registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    expect(s.registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('ok');
    await expect(w.result).resolves.toEqual({ status: 'decided', behavior: 'allow', suggestion: 0 });
    expect(s.registry.decide(id, { behavior: 'deny' })).toBe('not-found');
    expect(s.office.commit().snapshot.agents[0]!.permission).toBeUndefined();
  });

  it('a decision taken between two waits is kept for the hook; deny carries the message', async () => {
    const s = setup();
    const id = idOf(s.registry.register(s.body()));
    expect(s.registry.decide(id, { behavior: 'deny', message: 'not now', interrupt: true })).toBe('ok');
    expect(s.registry.decide(id, { behavior: 'allow' })).toBe('conflict');
    await expect(s.registry.wait(id, 1_000)!.result).resolves.toEqual({ status: 'decided', behavior: 'deny', message: 'not now', interrupt: true });
    expect(s.registry.wait(id, 1_000)).toBeUndefined();
  });

  it('questions: answered by position, checked against the original shape', async () => {
    const s = setup();
    const id = idOf(s.registry.register(s.body({ tool_name: 'AskUserQuestion', tool_input: ASK })));
    const p = s.office.commit().snapshot.agents[0]!.permission!;
    expect(p.questions?.map((q) => q.question)).toEqual(['Which database?', 'Which tests?']);
    expect(s.office.get(MAIN)).toBeDefined();
    expect(s.registry.decide(id, { behavior: 'allow' })).toBe('invalid-answer');
    expect(s.registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0, 1] }, { question: 1, options: [0] }] })).toBe('invalid-answer');
    const w = s.registry.wait(id, 10_000)!;
    expect(s.registry.decide(id, { behavior: 'answer', answers: [{ question: 1, options: [1, 0] }, { question: 0, other: 'MySQL' }] })).toBe('ok');
    await expect(w.result).resolves.toEqual({ status: 'decided', behavior: 'answer', answers: [{ question: 0, other: 'MySQL' }, { question: 1, options: [0, 1] }] });
    expect(s.office.detail(MAIN)!.history.some((h) => h.text === 'Answered in the office' && h.detail?.includes('DB: “MySQL”'))).toBe(true);
  });

  it('released: answered in the terminal, the hook died, the agent left, or handed back', async () => {
    const s = setup();
    // answered in the terminal: the tool call ends
    const a = idOf(s.registry.register(s.body()));
    const wa = s.registry.wait(a, 10_000)!;
    s.office.apply(ev('tool.start', { tool: { id: 't1', name: 'Bash', input: { command: 'npm test' } } }));
    s.office.apply(ev('tool.end', { tool: { id: 't1', name: 'Bash', ok: true } }));
    await expect(wa.result).resolves.toEqual({ status: 'released', reason: 'answered' });
    // orphan: nobody waits
    const b = idOf(s.registry.register(s.body()));
    s.advance(ORPHAN_MS + 1);
    s.registry.tick();
    await expect(s.registry.wait(b, 1)!.result).resolves.toEqual({ status: 'released', reason: 'orphan' });
    // handed back to the terminal
    const c = idOf(s.registry.register(s.body()));
    const wc = s.registry.wait(c, 10_000)!;
    expect(s.registry.decide(c, { behavior: 'terminal' })).toBe('ok');
    await expect(wc.result).resolves.toEqual({ status: 'released', reason: 'terminal' });
    // the agent left
    const d = idOf(s.registry.register(s.body()));
    const wd = s.registry.wait(d, 10_000)!;
    s.office.apply(ev('session.end'));
    s.registry.tick();
    await expect(wd.result).resolves.toEqual({ status: 'released', reason: 'gone' });
  });

  it('parses decisions and suggestions strictly', () => {
    expect(parseDecision({ behavior: 'allow', suggestion: -1 })).toBeUndefined();
    expect(parseDecision({ behavior: 'maybe' })).toBeUndefined();
    expect(parseDecision({ behavior: 'deny', message: '  x  ', interrupt: true })).toEqual({ behavior: 'deny', message: 'x', interrupt: true });
    expect(parseDecision({ behavior: 'answer', answers: [{ question: 0, options: [1, 1] }] })).toBeUndefined();
    expect(pickSuggestions([{ type: 'setMode', mode: 'acceptEdits' }, { type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'X' }] }, { type: 'addRules', behavior: 'allow', destination: 'nowhere', rules: [{ toolName: 'X' }] }])).toEqual([]);
  });
});

// ---------------------------------------------------------------- over HTTP, with the real hook

interface HookModule {
  run(argv: string[], env: NodeJS.ProcessEnv, stdinText: string): Promise<unknown>;
  answersFor(answers: unknown, toolInput: unknown): Record<string, string> | undefined;
}
const hook = (await import(pathToFileURL(resolve(__dirname, '../../hooks/claude-permission.mjs')).href)) as HookModule;

async function serve(interactive: boolean) {
  // eslint-disable-next-line prefer-const
  let registry: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: Date.now(),
    interactive,
    permissions: () => registry?.snapshot() ?? new Map(),
    onToolEnd: (id, tool, at) => registry?.toolEnded(id, tool, at),
  });
  const hub = new Hub(office, { throttleMs: 10 });
  hub.start();
  if (interactive) registry = new PermissionRegistry({ office, viewers: () => 1 });
  const api = createApiHandler({ office, hub, version: 't', sources: () => [], providers: () => [], ...(registry ? { actions: { '/api/permissions': createPermissionRoutes(registry) } } : {}) });
  const guard = createRequestGuard({ allowedHosts: new Set(['office.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  office.apply(ev('session.start'));
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    office,
    close: () =>
      new Promise<void>((ok) => {
        registry?.stop();
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      res.resume();
      res.on('end', () => ok(res.statusCode ?? 0));
    });
    req.on('error', fail);
    req.end(opts.body);
  });
}

async function waitFor<T>(fn: () => T | undefined, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('permission routes', () => {
  let env: Awaited<ReturnType<typeof serve>> | undefined;
  afterEach(async () => {
    await env?.close();
    env = undefined;
  });

  it('off by default: 403, and the hook leaves without deciding', async () => {
    env = await serve(false);
    const res = await fetch(`${env.base}/api/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
    const stdin = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(await hook.run([], { HOME: '/nonexistent', AGENT_OFFICE_PORT: String(env.port) }, stdin)).toBeUndefined();
  });

  it('local only: a non-loopback Host, a foreign Origin or a non-JSON body are refused', async () => {
    env = await serve(true);
    const json = { 'Content-Type': 'application/json' };
    expect(await raw(env.port, '/api/permissions/x', { headers: { Host: 'office.lan' } })).toBe(403);
    expect(await raw(env.port, '/api/permissions/x/decision', { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{"behavior":"allow"}' })).toBe(403);
    expect(await raw(env.port, '/api/permissions/x/decision', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"behavior":"allow"}' })).toBe(415);
    expect(await raw(env.port, '/api/permissions/x/decision', { method: 'POST', headers: json, body: '{"behavior":"allow"}' })).toBe(404);
    expect(await raw(env.port, '/api/permissions', { method: 'GET' })).toBe(405);
  });

  it('the hook registers, the page approves, the hook prints the decision with the chosen rule', async () => {
    env = await serve(true);
    const suggestion = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] };
    const stdin = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: SESSION, transcript_path: '/secret', tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [suggestion] });
    const out = hook.run(['--timeout', '20'], { HOME: '/nonexistent', AGENT_OFFICE_PORT: String(env.port) }, stdin);
    const office = env.office;
    const p = await waitFor<PermissionRequestInfo>(() => office.commit().snapshot.agents[0]?.permission);
    const detail = (await (await fetch(`${env.base}/api/permissions/${encodeURIComponent(p.id)}`)).json()) as PermissionRequestInfo;
    expect(detail.input).toBe('npm test');
    const res = await fetch(`${env.base}/api/permissions/${encodeURIComponent(p.id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.base }, body: JSON.stringify({ behavior: 'allow', suggestion: 0 }) });
    expect(res.status).toBe(200);
    expect(await out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [suggestion] } } });
  });

  it('a question answered in the office comes back with the original texts', async () => {
    env = await serve(true);
    const stdin = JSON.stringify({ session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK });
    const out = hook.run([], { HOME: '/nonexistent', AGENT_OFFICE_PORT: String(env.port) }, stdin);
    const office = env.office;
    const p = await waitFor<PermissionRequestInfo>(() => office.commit().snapshot.agents[0]?.permission);
    const snap = (await (await fetch(`${env.base}/api/snapshot`)).json()) as OfficeSnapshot;
    expect(snap.meta.interactive).toBe(true);
    await fetch(`${env.base}/api/permissions/${encodeURIComponent(p.id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ behavior: 'answer', answers: [{ question: 0, options: [1] }, { question: 1, options: [0], other: 'lint' }] }) });
    expect(await out).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...ASK, answers: { 'Which database?': 'SQLite', 'Which tests?': 'Unit, lint' } } } },
    });
  });

  it('answersFor refuses anything that does not fit the original', () => {
    expect(hook.answersFor([{ question: 0, options: [0] }], ASK)).toBeUndefined();
    expect(hook.answersFor([{ question: 0, options: [0, 1] }, { question: 1, options: [0] }], ASK)).toBeUndefined();
    expect(hook.answersFor([{ question: 0, options: [9] }, { question: 1, options: [0] }], ASK)).toBeUndefined();
  });
});

// keep the type import used
export type { WaitResult };
