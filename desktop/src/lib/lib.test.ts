// The desktop app's pure parts: port choice, server adoption, restarts, security rules, window and settings maths,
// tray counting. No Electron needed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attentionOf, newlyWaiting, notificationText, trayTooltip } from './attention';
import { parseHealth, probeHealth } from './health';
import { classifyPort, isPortFree, resolveServer, versionNote, type PortProbe } from './ports';
import { externalUrl, isAppUrl, isTrustedSender, permissionAllowed } from './security';
import { startServer } from './serverProcess';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings } from './settings';
import { SseParser, watchSnapshots } from './sse';
import { nextAction } from './supervisor';
import { defaultBounds, fitBounds } from './windowState';

const HEALTH = { ok: true, version: '1.2.3', demo: false, providers: [], sources: [] };
const FAKE = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe('health', () => {
  it('accepts only Agent Office’s /api/health', () => {
    expect(parseHealth(HEALTH)).toEqual({ version: '1.2.3', demo: false });
    expect(parseHealth({ ...HEALTH, demo: true })).toEqual({ version: '1.2.3', demo: true });
    for (const bad of [null, 'x', {}, { ok: false, version: '1', providers: [] }, { ok: true, providers: [] }, { ok: true, version: '1' }]) expect(parseHealth(bad)).toBeNull();
  });

  it('probes a port and treats errors as "not Agent Office"', async () => {
    expect(await probeHealth(1, (async () => new Response(JSON.stringify(HEALTH))) as typeof fetch)).toEqual({ version: '1.2.3', demo: false });
    expect(await probeHealth(1, (async () => new Response('nope', { status: 500 })) as typeof fetch)).toBeNull();
    expect(await probeHealth(1, (async () => new Response('<html>')) as typeof fetch)).toBeNull();
    expect(await probeHealth(1, (async () => Promise.reject(new Error('refused'))) as typeof fetch)).toBeNull();
  });
});

