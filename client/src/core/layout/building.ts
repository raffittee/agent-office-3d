// Ported from habblaud client/src/world/layout/building.ts (MIT, © 2026 Márcio Junior)
// Assembles the building: core + corridor + project rooms → walkability grid and spots.
import type { LayoutTemplate } from '../../../../shared/theme';
import { BUILDING_H, COL_W, CORRIDOR_Y, ROOM_H, SOUTH_Y } from '../constants';
import { BLOCKED, FREE, SEAT, WalkGrid } from '../nav/grid';
import { FURNITURE } from '../vocab';
import { AreaBuilder, furnitureBlocks, furnitureIsSeat } from './builder';
import { layoutCafe, layoutLounge, layoutReception, layoutRestroom } from './core';
import { layoutCorridor } from './corridor';
import { buildingRect } from './geometry';
import type { AreaLayout, SpotDef, TileRect } from './types';

export interface BuildingLayout {
  cols: number;
  rect: TileRect;
  core: AreaLayout[];
  corridor: AreaLayout;
  rooms: AreaLayout[];
  /** Open templates: the building's east wall (rooms there have side openings). */
  edge?: AreaLayout;
  template: LayoutTemplate;
  grid: WalkGrid;
  spots: SpotDef[];
}

let coreCache: AreaLayout[] | null = null;

/** The core's fixed areas (computed once). */
export function coreAreas(): AreaLayout[] {
  return (coreCache ??= [layoutReception(), layoutRestroom(), layoutCafe(), layoutLounge()]);
}

/** Marks an area's walkable cells, blocks and seats on the grid. */
export function paintArea(grid: WalkGrid, area: AreaLayout): void {
  for (const r of area.walkable) grid.fill(r.x, r.y, r.w, r.h, FREE);
  for (const r of area.blocked ?? []) grid.fill(r.x, r.y, r.w, r.h, BLOCKED);
  for (const f of area.furniture) {
    const def = FURNITURE[f.kind];
    if (def.mount !== 'floor') continue;
    const { w, h } = def.footprint;
    if (furnitureBlocks(f.kind)) grid.fill(f.tx, f.ty, w, h, BLOCKED);
    else if (furnitureIsSeat(f.kind)) {
      for (let y = f.ty; y < f.ty + h; y++) for (let x = f.tx; x < f.tx + w; x++) if (grid.get(x, y) === FREE) grid.set(x, y, SEAT);
    }
  }
}

export function buildWalkGrid(cols: number, areas: readonly AreaLayout[], version = 0): WalkGrid {
  const grid = new WalkGrid(cols * COL_W, BUILDING_H, version);
  for (const a of areas) paintArea(grid, a);
  return grid;
}

export const EDGE_ID = 'core:edge';

/**
 * Open templates (P4-03): rooms have openings in their side walls, so the last column needs the building's east wall
 * back. Painted last, so its blocked strip wins over the rooms' openings.
 */
export function layoutEdge(cols: number): AreaLayout {
  const x = cols * COL_W;
  const b = new AreaBuilder(EDGE_ID, 'corridor', { x: x - 1, y: 0, w: 1, h: BUILDING_H });
  const style = { base: '#eef1f4', exterior: true };
  // a hair thicker than a room's own side wall, so the two never z-fight
  b.cap(0.45, 0, 0.57, ROOM_H, style);
  b.cap(0.45, SOUTH_Y, 0.57, ROOM_H, style);
  b.area.blocked = [
    { x: x - 1, y: 0, w: 1, h: CORRIDOR_Y },
    { x: x - 1, y: SOUTH_Y, w: 1, h: ROOM_H },
  ];
  return b.build();
}

export function assembleBuilding(cols: number, rooms: readonly AreaLayout[], version = 0, template: LayoutTemplate = 'corridor'): BuildingLayout {
  const core = coreAreas();
  const corridor = layoutCorridor(cols, template);
  const edge = template === 'corridor' ? undefined : layoutEdge(cols);
  const all = [...core, corridor, ...rooms, ...(edge ? [edge] : [])];
  const grid = buildWalkGrid(cols, all, version);
  const spots: SpotDef[] = [];
  for (const a of all) spots.push(...a.spots);
  return { cols, rect: buildingRect(cols), core, corridor, rooms: [...rooms], ...(edge ? { edge } : {}), template, grid, spots };
}
