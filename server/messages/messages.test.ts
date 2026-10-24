// Messages from the office (P7-04): the registry's rules, Codex's `codex queue` runner, and the routes with the
// TypeScript SDK's inbox end to end.
import { chmodSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Office } from '../../shared/model/office';
import type { AgentEvent, OfficeSnapshot, OutboxMessage } from '../../shared/protocol';
import { AgentOffice } from '../../sdk/ts/agent-office';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { tempDir } from '../test/helpers';
import { createCodexQueueRunner, errorLine, findCodexBin, queueArgs, type CodexQueueJob } from './codex';
import { createMessageRoutes } from './http';
import { ERR_GONE, ERR_NOT_CONFIRMED, ERR_NOT_FETCHED, MAX_OPEN, MessageRegistry, PRESENCE_MS, QUEUED_TIMEOUT_MS, SENT_TIMEOUT_MS } from './registry';

setQuiet(true);

const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const ev = (provider: AgentEvent['provider'], session: string, type: AgentEvent['type'], extra: Partial<AgentEvent> = {}): AgentEvent => ({ v: 1, provider, account: 'default', session, cwd: '/p/shop', at: Date.now(), type, ...extra });

function setup(codex?: { calls: CodexQueueJob[]; ok?: boolean }) {
  let clock = 1_000_000;
  // eslint-disable-next-line prefer-const
  let registry: MessageRegistry;
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: clock, now: () => clock, interactive: true, canMessage: (a) => registry.canMessage(a) });
  registry = new MessageRegistry({
    office,
    now: () => clock,
    ...(codex
      ? {
          codex: {
            homeOf: (account: string) => (account === 'default' ? '/home/dev/.codex' : undefined),
            run: async (job: CodexQueueJob) => {
              codex.calls.push(job);
              return codex.ok === false ? { ok: false as const, error: 'Error: no rollout found for thread id' } : { ok: true as const };
            },
          },
        }
      : {}),
  });
  office.apply(ev('claude-code', 's1', 'session.start', { at: clock }));
  office.apply(ev('codex', THREAD, 'session.start', { at: clock }));
  const claude = 'claude-code:default:s1';
  const codexId = `codex:default:${THREAD}`;
  return { office, registry, claude, codexId, advance: (ms: number) => (clock += ms) };
}

const msgOf = (r: ReturnType<MessageRegistry['send']>): OutboxMessage => {
  if (!('message' in r)) throw new Error(JSON.stringify(r));
  return r.message;
};

