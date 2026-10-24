// Ingest endpoints:
// - POST /api/events: AgentEvents from custom agents (sdk/), one or a batch of up to MAX_BATCH, all-or-nothing.
//   Only `custom:*` providers: built-in providers come through their adapters, so a script can't impersonate them.
// - POST /api/hooks/:provider: raw payloads from the hook shims (hooks/<provider>.mjs); the provider's adapter turns
//   them into AgentEvents.
// Both are local-only (loopback socket and a loopback Host), JSON-only (the edge guard), capped at 256 KB,
// rate-limited per source, validated and masked before they reach the office.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentEvent, ProviderId } from '../../shared/protocol';
import { validateAgentEvent } from '../../shared/validate';
import { HttpError, MAX_BODY, readJson, sendError, sendJson } from '../http/app';
import { isLoopbackHost } from '../http/guard';
import { errMsg, log } from '../log';
import { maskEvent } from './mask';

export const MAX_BATCH = 100;

export interface HookAdapter {
  /** Raw hook payload → normalized events (may be empty). */
  onHook(payload: unknown): AgentEvent[];
}

export interface IngestDeps {
  apply: (e: AgentEvent) => void;
  /** Adapters that accept hook payloads, by provider. */
  hooks: (provider: string) => HookAdapter | undefined;
  /** Events per second per source, and the burst allowed. */
  rate?: { perSecond: number; burst: number };
  now?: () => number;
}

/** A token bucket per key. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes `n` tokens for `key`; false when there aren't enough. */
  take(key: string, n = 1): boolean {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 10_000) this.buckets.clear();
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  }
}

/** Connection from this computer (127.x, ::1 or ::ffff:127.x). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

const HOOK_ROUTE = /^\/api\/hooks\/([a-z0-9:._-]{1,60})$/;

export function createIngestHandler(deps: IngestDeps): (req: IncomingMessage, res: ServerResponse, path: string) => boolean {
  const rate = deps.rate ?? { perSecond: 50, burst: 300 };
  const limiter = new RateLimiter(rate.perSecond, rate.burst, deps.now);

  const local = (req: IncomingMessage): boolean => isLoopbackAddress(req.socket.remoteAddress) && (req.headers.host === undefined || isLoopbackHost(req.headers.host));

  const applyAll = (events: AgentEvent[]) => {
    for (const e of events) {
      try {
        deps.apply(maskEvent(e));
      } catch (err) {
        log.warn(`could not apply a ${e.provider} ${e.type} event: ${errMsg(err)}`);
      }
    }
  };

  const handleEvents = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readJson(req, MAX_BODY);
    const list = Array.isArray(body) ? body : [body];
    if (list.length === 0 || list.length > MAX_BATCH) throw new HttpError(400, `send 1 to ${MAX_BATCH} events`);
    const events: AgentEvent[] = [];
    const errors: { index: number; errors: string[] }[] = [];
    list.forEach((raw, index) => {
      const r = validateAgentEvent(raw);
      if (!r.ok) errors.push({ index, errors: r.errors });
      else if (!r.event.provider.startsWith('custom:')) errors.push({ index, errors: ['POST /api/events takes custom:<slug> providers; built-in providers report through their adapters'] });
      else events.push(r.event);
    });
    if (errors.length) return sendJson(res, 400, { error: 'invalid events', details: errors.slice(0, 20) });
    const key = `events:${events[0]!.provider}`;
    if (!limiter.take(key, events.length)) return sendJson(res, 429, { error: 'too many events' });
    applyAll(events);
    sendJson(res, 202, { accepted: events.length });
  };

  const handleHook = async (req: IncomingMessage, res: ServerResponse, provider: string) => {
    const adapter = deps.hooks(provider);
    if (!adapter) {
      req.resume();
      return sendJson(res, 404, { error: `no hook adapter for ${provider}` });
    }
    const body = await readJson(req, MAX_BODY);
    if (!limiter.take(`hooks:${provider}`)) return sendJson(res, 429, { error: 'too many events' });
    let events: AgentEvent[];
    try {
      events = adapter.onHook(body);
    } catch (err) {
      log.warn(`${provider} hook payload not understood: ${errMsg(err)}`);
      return sendJson(res, 400, { error: 'payload not understood' });
    }
    // Adapters are ours, but their output goes through the same validator as everyone else's.
    const valid: AgentEvent[] = [];
    for (const e of events) {
      const r = validateAgentEvent(e);
      if (r.ok && r.event.provider === (provider as ProviderId)) valid.push(r.event);
      else log.warnOnce(`bad-hook-event:${provider}`, `${provider} adapter produced an invalid event (${r.ok ? 'wrong provider' : r.errors[0]})`);
    }
    applyAll(valid);
    sendJson(res, 202, { accepted: valid.length });
  };

  return (req, res, path) => {
    const hook = HOOK_ROUTE.exec(path);
    if (path !== '/api/events' && !hook) return false;
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!local(req)) {
      req.resume();
      sendJson(res, 403, { error: 'ingest is local-only: post to 127.0.0.1 from this computer' });
      return true;
    }
    const work = hook ? handleHook(req, res, hook[1]!) : handleEvents(req, res);
    work.catch((err: unknown) => sendError(res, err));
    return true;
  };
}
