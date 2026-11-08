// Rooms and the building (P10-06): window and door frames, switch plates, light fixtures, the exterior, and that every
// theme and layout template still builds each area into at most three meshes, with its name on a plaque.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { DecorSpec, ThemePack } from '../../../shared/theme';
import cabinJson from '../../../themes/cabin/theme.json';
import industrialJson from '../../../themes/industrial/theme.json';
import modernJson from '../../../themes/modern/theme.json';
import startupJson from '../../../themes/startup/theme.json';
import traditionalJson from '../../../themes/traditional/theme.json';
import { assembleBuilding, coreAreas } from '../core/layout/building';
import { CAFE_ID, LOUNGE_ID, RECEPTION_ID, RESTROOM_ID } from '../core/layout/core';
import { columnsFor } from '../core/layout/geometry';
import { layoutProjectRoom } from '../core/layout/room';
import type { AreaLayout } from '../core/layout/types';
import { resolveLook } from '../themes/look';
import { buildArea, farSides } from './building';
import { doorHeight, doorParts, fixtureStyle, fixturesFor, switchBoxes, windowBoxes, type DecorBox, type DoorSpec, type FullWall } from './decor';
import { entranceSpan, exteriorBoxes, mixHex, spread } from './exterior';
import { signLabel } from './signs-model';
import { CUT_H, TILE_M } from './units';

const packs = [modernJson, industrialJson, traditionalJson, startupJson, cabinJson] as unknown as ThemePack[];

const inside = (b: DecorBox, o: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }) => b.x0 >= o.x0 - 1e-9 && b.x1 <= o.x1 + 1e-9 && b.y0 >= o.y0 - 1e-9 && b.y1 <= o.y1 + 1e-9 && b.z0 >= o.z0 - 1e-9 && b.z1 <= o.z1 + 1e-9;
const valid = (b: DecorBox) => b.x1 > b.x0 && b.y1 > b.y0 && b.z1 > b.z0 && [b.x0, b.x1, b.y0, b.y1, b.z0, b.z1].every(Number.isFinite);

describe('windowBoxes', () => {
  const spec = { cx: 5, y: 1.6, w: 0.9, h: 1.1, plane: 2, dir: 1 as const, frame: '#445566', sky: '#8fc4ea' };

  it('is a frame with depth and one glass pane set back from its face', () => {
    const boxes = windowBoxes(spec);
    expect(boxes.every(valid)).toBe(true);
    const glass = boxes.filter((b) => b.mat === 'glass');
    expect(glass).toHaveLength(1);
    const frameFace = Math.max(...boxes.filter((b) => b.mat === 'solid').map((b) => b.z1));
    expect(glass[0]!.z1).toBeLessThan(frameFace - 0.02);
    // the pane lies inside the frame's outline
    expect(glass[0]!.x0).toBeGreaterThan(spec.cx - spec.w / 2);
    expect(glass[0]!.x1).toBeLessThan(spec.cx + spec.w / 2);
    expect(boxes.filter((b) => b.mat === 'solid').length).toBeGreaterThanOrEqual(8);
  });

  it('stands out of the wall towards the room, on either side', () => {
    for (const dir of [1, -1] as const) {
      const boxes = windowBoxes({ ...spec, dir });
      for (const b of boxes) {
        if (dir === 1) expect(b.z0).toBeGreaterThanOrEqual(spec.plane - 1e-9);
        else expect(b.z1).toBeLessThanOrEqual(spec.plane + 1e-9);
      }
    }
  });
});

describe('doorParts', () => {
  const door: DoorSpec = { x0: 3.5, x1: 4.5, z0: 6, z1: 7, h: 2.8, full: true, wallHeight: 2.8, base: '#ddd', trim: '#444', coping: '#888', leaf: '#c0392b', roomSide: 1 };

  it('a full wall gets jambs, a header, the wall over the door and an open leaf in the room', () => {
    const p = doorParts(door);
    expect(p.boxes.every(valid)).toBe(true);
    const dh = doorHeight(2.8);
    expect(dh).toBeCloseTo(2.1);
    // the wall over the door stands from the door's top to the wall's top
    expect(p.boxes.some((b) => b.color === door.base && Math.abs(b.y0 - dh) < 1e-9 && Math.abs(b.y1 - 2.8) < 1e-9)).toBe(true);
    // jambs: two boxes standing on the floor at the opening's edges
    expect(p.boxes.filter((b) => b.y0 === 0 && (b.x0 === door.x0 || b.x1 === door.x1))).toHaveLength(2);
    expect(p.leaf).not.toBeNull();
    expect(p.leaf!.len).toBeLessThan(door.x1 - door.x0);
    expect(p.leaf!.hx).toBeGreaterThan(door.x0);
    // the leaf swings into the room (+z for a north wall, -z for a south wall)
    expect(p.leaf!.hz).toBeGreaterThan(door.z1);
    expect(doorParts({ ...door, roomSide: -1 }).leaf!.hz).toBeLessThan(door.z0);
  });

  it('a cut wall gets only low jambs; a hidden one nothing', () => {
    const cut = doorParts({ ...door, full: false, h: CUT_H });
    expect(cut.leaf).toBeNull();
    expect(cut.boxes).toHaveLength(2);
    expect(Math.max(...cut.boxes.map((b) => b.y1))).toBeLessThan(0.5);
    expect(doorParts({ ...door, full: false, h: 0.06 }).boxes).toHaveLength(0);
  });

  it('keeps a doorway usable in low walls', () => {
    expect(doorHeight(2.4)).toBeCloseTo(2.1);
    expect(doorHeight(2.2)).toBeCloseTo(1.9);
    expect(doorParts({ ...door, wallHeight: 2.2, h: 2.2 }).leaf!.h).toBeLessThan(1.9);
  });
});

