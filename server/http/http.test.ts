// Ported from habblaud server/http/http.test.ts (MIT, © 2026 Márcio Junior)
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, OfficeSnapshot } from '../../shared/protocol';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../../shared/model/office';
import { tempDir } from '../test/helpers';
import { createApiHandler } from './app';
import { createRequestGuard, hostAllowed, hostnameOf, isLoopbackHost, originAllowed, parseAllowedHosts } from './guard';
import { Hub } from './sse';
import { IMMUTABLE, REVALIDATE, createStaticHandler } from './static';

setQuiet(true);

const ID = 'claude-code:default:s1';
const event = (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}): AgentEvent => ({
  v: 1,
  provider: 'claude-code',
  account: 'default',
  session: 's1',
  cwd: '/p/shop',
  at: Date.now(),
  type,
  ...extra,
});

async function start() {
  const tmp = tempDir();
  const dist = join(tmp.dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'bundle'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Agent Office</title>');
  writeFileSync(join(dist, 'bundle', 'main-abc12345.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'manifest.json'), '{}');
  const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now() });
  const hub = new Hub(office, { throttleMs: 10 });
  hub.start();
  const api = createApiHandler({
    office,
    hub,
    version: '9.9.9',
    sources: () => [{ provider: 'claude-code', label: 'default', path: '/secret/path', sessions: 1, ok: true }],
    providers: () => [{ id: 'claude-code', label: 'Claude Code', color: '#d97757', capabilities: { transcript: true, approve: false, message: false, usage: false, subagents: true } }],
  });
  const serveStatic = createStaticHandler(dist);
  const guard = createRequestGuard({ allowedHosts: new Set(['office.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) serveStatic(req, res, url.pathname);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  office.apply(event('session.start'));
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    office,
    close: () =>
      new Promise<void>((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
        tmp.cleanup();
      }),
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A raw request (fetch won't let us change the Host header). */
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', fail);
    req.end(opts.body);
  });
}

describe('HTTP API', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start();
  });
  afterEach(async () => {
    await env.close();
  });

  it('GET /api/snapshot', async () => {
    const res = await fetch(`${env.base}/api/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const snap = (await res.json()) as OfficeSnapshot;
    expect(snap.rev).toBeGreaterThan(0);
    expect(snap.agents.map((a) => a.id)).toEqual([ID]);
    expect(snap.meta.version).toBe('9.9.9');
  });

  it('GET /api/stream sends retry, snapshot and feed, then the changes', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${env.base}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (re: RegExp) => {
      while (!re.test(text)) text += dec.decode((await reader.read()).value, { stream: true });
    };
    await readUntil(/event: feed\n/);
    expect(text).toMatch(/^retry: 2000\n\nevent: snapshot\ndata: \{/);
    env.office.apply(event('tool.start', { tool: { id: 'act-x', name: 'Read', input: { file_path: 'a.ts' } } }));
    await readUntil(/event: feed\ndata: \[\{"id":"claude-code:default:s1#tool:act-x"[^\n]*"text":"Reading a.ts"/);
    await readUntil(/event: snapshot\ndata: [^\n]*"status":"working"/);
    ctrl.abort();
  });

  it('GET /api/agents/:id and /api/health', async () => {
    const ok = await fetch(`${env.base}/api/agents/${encodeURIComponent(ID)}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ agent: { id: ID }, history: [] });
    expect((await fetch(`${env.base}/api/agents/nope`)).status).toBe(404);
    expect((await fetch(`${env.base}/api/agents/%E0%A4%A`)).status).toBe(400);
    const health = await (await fetch(`${env.base}/api/health`)).json();
    expect(health).toEqual({ ok: true, version: '9.9.9', demo: false, providers: [{ id: 'claude-code', label: 'Claude Code' }], sources: [{ provider: 'claude-code', label: 'default', ok: true, sessions: 1 }] });
    // Paths are not exposed in /api/health.
    expect(JSON.stringify(health)).not.toContain('/secret/path');
  });

  it('read-only routes answer 405 to other methods', async () => {
    const res = await fetch(`${env.base}/api/snapshot`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('DNS rebinding: a Host from another domain is refused on every route', async () => {
    for (const path of ['/api/snapshot', '/api/stream', '/', '/bundle/main-abc12345.js']) {
      const r = await raw(env.base, path, { headers: { Host: `attacker.example:${env.port}` } });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('"agents"');
    }
    for (const host of [`localhost:${env.port}`, `[::1]:${env.port}`, `192.168.0.10:${env.port}`, `office.lan:${env.port}`]) {
      expect((await raw(env.base, '/api/health', { headers: { Host: host } })).status).toBe(200);
    }
  });

  it('CSRF: POST needs JSON and a local origin', async () => {
    const body = JSON.stringify({ x: 1 });
    // A "simple" form/fetch from another site: text/plain, no preflight.
    expect((await fetch(`${env.base}/api/events`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })).status).toBe(415);
    expect((await raw(env.base, '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1' })).status).toBe(415);
    expect((await raw(env.base, '/api/events', { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'http://attacker.example' }, body })).status).toBe(403);
    // Same origin and JSON pass the guard (this route doesn't exist yet: 404 from the API, not 403/415).
    const same = await raw(env.base, '/api/nothing', { method: 'POST', headers: { ...JSON_HEADERS, Host: `localhost:${env.port}`, Origin: `http://localhost:${env.port}` }, body });
    expect(same.status).toBe(404);
  });

  it('JSON responses carry nosniff and same-origin CORP; no CORS', async () => {
    const res = await fetch(`${env.base}/api/snapshot`, { headers: { Origin: 'http://attacker.example' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unknown routes: 404 JSON', async () => {
    const res = await fetch(`${env.base}/api/nothing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown route' });
  });

  it('static files: SPA fallback, immutable only under /bundle (hashed), revalidation elsewhere', async () => {
    const page = await fetch(`${env.base}/room/anything`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Agent Office</title>');
    expect(page.headers.get('cache-control')).toBe(REVALIDATE);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const bundle = await fetch(`${env.base}/bundle/main-abc12345.js`);
    expect(bundle.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(bundle.headers.get('content-type')).toMatch(/javascript/);
    const res = await fetch(`${env.base}/assets/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(REVALIDATE);
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"/);
    expect((await fetch(`${env.base}/assets/manifest.json`, { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await fetch(`${env.base}/assets/manifest.json`, { headers: { 'If-Modified-Since': res.headers.get('last-modified')! } })).status).toBe(304);
    expect((await fetch(`${env.base}/assets/manifest.json`, { headers: { 'If-None-Match': 'W/"other"' } })).status).toBe(200);
    expect((await fetch(`${env.base}/assets/missing.png`)).status).toBe(404);
    // Path traversal stays inside dist.
    expect((await raw(env.base, '/..%2f..%2fpackage.json')).body).toContain('<title>Agent Office</title>');
  });
});

describe('Host/Origin guard', () => {
  const allowed = parseAllowedHosts(' My-PC.local:4848 , office.lan ');

  it('hostnameOf and AGENT_OFFICE_ALLOWED_HOSTS', () => {
    expect([...allowed]).toEqual(['my-pc.local', 'office.lan']);
    expect(hostnameOf('LocalHost:4848')).toBe('localhost');
    expect(hostnameOf('[::1]:4848')).toBe('::1');
    expect(hostnameOf('a b')).toBeUndefined();
    expect(hostnameOf('[::1]junk')).toBeUndefined();
  });

  it('Host: IPs, localhost and allowed names yes; outside domains no', () => {
    expect(hostAllowed(undefined, allowed)).toBe(true);
    for (const h of ['localhost:4848', 'app.localhost', '127.0.0.1:4848', '[::1]:1', '10.0.0.5:4848', 'my-pc.local:4848']) expect(hostAllowed(h, allowed)).toBe(true);
    for (const h of ['attacker.example:4848', 'localhost.attacker.example', '127.0.0.1.nip.io', '', 'x y']) expect(hostAllowed(h, allowed)).toBe(false);
  });

  it('isLoopbackHost: only localhost, *.localhost, 127.x and ::1', () => {
    for (const h of ['localhost:4848', 'LOCALHOST', 'app.localhost:1', '127.0.0.1:4848', '127.8.9.10', '[::1]:4848']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of [undefined, '', '10.0.0.5:4848', '192.168.0.10', '0.0.0.0:4848', 'office.lan', 'my-pc.local:4848', '[::]:4848', 'localhost.attacker.example', '127.0.0.1.nip.io', 'x y']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('Origin: missing, same origin or local', () => {
    expect(originAllowed(undefined, 'localhost:4848', allowed)).toBe(true);
    expect(originAllowed('http://localhost:4848', 'localhost:4848', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', '127.0.0.1:4848', allowed)).toBe(true); // Vite dev with proxy
    expect(originAllowed('http://192.168.0.10:4848', '192.168.0.10:4848', allowed)).toBe(true);
    expect(originAllowed('http://attacker.example', 'localhost:4848', allowed)).toBe(false);
    expect(originAllowed('http://1.2.3.4', 'localhost:4848', allowed)).toBe(false);
    expect(originAllowed('null', 'localhost:4848', allowed)).toBe(false);
    expect(originAllowed('file://', 'localhost:4848', allowed)).toBe(false);
  });
});
