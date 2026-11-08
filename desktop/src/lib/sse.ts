// Follows the server's live stream (GET /api/stream) from the app's main process, so the tray knows who waits for you
// without any new server route.
import type { OfficeSnapshot } from '../../../shared/protocol';

export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental parser of Server-Sent Events text. */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer);
      if (!m) break;
      const block = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}

export interface WatchOptions {
  base: string;
  onSnapshot: (snap: OfficeSnapshot) => void;
  onState?: (connected: boolean) => void;
  fetchImpl?: typeof fetch;
  retryMs?: number;
}

/** Keeps a connection to the stream open, reconnecting with a growing pause. `stop()` ends it. */
export function watchSnapshots(o: WatchOptions): { stop(): void } {
  const fetchImpl = o.fetchImpl ?? fetch;
  const ac = new AbortController();
  const base = o.retryMs ?? 1000;
  void (async () => {
    let failures = 0;
    while (!ac.signal.aborted) {
      try {
        const res = await fetchImpl(`${o.base}/api/stream`, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        o.onState?.(true);
        failures = 0;
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const m of parser.push(decoder.decode(value, { stream: true }))) {
            if (m.event !== 'snapshot') continue;
            try {
              o.onSnapshot(JSON.parse(m.data) as OfficeSnapshot);
            } catch {
              // a bad frame is skipped; the next snapshot replaces it
            }
          }
        }
      } catch {
        // fall through to reconnect (also when aborted: the loop condition ends it)
      }
      if (ac.signal.aborted) break;
      o.onState?.(false);
      failures++;
      await new Promise((r) => setTimeout(r, Math.min(10_000, base * 2 ** Math.min(failures - 1, 4))));
    }
  })();
  return { stop: () => ac.abort() };
}
