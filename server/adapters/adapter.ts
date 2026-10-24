// Ported from habblaud server/sources/source.ts (MIT, © 2026 Márcio Junior)
// Provider adapters (one per tool: Claude Code, Gemini CLI, Codex, ...) and what the rest of the server expects
// from them. An adapter is the only code that knows its vendor's files and hook payloads; it emits AgentEvents.
//
// Boot: an adapter that rebuilds open sessions at start calls ctx.beginBoot() before and ctx.endBoot() after,
// ALWAYS as a pair (in a `finally`, also for an async boot). The office counts boots: while any adapter boots there
// are no notices, and the feed is held to come out in chronological order at the end of the last one.
import type { ActivityDescription } from '../../shared/activity';
import type { AgentEvent, ProviderCapabilities, ProviderId, ProviderMeta, SourceInfo } from '../../shared/protocol';
import { validateAgentEvent } from '../../shared/validate';
import { maskEvent } from '../ingest/mask';
import { errMsg, log } from '../log';
import type { LivenessTarget, Office } from '../model/office';

export interface AdapterContext {
  /** Validates, masks and applies an event. */
  emit(e: AgentEvent): void;
  beginBoot(): void;
  endBoot(): void;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Human label, e.g. "Gemini CLI". */
  readonly label: string;
  /** Badge color (hex). */
  readonly color: string;
  readonly capabilities: ProviderCapabilities;
  /** Boot (rebuild open sessions between beginBoot/endBoot) and live watching. Async failures only reach the log. */
  start(ctx: AdapterContext): void | Promise<void>;
  stop(): void;
  /** One entry per watched account or endpoint (meta.sources and /api/health). */
  sources(): SourceInfo[];
  /** Raw payload from hooks/<provider>.mjs → normalized events. */
  onHook?(payload: unknown): AgentEvent[];
  /** Native tool name + input → activity (kind, icon, text, detail). */
  describeTool(name: string, input: unknown): ActivityDescription;
  /**
   * Is this agent's process still alive? true/false, or undefined to fall back to the generic check (PID probe, else
   * a heartbeat timeout).
   */
  alive?(target: LivenessTarget): boolean | undefined;
}

/** Agents without a PID are offline after this long without events (the SDK sends a heartbeat every 30 s). */
export const HEARTBEAT_TIMEOUT_MS = 120_000;

/** Does a process exist? EPERM means it exists but isn't ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** All enabled adapters, seen as one. */
export class AdapterSet {
  private readonly list: ProviderAdapter[] = [];

  constructor(adapters: readonly ProviderAdapter[] = []) {
    for (const a of adapters) this.add(a);
  }

  add(adapter: ProviderAdapter): void {
    if (this.list.some((a) => a.id === adapter.id)) throw new Error(`adapter ${adapter.id} added twice`);
    this.list.push(adapter);
  }

  all(): readonly ProviderAdapter[] {
    return this.list;
  }

  of(id: ProviderId | string): ProviderAdapter | undefined {
    return this.list.find((a) => a.id === id);
  }

  /** The context handed to adapters: events are validated and masked before they reach the office. */
  context(office: Office): AdapterContext {
    return {
      emit: (e) => {
        const r = validateAgentEvent(e);
        if (!r.ok) {
          log.warnOnce(`bad-event:${String((e as { provider?: unknown }).provider)}`, `an adapter produced an invalid event: ${r.errors[0]}`);
          return;
        }
        try {
          office.apply(maskEvent(r.event));
        } catch (err) {
          log.warn(`could not apply a ${r.event.provider} ${r.event.type} event: ${errMsg(err)}`);
        }
      },
      beginBoot: () => office.beginBoot(),
      endBoot: () => office.endBoot(),
    };
  }

  /**
   * Starts the adapters in the order they were added: synchronous ones finish booting here (before the hub starts
   * broadcasting). One failing doesn't stop the others; it goes to the log. Resolves when the async ones are up.
   */
  start(office: Office): Promise<void> {
    const ctx = this.context(office);
    const pending: Promise<void>[] = [];
    for (const a of this.list) {
      const failed = (err: unknown) => log.error(`${a.label}: failed to start (${errMsg(err)}).`);
      try {
        const r = a.start(ctx);
        if (r) pending.push(r.catch(failed));
      } catch (err) {
        failed(err);
      }
    }
    return Promise.all(pending).then(() => undefined);
  }

  stop(): void {
    for (const a of this.list) {
      try {
        a.stop();
      } catch (err) {
        log.warn(`${a.label}: failed to stop (${errMsg(err)}).`);
      }
    }
  }

  sources(): SourceInfo[] {
    return this.list.flatMap((a) => {
      try {
        return a.sources();
      } catch {
        return [];
      }
    });
  }

  /** Provider badges and capabilities for meta.providers. */
  providers(): ProviderMeta[] {
    return this.list.map((a) => ({ id: a.id, label: a.label, color: a.color, capabilities: { ...a.capabilities } }));
  }

  /** The adapter that accepts hook payloads for `provider`, if any. */
  hooks(provider: string): { onHook(payload: unknown): AgentEvent[] } | undefined {
    const a = this.of(provider);
    return a?.onHook ? { onHook: (p) => a.onHook!(p) } : undefined;
  }

  /**
   * Marks offline every present agent whose process is gone. The adapter decides when it knows how; otherwise a
   * known PID is probed, and an agent without one times out after HEARTBEAT_TIMEOUT_MS without events.
   */
  checkLiveness(office: Office, now = Date.now(), probe: (pid: number) => boolean = pidAlive): void {
    for (const target of office.livenessTargets()) {
      let alive: boolean | undefined;
      try {
        alive = this.of(target.provider)?.alive?.(target);
      } catch {
        alive = undefined;
      }
      if (alive === undefined) alive = target.pid !== undefined ? probe(target.pid) : now - target.lastEventAt < HEARTBEAT_TIMEOUT_MS;
      if (!alive) office.markOffline(target.id);
    }
  }
}
