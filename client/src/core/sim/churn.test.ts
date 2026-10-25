// P8-02: a demo office at 50× speed (agents and subagents come and go faster than the elevators can stagger their
// arrivals). Every character must belong to an agent of the latest snapshot, give or take the few walking out.
import { describe, expect, it } from 'vitest';
import { createMockOffice } from '../../../../shared/demo/mock';
import { DEFAULT_WORLD_OPTIONS } from '../options';
import { Sim } from './sim';

describe('sim under high churn', () => {
  it('characters whose agent is gone do not pile up', () => {
    let now = Date.UTC(2026, 9, 26, 9);
    const mock = createMockOffice({ seed: 7, sessions: 15, speed: 50 }, now);
    const sim = new Sim({ options: () => DEFAULT_WORLD_OPTIONS });
    sim.applySnapshot(mock.office.commit().snapshot, now);
    let worst = 0;
    for (let f = 1; f <= 20 * 600; f++) {
      now += 100;
      if (f % 3 === 0) {
        const r = mock.step(now);
        if (r.changed) sim.applySnapshot(r.snapshot, now);
      }
      sim.update(0.1, now);
      sim.effects.length = 0;
      if (f % 600 === 0) {
        const ids = new Set(mock.office.commit().snapshot.agents.map((a) => a.id));
        worst = Math.max(worst, [...sim.chars.keys()].filter((id) => !ids.has(id)).length);
      }
    }
    expect(worst).toBeLessThanOrEqual(10);
  }, 120_000);
});
