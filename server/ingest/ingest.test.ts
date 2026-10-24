import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/protocol';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../../shared/model/office';
import { RateLimiter, createIngestHandler, isLoopbackAddress, type HookAdapter } from './ingest';
import { maskDeep, maskEvent } from './mask';

setQuiet(true);

const custom = (extra: Partial<AgentEvent> = {}) => ({ v: 1, provider: 'custom:bot', account: 'default', session: 's1', cwd: '/p/bot', at: Date.now(), type: 'turn.start', ...extra });

/** A fake adapter: { kind, sid } payloads → events. */
const fakeAdapter: HookAdapter = {
  onHook(p) {
    const payload = p as { kind?: string; sid?: string; prompt?: string };
    if (payload.kind === 'boom') throw new Error('bad payload');
    if (payload.kind === 'wrong') return [{ v: 1, provider: 'claude-code', account: 'default', session: 'x', at: Date.now(), type: 'heartbeat' }];
    return [{ v: 1, provider: 'gemini-cli', account: 'default', session: payload.sid ?? 'g1', cwd: '/p/g', at: Date.now(), type: 'turn.start', prompt: payload.prompt }];
  },
};

async function start(rate?: { perSecond: number; burst: number }) {
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now() });
  const hub = new Hub(office, { throttleMs: 5 });
  const ingest = createIngestHandler({ apply: (e) => office.apply(e), hooks: (p) => (p === 'gemini-cli' ? fakeAdapter : undefined), ...(rate ? { rate } : {}) });
  const api = createApiHandler({ office, hub, version: 't', sources: () => [], providers: () => [], ingest });
  const guard = createRequestGuard({ allowedHosts: new Set(['office.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return { office, port, close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  return new Promise((ok, fail) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let json: unknown = text;
          try {
            json = JSON.parse(text);
          } catch {
            // plain-text answer from the guard
          }
          ok({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

describe('POST /api/events', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => (env = await start()));
  afterEach(async () => env.close());

  it('accepts a custom event and a batch; the agent shows up', async () => {
    expect(await post(env.port, '/api/events', JSON.stringify(custom()))).toEqual({ status: 202, json: { accepted: 1 } });
    expect(env.office.get('custom:bot:default:s1')?.status).toBe('working');
    const batch = [custom({ type: 'tool.start', tool: { name: 'read_file', input: { path: 'a.py' } } }), custom({ type: 'turn.end' })];
    expect(await post(env.port, '/api/events', JSON.stringify(batch))).toEqual({ status: 202, json: { accepted: 2 } });
    expect(env.office.get('custom:bot:default:s1')?.status).toBe('idle');
  });

  it('rejects a bad schema (the whole batch), built-in providers and empty or huge batches', async () => {
    const bad = await post(env.port, '/api/events', JSON.stringify([custom(), { ...custom(), type: 'nope' }]));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: 'invalid events', details: [{ index: 1 }] });
    expect(env.office.list()).toEqual([]);
    const builtin = await post(env.port, '/api/events', JSON.stringify(custom({ provider: 'claude-code' })));
    expect(builtin.status).toBe(400);
    expect((await post(env.port, '/api/events', '[]')).status).toBe(400);
    expect((await post(env.port, '/api/events', JSON.stringify(Array.from({ length: 101 }, () => custom())))).status).toBe(400);
    expect((await post(env.port, '/api/events', '{')).status).toBe(400);
  });

  it('rejects an oversized body (413)', async () => {
    const huge = JSON.stringify(custom({ prompt: 'x'.repeat(300 * 1024) }));
    expect((await post(env.port, '/api/events', huge)).status).toBe(413);
  });

  it('rejects a non-local Host (even an allowed one), a foreign Origin and non-JSON bodies', async () => {
    expect((await post(env.port, '/api/events', JSON.stringify(custom()), { Host: `office.lan:${env.port}` })).status).toBe(403);
    expect((await post(env.port, '/api/events', JSON.stringify(custom()), { Host: `evil.example:${env.port}` })).status).toBe(403);
    expect((await post(env.port, '/api/events', JSON.stringify(custom()), { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(env.port, '/api/events', JSON.stringify(custom()), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(env.office.list()).toEqual([]);
  });

  it('masks secrets on entry', async () => {
    await post(env.port, '/api/events', JSON.stringify(custom({ prompt: 'deploy with sk-proj-0123456789abcdef please', title: 'token=abc123secret' })));
    const a = env.office.get('custom:bot:default:s1')!;
    expect(a.activity!.detail).toBe('deploy with sk-*** please');
    expect(a.title).toBe('token=***');
  });

  it('only POST', async () => {
    const res = await fetch(`http://127.0.0.1:${env.port}/api/events`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('POST /api/hooks/:provider', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => (env = await start()));
  afterEach(async () => env.close());

  it('turns a raw payload into events through the adapter (masked)', async () => {
    expect(await post(env.port, '/api/hooks/gemini-cli', JSON.stringify({ kind: 'turn', prompt: 'use ghp_abcdefghijklmnopqrstuvwxyz123456' }))).toEqual({ status: 202, json: { accepted: 1 } });
    const a = env.office.get('gemini-cli:default:g1')!;
    expect(a.status).toBe('working');
    expect(a.activity!.detail).toBe('use gh*_***');
  });

  it('unknown providers 404; a payload the adapter rejects 400; events for another provider are dropped', async () => {
    expect((await post(env.port, '/api/hooks/codex', '{}')).status).toBe(404);
    expect((await post(env.port, '/api/hooks/gemini-cli', JSON.stringify({ kind: 'boom' }))).status).toBe(400);
    expect(await post(env.port, '/api/hooks/gemini-cli', JSON.stringify({ kind: 'wrong' }))).toEqual({ status: 202, json: { accepted: 0 } });
    expect(env.office.list()).toEqual([]);
  });
});

describe('limits', () => {
  it('rate-limits per source (429)', async () => {
    const env = await start({ perSecond: 0.001, burst: 3 });
    try {
      for (let i = 0; i < 3; i++) expect((await post(env.port, '/api/hooks/gemini-cli', JSON.stringify({ sid: `g${i}` }))).status).toBe(202);
      expect((await post(env.port, '/api/hooks/gemini-cli', JSON.stringify({ sid: 'g9' }))).status).toBe(429);
      // Another source has its own bucket.
      expect((await post(env.port, '/api/events', JSON.stringify(custom()))).status).toBe(202);
    } finally {
      await env.close();
    }
  });

  it('RateLimiter refills over time', () => {
    let now = 0;
    const r = new RateLimiter(10, 2, () => now);
    expect(r.take('a')).toBe(true);
    expect(r.take('a')).toBe(true);
    expect(r.take('a')).toBe(false);
    now += 100;
    expect(r.take('a')).toBe(true);
    expect(r.take('b', 3)).toBe(false);
  });

  it('loopback addresses', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.9.9.9']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of [undefined, '', '10.0.0.2', '::ffff:192.168.0.2', '0.0.0.0']) expect(isLoopbackAddress(a)).toBe(false);
  });

  it('maskDeep masks nested strings and caps depth and size', () => {
    const m = maskDeep({ cmd: 'curl -H "Authorization: Bearer abcdef123456"', nested: { a: [{ b: { c: { d: { e: { f: 'deep' } } } } }] }, n: 3, f: () => 1 }) as Record<string, unknown>;
    expect(m.cmd).toBe('curl -H "Authorization: ***"');
    expect(JSON.stringify(m.nested)).toContain('…');
    expect(m.n).toBe(3);
    expect(m.f).toBeUndefined();
    const e = maskEvent({ v: 1, provider: 'custom:x', account: 'default', session: 's', at: 1, type: 'job.start', job: { id: 'j', command: 'export API_KEY=abc123 && run' } });
    expect(e.job!.command).toBe('export API_KEY=*** && run');
  });
});
