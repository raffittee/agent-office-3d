// A whole office in memory, fed by the demo simulator: the browser's mock mode (?mock=1) runs it without a server.
// The same reducer as the server's, so what the mock shows is what real agents would show.
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
