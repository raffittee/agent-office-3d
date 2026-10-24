// The 3D layer's pure parts: camera framing, cutaway sides, build easing, the furniture kit, poses, labels.
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/protocol';
import { DEFAULT_WORLD_OPTIONS } from '../core/options';
import { Character } from '../core/sim/character';
import { FURNITURE, FURNITURE_KINDS, TILE } from '../core/vocab';
import { buildScale, cutKey, farSides, roomBrightness } from './building';
import { frameBounds, viewAxes, ZOOM_MAX, ZOOM_MIN } from './camera';
import { furnitureParts, wallItemShape } from './kit';
import { declutter, labelFor } from './labels';
import { dirYaw, isSeatedPose, lookColors, poseRig, SEAT_Y, HIP_Y, turnTowards } from './pose';
import { cappedDpr } from './scene';
import { TILE_M, UNIT_M } from './units';

const T0 = Date.parse('2026-10-25T09:00:00Z');

function agent(extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'a',
    kind: 'main',
    provider: 'claude-code',
    roomId: '/r',
    name: 'Ana',
    look: 'f',
    role: 'Main agent',
    sessionId: 's',
    account: 'default',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1234,
    ...extra,
  };
}

describe('units and camera', () => {
  it('a tile is half a metre', () => {
    expect(TILE * UNIT_M).toBe(TILE_M);
    expect(TILE_M).toBe(0.5);
  });

  it('view axes are orthonormal for every quarter turn', () => {
    for (const yaw of [45, 135, 225, 315]) {
      const { right, up, back } = viewAxes(yaw);
      expect(right.length()).toBeCloseTo(1);
      expect(up.length()).toBeCloseTo(1);
      expect(back.length()).toBeCloseTo(1);
      expect(right.dot(up)).toBeCloseTo(0);
      expect(right.dot(back)).toBeCloseTo(0);
      expect(up.y).toBeGreaterThan(0);
    }
  });

  it('framing fits a bigger area with a larger view, centred on it, within limits', () => {
    const small = frameBounds({ x0: 0, z0: 0, x1: 8, z1: 6 }, 45, 16 / 9);
    const big = frameBounds({ x0: 0, z0: 0, x1: 40, z1: 15 }, 45, 16 / 9);
    expect(big.zoom).toBeGreaterThan(small.zoom);
    expect(big.x).toBe(20);
    expect(big.z).toBe(7.5);
    expect(frameBounds({ x0: 0, z0: 0, x1: 0.1, z1: 0.1 }, 45, 1).zoom).toBe(ZOOM_MIN);
    expect(frameBounds({ x0: 0, z0: 0, x1: 900, z1: 900 }, 45, 1).zoom).toBe(ZOOM_MAX);
    // panels covering half the screen need a wider view
    expect(frameBounds({ x0: 0, z0: 0, x1: 40, z1: 15 }, 45, 16 / 9, { w: 0.5, h: 1 }).zoom).toBeGreaterThan(big.zoom);
  });

  it('caps the device pixel ratio by quality', () => {
    expect(cappedDpr(3, 'medium')).toBe(1.5);
    expect(cappedDpr(3, 'high')).toBe(2);
    expect(cappedDpr(2, 'low')).toBe(1);
    expect(cappedDpr(0, 'medium')).toBe(1);
  });
});

describe('cutaway and rooms', () => {
  it('two far sides per quarter turn, and the key changes with them', () => {
    expect(farSides(45)).toEqual({ north: true, south: false, west: true, east: false });
    expect(farSides(135)).toEqual({ north: false, south: true, west: true, east: false });
    expect(farSides(225)).toEqual({ north: false, south: true, west: false, east: true });
    expect(farSides(-45)).toEqual({ north: true, south: false, west: false, east: true });
    expect(new Set([45, 135, 225, 315].map(cutKey)).size).toBe(4);
    expect(cutKey(45)).toBe(cutKey(60));
  });

  it('rooms grow while building, shrink while dismantling, and are never pitch black', () => {
    expect(buildScale('building', 0)).toBeLessThan(0.01);
    expect(buildScale('building', 1)).toBe(1);
    expect(buildScale('dismantling', 1)).toBeLessThan(0.01);
    expect(buildScale('ready', 0)).toBe(1);
    expect(buildScale('building', 0.5)).toBeGreaterThan(0.5);
    expect(roomBrightness(0)).toBeGreaterThan(0.25);
    expect(roomBrightness(1)).toBe(1);
  });
});

