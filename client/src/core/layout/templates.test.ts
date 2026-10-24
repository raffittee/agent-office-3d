// Layout templates (P4-03): every template must produce the same spot kinds, all reachable, for 1 to 20 rooms.
import { describe, expect, it } from 'vitest';
import { LAYOUT_TEMPLATES } from '../../../../shared/theme';
import { COL_W } from '../constants';
import { roomTheme } from '../room-theme';
import { assembleBuilding, coreAreas } from './building';
import { RECEPTION_ID } from './core';
import { columnsFor, slotRect } from './geometry';
import { layoutProjectRoom, SIDE_OPENING } from './room';
import type { SpotKind } from './types';

function building(n: number, template: (typeof LAYOUT_TEMPLATES)[number]) {
  const slots = Array.from({ length: n }, (_, i) => i);
  const rooms = slots.map((slot) => layoutProjectRoom({ id: `/p/${slot}`, slot, seed: 4242 + slot * 131 }, roomTheme(slot), template));
  return assembleBuilding(columnsFor(slots), rooms, 0, template);
}

/** The spot kinds a building has, with counts per room kind set. */
function kinds(b: ReturnType<typeof building>): Set<SpotKind> {
  return new Set(b.spots.map((s) => s.kind));
}

describe('layout templates', () => {
  const reference = new Map<number, Set<SpotKind>>();
  for (let n = 1; n <= 20; n++) reference.set(n, kinds(building(n, 'corridor')));

  for (const template of LAYOUT_TEMPLATES) {
    it(`${template}: same spot kinds and count as the corridor, all reachable, for 1–20 rooms`, () => {
      for (let n = 1; n <= 20; n++) {
        const b = building(n, template);
        const ref = building(n, 'corridor');
        expect([...kinds(b)].sort(), `${template} ${n}`).toEqual([...reference.get(n)!].sort());
        // the template only changes walls: every place keeps its id and position
        expect(b.spots.map((s) => `${s.id}@${s.tx},${s.ty}`)).toEqual(ref.spots.map((s) => `${s.id}@${s.tx},${s.ty}`));
        const elevator = coreAreas()
          .find((a) => a.id === RECEPTION_ID)!
          .spots.find((s) => s.kind === 'elevator')!;
        const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
        const lost = b.spots.filter((s) => reach[s.ty * b.grid.w + s.tx] !== 1).map((s) => s.id);
        expect(lost, `${template} ${n}`).toEqual([]);
      }
    });
  }

  it('open templates connect neighbouring rooms through their side walls; the corridor template does not', () => {
    const r = slotRect(0);
    const y = r.y + SIDE_OPENING.ly + 1;
    const x = r.x + COL_W; // the first tile of the next room on the same side
    for (const template of LAYOUT_TEMPLATES) {
      const b = building(4, template);
      expect(b.grid.walkable(x - 1, y) && b.grid.walkable(x, y), template).toBe(template !== 'corridor');
    }
  });

  it("the building's east edge stays closed in open templates", () => {
    for (const template of ['open-plan', 'loft'] as const) {
      const b = building(3, template);
      const last = b.cols * COL_W - 1;
      for (let y = 0; y < b.grid.h; y++) {
        if (y >= 12 && y < 17) continue; // the corridor ends in a glass front
        expect(b.grid.walkable(last, y), `${template} y=${y}`).toBe(false);
      }
      expect(b.edge?.walls.length).toBe(2);
    }
    expect(building(3, 'corridor').edge).toBeUndefined();
  });

  it('open templates use partitions, and the loft has no corridor runners', () => {
    const glass = layoutProjectRoom({ id: 'a', slot: 0, seed: 1 }, roomTheme(0), 'open-plan');
    const low = layoutProjectRoom({ id: 'a', slot: 0, seed: 1 }, roomTheme(0), 'loft');
    expect(glass.walls.filter((w) => w.style.partition === 'glass').length).toBeGreaterThan(0);
    expect(low.walls.filter((w) => w.style.partition === 'low').length).toBeGreaterThan(0);
    expect(building(2, 'loft').corridor.rugs).toHaveLength(0);
    expect(building(2, 'corridor').corridor.rugs.length).toBeGreaterThan(0);
  });
});