describe('message registry', () => {
  it('a Claude session can be messaged only while its plugin polls; the box shows on the agent', () => {
    const s = setup();
    expect(s.registry.send({ agentId: s.claude, text: 'hi' })).toMatchObject({ error: 'unavailable', reason: expect.stringContaining('agent-office-messages') });
    expect(s.registry.inbox({ provider: 'claude-code', session: 's1' })).toEqual([]);
    expect(s.office.commit().snapshot.agents.find((a) => a.id === s.claude)!.canMessage).toBe(true);
    s.advance(PRESENCE_MS + 1);
    s.registry.tick();
    expect(s.office.commit().snapshot.agents.find((a) => a.id === s.claude)!.canMessage).toBeUndefined();
    expect(s.registry.send({ agentId: 'nope', text: 'hi' })).toEqual({ error: 'not-found' });
    expect(s.registry.send({ agentId: s.claude, text: '  ' })).toEqual({ error: 'invalid' });
  });

  it('queued → sent → delivered, in order, with the activity; only the right session can confirm', () => {
    const s = setup();
    s.registry.inbox({ provider: 'claude-code', session: 's1' });
    const a = msgOf(s.registry.send({ agentId: s.claude, text: 'run the tests' }));
    const b = msgOf(s.registry.send({ agentId: s.claude, text: 'then open a PR with key sk-proj-0123456789abcdefghij' }));
    expect(a.status).toBe('queued');
    expect(s.registry.inbox({ provider: 'custom:x', session: 's1' })).toEqual([]);
    expect(s.registry.inbox({ provider: 'claude-code', session: 's1' })).toEqual([
      { id: a.id, text: 'run the tests' },
      { id: b.id, text: 'then open a PR with key sk-proj-0123456789abcdefghij' },
    ]);
    expect(s.registry.get(a.id)!.status).toBe('sent');
    s.registry.ack({ provider: 'claude-code', session: 'other', results: [{ id: a.id, ok: true }] });
    expect(s.registry.get(a.id)!.status).toBe('sent');
    s.registry.ack({ provider: 'claude-code', session: 's1', results: [{ id: a.id, ok: true }, { id: b.id, ok: false, error: 'refused by a hook' }] });
    expect(s.registry.get(a.id)).toMatchObject({ status: 'delivered' });
    expect(s.registry.get(b.id)).toMatchObject({ status: 'failed', error: 'refused by a hook' });
    const history = s.office.detail(s.claude)!.history;
    expect(history.some((h) => h.text === 'Message from the office' && h.detail === 'run the tests')).toBe(true);
    expect(JSON.stringify(history)).not.toContain('0123456789abcdefghij');
  });

  it('fails what nobody fetched or confirmed, and the messages of an agent that left; caps open messages', () => {
    const s = setup();
    s.registry.inbox({ provider: 'claude-code', session: 's1' });
    const a = msgOf(s.registry.send({ agentId: s.claude, text: 'one' }));
    s.advance(QUEUED_TIMEOUT_MS);
    s.registry.tick();
    expect(s.registry.get(a.id)).toMatchObject({ status: 'failed', error: ERR_NOT_FETCHED });
    s.registry.inbox({ provider: 'claude-code', session: 's1' });
    const b = msgOf(s.registry.send({ agentId: s.claude, text: 'two' }));
    s.registry.inbox({ provider: 'claude-code', session: 's1' });
    s.advance(SENT_TIMEOUT_MS);
    s.registry.tick();
    expect(s.registry.get(b.id)).toMatchObject({ status: 'failed', error: ERR_NOT_CONFIRMED });
    s.registry.inbox({ provider: 'claude-code', session: 's1' });
    for (let i = 0; i < MAX_OPEN; i++) msgOf(s.registry.send({ agentId: s.claude, text: `m${i}` }));
    expect(s.registry.send({ agentId: s.claude, text: 'too many' })).toEqual({ error: 'too-many' });
    s.office.apply(ev('claude-code', 's1', 'session.end'));
    s.registry.tick();
    expect(s.registry.send({ agentId: s.claude, text: 'x' })).toEqual({ error: 'not-found' });
  });

  it('Codex: `codex queue` with the account’s home and the thread id; its error comes back', async () => {
    const calls: CodexQueueJob[] = [];
    const s = setup({ calls });
    const a = msgOf(s.registry.send({ agentId: s.codexId, text: 'also fix the lint' }));
    expect(a.status).toBe('sent');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ codexHome: '/home/dev/.codex', thread: THREAD, text: 'also fix the lint' }]);
    expect(s.registry.get(a.id)!.status).toBe('delivered');
    const failing = setup({ calls: [], ok: false });
    const b = msgOf(failing.registry.send({ agentId: failing.codexId, text: 'x' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(failing.registry.get(b.id)).toMatchObject({ status: 'failed', error: 'Error: no rollout found for thread id' });
    // without the binary, Codex agents have no message box
    expect(setup().registry.send({ agentId: s.codexId, text: 'x' })).toMatchObject({ error: 'unavailable' });
    void ERR_GONE;
  });
});

