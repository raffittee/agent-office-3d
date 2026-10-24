// SDK emitters (P5-02): the TypeScript and Python SDKs and their example agents, against the real ingest endpoint
// (guard + /api/events + the office reducer) and stub model endpoints. Every event must pass validation.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, OfficeSnapshot } from '../shared/protocol';
import { Office } from '../shared/model/office';
import { createApiHandler } from '../server/http/app';
import { createRequestGuard } from '../server/http/guard';
import { Hub } from '../server/http/sse';
import { createIngestHandler } from '../server/ingest/ingest';
import { setQuiet } from '../server/log';
import { NameStore } from '../server/model/names';
import { AgentOffice, type OfficeEvent } from '../sdk/ts/agent-office';
import { runAgent } from '../sdk/ts/examples/openai-agent';

setQuiet(true);

// The SDK's event type is the protocol's (checked at compile time).
const sdkIsProtocol = (e: OfficeEvent): AgentEvent => e;
void sdkIsProtocol;

const ROOT = resolve(__dirname, '..');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

interface Server {
  port: number;
  office: Office;
  received: AgentEvent[];
  rejected: unknown[];
  close(): Promise<void>;
}

async function startOffice(): Promise<Server> {
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now() });
  const hub = new Hub(office, { throttleMs: 5 });
  const received: AgentEvent[] = [];
  const ingest = createIngestHandler({ apply: (e) => (received.push(e), office.apply(e)), hooks: () => undefined, rate: { perSecond: 1000, burst: 1000 } });
  const api = createApiHandler({ office, hub, version: 't', sources: () => [], providers: () => [], ingest });
  const guard = createRequestGuard({ allowedHosts: new Set() });
  const rejected: unknown[] = [];
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const end = res.end.bind(res);
    // keep 4xx answers for the assertions
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (res.statusCode >= 400) rejected.push(String(chunk));
      return (end as (...a: unknown[]) => http.ServerResponse)(chunk, ...rest);
    }) as typeof res.end;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return { port, office, received, rejected, close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

/** A local HTTP stub that answers each POST with the next scripted body. */
async function stub(answers: ((body: unknown) => unknown)[]): Promise<{ url: string; calls: unknown[]; close(): Promise<void> }> {
  const calls: unknown[] = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      calls.push(body);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

/** Runs a command without blocking the event loop (the office under test answers from this process). */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(t);
      ok({ stdout, stderr });
    });
  });
}

const agents = (s: OfficeSnapshot) => s.agents.filter((a) => a.provider.startsWith('custom:'));

