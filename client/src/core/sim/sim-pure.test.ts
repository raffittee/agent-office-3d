// Ported from habblaud client/src/world/sim/sim-pure.test.ts (MIT, © 2026 Márcio Junior)
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../../shared/hash';
import type { SpotDef } from '../layout/types';
import {
  canDismantle,
  chooseSeat,
  idleSitMs,
  IDLE_WEIGHTS,
  isLastInRoom,
  isLongIdle,
  LONG_IDLE_MS,
  lightLevel,
  modeFor,
  pickIdleActivity,
  screenModeFor,
  shouldRun,
} from './behavior';
import { SpotRegistry } from './spots';
import { Elevator } from './elevator';

function spot(id: string, kind: SpotDef['kind'], extra: Partial<SpotDef> = {}): SpotDef {
  return { id, kind, areaId: 'a', tx: 0, ty: 0, x: 0, y: 0, dir: 'up', ...extra };
}

describe('behavior modes', () => {
  it('status → mode', () => {
    expect(modeFor('working', { kind: 'main' })).toBe('work');
    expect(modeFor('waiting', { kind: 'main' })).toBe('wait');
    expect(modeFor('idle', { kind: 'main' })).toBe('idle');
    expect(modeFor('offline', { kind: 'main' })).toBe('leave');
    expect(modeFor('done', { kind: 'sub' })).toBe('deliver');
    expect(modeFor('done', { kind: 'main' })).toBe('idle');
    expect(modeFor('working', { kind: 'main', missing: true })).toBe('leave');
    expect(modeFor('working', { kind: 'sub', parentGone: true })).toBe('leave');
  });

  it('the monitor follows the activity', () => {
    expect(screenModeFor('edit')).toBe('code');
    expect(screenModeFor('write')).toBe('code');
    expect(screenModeFor('test')).toBe('terminal');
    expect(screenModeFor('git')).toBe('terminal');
    expect(screenModeFor('web')).toBe('browser');
    expect(screenModeFor('search')).toBe('search');
    expect(screenModeFor('read')).toBe('docs');
    expect(screenModeFor('plan')).toBe('tasks');
    expect(screenModeFor('ask')).toBe('chat');
    expect(screenModeFor('error')).toBe('alert');
    expect(screenModeFor(undefined)).toBe('code');
  });

  it('runs when far (work) or when the user is needed', () => {
    expect(shouldRun(20, 'work')).toBe(true);
    expect(shouldRun(5, 'work')).toBe(false);
    expect(shouldRun(4, 'wait')).toBe(true);
    expect(shouldRun(40, 'idle')).toBe(false);
  });

  it('idle for over 10 min dozes', () => {
    const now = 1_000_000_000;
    expect(isLongIdle('idle', now - LONG_IDLE_MS - 1, now)).toBe(true);
    expect(isLongIdle('idle', now - 1000, now)).toBe(false);
    expect(isLongIdle('working', now - LONG_IDLE_MS * 2, now)).toBe(false);
  });
});

describe('outings', () => {
  it('the weighted draw respects availability', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const a = pickIdleActivity(rng, { pingpong: false, talk: false, bathroom: false });
      expect(a).not.toBeNull();
      expect(['pingpong', 'talk', 'bathroom']).not.toContain(a);
    }
    const none = Object.fromEntries(Object.keys(IDLE_WEIGHTS).map((k) => [k, false]));
    expect(pickIdleActivity(rng, none)).toBeNull();
  });

  it('coffee is the most common outing', () => {
    const rng = mulberry32(7);
    const count = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const a = pickIdleActivity(rng)!;
      count.set(a, (count.get(a) ?? 0) + 1);
    }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(top).toBe('coffee');
  });

  it('time seated depends on the chosen liveliness', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 50; i++) {
      const calm = idleSitMs(rng, 'calm');
      const lively = idleSitMs(rng, 'lively');
      expect(calm).toBeGreaterThanOrEqual(16_000);
      expect(lively).toBeLessThanOrEqual(10_000);
      const normal = idleSitMs(rng, 'normal');
      expect(normal).toBeGreaterThanOrEqual(6_000);
      expect(normal).toBeLessThanOrEqual(20_000);
    }
  });
});

