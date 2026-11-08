// Lamp light pools (P10-19): which furniture are lamps, where the pools fall, how strong they are, and the rim light.
import { describe, expect, it } from 'vitest';
import { ambientAt, lightLevelsAt } from '../core/daylight';
import type { FurniturePlacement } from '../core/layout/types';
import { FURNITURE_KINDS, type FurnitureKind, type RoomTheme } from '../core/vocab';
import { coreAreas } from '../core/layout/building';
import { layoutProjectRoom } from '../core/layout/room';
import { CEILING_Y, falloff, FLOOR_Y, isLampKind, lampsFromFurniture, lampsFromGlowBoxes, POOL, poolsFor, poolStrength, tablesFromFurniture } from './lamps-model';
import { rimAt } from './rim';
import { TILE_M } from './units';

function furn(kind: FurnitureKind, tx: number, ty: number, extra: Partial<FurniturePlacement> = {}): FurniturePlacement {
  return { id: `${kind}-${tx}-${ty}`, kind, tx, ty, order: 0, ...extra };
}

const BASE = { hemi: 1.9, sun: 1.6 };
const levelsAt = (hour: number) => lightLevelsAt(ambientAt(hour), BASE);

describe('which furniture is a lamp', () => {
  it('only the floor lamp, of every furniture kind', () => {
    expect(FURNITURE_KINDS.filter(isLampKind)).toEqual(['floor_lamp']);
  });

  it('a floor lamp sits in the middle of its tile, the bulb high up', () => {
    const [l] = lampsFromFurniture([furn('floor_lamp', 4, 6), furn('desk', 1, 1)]);
    expect(l).toEqual({ x: 4 * TILE_M + TILE_M / 2, z: 6 * TILE_M + TILE_M / 2, y: 1.7, type: 'floor' });
  });

  it('follows the placement offset', () => {
    const [l] = lampsFromFurniture([furn('floor_lamp', 4, 6, { dx: 8, dy: -8 })]);
    expect(l!.x).toBeCloseTo(4 * TILE_M + TILE_M / 2 + 0.25);
    expect(l!.z).toBeCloseTo(6 * TILE_M + TILE_M / 2 - 0.25);
  });

  it('ceiling lamps are the glowing decor high up; wall neon and strips at the wall are not', () => {
    const box = (y0: number, mat: string) => ({ x0: 1, x1: 1.2, y0, y1: y0 + 0.1, z0: 3, z1: 3.2, mat });
    const lamps = lampsFromGlowBoxes([box(2.06, 'glow'), box(2.38, 'glow'), box(1.65, 'glow'), box(2.2, 'solid')]);
    expect(lamps.map((l) => l.y)).toEqual([2.06, 2.38]);
    expect(lamps[0]).toMatchObject({ x: 1.1, z: 3.1, type: 'ceiling' });
    expect(CEILING_Y).toBeGreaterThan(1.65);
  });
});