describe('switchBoxes', () => {
  it('a plate with a toggle that is up when the light is on', () => {
    const on = switchBoxes(2, 3, 1, true);
    const off = switchBoxes(2, 3, 1, false);
    expect(on.every(valid)).toBe(true);
    expect(on[0]!.y0).toBeGreaterThan(1);
    expect(on[1]!.y0).toBeGreaterThan(off[1]!.y0);
    // on the room side of a north wall it stands out towards +z, on a south wall towards -z
    expect(on[0]!.z0).toBeGreaterThanOrEqual(3);
    expect(switchBoxes(2, 3, -1, true)[0]!.z1).toBeLessThanOrEqual(3);
  });
});

describe('light fixtures', () => {
  const ctx = { wallHeight: 2.8, accent: '#ff00aa', practical: '#ffb45e' };
  const wall = (extra: Partial<FullWall> = {}): FullWall => ({ axis: 'x', a0: 0, a1: 8, plane: 4, normal: 1, busy: [], ...extra });
  const spec = (kind: DecorSpec['kind']): DecorSpec => ({ kind, on: 'everywhere' });

  it('picks a fixture from the theme', () => {
    const style = (p: ThemePack) => fixtureStyle(p.decor ?? []);
    const by = (id: string) => packs.find((p) => p.id === id)!;
    expect(style(by('industrial'))).toBe('bulb');
    expect(style(by('traditional'))).toBe('panel');
    expect(style(by('startup'))).toBe('tube');
    expect(style(by('cabin'))).toBe('lantern');
    expect(style(by('modern'))).toBe('disc');
  });

  it('hangs fixtures near the top of a wall, within a metre of it, with a glowing part', () => {
    for (const kind of ['pendant_bulbs', 'fluorescent', 'neon', 'plant_wall'] as const) {
      const boxes = fixturesFor([wall()], [spec(kind)], ctx);
      expect(boxes.length, kind).toBeGreaterThan(0);
      expect(boxes.every(valid), kind).toBe(true);
      expect(boxes.some((b) => b.mat === 'glow'), kind).toBe(true);
      for (const b of boxes) {
        expect(b.y0, kind).toBeGreaterThan(ctx.wallHeight - 0.8);
        expect(b.y1, kind).toBeLessThanOrEqual(ctx.wallHeight + 1e-9);
        expect(b.z0, kind).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(b.z1, kind).toBeLessThanOrEqual(4 + 0.95);
      }
    }
  });

  it('stays clear of the spans it is told about, and works on side walls', () => {
    const busy: [number, number][] = [[1, 3.6]];
    const boxes = fixturesFor([wall({ busy })], [spec('pendant_bulbs')], ctx);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b.x1 <= 1 + 1e-9 || b.x0 >= 3.6 - 1e-9).toBe(true);
    const side = fixturesFor([{ axis: 'z', a0: 0, a1: 6, plane: 10, normal: -1, busy: [] }], [spec('pendant_bulbs')], ctx);
    expect(side.length).toBeGreaterThan(0);
    for (const b of side) expect(b.x1).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('puts nothing on a wall run too short for it', () => {
    expect(fixturesFor([wall({ a1: 0.5 })], [spec('fluorescent')], ctx)).toHaveLength(0);
  });
});

describe('exterior', () => {
  const W = 40;
  const D = 14.5;
  const base = { w: W, d: D, ground: '#cbc6bc', practical: '#fff1c9' };
  const far = (north: boolean, south: boolean, west: boolean, east: boolean) => ({ north, south, west, east });

  it('keeps clear of the building: whatever lies under it is below the floor', () => {
    for (const f of [far(true, false, false, true), far(false, true, true, false), far(false, false, false, false)]) {
      for (const b of exteriorBoxes({ ...base, far: f })) {
        expect(valid(b)).toBe(true);
        // (the foundation's top edge may tuck 2 cm under the wall's face)
        const overlaps = Math.min(b.x1, W) - Math.max(b.x0, 0) > 0.03 && Math.min(b.z1, D) - Math.max(b.z0, 0) > 0.03;
        if (overlaps) expect(b.y1, `${b.color}`).toBeLessThanOrEqual(0);
      }
    }
  });

  it('leaves the corridor entrances open in the foundation strip', () => {
    const [e0, e1] = entranceSpan();
    expect(e0).toBeCloseTo(6);
    expect(e1).toBeCloseTo(8.5);
    const strip = exteriorBoxes({ ...base, far: far(true, false, false, true) }).filter((b) => Math.abs(b.y1 - 0.15) < 1e-9 && b.x1 <= 0.01 && b.x0 >= -0.2);
    expect(strip.length).toBeGreaterThan(0);
    for (const b of strip) expect(b.z1 <= e0 + 1e-9 || b.z0 >= e1 - 1e-9).toBe(true);
  });

  it('plants trees and lamp posts only on the far sides', () => {
    const tall = (f: ReturnType<typeof far>) => exteriorBoxes({ ...base, far: f }).filter((b) => b.y1 > 0.9);
    expect(tall(far(false, false, false, false)).filter((b) => b.y1 > 0.75)).toHaveLength(0);
    const north = tall(far(true, false, false, false));
    expect(north.length).toBeGreaterThan(0);
    for (const b of north) expect(b.z1).toBeLessThan(0);
    const east = tall(far(false, false, false, true));
    expect(east.length).toBeGreaterThan(0);
    for (const b of east) expect(b.x0).toBeGreaterThan(W);
    // a lamp post's lamp glows
    expect(exteriorBoxes({ ...base, far: far(true, false, false, false) }).some((b) => b.mat === 'glow')).toBe(true);
  });

  it('spreads and mixes', () => {
    expect(spread(10, 3, 1)).toEqual([1, 5, 9]);
    expect(spread(1, 3, 1)).toEqual([]);
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

/** Every mesh position of a built area, for sanity checks. */
function positions(view: ReturnType<typeof buildArea>): { meshes: number; bad: number; box: THREE.Box3 } {
  const box = new THREE.Box3();
  let meshes = 0;
  let bad = 0;
  view.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    meshes++;
    const p = o.geometry.attributes.position!;
    for (let i = 0; i < p.count * 3; i++) if (!Number.isFinite(p.array[i] as number)) bad++;
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox!);
  });
  return { meshes, bad, box };
}

describe('buildArea for every theme, template and camera side', () => {
  for (const pack of packs) {
    const look = resolveLook(pack);
    it(`${pack.id} (${look.template}): at most three meshes per area, finite geometry, names on plaques`, () => {
      const slots = [0, 1, 2, 3];
      const rooms: AreaLayout[] = slots.map((slot) => layoutProjectRoom({ id: `/p/${slot}`, slot, seed: 91 + slot * 17 }, look.roomTheme(slot), look.template));
      const b = assembleBuilding(columnsFor(slots), rooms, 0, look.template);
      const areas = [...coreAreas(), b.corridor, ...rooms, ...(b.edge ? [b.edge] : [])];
      const rect = b.rect;
      const bounds = { x0: rect.x * TILE_M - 0.6, x1: (rect.x + rect.w) * TILE_M + 0.6, z0: rect.y * TILE_M - 0.6, z1: (rect.y + rect.h) * TILE_M + 0.6 };
      const named = new Map<string, number>();
      for (const yaw of [45, 135, 225, 315]) {
        for (const cutaway of ['cut', 'hide'] as const) {
          for (const area of areas) {
            const view = buildArea(area, { cols: b.cols, far: farSides(yaw), cutaway, look, modelled: new Set() }, '#c0392b');
            const info = positions(view);
            expect(info.meshes, `${area.id} ${yaw}`).toBeLessThanOrEqual(3);
            expect(info.bad, `${area.id} ${yaw}`).toBe(0);
            expect(info.box.max.x, `${area.id} ${yaw}`).toBeLessThanOrEqual(bounds.x1);
            expect(info.box.min.x, `${area.id} ${yaw}`).toBeGreaterThanOrEqual(bounds.x0);
            expect(info.box.max.z, `${area.id} ${yaw}`).toBeLessThanOrEqual(bounds.z1);
            expect(info.box.min.z, `${area.id} ${yaw}`).toBeGreaterThanOrEqual(bounds.z0);
            // the sign quads never leave the building either
            for (const s of view.signs) {
              expect(s.spec.w / s.spec.h).toBeCloseTo(4, 6);
              expect(s.spec.x).toBeGreaterThan(bounds.x0);
              expect(s.spec.x).toBeLessThan(bounds.x1);
              expect(Math.abs(s.spec.nx) + Math.abs(s.spec.nz)).toBe(1);
            }
            if (yaw === 315 && cutaway === 'cut') named.set(area.id, view.signs.length);
            view.dispose();
          }
        }
      }
      // in the default view every named area carries a plaque
      for (const id of [RECEPTION_ID, CAFE_ID, LOUNGE_ID, RESTROOM_ID, ...rooms.map((r) => r.id)]) {
        expect(signLabel(id, 'x'), id).not.toBeNull();
        expect(named.get(id) ?? 0, `${pack.id} ${id}`).toBeGreaterThan(0);
      }
      expect(named.get('core:corridor') ?? 0).toBe(0);
    });
  }
});