describe('SDKs', () => {
  let srv: Server;
  beforeEach(async () => {
    srv = await startOffice();
  });
  afterEach(async () => {
    await srv.close();
  });

  it('TypeScript: a session with tools, a subagent, a job and a question; nothing rejected', async () => {
    const errors: unknown[] = [];
    const office = new AgentOffice({ name: 'ts-bot', cwd: '/home/dev/shop', url: `http://127.0.0.1:${srv.port}`, heartbeatMs: 0, onError: (e) => errors.push(e) });
    await office.sessionStart({ title: 'Fix the tests', model: 'my-model' });
    office.turnStart('Fix the failing test');
    await office.tool('read_file', { path: 'src/a.ts' }, () => 'text');
    await expect(office.tool('run_command', { command: 'npm test' }, () => Promise.reject(new TypeError('boom')))).rejects.toThrow('boom');
    const sub = office.subagent({ role: 'reviewer', title: 'Review the diff' });
    await sub.tool('search_code', { query: 'parse' }, () => 1);
    const job = office.jobStart({ label: 'dev server', command: 'npm run dev' });
    office.usage({ in: 100, out: 20, cached: 50 });
    office.tasks([{ id: '1', title: 'Fix it', status: 'in_progress' }]);
    office.waiting('question', 'Which approach?');
    await office.flush();
    let snap = srv.office.commit().snapshot;
    const main = agents(snap).find((a) => a.kind === 'main')!;
    expect(main).toMatchObject({ provider: 'custom:ts-bot', status: 'waiting' });
    expect(agents(snap).find((a) => a.kind === 'sub')).toBeDefined();
    sub.end();
    office.jobEnd(job, true);
    office.turnEnd();
    await office.close();
    snap = srv.office.commit().snapshot;
    expect(agents(snap).find((a) => a.kind === 'main')?.status).toBe('offline');
    expect(errors).toEqual([]);
    expect(srv.rejected).toEqual([]);
    expect(srv.received.map((e) => e.type)).toEqual(['session.start', 'turn.start', 'tool.start', 'tool.end', 'tool.start', 'tool.end', 'subagent.start', 'tool.start', 'tool.end', 'job.start', 'usage', 'tasks', 'waiting', 'subagent.end', 'job.end', 'turn.end', 'session.end']);
    expect(srv.received.every((e) => e.pid === process.pid && e.model === 'my-model')).toBe(true);
  });

  it('TypeScript: reporting never throws when the office is down', async () => {
    const errors: unknown[] = [];
    const office = new AgentOffice({ name: 'ts-bot', url: 'http://127.0.0.1:1', heartbeatMs: 0, onError: (e) => errors.push(e) });
    await office.sessionStart();
    office.toolStart('x');
    await office.close();
    expect(errors.length).toBeGreaterThan(0);
    expect(() => new AgentOffice({ name: 'Not A Slug' })).toThrow(/slug/);
  });

  it('the OpenAI-compatible example agent reports its turn, tool call and tokens', async () => {
    const model = await stub([
      () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"sdk"}' } }] } }], usage: { prompt_tokens: 300, completion_tokens: 12 } }),
      () => ({ choices: [{ message: { role: 'assistant', content: 'It is an SDK.' } }], usage: { prompt_tokens: 400, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } } }),
    ]);
    try {
      const answer = await runAgent('What is in sdk/?', { baseUrl: `${model.url}/v1`, model: 'stub', root: ROOT, officeUrl: `http://127.0.0.1:${srv.port}` });
      expect(answer).toBe('It is an SDK.');
      // the tool's result went back to the model
      expect(JSON.stringify(model.calls[1])).toContain('python/');
      const types = srv.received.map((e) => e.type);
      expect(types).toEqual(['session.start', 'turn.start', 'usage', 'tool.start', 'tool.end', 'usage', 'turn.end', 'session.end']);
      expect(srv.received.find((e) => e.type === 'tool.start')?.tool).toMatchObject({ name: 'list_files', input: { path: 'sdk' } });
      const main = agents(srv.office.commit().snapshot)[0]!;
      expect(main.stats.tokensIn).toBe(700);
      expect(srv.rejected).toEqual([]);
    } finally {
      await model.close();
    }
  });

  it.skipIf(!python)('Python: the SDK and the Gemini example agent report through the same endpoint', async () => {
    const script = `
import sys; sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'sdk/python'))})
from agent_office import AgentOffice
o = AgentOffice(name="py-bot", cwd="/home/dev/shop", url="http://127.0.0.1:${srv.port}", heartbeat_s=0)
o.session_start(title="t", model="m")
o.turn_start("hello")
with o.tool("read_file", {"path": "a.py"}):
    pass
try:
    with o.tool("run_command", {"command": "pytest"}):
        raise RuntimeError("x")
except RuntimeError:
    pass
s = o.subagent(role="helper", title="Look around")
with s.tool("list_files"):
    pass
s.end()
o.usage(10, 2, 1)
o.waiting("permission", "rm -rf build?")
o.turn_end()
o.close()
`;
    const r = await run(python!, ['-c', script]);
    expect(r.stderr).toBe('');
    expect(srv.rejected).toEqual([]);
    const py = srv.received.filter((e) => e.provider === 'custom:py-bot');
    expect(py.map((e) => e.type)).toEqual(['session.start', 'turn.start', 'tool.start', 'tool.end', 'tool.start', 'tool.end', 'subagent.start', 'tool.start', 'tool.end', 'subagent.end', 'usage', 'waiting', 'turn.end', 'session.end']);
    expect(py.find((e) => e.type === 'tool.end' && e.tool?.ok === false)?.tool?.error).toBe('RuntimeError');

    // the Gemini example, against a stub Gemini API
    const gemini = await stub([
      () => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_files', args: { path: 'sdk' } } }] } }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 5 } }),
      () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'An SDK folder.' }] } }], usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 6, cachedContentTokenCount: 50 } }),
    ]);
    try {
      const g = await run(python!, [resolve(ROOT, 'sdk/python/examples/gemini_agent.py'), 'What is in sdk?'], {
        cwd: ROOT,
        env: { ...process.env, GEMINI_API_KEY: 'test', GEMINI_API_BASE: gemini.url, AGENT_OFFICE_PORT: String(srv.port) },
      });
      expect(g.stdout.trim()).toBe('An SDK folder.');
      const ex = srv.received.filter((e) => e.provider === 'custom:gemini-example');
      expect(ex.map((e) => e.type)).toEqual(['session.start', 'turn.start', 'usage', 'tool.start', 'tool.end', 'usage', 'turn.end', 'session.end']);
      expect(JSON.stringify(gemini.calls[1])).toContain('python/');
    } finally {
      await gemini.close();
    }
  });
});
