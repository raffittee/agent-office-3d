// P8-02 in CI: a short accelerated soak (2 simulated hours of a busy demo office through the reducer and the client
// sim). Memory and bookkeeping must stay bounded, and the sim's per-frame cost must stay a small part of the 16 ms
// frame. Thresholds are generous so a slow CI runner doesn't flake; `npm run soak` runs the full 8 hours.
import { describe, expect, it } from 'vitest';
import { soak } from '../../scripts/soak';

describe('soak (accelerated)', () => {
  it('2 simulated hours: agents come and go, the feed stays capped, the sim stays cheap', () => {
    const r = soak({ hours: 2, sessions: 15, seed: 7 });
    expect(r.samples).toHaveLength(2);
    expect(r.peakAgents).toBeGreaterThanOrEqual(15);
    for (const s of r.samples) {
      expect(s.chars).toBeLessThanOrEqual(s.agents + 40);
      expect(s.feed).toBeLessThanOrEqual(1_000);
      expect(s.p99).toBeLessThan(4);
    }
    expect(r.worstP99).toBeLessThan(4);
  }, 120_000);
});