describe('codex queue runner', () => {
  it('arguments never turn the text into an option; the binary comes from AGENT_OFFICE_CODEX_BIN or PATH', () => {
    expect(queueArgs(THREAD, '--help me')).toEqual(['queue', `--thread=${THREAD}`, '--message=--help me']);
    expect(findCodexBin({ AGENT_OFFICE_CODEX_BIN: '/x/codex' }, (p) => p === '/x/codex')).toBe('/x/codex');
    expect(findCodexBin({ AGENT_OFFICE_CODEX_BIN: '/x/missing' }, () => false)).toBeUndefined();
    // codex-cli 0.164.0's real stderr for an unknown thread (a warning first, then the error, then a backtrace)
    expect(errorLine('WARNING: proceeding, even though we could not create PATH aliases\nError: failed to queue session message: no rollout found for thread id x (code -32603)\n\nStack backtrace:\n   0: <unknown>')).toBe(
      'Error: failed to queue session message: no rollout found for thread id x (code -32603)',
    )
    expect(errorLine('just this')).toBe('just this');
    expect(findCodexBin({ PATH: ['/a', '/b'].join(process.platform === 'win32' ? ';' : ':') }, (p) => /^[\\/]b[\\/]/.test(p))).toMatch(/^[\\/]b[\\/]codex/);
  });

  it.skipIf(process.platform === 'win32')('runs the binary with CODEX_HOME and reports stderr’s first line', async () => {
    const tmp = tempDir();
    try {
      const bin = join(tmp.dir, 'codex');
      writeFileSync(bin, `#!/bin/sh\nif [ "$3" = "--message=fail" ]; then echo "Error: no rollout found for thread id" >&2; exit 1; fi\necho "$CODEX_HOME $1 $2 $3" > "${join(tmp.dir, 'out.txt')}"\n`);
      chmodSync(bin, 0o755);
      const run = createCodexQueueRunner(bin);
      expect(await run({ codexHome: '/home/dev/.codex', thread: THREAD, text: 'hello' })).toEqual({ ok: true });
      expect(await run({ codexHome: '/home/dev/.codex', thread: THREAD, text: 'fail' })).toEqual({ ok: false, error: 'Error: no rollout found for thread id' });
      expect(await run({ codexHome: 'relative', thread: THREAD, text: 'x' })).toMatchObject({ ok: false });
      expect(await run({ codexHome: '/h', thread: 'not-a-uuid', text: 'x' })).toMatchObject({ ok: false });
    } finally {
      tmp.cleanup();
    }
  });
});

describe('message routes with the SDK inbox', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('the page sends, the SDK agent polls, delivers and confirms; the page sees the status', async () => {
    let registry: MessageRegistry | undefined;
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now(), interactive: true, canMessage: (a) => registry?.canMessage(a) ?? false });
    registry = new MessageRegistry({ office });
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const routes = createMessageRoutes(registry);
    const api = createApiHandler({ office, hub, version: 't', sources: () => [], providers: () => [], actions: { '/api/messages': routes, '/api/inbox': routes } });
    const guard = createRequestGuard({ allowedHosts: new Set() });
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      });

    const agent = new AgentOffice({ name: 'helper', url: base, heartbeatMs: 0, pid: false });
    await agent.sessionStart();
    // the ingest route isn't mounted here: report the session straight to the office
    office.apply({ v: 1, provider: agent.provider, account: 'default', session: agent.session, at: Date.now(), type: 'session.start' });
    const id = `${agent.provider}:default:${agent.session}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/api/messages', { agentId: id, text: 'hi' })).status).toBe(409);
    expect(await agent.inbox()).toEqual([]);
    const snap = (await (await fetch(`${base}/api/snapshot`)).json()) as OfficeSnapshot;
    expect(snap.agents.find((a) => a.id === id)?.canMessage).toBe(true);
    const sent = await post('/api/messages', { agentId: id, text: 'summarize the logs' });
    expect(sent.status).toBe(201);
    const msg = (await sent.json()) as OutboxMessage;
    expect(JSON.stringify(msg)).not.toContain('summarize');
    const got = await agent.inbox();
    expect(got).toEqual([{ id: msg.id, text: 'summarize the logs' }]);
    await agent.ack([{ id: msg.id, ok: true }]);
    const status = (await (await fetch(`${base}/api/messages/${encodeURIComponent(msg.id)}`)).json()) as OutboxMessage;
    expect(status.status).toBe('delivered');
    expect((await post('/api/inbox', { provider: 'gemini-cli', session: 'x' })).status).toBe(400);
    await agent.close();
  });
});
