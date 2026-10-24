// Ported from habblaud client/src/world/layout/geometry.ts (MIT, © 2026 Márcio Junior)
// Building geometry: slots, columns and rectangles. Pure and testable.
import { BUILDING_H, COL_W, CORE_COLS, CORRIDOR_H, CORRIDOR_Y, NORTH_Y, ROOM_H, SOUTH_Y, TILE } from '../constants';
import type { TileRect } from './types';

export type Side = 'north' | 'south';

/** The building column (0 = core A) a project room slot takes. */
export function slotColumn(slot: number): number {
  return CORE_COLS + Math.floor(Math.max(0, slot) / 2);
}

/** Even slots are north of the corridor; odd ones south. */
export function slotSide(slot: number): Side {
  return Math.max(0, slot) % 2 === 0 ? 'north' : 'south';
}

/** A room's rectangle (tiles) in a column and side. */
export function cellRect(col: number, side: Side): TileRect {
  return { x: col * COL_W, y: side === 'north' ? NORTH_Y : SOUTH_Y, w: COL_W, h: ROOM_H };
}

export function slotRect(slot: number): TileRect {
  return cellRect(slotColumn(slot), slotSide(slot));
}

/** The slot of a project column and side (inverse of slotColumn/slotSide). */
export function slotAt(col: number, side: Side): number {
  return (col - CORE_COLS) * 2 + (side === 'north' ? 0 : 1);
}

/** Building columns for the slots in use (at least 1 project column). */
export function columnsFor(slots: Iterable<number>): number {
  let maxCol = 0;
  for (const s of slots) maxCol = Math.max(maxCol, Math.floor(Math.max(0, s) / 2));
  return CORE_COLS + maxCol + 1;
}

export function corridorRect(cols: number): TileRect {
  return { x: 0, y: CORRIDOR_Y, w: cols * COL_W, h: CORRIDOR_H };
}

export function buildingRect(cols: number): TileRect {
  return { x: 0, y: 0, w: cols * COL_W, h: BUILDING_H };
}

/** A tile rectangle in world units. */
export function rectUnits(r: TileRect): { x: number; y: number; w: number; h: number } {
  return { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE };
}

export function inRect(r: TileRect, tx: number, ty: number): boolean {
  return tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
}
