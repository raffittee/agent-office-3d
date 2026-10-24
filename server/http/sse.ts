// Ported from habblaud server/http/sse.ts (MIT, © 2026 Márcio Junior)
// Live updates (Server-Sent Events) at GET /api/stream. Named events: snapshot | feed | notice (`data` is the
// protocol JSON from shared/protocol.ts). Snapshots are throttled (~200 ms); feed and notices go right after.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OfficeSnapshot } from '../../shared/protocol';
import type { Office } from '../../shared/model/office';

/** A client too slow to keep up (buffer above this) is dropped; EventSource reconnects. */
const MAX_BUFFERED = 8 * 1024 * 1024;

/** Most open streams (pages) at once. */
export const MAX_CLIENTS = 64;

export class Hub {
  private clients = new Set<ServerResponse>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastFlush = 0;
  private unsubscribe: (() => void) | null = null;
  private snapshotCbs = new Set<(snap: OfficeSnapshot) => void>();
  private readonly throttleMs: number;
  private readonly pingMs: number;

  constructor(
    private readonly office: Office,
    opts: { throttleMs?: number; pingMs?: number } = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 200;
    this.pingMs = opts.pingMs ?? 15_000;
  }

  start(): void {
    this.unsubscribe = this.office.onChange(() => this.schedule());
    this.pinger = setInterval(() => this.writeAll(': ping\n\n'), this.pingMs);
    this.pinger.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Called on every new snapshot that goes out. */
  onSnapshot(cb: (snap: OfficeSnapshot) => void): () => void {
    this.snapshotCbs.add(cb);
    return () => void this.snapshotCbs.delete(cb);
  }

  /** Connects a client: full snapshot + the last 50 feed items, then the live stream. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    // P8-01: a runaway script opening streams can't exhaust the server
    if (this.clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '5', 'X-Content-Type-Options': 'nosniff' });
      res.end('{"error":"too many open pages"}');
      return;
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const snapshot = this.current();
    res.write('retry: 2000\n\n');
    res.write(frame('snapshot', snapshot));
    res.write(frame('feed', this.office.recentFeed(50)));
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  /** Closes the revision now and broadcasts whatever there is. Returns the current snapshot. */
  flush(): OfficeSnapshot {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastFlush = Date.now();
    const r = this.office.commit();
    if (r.changed) {
      this.writeAll(frame('snapshot', r.snapshot));
      for (const cb of this.snapshotCbs) {
        try {
          cb(r.snapshot);
        } catch {
          // listeners never break the broadcast
        }
      }
    }
    if (r.feed.length) this.writeAll(frame('feed', r.feed));
    for (const n of r.notices) this.writeAll(frame('notice', n));
    return r.snapshot;
  }

  /** Current snapshot (after broadcasting what's pending), with `serverTime` of now. */
  current(): OfficeSnapshot {
    return { ...this.flush(), serverTime: Date.now() };
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastFlush + this.throttleMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private writeAll(chunk: string): void {
    for (const c of this.clients) {
      if (c.destroyed || c.writableEnded) {
        this.clients.delete(c);
        continue;
      }
      if (c.writableLength > MAX_BUFFERED) {
        this.clients.delete(c);
        c.destroy();
        continue;
      }
      c.write(chunk);
    }
  }
}

export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