describe('where the pools fall', () => {
  const lamp = lampsFromFurniture([furn('floor_lamp', 10, 10)]);

  it('one floor pool per lamp, centred under it, just above the floor', () => {
    const pools = poolsFor(lamp, []);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ x: lamp[0]!.x, z: lamp[0]!.z, y: FLOOR_Y, onTable: false, peak: POOL.floor.peak });
    expect(pools[0]!.rx).toBe(POOL.floor.radius);
  });

  it('a desk next to a lamp catches a pool on its top; a far one does not', () => {
    const near = tablesFromFurniture([furn('desk', 8, 10)]);
    const far = tablesFromFurniture([furn('desk', 30, 10)]);
    const lit = poolsFor(lamp, near).filter((p) => p.onTable);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.y).toBeGreaterThan(0.7);
    // the pool covers the desk top (2 x 1 tiles)
    expect(lit[0]!.rx).toBeCloseTo(TILE_M);
    expect(lit[0]!.rz).toBeCloseTo(TILE_M / 2);
    expect(poolsFor(lamp, far).filter((p) => p.onTable)).toHaveLength(0);
  });

  it('a nearer table is lit more than a farther one, never above 0.85', () => {
    const t = tablesFromFurniture([furn('desk', 8, 10), furn('desk', 12, 10), furn('desk', 10, 10)]);
    const lit = poolsFor(lamp, t).filter((p) => p.onTable);
    const byX = [...lit].sort((a, b) => a.x - b.x);
    expect(byX).toHaveLength(3);
    for (const p of lit) expect(p.peak).toBeLessThanOrEqual(0.85);
    // the desk at x tile 10 is right under the lamp
    expect(lit.find((p) => Math.abs(p.x - (10 * TILE_M + TILE_M)) < 1e-6)!.peak).toBeGreaterThanOrEqual(byX[0]!.peak);
  });

  it('falloff is 1 under the lamp, 0 at the radius and in between smoothly', () => {
    expect(falloff(0, 2)).toBe(1);
    expect(falloff(2, 2)).toBe(0);
    expect(falloff(3, 2)).toBe(0);
    expect(falloff(1, 2)).toBeCloseTo(0.5);
    expect(falloff(0.5, 2)).toBeGreaterThan(falloff(1, 2));
  });

  it('real layouts: every project room has a lamp and lit desks, pools stay inside their area', () => {
    const theme: RoomTheme = { carpet: '#4f6d8f', carpet2: '#486685', wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' }, accent: '#3f7fd8', deskVariant: 'wood', chairVariant: 'black' } as RoomTheme;
    for (let slot = 0; slot < 6; slot++) {
      const room = layoutProjectRoom({ id: `/p/${slot}`, slot, seed: 1000 + slot * 77 }, theme);
      const pools = poolsFor(lampsFromFurniture(room.furniture), tablesFromFurniture(room.furniture));
      expect(pools.some((p) => !p.onTable)).toBe(true);
      expect(pools.some((p) => p.onTable)).toBe(true);
      const r = room.rect;
      for (const p of pools.filter((q) => q.onTable)) {
        expect(p.x).toBeGreaterThan(r.x * TILE_M);
        expect(p.x).toBeLessThan((r.x + r.w) * TILE_M);
        expect(p.z).toBeGreaterThan(r.y * TILE_M);
        expect(p.z).toBeLessThan((r.y + r.h) * TILE_M);
      }
    }
    // the lounge has a lamp too
    expect(coreAreas().some((a) => lampsFromFurniture(a.furniture).length > 0)).toBe(true);
  });
});

describe('how strong the pools are', () => {
  it('there are none by day and full deep in the night', () => {
    expect(poolStrength(levelsAt(13.5).glassGlow, 1)).toBe(0);
    expect(poolStrength(levelsAt(22.5).glassGlow, 1)).toBe(1);
  });

  it('follows the room: off = none, on = full, in between while the light fades', () => {
    expect(poolStrength(1, 0)).toBe(0);
    expect(poolStrength(1, 1)).toBe(1);
    expect(poolStrength(1, 0.5)).toBeCloseTo(0.5);
  });

  it('common areas always count as lit', () => {
    expect(poolStrength(1, null)).toBe(1);
    expect(poolStrength(0, null)).toBe(0);
  });

  it('grows through dusk and fades at dawn, without jumps', () => {
    let prev = 0;
    for (let h = 16; h <= 21; h += 0.25) {
      const s = poolStrength(levelsAt(h).glassGlow, 1);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s - prev).toBeLessThan(0.35);
      prev = s;
    }
    expect(poolStrength(levelsAt(7.5).glassGlow, 1)).toBe(0);
  });

  it('survives junk', () => {
    expect(poolStrength(Number.NaN, 1)).toBe(0);
    expect(poolStrength(1, Number.NaN)).toBe(0);
    expect(poolStrength(5, -3)).toBe(0);
  });
});

describe('night rim light', () => {
  it('is off by day, subtle at night, and clamped', () => {
    expect(rimAt(levelsAt(13.5).glassGlow)).toBe(0);
    expect(rimAt(levelsAt(22.5).glassGlow)).toBeCloseTo(0.5);
    expect(rimAt(2)).toBeCloseTo(0.5);
    expect(rimAt(-1)).toBe(0);
    expect(rimAt(Number.NaN)).toBe(0);
  });
});
