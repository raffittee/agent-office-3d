// The read-only conversation view (P7-05): each provider's parser on real (sanitized) transcripts, masking, the
// tail reader, and the routes behind the interactive gate.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Office } from '../../shared/model/office';
import type { AgentInfo, ConversationPage, RecentSession } from '../../shared/protocol';
import { parseClaudeConversation } from '../adapters/claude-code/conversation';
import { parseCodexConversation } from '../adapters/codex/conversation';
import { parseGeminiConversation } from '../adapters/gemini-cli/conversation';
import type { AdapterSet, SessionFile } from '../adapters/adapter';
import { createApiHandler } from '../http/app';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { tempDir } from '../test/helpers';
import { readTail } from './files';
import { createConversationRoutes, sessionKey } from './http';

setQuiet(true);

const fixture = (p: string) => readFileSync(join(__dirname, '../../test/fixtures', p), 'utf8').split('\n');
const kinds = (e: { kind: string }[]) => e.map((x) => x.kind);

describe('parsers', () => {
  it('Claude Code: tool calls with their results; compaction; credentials and API requests never parsed', () => {
    const e = parseClaudeConversation(fixture('claude-code/transcript-denied.jsonl'));
    expect(kinds(e)).toEqual(['thinking', 'tool', 'result']);
    expect(e[1]).toMatchObject({ kind: 'tool', tool: 'Bash', title: 'Bash(npm test)', input: 'npm test' });
    expect(e[2]).toMatchObject({ kind: 'result', toolId: e[1]!.id, error: true });
    expect(kinds(parseClaudeConversation(fixture('claude-code/transcript-compact.jsonl')))).toContain('system');
    const lines = [
      JSON.stringify({ type: 'api-request', body: { messages: [{ content: 'SECRET-REQUEST' }] } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'credential_org', token: 'SECRET-ORG' } }),
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-24T10:00:00Z', message: { role: 'user', content: 'deploy with <system-reminder>hidden</system-reminder>key sk-proj-0123456789abcdefghij' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', isMeta: true, message: { content: 'meta' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'On it.' }] } }),
    ];
    const out = parseClaudeConversation(lines);
    expect(JSON.stringify(out)).not.toMatch(/SECRET|hidden|0123456789abcdefghij|meta/);
    expect(out.map((x) => (x.kind === 'user' || x.kind === 'assistant' ? x.text : x.kind))).toEqual(['deploy with key sk-***', 'On it.']);
  });

  it('Codex: prompts, tool calls and outputs (patches too); no developer or environment messages', () => {
    const e = parseCodexConversation(fixture('codex/rollout-main.jsonl'));
    expect(e[0]).toMatchObject({ kind: 'user', text: 'do the work' });
    expect(e[1]).toMatchObject({ kind: 'tool', tool: 'exec_command', title: 'exec_command(echo hello > b.txt)' });
    expect(e.find((x) => x.kind === 'result' && x.toolId === 'call_8')).toMatchObject({ error: true });
    expect(e.at(-1)).toMatchObject({ kind: 'assistant', text: 'All done.' });
    expect(JSON.stringify(e)).not.toMatch(/developer instructions|environment_context/);
    const p = parseCodexConversation(fixture('codex/rollout-patch.jsonl'));
    expect(p.find((x) => x.kind === 'tool' && x.tool === 'apply_patch')).toMatchObject({ input: expect.stringContaining('*** Add File: notes.md') });
  });

  it('Gemini CLI: rewrites by id, a cancelled call, the session context hidden, secrets masked', () => {
    const e = parseGeminiConversation(fixture('gemini-cli/chat-headless-work.jsonl'));
    expect(e[0]).toMatchObject({ kind: 'user', text: 'SCENARIO work: do the tasks' });
    expect(e.filter((x) => x.kind === 'tool').map((x) => (x.kind === 'tool' ? x.tool : ''))).toEqual(expect.arrayContaining(['read_file', 'replace', 'write_file', 'run_shell_command']));
    const json = JSON.stringify(e);
    expect(json).not.toContain('session_context');
    expect(json).not.toContain('FAKEFAKEFAKE');
    const deny = parseGeminiConversation(fixture('gemini-cli/chat-tui-allow-deny.jsonl'));
    expect(kinds(deny)).toEqual(['user', 'tool', 'result', 'tool', 'result', 'system', 'user', 'assistant']);
    expect(deny[4]).toMatchObject({ kind: 'result', error: true });
    const rewound = parseGeminiConversation([
      JSON.stringify({ id: 'a', type: 'user', timestamp: 1, content: [{ text: 'first' }] }),
      JSON.stringify({ id: 'b', type: 'user', timestamp: 2, content: [{ text: 'dropped' }] }),
      JSON.stringify({ $rewindTo: 'b' }),
      JSON.stringify({ id: 'a', type: 'user', timestamp: 1, content: [{ text: 'first, edited' }] }),
    ]);
    expect(rewound).toEqual([{ kind: 'user', id: 'a', at: 1, text: 'first, edited' }]);
  });
});