describe('the placeholder kit', () => {
  it('every furniture kind has boxes inside its footprint (floor) or a wall shape', () => {
    for (const kind of FURNITURE_KINDS) {
      const def = FURNITURE[kind];
      if (def.mount === 'wall') {
        if (kind !== 'door_frame') expect(wallItemShape(kind), kind).not.toBeNull();
        continue;
      }
      const parts = furnitureParts(kind, def.variants?.[0]);
      expect(parts.length, kind).toBeGreaterThan(0);
      const w = def.footprint.w * TILE_M;
      const d = def.footprint.h * TILE_M;
      for (const p of parts) {
        expect(p.x0, kind).toBeGreaterThanOrEqual(-0.001);
        expect(p.x1, kind).toBeLessThanOrEqual(w + 0.001);
        expect(p.z0, kind).toBeGreaterThanOrEqual(-0.001);
        expect(p.z1, kind).toBeLessThanOrEqual(d + 0.001);
        expect(p.y1, kind).toBeGreaterThan(p.y0);
        expect(p.y1, kind).toBeLessThan(2.5);
      }
    }
  });

  it('desk monitors face the person: desk to the south, desk_back to the north', () => {
    const glow = (k: 'desk' | 'desk_back') => furnitureParts(k).find((p) => p.mat === 'glow')!;
    expect(glow('desk').z0).toBeLessThan(0.25);
    expect(glow('desk_back').z0).toBeGreaterThan(0.25);
  });
});

describe('poses', () => {
  it('seated poses sink onto the seat with legs forward; walking swings and bobs', () => {
    const sit = poseRig('type', 0, 1, true);
    expect(sit.rootY).toBeCloseTo(SEAT_Y - HIP_Y);
    expect(sit.legL).toBeGreaterThan(1.4);
    const walk = [0, 120, 240, 360].map((t) => poseRig('walk', t, 1, false));
    expect(new Set(walk.map((r) => r.legL.toFixed(2))).size).toBeGreaterThan(1);
    expect(walk.every((r) => r.rootY >= 0)).toBe(true);
    expect(isSeatedPose('raise_hand', true)).toBe(true);
    expect(isSeatedPose('raise_hand', false)).toBe(false);
  });

  it('raising a hand lifts the right arm overhead', () => {
    expect(poseRig('raise_hand', 0, 1, false).armR.pitch).toBeGreaterThan(Math.PI * 0.8);
    expect(poseRig('stand', 0, 1, false).armR.pitch).toBeLessThan(0.3);
  });

  it('turns the shortest way and faces the right direction', () => {
    expect(dirYaw('down')).toBe(0);
    expect(dirYaw('up')).toBeCloseTo(Math.PI);
    expect(turnTowards(3, -3, 10)).toBe(-3);
    expect(turnTowards(3, -3, 0.1)).toBeGreaterThan(3);
  });

  it('looks are deterministic per seed and differ between seeds', () => {
    expect(lookColors(5, false)).toEqual(lookColors(5, false));
    expect(lookColors(5, false).shirt).not.toBe(lookColors(6, false).shirt);
  });
});

