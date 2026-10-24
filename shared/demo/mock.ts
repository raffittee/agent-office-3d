// A whole office in memory, fed by the demo simulator: the browser's mock mode (?mock=1) runs it without a server.
// The same reducer as the server's, so what the mock shows is what real agents would show.
import type { AccountInfo } from '../protocol';
import { MemoryNames } from '../names';
import { Office, type CommitResult } from '../model/office';
import { DEMO_PROVIDERS, DemoSimulator, type DemoOptions } from './simulator';

export interface MockOffice {
  office: Office;
  /** Advances the simulation and the office to `now`; returns what changed (snapshot, feed, notices). */
  step(now: number): CommitResult;
}

export function createMockOffice(opts: DemoOptions = {}, now = Date.now()): MockOffice {
  let clock = now;
  const office = new Office({
    names: new MemoryNames(),
    version: 'mock',
    demo: true,
    startedAt: now,
    providers: () => DEMO_PROVIDERS.map((p) => ({ ...p, capabilities: { ...p.capabilities } })),
    accounts: (sessions) => demoAccounts(sessions, clock),
    now: () => clock,
  });
  const sim = new DemoSimulator(opts, now);
  // The opening burst is history, not news: no notices, feed in order.
  office.beginBoot();
  for (const e of sim.tick(now)) office.apply(e);
  office.endBoot();
  return {
    office,
    step(at: number): CommitResult {
      clock = at;
      for (const e of sim.tick(at)) office.apply(e);
      office.tick();
      return office.commit();
    },
  };
}

const DEMO_USAGE: Record<string, [number, number]> = { 'claude-code': [42, 18], codex: [67, 31] };
/** Same short labels as the server's accounts (server/accounts/service.ts). */
const SHORT: Record<string, string> = { 'claude-code': 'C', 'gemini-cli': 'G', codex: 'X' };

/** Mock mode's accounts: one per provider with sessions, with made-up plan usage (source 'demo') where it applies. */
export function demoAccounts(sessions: ReadonlyMap<string, number>, now: number): AccountInfo[] {
  const out: AccountInfo[] = [];
  for (const p of DEMO_PROVIDERS) {
    // the simulator's agents all use the 'demo' account
    const open = sessions.get(`${p.id}|demo`) ?? 0;
    if (!open) continue;
    const pct = DEMO_USAGE[p.id];
    const hour = 3_600_000;
    const info: AccountInfo = { id: 'demo', provider: p.id, short: SHORT[p.id] ?? p.id.replace(/^custom:/, '').slice(0, 1).toUpperCase(), name: p.label, color: p.color, sessions: open, usageStatus: pct ? 'ok' : 'disabled' };
    if (pct) info.usage = { source: 'demo', fetchedAt: now, fiveHour: { utilization: pct[0], resetsAt: now + 2.5 * hour }, sevenDay: { utilization: pct[1], resetsAt: now + 4 * 24 * hour } };
    out.push(info);
  }
  return out;
}
