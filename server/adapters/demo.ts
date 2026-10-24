// Simulated agents on the server (AGENT_OFFICE_DEMO=1 or --demo): the demo simulator's events go through the
// adapter context like any provider's. They use the account 'demo' and session ids 'demo-…', so they never mix with
// real sessions, and they run alongside the real adapters.
import { DEMO_PROVIDERS, DemoSimulator, type DemoOptions } from '../../shared/demo/simulator';
import type { ProviderCapabilities, ProviderMeta, SourceInfo } from '../../shared/protocol';
import { describeGenericTool } from '../../shared/tools';
import { errMsg, log } from '../log';
import type { AdapterContext, ProviderAdapter } from './adapter';

const TICK_MS = 250;

export class DemoAdapter implements ProviderAdapter {
  readonly id = 'custom:demo' as const;
  readonly label = 'Demo';
  readonly color = '#a77bf3';
  readonly capabilities: ProviderCapabilities = { transcript: false, approve: false, message: false, usage: false, subagents: false };
  describeTool = describeGenericTool;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: DemoOptions & { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  start(ctx: AdapterContext): void {
    const sim = new DemoSimulator(this.opts, this.now());
    ctx.beginBoot();
    try {
      for (const e of sim.tick(this.now())) ctx.emit(e);
    } finally {
      ctx.endBoot();
    }
    this.timer = setInterval(() => {
      try {
        for (const e of sim.tick(this.now())) ctx.emit(e);
      } catch (err) {
        log.warnOnce(`demo:${errMsg(err)}`, `Demo: a simulation step failed (${errMsg(err)}).`);
      }
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return [{ provider: this.id, label: 'demo', path: '(simulated)', sessions: 0, ok: true }];
  }

  /** Badges for the providers the demo simulates but no adapter runs (Codex, the custom agent). */
  extraProviders(running: readonly ProviderMeta[]): ProviderMeta[] {
    return DEMO_PROVIDERS.filter((p) => !running.some((r) => r.id === p.id)).map((p) => ({ ...p, capabilities: { ...p.capabilities } }));
  }
}