describe('reading', () => {
  it('reads only the tail, in whole lines', () => {
    const tmp = tempDir();
    try {
      const f = join(tmp.dir, 't.jsonl');
      writeFileSync(f, '');
      for (let i = 0; i < 200; i++) appendFileSync(f, `${JSON.stringify({ i })}\n`);
      expect(readTail(f).truncated).toBe(false);
      const tail = readTail(f, 300);
      expect(tail.truncated).toBe(true);
      expect(tail.lines.filter(Boolean).every((l) => /^\{"i":\d+\}$/.test(l))).toBe(true);
      expect(tail.lines.filter(Boolean).at(-1)).toBe('{"i":199}');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('routes', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(on: boolean) {
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now() });
    office.apply({ v: 1, provider: 'codex', account: 'default', session: 'thread-1', at: Date.now(), type: 'session.start', cwd: '/p/shop' });
    const file = join(__dirname, '../../test/fixtures/codex/rollout-main.jsonl');
    const ended: SessionFile = { provider: 'codex', account: 'default', sessionId: 'old', file, lastAt: 1_000, project: 'shop' };
    const adapters = {
      conversationOf: (a: AgentInfo) => (a.provider === 'codex' ? { file, parse: parseCodexConversation } : undefined),
      recentSessions: () => [ended],
      parserOf: () => parseCodexConversation,
    } as unknown as AdapterSet;
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const routes = createConversationRoutes(office, adapters);
    const api = createApiHandler({ office, hub, version: 't', sources: () => [], providers: () => [], ...(on ? { actions: { '/api/conversation': routes, '/api/sessions': routes } } : {}) });
    const server = http.createServer((req, res) => {
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    close = () =>
      new Promise<void>((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('off by default', async () => {
    const base = await serve(false);
    expect((await fetch(`${base}/api/conversation/x`)).status).toBe(403);
    expect((await fetch(`${base}/api/sessions`)).status).toBe(403);
  });

  it('an agent’s conversation, and the history without paths', async () => {
    const base = await serve(true);
    const page = (await (await fetch(`${base}/api/conversation/${encodeURIComponent('codex:default:thread-1')}`)).json()) as ConversationPage;
    expect(page.provider).toBe('codex');
    expect(page.entries[0]).toMatchObject({ kind: 'user', text: 'do the work' });
    expect((await fetch(`${base}/api/conversation/nobody`)).status).toBe(404);
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as RecentSession[];
    expect(list).toEqual([{ key: sessionKey({ provider: 'codex', account: 'default', sessionId: 'old' }), provider: 'codex', account: 'default', sessionId: 'old', lastAt: 1_000, open: false, project: 'shop' }]);
    expect(JSON.stringify(list)).not.toContain('fixtures');
    const old = (await (await fetch(`${base}/api/sessions/${list[0]!.key}/conversation`)).json()) as ConversationPage;
    expect(old.entries.length).toBeGreaterThan(5);
    expect((await fetch(`${base}/api/sessions/unknownkey123/conversation`)).status).toBe(404);
    expect((await fetch(`${base}/api/conversation/x`, { method: 'POST' })).status).toBe(405);
  });
});
