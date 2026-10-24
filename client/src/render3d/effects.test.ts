// Shell-wait gags in 3D (P6-03): confetti bursts once per effect, clouds follow the 'storm' icon, cobwebs the wait's
// stage. No WebGL needed: only instance counts and buffers are checked.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Character } from '../core/sim/character';
import type { Sim } from '../core/sim/sim';
import { SHELL_COBWEB_BIG_MS } from '../core/sim/shell';
import { cobwebSegments, EffectsView } from './effects';

const heads = { headPoint: (c: Character, out: THREE.Vector3) => out.set(c.x / 32, 1.2, c.y / 32) };

function char(id: string, extra: Partial<Character> = {}): Character {
  return { id, x: 100, y: 100, visible: true, inside: false, icon: null, iconUntil: 0, shellStage: null, shellSince: 0, ...extra } as Character;
}

function fakeSim(chars: Character[], effects: Sim['effects'] = []): Sim {
  return { chars: new Map(chars.map((c) => [c.id, c])), effects } as unknown as Sim;
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
});
