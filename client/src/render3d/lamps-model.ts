// Lamp light pools (P10-19), the pure part: which furniture and decor are lamps, where their pools of light fall (on
// the floor and on the tables nearby), and how strong they are for the night amount and the room's light. No three
// here, so it is tested without a browser; lamps.ts turns the pools into one instanced mesh.
import type { FurniturePlacement } from '../core/layout/types';
import { FURNITURE, type FurnitureKind } from '../core/vocab';
import { TILE_M, UNIT_M } from './units';

/** Furniture kinds that are lamps. (Ceiling fixtures come from the theme's decor, see `lampsFromGlowBoxes`.) */
const LAMP_KINDS: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>(['floor_lamp']);

export function isLampKind(kind: FurnitureKind): boolean {
  return LAMP_KINDS.has(kind);
}

export type LampType = 'floor' | 'ceiling';

/** A light source: ground position and the height of the bulb, in metres. */
export interface LampSource {
  x: number;
  z: number;
  y: number;
  type: LampType;
}

/** What a lamp lights: the floor pool's radius (m) and its peak brightness (0..1, before the night amount). */
export const POOL: Record<LampType, { radius: number; peak: number }> = {
  floor: { radius: 1.8, peak: 0.5 },
  ceiling: { radius: 1.5, peak: 0.3 },
};

/** Floor pools sit just above the floor. */
export const FLOOR_Y = 0.03;
/** Decor above this height is a ceiling fixture. */
export const CEILING_Y = 1.9;

/** Table-like furniture whose top catches the light, with the height of the top (m). */
const TABLE_TOP: Partial<Record<FurnitureKind, number>> = {
  desk: 0.755,
  desk_back: 0.755,
  meeting_table: 0.755,
  cafe_table: 0.755,
  coffee_table: 0.405,
};

/** A table top: centre and size on the ground plane, and its height. */
export interface TableTop {
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
}

function footprintOf(f: FurniturePlacement): { x: number; z: number; w: number; d: number } {
  const def = FURNITURE[f.kind];
  const w = def.footprint.w * TILE_M;
  const d = def.footprint.h * TILE_M;
  const ox = f.tx * TILE_M + (f.dx ?? 0) * UNIT_M;
  const oz = f.ty * TILE_M + (f.dy ?? 0) * UNIT_M;
  return { x: ox + w / 2, z: oz + d / 2, w, d };
}

/** Lamps among an area's furniture: the middle of the footprint, the bulb at the top of the pole. */
export function lampsFromFurniture(furniture: readonly FurniturePlacement[]): LampSource[] {
  const out: LampSource[] = [];
  for (const f of furniture) {
    if (!isLampKind(f.kind)) continue;
    const p = footprintOf(f);
    out.push({ x: p.x, z: p.z, y: 1.7, type: 'floor' });
  }
  return out;
}

/** Table tops among an area's furniture. */
export function tablesFromFurniture(furniture: readonly FurniturePlacement[]): TableTop[] {
  const out: TableTop[] = [];
  for (const f of furniture) {
    const y = TABLE_TOP[f.kind];
    if (y === undefined) continue;
    const p = footprintOf(f);
    out.push({ x: p.x, z: p.z, w: p.w, d: p.d, y });
  }
  return out;
}

/** The glowing parts of a theme's overhead decor (pendant bulbs, fluorescent strips) as ceiling lamps. */
export function lampsFromGlowBoxes(boxes: readonly { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; mat: string }[]): LampSource[] {
  const out: LampSource[] = [];
  for (const b of boxes) {
    if (b.mat !== 'glow' || b.y0 < CEILING_Y) continue;
    out.push({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, y: b.y0, type: 'ceiling' });
  }
  return out;
}

/** One pool of light: an ellipse (half-sizes rx, rz) lying at height y; `peak` 0..1 is its brightness at full night. */
export interface Pool {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
  peak: number;
  onTable: boolean;
}

/** How much of a lamp's light reaches a point `dist` away: 1 under it, 0 at the radius. */
export function falloff(dist: number, radius: number): number {
  const u = Math.max(0, Math.min(1, 1 - dist / radius));
  return u * u * (3 - 2 * u);
}

/** A table lit less than this isn't given a pool. */
const MIN_TABLE_PEAK = 0.04;

/** The pools for an area's lamps and tables: one on the floor under each lamp, and one on each table in reach. */
export function poolsFor(lamps: readonly LampSource[], tables: readonly TableTop[]): Pool[] {
  const out: Pool[] = [];
  for (const l of lamps) {
    const s = POOL[l.type];
    out.push({ x: l.x, y: FLOOR_Y, z: l.z, rx: s.radius, rz: s.radius, peak: s.peak, onTable: false });
  }
  for (const t of tables) {
    let sum = 0;
    for (const l of lamps) {
      const s = POOL[l.type];
      // the nearest point of the table top to the lamp, so a long table is lit along its whole length
      const nx = Math.max(t.x - t.w / 2, Math.min(t.x + t.w / 2, l.x));
      const nz = Math.max(t.z - t.d / 2, Math.min(t.z + t.d / 2, l.z));
      sum += falloff(Math.hypot(nx - l.x, nz - l.z), s.radius) * Math.min(1, s.peak * 1.9);
    }
    const peak = Math.min(0.85, sum);
    if (peak < MIN_TABLE_PEAK) continue;
    out.push({ x: t.x, y: t.y, z: t.z, rx: t.w / 2, rz: t.d / 2, peak, onTable: true });
  }
  return out;
}

/**
 * How strong an area's pools are: the night amount (`LightLevels.glassGlow`: 0 by day, 1 deep in the night) times the
 * room's light (0 off .. 1 on, fading as it switches). Common areas always count as lit (`light` = null).
 */
export function poolStrength(night: number, light: number | null): number {
  const n = Number.isFinite(night) ? Math.max(0, Math.min(1, night)) : 0;
  const l = light === null ? 1 : Math.max(0, Math.min(1, Number.isFinite(light) ? light : 0));
  return n * l;
}
