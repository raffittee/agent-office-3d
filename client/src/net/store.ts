// Ported from habblaud client/src/net/store.ts (MIT, © 2026 Márcio Junior)
// The office state in the browser: snapshots, feed and notices from the server over SSE (or from the in-browser demo
// office with ?mock=1), handed to subscribers. It also reconnects: when the browser gives up on the stream (the
// EventSource closes after an HTTP error, e.g. the server restarting), it retries with a growing delay.
// Not ported: permissions, messages, the character editor and the timelapse (Phase 7 / backlog).
import { createMockOffice, type MockOffice } from '../../../shared/demo/mock';
import type { DemoOptions } from '../../../shared/demo/simulator';
import type { Activity, AgentDetail, AgentInfo, FeedItem, Notice, OfficeSnapshot, RoomInfo } from '../../../shared/protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'mock';

export interface StoreEvents {
  snapshot: OfficeSnapshot;
  feed: FeedItem[];
  notice: Notice;
  connection: ConnectionState;
  /** The server now serves another client build: this page is stale. Emitted once. */
  update: { build: string; current: string };
}

/**
 * This page's build: the main bundle's name (e.g. "main-BFqheOCa"), read from the module's own URL. In dev mode (Vite
 * serving sources) there is no bundle and the result is undefined.
 */
export function pageBuild(moduleUrl: string = import.meta.url): string | undefined {
  try {
    return /\/bundle\/(main-[\w-]+)\.js$/.exec(new URL(moduleUrl).pathname)?.[1];
  } catch {
    return undefined;
  }
}

type Listener<K extends keyof StoreEvents> = (value: StoreEvents[K]) => void;

/** The part of EventSource the store uses (tests inject a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export interface StoreOptions {
  mock?: boolean;
  /** Mock-mode parameters (default: the page's query string). */
  search?: string;
  /** Stream factory (default: `new EventSource(url)`). */
  eventSource?: (url: string) => EventSourceLike;
}

const FEED_LIMIT = 200;
/** EventSource.CLOSED (a literal: Node, where tests run, has no EventSource). */
const ES_CLOSED = 2;
const MOCK_TICK_MS = 250;
/** Delay between reconnection attempts: 2 s, 4 s, 8 s… up to 30 s. */
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/** Demo options from the query string (?speed=2&sessions=6&seed=7). `sessions=0` is valid: an empty office. */
export function mockOptionsFrom(search: string): Required<Pick<DemoOptions, 'speed' | 'sessions'>> & Pick<DemoOptions, 'seed'> {
  const params = new URLSearchParams(search);
  const num = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const speed = num('speed');
  const sessions = num('sessions');
  const seed = num('seed');
  return {
    speed: speed !== null && speed > 0 ? Math.min(speed, 50) : 1,
    sessions: sessions !== null && sessions >= 0 ? Math.min(Math.floor(sessions), 40) : 4,
    ...(seed !== null && seed >= 0 ? { seed: Math.floor(seed) } : {}),
  };
}

export class OfficeStore {
  snapshot: OfficeSnapshot | null = null;
  /** The office-wide feed, oldest first. */
  feed: FeedItem[] = [];
  connection: ConnectionState = 'connecting';
  readonly mock: boolean;
  /** This page's build (see pageBuild); exposed for tests. */
  pageBuildId: string | undefined = pageBuild();

  private listeners = new Map<keyof StoreEvents, Set<(value: never) => void>>();
  private agentIndex = new Map<string, AgentInfo>();
  private roomIndex = new Map<string, RoomInfo>();
  private source: EventSourceLike | null = null;
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private mockOffice: MockOffice | null = null;
  private readonly search: string;
  private readonly openStream: (url: string) => EventSourceLike;
  /** Reconnection: failed attempts in a row, and the timer of the next one. */
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt: number | null = null;
  /** Disconnected on purpose (disconnect()): no automatic reconnection. */
  private stopped = true;
  private updateAnnounced = false;
  private readonly onOnline = () => {
    if (!this.stopped && this.connection === 'closed') this.reconnectNow();
  };

  constructor(opts: StoreOptions = {}) {
    this.mock = !!opts.mock;
    this.search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    this.openStream = opts.eventSource ?? ((url) => new EventSource(url));
  }

