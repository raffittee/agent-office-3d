// Ported from habblaud client/src/net/store.test.ts (MIT, © 2026 Márcio Junior)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot } from '../../../shared/protocol';
import { mockOptionsFrom, OfficeStore, pageBuild, reconnectDelay, type EventSourceLike } from './store';

/** A fake EventSource: the test fires open/error and changes readyState. */
class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  private handlers = new Map<string, ((ev: Event) => void)[]>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  fire(type: string, data?: unknown): void {
    const ev = (data === undefined ? { type } : { type, data: JSON.stringify(data) }) as unknown as Event;
    this.handlers.get(type)?.forEach((fn) => fn(ev));
  }

  open(): void {
    this.readyState = 1;
    this.fire('open');
  }

  /** A final error (e.g. HTTP 502): the browser gives up and closes the stream. */
  fail(): void {
    this.readyState = 2;
    this.fire('error');
  }
}

describe('mockOptionsFrom', () => {
  it('uses the defaults without parameters', () => {
    expect(mockOptionsFrom('')).toEqual({ speed: 1, sessions: 4 });
  });

  it('accepts sessions=0 (an empty office)', () => {
    expect(mockOptionsFrom('?mock=1&sessions=0').sessions).toBe(0);
  });

  it('ignores invalid values and caps excessive ones', () => {
    expect(mockOptionsFrom('?sessions=abc&speed=-2')).toEqual({ speed: 1, sessions: 4 });
    expect(mockOptionsFrom('?sessions=&speed=')).toEqual({ speed: 1, sessions: 4 });
    expect(mockOptionsFrom('?sessions=6.7&speed=2')).toEqual({ speed: 2, sessions: 6 });
    expect(mockOptionsFrom('?sessions=999&speed=999')).toEqual({ speed: 50, sessions: 40 });
  });

  it('takes a fixed seed for screenshots', () => {
    expect(mockOptionsFrom('?mock=1&seed=7')).toEqual({ speed: 1, sessions: 4, seed: 7 });
    expect(mockOptionsFrom('?seed=-1')).toEqual({ speed: 1, sessions: 4 });
  });
});

describe('reconnectDelay', () => {
  it('doubles on every attempt, up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe('OfficeStore: reconnection', () => {
  let sources: FakeSource[];
  let store: OfficeStore;
  const last = () => sources[sources.length - 1]!;

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    store = new OfficeStore({
      eventSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
    });
  });

  afterEach(() => {
    store.disconnect();
    vi.useRealTimers();
  });

  it('repeated connect() keeps a single stream, closed by disconnect()', () => {
    store.connect();
    store.connect();
    last().open();
    store.connect();
    store.disconnect();
    expect(sources.map((s) => s.closed)).toEqual([true]);
  });

  it('reconnects by itself with a growing delay when the browser gives up on the stream', () => {
    const states: string[] = [];
    store.on('connection', (s) => states.push(s));
    store.connect();
    last().fail();
    expect(store.connection).toBe('closed');
    expect(sources).toHaveLength(1);

    vi.advanceTimersByTime(1_999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);

    // Second failure in a row: waits 4 s.
    last().fail();
    vi.advanceTimersByTime(3_999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);

    // Connected: the delay starts over.
    last().open();
    expect(store.connection).toBe('open');
    last().fail();
    vi.advanceTimersByTime(2_000);
    expect(sources).toHaveLength(4);
    expect(states).toEqual(['closed', 'connecting', 'closed', 'connecting', 'open', 'closed', 'connecting']);
  });

  it('a transient error (the browser still retries) schedules no reconnection of its own', () => {
    store.connect();
    last().open();
    last().readyState = 0;
    last().fire('error');
    expect(store.connection).toBe('connecting');
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });

  it('"Retry now" reconnects at once and cancels the scheduled attempt', () => {
    store.connect();
    last().fail();
    expect(store.nextRetryAt).not.toBeNull();
    store.reconnectNow();
    expect(sources).toHaveLength(2);
    expect(store.connection).toBe('connecting');
    expect(store.nextRetryAt).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(2);
  });

  it('disconnect() removes the network listener and connect() restores it without piling up', () => {
    const online = new Set<EventListener>();
    vi.stubGlobal('addEventListener', (type: string, cb: EventListener) => {
      if (type === 'online') online.add(cb);
    });
    vi.stubGlobal('removeEventListener', (type: string, cb: EventListener) => {
      if (type === 'online') online.delete(cb);
    });
    store = new OfficeStore({
      eventSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
    });
    try {
      for (let i = 0; i < 3; i++) {
        store.connect();
        expect(online.size).toBe(1);
        last().fail();
        online.forEach((cb) => cb(new Event('online')));
        expect(sources).toHaveLength((i + 1) * 2);
        expect(store.nextRetryAt).toBeNull();
        store.disconnect();
        expect(online.size).toBe(0);
        vi.advanceTimersByTime(60_000);
        expect(sources).toHaveLength((i + 1) * 2);
      }
    } finally {
      store.disconnect();
      vi.unstubAllGlobals();
    }
  });

  it('disconnect() does not reconnect, and events from the old stream are ignored', () => {
    store.connect();
    const old = last();
    store.disconnect();
    old.fail();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
    expect(store.connection).toBe('connecting');
  });

  it('applies snapshots, feed and notices; invalid JSON is ignored', () => {
    const notices: unknown[] = [];
    store.on('notice', (n) => notices.push(n));
    store.connect();
    last().open();
    const snap = { rev: 1, serverTime: 0, rooms: [], agents: [], accounts: [], meta: { demo: false, sources: [], providers: [], startedAt: 1, version: 't' } };
    last().fire('snapshot', snap);
    expect(store.snapshot?.rev).toBe(1);
    last().fire('feed', [{ id: 'f1', agentId: 'a', roomId: 'r', agentName: 'Ana', roomName: 'x', provider: 'claude-code', activity: { id: 'x', at: 0, kind: 'tool', icon: '·', text: 't' } }]);
    expect(store.feed).toHaveLength(1);
    last().fire('notice', { id: 'n', level: 'info', text: 'hi', at: 0 });
    expect(notices).toHaveLength(1);
    expect(() => last().fire('snapshot', undefined)).not.toThrow();
    const bad = { type: 'snapshot', data: '{broken' } as unknown as Event;
    expect(() => (last() as unknown as { handlers: Map<string, ((e: Event) => void)[]> }).handlers.get("snapshot")![0]!(bad)).not.toThrow();
    expect(store.snapshot?.rev).toBe(1);
  });
});

