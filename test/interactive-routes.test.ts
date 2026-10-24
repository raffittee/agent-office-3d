// P7-06: every session-touching route (approve, answer, message, inbox, conversation, history) refuses requests that
// break the local-only rules (CLAUDE.md › Security): the features off or not on a loopback bind, a Host that isn't
// loopback (even an allow-listed LAN name), a POST without JSON, and a POST from a foreign Origin. One table drives
// the negative tests so a new route can't slip through without them.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Office } from '../shared/model/office';
import type { AdapterSet } from '../server/adapters/adapter';
import { interactive } from '../server/config';
import { createConversationRoutes } from '../server/conversation/http';
import { ACTION_PREFIXES, createApiHandler } from '../server/http/app';
import { createRequestGuard } from '../server/http/guard';
import { Hub } from '../server/http/sse';
import { setQuiet } from '../server/log';
import { createMessageRoutes } from '../server/messages/http';
import { MessageRegistry } from '../server/messages/registry';
import { NameStore } from '../server/model/names';
import { createPermissionRoutes } from '../server/permissions/http';
import { PermissionRegistry } from '../server/permissions/registry';

setQuiet(true);

interface Route {
  method: 'GET' | 'POST';
  path: string;
}

/** Every interactive route (a representative path for each). */
const ROUTES: Route[] = [
  { method: 'POST', path: '/api/permissions' },
  { method: 'GET', path: '/api/permissions/p-1' },
  { method: 'GET', path: '/api/permissions/p-1/wait?timeout=0.05' },
  { method: 'POST', path: '/api/permissions/p-1/decision' },
  { method: 'POST', path: '/api/messages' },
  { method: 'GET', path: '/api/messages/m-1' },
  { method: 'POST', path: '/api/inbox' },
  { method: 'POST', path: '/api/inbox/ack' },
  { method: 'GET', path: '/api/conversation/claude-code%3Adefault%3As1' },
  { method: 'GET', path: '/api/sessions' },
  { method: 'GET', path: '/api/sessions/abcdefghijklmnop/conversation' },
];

const BODY = JSON.stringify({ provider: 'claude-code', session: 's1', session_id: 's1', tool_name: 'Bash', behavior: 'deny', agentId: 'x', text: 'hi', results: [] });

async function serve(on: boolean) {
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now() });
  const hub = new Hub(office, { throttleMs: 10 });
  hub.start();
  const permissions = new PermissionRegistry({ office, viewers: () => 1 });
  const messages = new MessageRegistry({ office });
  const adapters = { conversationOf: () => undefined, recentSessions: () => [], parserOf: () => undefined } as unknown as AdapterSet;
  const conversation = createConversationRoutes(office, adapters);
  const actions = {
    '/api/permissions': createPermissionRoutes(permissions),
    '/api/messages': createMessageRoutes(messages),
    '/api/inbox': createMessageRoutes(messages),
    '/api/conversation': conversation,
    '/api/sessions': conversation,
  };
  const api = createApiHandler({ office, hub, version: 't', sources: () => [], providers: () => [], ...(on ? { actions } : {}) });
  const guard = createRequestGuard({ allowedHosts: new Set(['office.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((ok) => {
        permissions.stop();
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function request(port: number, r: Route, headers: Record<string, string>): Promise<number> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path: r.path, method: r.method, headers }, (res) => {
      res.resume();
      res.on('end', () => ok(res.statusCode ?? 0));
    });
    req.on('error', fail);
    req.end(r.method === 'POST' ? BODY : undefined);
  });
}

const json = { 'Content-Type': 'application/json' };
const local = (port: number) => ({ Host: `127.0.0.1:${port}` });

describe('interactive routes: local only', () => {
  let on: Awaited<ReturnType<typeof serve>>;
  let off: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    on = await serve(true);
    off = await serve(false);
  });
  afterAll(async () => {
    await on.close();
    await off.close();
  });

  it('the table covers every action prefix', () => {
    for (const p of ACTION_PREFIXES) expect(ROUTES.some((r) => r.path.startsWith(p)), p).toBe(true);
  });

  it('only a loopback bind turns them on', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost']) expect(interactive({ interactiveRequested: true, host }), host).toBe(true);
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'office.lan', '']) expect(interactive({ interactiveRequested: true, host }), host).toBe(false);
    expect(interactive({ interactiveRequested: false, host: '127.0.0.1' })).toBe(false);
  });

  for (const r of ROUTES) {
    describe(`${r.method} ${r.path}`, () => {
      it('is refused (403) while the features are off', async () => {
        expect(await request(off.port, r, { ...local(off.port), ...json })).toBe(403);
      });

      it('is refused (403) with a non-loopback Host, even an allow-listed one', async () => {
        expect(await request(on.port, r, { Host: 'office.lan', ...json })).toBe(403);
        expect(await request(on.port, r, { Host: 'evil.example', ...json })).toBe(403);
      });

      if (r.method === 'POST') {
        it('is refused without a JSON body (415)', async () => {
          expect(await request(on.port, r, { ...local(on.port), 'Content-Type': 'text/plain' })).toBe(415);
          expect(await request(on.port, r, { ...local(on.port), 'Content-Type': 'application/x-www-form-urlencoded' })).toBe(415);
        });

        it('is refused from a foreign Origin (403)', async () => {
          expect(await request(on.port, r, { ...local(on.port), ...json, Origin: 'https://evil.example' })).toBe(403);
          expect(await request(on.port, r, { ...local(on.port), ...json, Origin: 'null' })).toBe(403);
        });
      }

      it('passes the gate from this computer (whatever the route answers next)', async () => {
        const status = await request(on.port, r, { ...local(on.port), ...json, Origin: `http://127.0.0.1:${on.port}` });
        expect(status).not.toBe(403);
        expect(status).not.toBe(415);
      });
    });
  }
});