describe('ports', () => {
  const probe = (office: number[], busy: number[] = []): PortProbe => ({
    health: async (p) => (office.includes(p) ? { version: '1.0.0', demo: false } : null),
    free: async (p) => !busy.includes(p) && !office.includes(p),
  });

  it('tells Agent Office, free and busy ports apart', async () => {
    expect((await classifyPort(1, probe([1]))).state).toBe('agent-office');
    expect((await classifyPort(2, probe([1]))).state).toBe('free');
    expect((await classifyPort(3, probe([], [3]))).state).toBe('busy');
  });

  it('starts a server on a free preferred port', async () => {
    expect(await resolveServer(4848, probe([]))).toEqual({ kind: 'spawn', port: 4848 });
  });

  it('adopts a running Agent Office instead of starting a second one', async () => {
    expect(await resolveServer(4848, probe([4848]))).toEqual({ kind: 'adopt', port: 4848, version: '1.0.0' });
  });

  it('skips a port held by another program', async () => {
    expect(await resolveServer(4848, probe([], [4848, 4849]))).toEqual({ kind: 'spawn', port: 4850 });
    expect(await resolveServer(4848, probe([4849], [4848]))).toEqual({ kind: 'adopt', port: 4849, version: '1.0.0' });
  });

  it('gives up with a useful message when nothing is free', async () => {
    await expect(resolveServer(65530, probe([], [65530, 65531, 65532, 65533, 65534, 65535]))).rejects.toThrow(/No free port/);
  });

  it('really checks a port', async () => {
    const port = await freePort();
    expect(await isPortFree(port)).toBe(true);
    const s = createServer().listen(port, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    expect(await isPortFree(port)).toBe(false);
    s.close();
  });

  it('mentions a version mismatch only when there is one', () => {
    expect(versionNote('0.1.0', '0.1.0')).toBeNull();
    expect(versionNote('0.2.0', '0.1.0')).toContain('0.1.0');
  });
});

describe('supervisor', () => {
  it('restarts with a growing pause, then gives up', () => {
    const now = 100_000;
    expect(nextAction([now], now)).toEqual({ action: 'restart', delayMs: 500 });
    expect(nextAction([now - 5000, now], now)).toEqual({ action: 'restart', delayMs: 1000 });
    expect(nextAction([now - 9000, now - 5000, now], now)).toEqual({ action: 'restart', delayMs: 2000 });
    expect(nextAction([now - 9000, now - 7000, now - 5000, now], now)).toEqual({ action: 'give-up' });
  });

  it('forgets old exits', () => {
    const now = 1_000_000;
    expect(nextAction([now - 500_000, now - 400_000, now - 300_000, now], now)).toEqual({ action: 'restart', delayMs: 500 });
  });
});

describe('server process', () => {
  it('starts, answers health and stops cleanly', async () => {
    const port = await freePort();
    const logs: string[] = [];
    const server = await startServer({ execPath: process.execPath, entry: FAKE, port, onLog: (l) => logs.push(l), healthTimeoutMs: 10_000 });
    expect(server.port).toBe(port);
    expect(await probeHealth(port)).toEqual({ version: '9.9.9', demo: false });
    await server.stop();
    expect(await probeHealth(port)).toBeNull();
    expect(logs.join('\n')).toContain(`fake server on ${port}`);
  }, 30_000);

  it('reports a server that dies while starting, with its last output', async () => {
    const port = await freePort();
    await expect(startServer({ execPath: process.execPath, entry: FAKE, port, env: { FAKE_MODE: 'crash' }, healthTimeoutMs: 5000 })).rejects.toThrow(/stopped while starting[\s\S]*boom/);
  }, 30_000);

  it('gives up on a server that never answers and does not leave it running', async () => {
    const port = await freePort();
    await expect(startServer({ execPath: process.execPath, entry: FAKE, port, env: { FAKE_MODE: 'silent' }, healthTimeoutMs: 600 })).rejects.toThrow(/did not answer/);
  }, 30_000);

  it('tells the app when the server dies on its own', async () => {
    const port = await freePort();
    let exit: number | null | undefined;
    const server = await startServer({ execPath: process.execPath, entry: FAKE, port, healthTimeoutMs: 10_000, onUnexpectedExit: (code) => (exit = code) });
    process.kill(server.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    expect(exit === null || exit !== undefined).toBe(true);
    await server.stop();
  }, 30_000);
});

describe('security rules', () => {
  it('knows its own origin exactly', () => {
    expect(isAppUrl('http://127.0.0.1:4848/', 4848)).toBe(true);
    expect(isAppUrl('http://127.0.0.1:4848/?mode=widget#x', 4848)).toBe(true);
    for (const bad of ['http://127.0.0.1:4849/', 'http://localhost:4848/', 'https://127.0.0.1:4848/', 'http://127.0.0.1.evil.test:4848/', 'http://evil.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
      expect(isAppUrl(bad, 4848), bad).toBe(false);
    }
  });

  it('opens only plain web links in the browser', () => {
    expect(externalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(externalUrl('http://example.com')).toBe('http://example.com/');
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-msdt:/id', 'smb://host/share', 'https://user:pass@example.com/', 'x', '']) expect(externalUrl(bad), bad).toBeNull();
  });

  it('grants notifications and nothing else', () => {
    expect(permissionAllowed('notifications')).toBe(true);
    for (const p of ['media', 'geolocation', 'clipboard-read', 'midi', 'openExternal', 'fullscreen', 'display-capture']) expect(permissionAllowed(p), p).toBe(false);
  });

  it('trusts messages only from its own page', () => {
    expect(isTrustedSender('http://127.0.0.1:4848/', 4848)).toBe(true);
    expect(isTrustedSender(undefined, 4848)).toBe(false);
    expect(isTrustedSender('http://evil.test/', 4848)).toBe(false);
  });
});

describe('window bounds', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 1280, height: 720 };

  it('centers the window and puts the widget in the corner', () => {
    expect(defaultBounds('window', screen)).toEqual({ x: 320, y: 120, width: 1280, height: 800 });
    expect(defaultBounds('widget', screen)).toEqual({ x: 1920 - 420 - 16, y: 1040 - 300 - 16, width: 420, height: 300 });
    expect(defaultBounds('window', { x: 0, y: 0, width: 800, height: 600 })).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('keeps good saved bounds', () => {
    const saved = { x: 100, y: 100, width: 800, height: 500 };
    expect(fitBounds(saved, 'window', [screen])).toEqual(saved);
  });

  it('moves a window back when its monitor is gone', () => {
    const onSecond = { x: 2200, y: 100, width: 800, height: 500 };
    expect(fitBounds(onSecond, 'window', [screen])).toEqual(defaultBounds('window', screen));
    expect(fitBounds(onSecond, 'window', [screen, second])).toEqual(onSecond);
  });

  it('pulls a half-offscreen window in and enforces the size limits', () => {
    expect(fitBounds({ x: 1800, y: 900, width: 800, height: 500 }, 'window', [screen])).toEqual({ x: 1120, y: 540, width: 800, height: 500 });
    expect(fitBounds({ x: 10, y: 10, width: 50, height: 50 }, 'widget', [screen])).toEqual({ x: 10, y: 10, width: 260, height: 180 });
    expect(fitBounds({ x: 0, y: 0, width: 9000, height: 9000 }, 'window', [screen])).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('survives nonsense', () => {
    expect(fitBounds(undefined, 'widget', [screen])).toEqual(defaultBounds('widget', screen));
    expect(fitBounds({ x: NaN, y: 0, width: 5, height: 5 }, 'window', [screen])).toEqual(defaultBounds('window', screen));
    expect(fitBounds({ x: 0, y: 0, width: 600, height: 500 }, 'window', [])).toEqual(defaultBounds('window', { x: 0, y: 0, width: 1280, height: 800 }));
  });
});

describe('settings', () => {
  it('fills defaults and drops garbage', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ mode: 'widget', pinned: 'yes', opacity: 7, closeToTray: false, port: 80, bounds: { widget: { x: 1.4, y: 2, width: 300, height: 200 }, window: { x: 'a' } } });
    expect(s).toMatchObject({ mode: 'widget', pinned: true, opacity: 1, closeToTray: false, bounds: { widget: { x: 1, y: 2, width: 300, height: 200 } } });
    expect(s.port).toBeUndefined();
    expect(s.bounds.window).toBeUndefined();
    expect(sanitizeSettings({ opacity: 0 }).opacity).toBe(0.3);
    expect(sanitizeSettings({ port: 5000 }).port).toBe(5000);
  });

  it('round-trips through a file and tolerates a missing or broken one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-settings-'));
    try {
      const file = join(dir, 'sub', 'settings.json');
      expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
      const s = { ...DEFAULT_SETTINGS, mode: 'widget' as const, port: 4900, bounds: { widget: { x: 1, y: 2, width: 300, height: 200 } } };
      saveSettings(file, s);
      expect(loadSettings(file)).toEqual(s);
      expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
      writeFileSync(file, '{ not json');
      expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tray attention', () => {
  const rooms = [{ id: 'r1', name: 'api' }] as never;
  const agent = (id: string, status: string, extra = {}) => ({ id, name: id, roomId: 'r1', status, ...extra });
  const snap = (agents: unknown[]) => ({ agents, rooms }) as never;

  it('counts who waits, who works and who is around', () => {
    const a = attentionOf(snap([agent('ana', 'waiting'), agent('bia', 'working'), agent('caio', 'idle'), agent('davi', 'offline'), agent('eva', 'done')]));
    expect(a.waiting).toEqual([{ id: 'ana', name: 'ana', room: 'api' }]);
    expect(a.working).toBe(1);
    expect(a.total).toBe(3);
  });

  it('words the tooltip', () => {
    expect(trayTooltip(attentionOf(snap([])))).toBe('Agent Office: no agents');
    expect(trayTooltip(attentionOf(snap([agent('a', 'waiting'), agent('b', 'waiting'), agent('c', 'working'), agent('d', 'idle')])))).toBe('Agent Office: 2 need you · 1 working · 1 idle');
    expect(trayTooltip(attentionOf(snap([agent('a', 'waiting')])))).toBe('Agent Office: 1 needs you');
  });

  it('notifies once per agent that starts waiting', () => {
    const a1 = attentionOf(snap([agent('ana', 'waiting')]));
    const first = newlyWaiting(new Set(), a1);
    expect(first.fresh).toHaveLength(1);
    const again = newlyWaiting(first.next, a1);
    expect(again.fresh).toHaveLength(0);
    const gone = newlyWaiting(again.next, attentionOf(snap([agent('ana', 'working')])));
    expect(gone.next.size).toBe(0);
    expect(newlyWaiting(gone.next, a1).fresh).toHaveLength(1);
  });

  it('writes notifications that name the agent and room, never what it does', () => {
    expect(notificationText([])).toBeNull();
    expect(notificationText([{ id: 'a', name: 'Robin', room: 'api' }])).toEqual({ title: 'Agent Office', body: 'Robin (api) needs you' });
    expect(notificationText([{ id: 'a', name: 'Robin', room: '' }])?.body).toBe('Robin needs you');
    expect(notificationText([{ id: 'a', name: 'A', room: '' }, { id: 'b', name: 'B', room: '' }])?.body).toBe('2 agents need you');
  });
});

describe('live stream', () => {
  it('parses events split across chunks, comments and CRLF', () => {
    const p = new SseParser();
    expect(p.push('retry: 2000\n\n: ping\n\nevent: snap')).toEqual([]);
    expect(p.push('shot\ndata: {"a":1}\n\n')).toEqual([{ event: 'snapshot', data: '{"a":1}' }]);
    expect(p.push('event: feed\r\ndata: [1]\r\ndata: [2]\r\n\r\n')).toEqual([{ event: 'feed', data: '[1]\n[2]' }]);
    expect(p.push('data: plain\n\n')).toEqual([{ event: 'message', data: 'plain' }]);
  });

  it('delivers snapshots, ignores other events, and reconnects', async () => {
    let connections = 0;
    const server = http.createServer((req, res) => {
      connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ rev: connections, agents: [], rooms: [] })}\n\n`);
      res.write('event: feed\ndata: []\n\n');
      res.write('event: snapshot\ndata: {broken\n\n');
      if (connections === 1) res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const revs: number[] = [];
    const states: boolean[] = [];
    const watch = watchSnapshots({ base: `http://127.0.0.1:${port}`, retryMs: 20, onSnapshot: (s) => revs.push(s.rev), onState: (c) => states.push(c) });
    const until = Date.now() + 5000;
    while (revs.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    watch.stop();
    server.closeAllConnections();
    server.close();
    expect(revs.slice(0, 2)).toEqual([1, 2]);
    expect(states[0]).toBe(true);
    expect(states).toContain(false);
  }, 15_000);
});