describe('labels', () => {
  const opts = { ...DEFAULT_WORLD_OPTIONS };
  const ch = (extra: Partial<AgentInfo> = {}) => {
    const c = new Character(agent(extra));
    c.mode = extra.status === 'waiting' ? 'wait' : 'work';
    return c;
  };

  it('a waiting agent always shows its alert, even zoomed far out or with bubbles off', () => {
    const c = ch({ status: 'waiting', waitingFor: 'approve a permission' });
    for (const o of [opts, { ...opts, bubbles: 'none' as const }]) {
      const l = labelFor(c, T0, o, false, 4);
      expect(l.bubble).toMatchObject({ kind: 'alert', text: 'approve a permission' });
    }
  });

  it('activity bubbles: in "important" mode only right after a change, always in "all", never in "none"', () => {
    const c = ch({ activity: { id: 'x', kind: 'edit', icon: '✏️', text: 'Editing a.ts', at: T0 } });
    c.activityChangedAt = T0;
    expect(labelFor(c, T0 + 1000, opts, false, 30).bubble?.text).toBe('Editing a.ts');
    expect(labelFor(c, T0 + 60_000, opts, false, 30).bubble).toBeNull();
    expect(labelFor(c, T0 + 60_000, { ...opts, bubbles: 'all' }, false, 30).bubble?.text).toBe('Editing a.ts');
    expect(labelFor(c, T0 + 1000, { ...opts, bubbles: 'none' }, false, 30).bubble).toBeNull();
    // the selected agent always shows its activity
    expect(labelFor(c, T0 + 60_000, opts, true, 30).bubble?.text).toBe('Editing a.ts');
  });

  it('names follow the option and the zoom, except for the selection', () => {
    const c = ch();
    expect(labelFor(c, T0, opts, false, 30).name).toBe('Ana');
    expect(labelFor(c, T0, { ...opts, showNames: false }, false, 30).name).toBeNull();
    expect(labelFor(c, T0, opts, false, 5).name).toBeNull();
    expect(labelFor(c, T0, opts, true, 5).name).toBe('Ana');
  });

  it('decluttering keeps the higher priority of two overlapping labels', () => {
    const kept = declutter([
      { id: 'low', rect: { x: 0, y: 0, w: 50, h: 20 }, priority: 1 },
      { id: 'high', rect: { x: 10, y: 5, w: 50, h: 20 }, priority: 60 },
      { id: 'apart', rect: { x: 200, y: 0, w: 50, h: 20 }, priority: 0 },
    ]);
    expect([...kept].sort()).toEqual(['apart', 'high']);
  });
});

describe('rigged characters', () => {
  const all = () => true;
  const none = () => false;

  it('picks a base clip per pose: seated poses sit, walking walks, the clip covers what it can', async () => {
    const { baseClipFor } = await import('./rig');
    expect(baseClipFor('type', true, all)).toBe('sit');
    expect(baseClipFor('sleep', true, all)).toBe('sit');
    expect(baseClipFor('wait', true, all)).toBe('sit');
    expect(baseClipFor('raise_hand', true, all)).toBe('sit');
    expect(baseClipFor('raise_hand', false, all)).toBe('wave');
    expect(baseClipFor('raise_hand', false, none)).toBe('idle');
    expect(baseClipFor('walk', false, all)).toBe('walk');
    expect(baseClipFor('run', false, none)).toBe('walk');
    expect(baseClipFor('cheer', false, all)).toBe('dance');
    expect(baseClipFor('talk', false, all)).toBe('yes');
    expect(baseClipFor('sulk', false, all)).toBe('no');
    expect(baseClipFor('drink', false, all)).toBe('idle');
  });

  it('layers procedural poses only where the clip does not already do the motion', async () => {
    const { layersFor } = await import('./rig');
    expect(layersFor('walk', 'walk')).toEqual({ arms: false, head: false, lean: false });
    expect(layersFor('raise_hand', 'wave')).toEqual({ arms: false, head: false, lean: false });
    expect(layersFor('type', 'sit')).toEqual({ arms: true, head: true, lean: true });
    expect(layersFor('sit', 'sit').arms).toBe(false);
    expect(layersFor('raise_hand', 'sit').arms).toBe(true);
  });

  it('at least 10 distinct poses are animated (exit criterion): base clip or a procedural layer', async () => {
    const { baseClipFor, layersFor } = await import('./rig');
    const poses = ['stand', 'walk', 'run', 'sit', 'type', 'sleep', 'drink', 'use', 'raise_hand', 'talk', 'stretch', 'read', 'wait', 'cheer', 'sulk'] as const;
    const animated = poses.filter((p) => {
      const base = baseClipFor(p, false, all);
      const l = layersFor(p, base);
      return base !== 'idle' || l.arms || l.head || l.lean;
    });
    expect(animated.length).toBeGreaterThanOrEqual(10);
  });
});