const snap = (rev: number, build?: string): OfficeSnapshot => ({
  rev,
  serverTime: 0,
  rooms: [],
  agents: [],
  accounts: [],
  meta: { demo: false, sources: [], providers: [], startedAt: 1, version: '0.1.0', build },
});

describe('new version detection', () => {
  it("reads the build from the bundle's URL and ignores dev mode sources", () => {
    expect(pageBuild('http://localhost:4747/bundle/main-BFqheOCa.js')).toBe('main-BFqheOCa');
    expect(pageBuild('http://192.168.0.10:4747/bundle/main-a_b-C1.js')).toBe('main-a_b-C1');
    expect(pageBuild('http://localhost:5173/src/net/store.ts')).toBeUndefined();
    expect(pageBuild('not a url')).toBeUndefined();
  });

  it('announces once that the server serves another build', () => {
    const store = new OfficeStore();
    store.pageBuildId = 'main-old';
    const seen: string[] = [];
    store.on('update', (u) => seen.push(`${u.current}->${u.build}`));
    const apply = (s: OfficeSnapshot) => (store as unknown as { applySnapshot(s: OfficeSnapshot): void }).applySnapshot(s);
    apply(snap(1, 'main-old'));
    expect(seen).toEqual([]);
    apply(snap(2, 'main-new'));
    apply(snap(3, 'main-new'));
    expect(seen).toEqual(['main-old->main-new']);
  });

  it('does not announce without a server build, in dev mode or in mock mode', () => {
    const dev = new OfficeStore();
    dev.pageBuildId = undefined;
    const mock = new OfficeStore({ mock: true });
    mock.pageBuildId = 'main-old';
    const noBuild = new OfficeStore();
    noBuild.pageBuildId = 'main-old';
    let count = 0;
    for (const s of [dev, mock, noBuild]) s.on('update', () => count++);
    const apply = (s: OfficeStore, x: OfficeSnapshot) => (s as unknown as { applySnapshot(s: OfficeSnapshot): void }).applySnapshot(x);
    apply(dev, snap(1, 'main-new'));
    apply(mock, snap(1, 'main-new'));
    apply(noBuild, snap(1));
    expect(count).toBe(0);
  });
});

describe('mock mode (?mock=1)', () => {
  it('runs the demo office in the page: snapshots with every demo provider, a feed, no network', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-25T09:00:00Z'));
    const opened: string[] = [];
    const store = new OfficeStore({ mock: true, search: '?mock=1&seed=3', eventSource: (url) => (opened.push(url), new FakeSource()) });
    try {
      const states: string[] = [];
      store.on('connection', (s) => states.push(s));
      store.connect();
      vi.advanceTimersByTime(5 * 60_000);
      expect(states).toEqual(['mock']);
      expect(opened).toEqual([]);
      expect(store.snapshot!.meta.demo).toBe(true);
      expect(store.snapshot!.agents.length).toBeGreaterThan(0);
      expect(store.feed.length).toBeGreaterThan(0);
      const a = store.snapshot!.agents[0]!;
      expect(store.agent(a.id)).toBe(a);
      expect((await store.agentHistory(a.id)).length).toBeGreaterThan(0);
    } finally {
      store.disconnect();
      vi.useRealTimers();
    }
  });
});