describe('seats and reservations', () => {
  const spots: SpotDef[] = [
    spot('d0', 'desk', { rank: 0 }),
    spot('d1', 'desk', { rank: 1 }),
    spot('s0', 'stool'),
    spot('p0', 'stand'),
  ];

  it('main agents and subagents take the first free desk; then a stool; then standing', () => {
    const reg = new SpotRegistry();
    reg.setSpots(spots);
    const pick = (who: string) => {
      const s = chooseSeat(spots, (id) => reg.isFree(id, who), 'sub');
      if (s) reg.reserve(s.id, who);
      return s?.id ?? null;
    };
    expect(pick('a')).toBe('d0');
    expect(pick('b')).toBe('d1');
    expect(pick('c')).toBe('s0');
    expect(pick('d')).toBe('p0');
    expect(pick('e')).toBeNull();
  });

  it('a reservation has a single owner, and free alternatives are found', () => {
    const reg = new SpotRegistry();
    reg.setSpots([spot('c1', 'coffee', { tx: 0 }), spot('c2', 'coffee', { tx: 10 })]);
    expect(reg.reserve('c1', 'ana')).toBe(true);
    expect(reg.reserve('c1', 'bia')).toBe(false);
    expect(reg.reserve('c1', 'ana')).toBe(true);
    expect(reg.findFree('coffee', { near: { tx: 0, ty: 0 } })?.id).toBe('c2');
    reg.release('c1', 'bia');
    expect(reg.ownerOf('c1')).toBe('ana');
    reg.releaseAll('ana');
    expect(reg.isFree('c1')).toBe(true);
  });

  it('groups (pairs) are only offered whole', () => {
    const reg = new SpotRegistry();
    reg.setSpots([spot('t1', 'talk', { group: 'g' }), spot('t2', 'talk', { group: 'g' })]);
    expect(reg.findFreeGroup('talk')?.length).toBe(2);
    reg.reserve('t2', 'x');
    expect(reg.findFreeGroup('talk')).toBeNull();
  });

  it('reservations of spots that no longer exist are returned', () => {
    const reg = new SpotRegistry();
    reg.setSpots([spot('a', 'desk'), spot('b', 'desk')]);
    reg.reserve('a', 'ana');
    reg.reserve('b', 'bia');
    const lost = reg.setSpots([spot('b', 'desk')]);
    expect(lost).toEqual([{ spotId: 'a', owner: 'ana' }]);
    expect(reg.ownerOf('b')).toBe('bia');
  });
});

describe('rooms, light and elevator', () => {
  it('the last one in the room switches the light off', () => {
    const chars = [
      { id: 'a', roomId: 'r', leaving: true },
      { id: 'b', roomId: 'r', leaving: false },
      { id: 'c', roomId: 'x', leaving: false },
    ];
    expect(isLastInRoom('r', 'a', chars)).toBe(false);
    chars[1]!.leaving = true;
    expect(isLastInRoom('r', 'a', chars)).toBe(true);
  });

  it('dismantling only when the room is out of the snapshot, empty and dark', () => {
    const base = { listed: false, occupants: 0, lightOn: false, dark: true, unlistedForMs: 5000 };
    expect(canDismantle(base, 1500)).toBe(true);
    expect(canDismantle({ ...base, listed: true }, 1500)).toBe(false);
    expect(canDismantle({ ...base, occupants: 1 }, 1500)).toBe(false);
    expect(canDismantle({ ...base, lightOn: true }, 1500)).toBe(false);
    expect(canDismantle({ ...base, unlistedForMs: 100 }, 1500)).toBe(false);
  });

  it('the light flickers on and fades off in ~0.6 s', () => {
    expect(lightLevel(true, 100)).toBeLessThan(0.5);
    expect(lightLevel(true, 2000)).toBe(1);
    expect(lightLevel(false, 30)).toBeGreaterThan(0);
    expect(lightLevel(false, 600)).toBe(0);
  });

  it('the elevator opens while used and staggers arrivals', () => {
    const e = new Elevator(0, 'e');
    e.request('a');
    for (let i = 0; i < 10; i++) e.update(0.05, 0);
    expect(e.isOpen).toBe(true);
    expect(e.state).toBe(4);
    e.release('a', 0);
    for (let i = 0; i < 40; i++) e.update(0.05, 2000);
    expect(e.state).toBe(0);
    const t1 = e.reserveAppear(1000);
    const t2 = e.reserveAppear(1000);
    expect(t2).toBeGreaterThan(t1);
  });
});
