// Ambient sound cues (P6-05): keys from people typing on screen, the elevator ding, ping-pong rhythm.
import { describe, expect, it } from 'vitest';
import type { SoundCue } from '../audio/scheduler';
import type { Sim } from './sim/sim';
import { SoundCues, type SoundView } from './sound-cues';

const view = (visible = true): SoundView => ({ visible: () => visible, pan: (x) => (x > 100 ? 0.5 : -0.5), near: () => 1 });
const typist = (id: string, x: number) => ({ id, x, y: 10, mode: 'work', seated: true, pose: 'type', leaving: false, inside: false, alpha: 1 });

function fakeSim(parts: Partial<{ chars: unknown[]; elevators: { door: number; spotId: string }[]; gatherings: unknown[] }>): Sim {
  return {
    chars: new Map((parts.chars ?? []).map((c) => [(c as { id: string }).id, c])),
    elevators: parts.elevators ?? [],
    spots: { get: (id: string) => (id === 'e0' ? { x: 50, y: 5 } : undefined) },
    social: { gatherings: new Map((parts.gatherings ?? []).map((g) => [(g as { id: number }).id, g])) },
  } as unknown as Sim;
}

function run(cues: SoundCues, v: SoundView, from: number, to: number, step = 50): SoundCue[] {
  const out: SoundCue[] = [];
  for (let t = from; t <= to; t += step) cues.update(t, v, (c) => out.push(c));
  return out;
}

describe('sound cues', () => {
  it('keys only for people typing on screen', () => {
    const sim = fakeSim({ chars: [typist('a', 200), { ...typist('b', 20), pose: 'stand' }] });
    const keys = run(new SoundCues(sim, () => 0.1), view(), 0, 10_000).filter((c) => c.kind === 'keys');
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.every((c) => c.pan === 0.5 && (c.count ?? 0) >= 2)).toBe(true);
    expect(run(new SoundCues(sim, () => 0.1), view(false), 0, 10_000)).toEqual([]);
  });

  it('a ding when an elevator door starts to open (quieter off screen)', () => {
    const elevators = [{ door: 0, spotId: 'e0' }];
    const sim = fakeSim({ elevators });
    const cues = new SoundCues(sim);
    const out: SoundCue[] = [];
    cues.update(0, view(false), (c) => out.push(c));
    elevators[0]!.door = 0.3;
    cues.update(50, view(false), (c) => out.push(c));
    elevators[0]!.door = 1.5;
    cues.update(100, view(false), (c) => out.push(c));
    expect(out).toEqual([{ kind: 'elevator', gain: 0.5, pan: -0.5 }]);
  });

  it('ping-pong alternates paddle and table while the game runs', () => {
    const g = { id: 1, kind: 'pingpong', phase: 'run', createdAt: 0, members: [{ id: 'a', watcher: false, left: false }, { id: 'b', watcher: false, left: false }] };
    const sim = fakeSim({ chars: [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 30, y: 10 }], gatherings: [g] });
    const kinds = run(new SoundCues(sim), view(), 0, 2_300).map((c) => c.kind);
    expect(kinds).toEqual(['table', 'pingpong', 'table', 'pingpong']);
    g.phase = 'final';
    expect(run(new SoundCues(sim), view(), 3_000, 6_000)).toEqual([]);
  });
});
