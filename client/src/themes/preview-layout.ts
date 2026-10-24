// The preview page's showroom (P4-10): every furniture kind side by side on one floor, wall items on a back wall.
// Pure: a plain AreaLayout that building.ts and models.ts draw like any area.
import { AreaBuilder } from '../core/layout/builder';
import type { AreaLayout } from '../core/layout/types';
import { FURNITURE, FURNITURE_KINDS, type FurnitureKind, type WallStyle } from '../core/vocab';

/** Showroom width in tiles. */
export const SHOWROOM_W = 30;

export interface ShowroomItem {
  kind: FurnitureKind;
  /** Label anchor in tiles (centre of the footprint, or of the wall item). */
  x: number;
  y: number;
  wall: boolean;
}

/** Lays out every kind: wall items along the north wall, floor items in rows with a tile of space around each. */
export function showroom(wall: WallStyle = { base: '#eef1f4', trim: '#9fb0c4' }): { layout: AreaLayout; items: ShowroomItem[] } {
  const items: ShowroomItem[] = [];
  const floorKinds = FURNITURE_KINDS.filter((k) => FURNITURE[k].mount === 'floor');
  const wallKinds = FURNITURE_KINDS.filter((k) => FURNITURE[k].mount === 'wall' && k !== 'door_frame');
  // rows of floor items
  let x = 1;
  let y = 3;
  let rowH = 0;
  const spots: { kind: FurnitureKind; x: number; y: number }[] = [];
  for (const kind of floorKinds) {
    const { w, h } = FURNITURE[kind].footprint;
    if (x + w > SHOWROOM_W - 1) {
      x = 1;
      y += rowH + 2;
      rowH = 0;
    }
    spots.push({ kind, x, y });
    x += w + 1;
    rowH = Math.max(rowH, Math.max(1, h));
  }
  const height = y + rowH + 2;
  const b = new AreaBuilder('preview', 'room', { x: 0, y: 0, w: SHOWROOM_W, h: height });
  b.floor('marble', 0, 0, SHOWROOM_W, height, 7);
  b.face(0, SHOWROOM_W, wall);
  b.walk(0, 2, SHOWROOM_W, height - 2);
  for (const s of spots) {
    const def = FURNITURE[s.kind];
    b.furn(s.kind, s.x, s.y, def.variants?.[0]);
    items.push({ kind: s.kind, x: s.x + def.footprint.w / 2, y: s.y + Math.max(1, def.footprint.h), wall: false });
  }
  // wall items, spread along the wall
  let cx = 1;
  for (const kind of wallKinds) {
    const w = FURNITURE[kind].footprint.w;
    if (cx + w > SHOWROOM_W) break;
    b.wall(kind, cx + w / 2, FURNITURE[kind].variants?.[0]);
    items.push({ kind, x: cx + w / 2, y: 2, wall: true });
    cx += w + 0.5;
  }
  return { layout: b.build(), items };
}
