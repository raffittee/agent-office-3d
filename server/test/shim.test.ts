// The shim kit (hooks/shim.mjs) run as a real process against a test server, with a FAKE home.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './helpers';

const SHIM = resolve(__dirname, '../../hooks/shim.mjs');

interface ShimModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number };
  trimDeep(v: unknown, max?: number): unknown;
  fitBody(v: unknown): unknown;
  isShellName(name: string): boolean;
  agentPid(ppid: number, info: (pid: number) => [number, string] | undefined): number;
  processInfo(pid: number): [number, string] | undefined;
}
const shim = (await import(pathToFileURL(SHIM).href)) as ShimModule;

let tmp: ReturnType<typeof tempDir>;
let home: string;
beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  mkdirSync(join(home, '.agent-office'), { recursive: true });
});
afterEach(() => tmp.cleanup());

function runShim(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}, script = SHIM): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.resume();
    const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

async function capture(): Promise<{ port: number; requests: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }>; close: () => Promise<void> }> {
  const requests: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: JSON.parse(raw) as unknown, headers: req.headers });
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"accepted":1}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { port: (server.address() as AddressInfo).port, requests, close: () => new Promise((ok) => server.close(() => ok())) };
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

describe('hooks/shim.mjs as a real process', () => {
  it('forwards stdin to /api/hooks/<provider> on the configured port, as JSON, with nothing on stdout', async () => {
    const srv = await capture();
    try {
      writeFileSync(join(home, '.agent-office', 'hooks.json'), JSON.stringify({ port: srv.port }));
      const input = { session_id: 's1', hook_event_name: 'BeforeAgent', prompt: 'x'.repeat(20_000) };
      const r = await runShim(['gemini-cli'], JSON.stringify(input));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(srv.requests).toHaveLength(1);
      expect(srv.requests[0]!.path).toBe('/api/hooks/gemini-cli');
      expect(srv.requests[0]!.headers['content-type']).toBe('application/json');
      const body = srv.requests[0]!.body as { session_id: string; prompt: string };
      expect(body.session_id).toBe('s1');
      expect(body.prompt).toHaveLength(8 * 1024);
    } finally {
      await srv.close();
    }
  });

  it('hooks/gemini-cli.mjs posts the slimmed body: no file contents, nothing on stdout', async () => {
    const srv = await capture();
    try {
      const input = {
        session_id: 's1',
        hook_event_name: 'AfterTool',
        tool_name: 'write_file',
        tool_input: { file_path: 'config.env', content: 'API_KEY=hunter2' },
        tool_response: { llmContent: 'Successfully wrote config.env: API_KEY=hunter2', returnDisplay: '' },
      };
      const r = await runShim([], JSON.stringify(input), { AGENT_OFFICE_PORT: String(srv.port) }, resolve(__dirname, '../../hooks/gemini-cli.mjs'));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(srv.requests.map((q) => q.path)).toEqual(['/api/hooks/gemini-cli']);
      expect(srv.requests[0]!.body).toEqual({ hook_event_name: 'AfterTool', session_id: 's1', tool_name: 'write_file', tool_input: { file_path: 'config.env' }, tool_result: { ok: true } });
    } finally {
      await srv.close();
    }
  });

  it('AGENT_OFFICE_PORT works when there is no config file', async () => {
    const srv = await capture();
    try {
      await runShim(['custom:x'], '{"a":1}', { AGENT_OFFICE_PORT: String(srv.port) });
      expect(srv.requests.map((q) => q.path)).toEqual(['/api/hooks/custom%3Ax']);
    } finally {
      await srv.close();
    }
  });

  it('Agent Office down, bad JSON, empty stdin or a bad provider: exit 0 quickly, nothing on stdout', async () => {
    writeFileSync(join(home, '.agent-office', 'hooks.json'), JSON.stringify({ port: await deadPort() }));
    for (const [args, stdin] of [
      [['gemini-cli'], '{"session_id":"s"}'],
      [['gemini-cli'], '{ not json'],
      [['gemini-cli'], ''],
      [['../../etc'], '{}'],
      [[], '{}'],
    ] as const) {
      const r = await runShim([...args], stdin);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.ms).toBeLessThan(8_000);
    }
    // Five real process spawns in a row: the per-run budget above is what's tested, not the suite's default 5 s.
  }, 45_000);
});

describe('shim kit functions', () => {
  it('readConfig: file, then env, then 4848', () => {
    expect(shim.readConfig({ HOME: home }).port).toBe(4848);
    expect(shim.readConfig({ HOME: home, AGENT_OFFICE_PORT: '5001' }).port).toBe(5001);
    writeFileSync(join(home, '.agent-office', 'hooks.json'), JSON.stringify({ port: 4999 }));
    expect(shim.readConfig({ HOME: home, AGENT_OFFICE_PORT: '5001' }).port).toBe(4999);
    writeFileSync(join(home, '.agent-office', 'hooks.json'), '{"port":"nope"}');
    expect(shim.readConfig({ HOME: home }).port).toBe(4848);
  });

  it('trims strings and fits the body under 200 KB', () => {
    expect(shim.trimDeep({ a: 'x'.repeat(10), b: [{ c: 'y'.repeat(10) }] }, 4)).toEqual({ a: 'xxxx', b: [{ c: 'yyyy' }] });
    const big = { items: Array.from({ length: 150 }, () => 'z'.repeat(8_000)) };
    expect(JSON.stringify(shim.fitBody(big)).length).toBeLessThanOrEqual(200_000);
  });

  it('agentPid climbs over a shell wrapper only', () => {
    const tree: Record<number, [number, string]> = { 10: [5, 'pwsh.exe'], 20: [6, 'node.exe'], 30: [7, '/bin/bash'], 40: [1, 'bash'] };
    const info = (pid: number) => tree[pid];
    expect(shim.agentPid(10, info)).toBe(5);
    expect(shim.agentPid(20, info)).toBe(20);
    expect(shim.agentPid(30, info)).toBe(7);
    expect(shim.agentPid(40, info)).toBe(40); // init is never "the agent"
    expect(shim.agentPid(99, info)).toBe(99);
    for (const n of ['pwsh', 'powershell.exe', 'cmd.exe', '-zsh', '/usr/bin/sh']) expect(shim.isShellName(n)).toBe(true);
    for (const n of ['node', 'gemini', 'claude.exe']) expect(shim.isShellName(n)).toBe(false);
  });

  it('processInfo finds this process’s parent', () => {
    const info = shim.processInfo(process.pid);
    expect(info?.[0]).toBe(process.ppid);
  }, 15_000);
});