  on<K extends keyof StoreEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb as (value: never) => void);
    return () => void set.delete(cb as (value: never) => void);
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.mock) return this.startMock();
    this.startSSE();
  }

  disconnect(): void {
    this.stopped = true;
    if (typeof removeEventListener === 'function') removeEventListener('online', this.onOnline);
    this.clearRetry();
    this.closeSource();
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }

  /** Reconnects now ("Retry now"), without waiting for the next attempt. */
  reconnectNow(): void {
    if (this.mock) return;
    this.clearRetry();
    this.closeSource();
    this.stopped = false;
    this.startSSE();
  }

  /** When the next automatic reconnection happens (epoch ms), or null. */
  get nextRetryAt(): number | null {
    return this.retryAt;
  }

  agent(id: string): AgentInfo | undefined {
    return this.agentIndex.get(id);
  }

  room(id: string): RoomInfo | undefined {
    return this.roomIndex.get(id);
  }

  agentsInRoom(roomId: string): AgentInfo[] {
    return (this.snapshot?.agents ?? []).filter((a) => a.roomId === roomId);
  }

  /** An agent's long history (GET /api/agents/:id). Falls back to the snapshot's `recent`. */
  async agentHistory(id: string): Promise<Activity[]> {
    const fallback = this.agent(id)?.recent ?? [];
    if (this.mockOffice) return this.mockOffice.office.detail(id)?.history ?? fallback;
    if (this.mock) return fallback;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
      if (!res.ok) return fallback;
      return ((await res.json()) as AgentDetail).history;
    } catch {
      return fallback;
    }
  }

  // ---------------------------------------------------------------- internals

  private emit<K extends keyof StoreEvents>(event: K, value: StoreEvents[K]): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        (cb as Listener<K>)(value);
      } catch (err) {
        console.error(`[store] a "${event}" listener failed`, err);
      }
    });
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit('connection', state);
  }

  private applySnapshot(snap: OfficeSnapshot): void {
    const cur = this.snapshot;
    // An older revision of the same server run (a late frame) is dropped; a restarted server starts over.
    if (cur && snap.rev < cur.rev && snap.meta.startedAt === cur.meta.startedAt) return;
    this.snapshot = snap;
    this.agentIndex = new Map(snap.agents.map((a) => [a.id, a]));
    this.roomIndex = new Map(snap.rooms.map((r) => [r.id, r]));
    this.emit('snapshot', snap);
    this.checkBuild(snap.meta.build);
  }

  /** Announces (once) that the server now serves another client build. */
  private checkBuild(serverBuild: string | undefined): void {
    if (this.updateAnnounced || this.mock || !serverBuild) return;
    const current = this.pageBuildId;
    if (!current || current === serverBuild) return;
    this.updateAnnounced = true;
    this.emit('update', { build: serverBuild, current });
  }

  private applyFeed(items: FeedItem[]): void {
    if (!items.length) return;
    const known = new Set(this.feed.map((f) => f.id));
    const fresh = items.filter((f) => !known.has(f.id));
    if (!fresh.length) return;
    this.feed = [...this.feed, ...fresh].slice(-FEED_LIMIT);
    this.emit('feed', fresh);
  }

  /** Reads an SSE event's JSON; a corrupt message is ignored without dropping the stream. */
  private parse<T>(ev: Event, what: string): T | null {
    try {
      return JSON.parse((ev as MessageEvent<string>).data) as T;
    } catch (err) {
      console.warn(`[store] ignored an invalid ${what}`, err);
      return null;
    }
  }

  private startSSE(): void {
    // Network back (Wi-Fi, VPN): don't wait for the next attempt.
    if (typeof addEventListener === 'function') addEventListener('online', this.onOnline);
    this.setConnection('connecting');
    let es: EventSourceLike;
    try {
      es = this.openStream('/api/stream');
    } catch (err) {
      console.error('[store] could not open the stream', err);
      this.setConnection('closed');
      this.scheduleRetry();
      return;
    }
    this.source = es;
    // Events from a replaced stream (after a reconnection) no longer count.
    const current = () => this.source === es;
    es.addEventListener('open', () => {
      if (!current()) return;
      this.attempts = 0;
      this.clearRetry();
      this.setConnection('open');
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: the browser retries by itself. CLOSED: it gave up, so reconnecting is up to us.
      if (es.readyState === ES_CLOSED) {
        this.setConnection('closed');
        this.scheduleRetry();
      } else {
        this.setConnection('connecting');
      }
    });
    es.addEventListener('snapshot', (ev) => {
      if (!current()) return;
      const snap = this.parse<OfficeSnapshot>(ev, 'snapshot');
      if (snap) this.applySnapshot(snap);
    });
    es.addEventListener('feed', (ev) => {
      if (!current()) return;
      const items = this.parse<FeedItem[]>(ev, 'feed');
      if (items) this.applyFeed(items);
    });
    es.addEventListener('notice', (ev) => {
      if (!current()) return;
      const n = this.parse<Notice>(ev, 'notice');
      if (n) this.emit('notice', n);
    });
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.mock || this.stopped) return;
    const delay = reconnectDelay(this.attempts);
    this.attempts++;
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      if (!this.stopped && this.connection === 'closed') {
        this.closeSource();
        this.startSSE();
      }
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  /** ?mock=1: the demo simulator and the real reducer, in this page. */
  private startMock(): void {
    if (this.mockTimer) return;
    this.setConnection('mock');
    const mock = (this.mockOffice ??= createMockOffice(mockOptionsFrom(this.search), Date.now()));
    const step = () => {
      const r = mock.step(Date.now());
      if (r.changed || !this.snapshot) this.applySnapshot(r.snapshot);
      this.applyFeed(r.feed);
      r.notices.forEach((n) => this.emit('notice', n));
    };
    step();
    this.mockTimer = setInterval(step, MOCK_TICK_MS);
  }
}
