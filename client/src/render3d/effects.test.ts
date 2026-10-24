// Shell-wait gags in 3D (P6-03): confetti bursts once per effect, clouds follow the 'storm' icon, cobwebs the wait's
// stage. No WebGL needed: only instance counts and buffers are checked.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Character } from '../core/sim/character';
import { RoomState, fxFade } from '../core/sim/room-state';
import type { Sim } from '../core/sim/sim';
import { SHELL_COBWEB_BIG_MS } from '../core/sim/shell';
import { alarmPulse, cobwebSegments, EffectsView } from './effects';

const heads = { headPoint: (c: Character, out: THREE.Vector3) => out.set(c.x / 32, 1.2, c.y / 32) };

function char(id: string, extra: Partial<Character> = {}): Character {
  return { id, x: 100, y: 100, visible: true, inside: false, icon: null, iconUntil: 0, shellStage: null, shellSince: 0, ...extra } as Character;
}

function fakeSim(chars: Character[], effects: Sim['effects'] = [], rooms: RoomState[] = []): Sim {
  return { chars: new Map(chars.map((c) => [c.id, c])), effects, rooms: new Map(rooms.map((r) => [r.id, r])) } as unknown as Sim;
}

function room(id: string, fx: RoomState['fx']): RoomState {
  return { id, fx, present: true, ghost: false, layout: { rect: { x: 0, y: 0, w: 16, h: 12 } } } as unknown as RoomState;
}

describe('effects view', () => {
  const NOW = 1_000_000;

  it('a job done bursts confetti once, which falls and fades', () => {
    const v = new EffectsView();
    const sim = fakeSim([char('a')], [{ kind: 'confetti', charId: 'a', at: NOW }]);
    v.sync(sim, heads, NOW, 0.016);
    const count = (v.root.children[0] as THREE.InstancedMesh).count;
    expect(count).toBeGreaterThan(20);
    v.sync(sim, heads, NOW + 16, 0.016); // the same effect again: no second burst
    expect((v.root.children[0] as THREE.InstancedMesh).count).toBe(count);
    for (let i = 0; i < 150; i++) v.sync(fakeSim([char('a')]), heads, NOW, 0.016);
    expect((v.root.children[0] as THREE.InstancedMesh).count).toBe(0);
  });

  it('a failed job: a cloud and drops over the head while the storm icon lasts', () => {
    const v = new EffectsView();
    v.sync(fakeSim([char('a', { icon: 'storm', iconUntil: NOW + 3000 }), char('b')]), heads, NOW, 0.016);
    expect((v.root.children[1] as THREE.InstancedMesh).count).toBe(3);
    expect((v.root.children[2] as THREE.InstancedMesh).count).toBe(6);
    v.sync(fakeSim([char('a', { icon: 'storm', iconUntil: NOW - 1 })]), heads, NOW, 0.016);
    expect((v.root.children[1] as THREE.InstancedMesh).count).toBe(0);
  });

  it('a long wait grows a cobweb (bigger after 20 minutes)', () => {
    const v = new EffectsView();
    const web = v.root.children[3] as THREE.LineSegments;
    const unit = cobwebSegments();
    v.sync(fakeSim([char('a', { shellStage: 'cobweb', shellSince: NOW - 11 * 60_000 }), char('b', { shellStage: 'popcorn' })]), heads, NOW, 0.016);
    expect(web.geometry.drawRange.count).toBe(unit.length / 3);
    const pos = web.geometry.getAttribute('position') as THREE.BufferAttribute;
    const height = () => {
      const ys = Array.from(pos.array as Float32Array).filter((_, i) => i % 3 === 1 && i < unit.length);
      return Math.max(...ys) - Math.min(...ys);
    };
    const small = height();
    v.sync(fakeSim([char('a', { shellStage: 'nap', shellSince: NOW - SHELL_COBWEB_BIG_MS - 1 })]), heads, NOW, 0.016);
    expect(height()).toBeGreaterThan(small * 1.5);
  });

  it('cobweb geometry: spokes from the centre, rings around', () => {
    const seg = cobwebSegments(8, 3);
    expect(seg.length).toBe((8 + 3 * 8 * 2) * 6);
    expect(Math.max(...Array.from(seg).map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('room effects: confetti rains over a party; an alarm lights two beacons, four beams and a floor tint', () => {
    const v = new EffectsView();
    const [confetti, , , , domes, beams, tints] = v.root.children as THREE.InstancedMesh[];
    const party = room('/a', { kind: 'party', text: 'x', at: 1, start: NOW - 1000, end: NOW + 10_000 });
    for (let i = 0; i < 30; i++) v.sync(fakeSim([], [], [party]), heads, NOW, 0.05);
    expect(confetti!.count).toBeGreaterThan(30);
    const alarm = room('/b', { kind: 'alarm', text: 'y', at: 2, start: NOW - 1000, end: NOW + 60_000 });
    v.sync(fakeSim([], [], [alarm, room('/c', null)]), heads, NOW, 0.016);
    expect([domes!.count, beams!.count, tints!.count]).toEqual([2, 4, 1]);
    v.sync(fakeSim([], [], [alarm]), heads, NOW + 60_000, 0.016);
    expect(tints!.count).toBe(0);
  });

  it('fades and pulses', () => {
    expect(fxFade({ start: 0, end: 10_000 }, 150)).toBeCloseTo(0.5);
    expect(fxFade({ start: 0, end: 10_000 }, 9_700)).toBeCloseTo(0.5);
    expect(fxFade({ start: 0, end: 10_000 }, 5_000)).toBe(1);
    expect(alarmPulse(0.3, true)).toBe(alarmPulse(0.9, true));
    expect(alarmPulse(0.3, false)).not.toBe(alarmPulse(0.9, false));
  });

  it('a room keeps its effect start across snapshots and moves it to the local clock', () => {
    const r = Object.create(RoomState.prototype) as RoomState;
    r.fx = null;
    r.info = { id: '/a', name: 'a', path: '/a', slot: 0, seed: 1, createdAt: 0, effect: { kind: 'alarm', text: 'y', at: 500, until: 10_500 } };
    r.syncEffect(1_500, 100_000);
    expect(r.fx).toMatchObject({ kind: 'alarm', start: 99_000, end: 109_000 });
    r.syncEffect(2_500, 101_200);
    expect(r.fx).toMatchObject({ start: 99_000, end: 109_200 });
    delete r.info.effect;
    r.syncEffect(3_000, 101_700);
    expect(r.fx).toBeNull();
  });
});
