// The procedural placeholder kit: each furniture kind as a few boxes (P2-06). Pure data, no three: building.ts turns
// the boxes into merged geometry. Theme packs (Phase 4) replace these with models; a missing kind falls back here.
import { FURNITURE, type FurnitureKind } from '../core/vocab';
import { TILE_M } from './units';

export type PartMaterial = 'solid' | 'glass' | 'glow';

/** A box in metres: x/z relative to the footprint's top-left corner (+z = south), y up from the floor. */
export interface Part {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
  color: string;
  mat?: PartMaterial;
}

const WOOD: Record<string, string> = { wood: '#b98a5e', white: '#e9e6e0', dark: '#4d4844' };
const CHAIR: Record<string, string> = { black: '#2f3236', blue: '#3d6fb6', red: '#c0463b', green: '#3f8f5b', gray: '#8a8f96' };
const BEANBAG: Record<string, string> = { red: '#d0543f', blue: '#4579c4', yellow: '#e7b53c', green: '#4f9e63' };
const FOLIAGE: Record<string, string> = { fern: '#4f8f45', succulent: '#6aa36d', flower: '#d46a8c', palm: '#3f8a4a', ficus: '#4a7d3c', monstera: '#2f7a4f', bonsai: '#5b8a3a' };
const METAL = '#9aa3ad';
const DARK = '#3a3d42';
const POT = '#c9845c';
const SCREEN = '#5fa8ff';
const GLASS = '#bfe3f2';

/** Box helper in metres. */
function b(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, color: string, mat?: PartMaterial): Part {
  return mat ? { x0, x1, z0, z1, y0, y1, color, mat } : { x0, x1, z0, z1, y0, y1, color };
}

/** A seat facing `dir`, with its backrest on the opposite side, inside a w x d footprint. */
function seat(w: number, d: number, dir: string, color: string, seatY: number, backY: number, inset = 0.06): Part[] {
  const s = b(inset, inset, w - inset, d - inset, 0.18, seatY, color);
  const t = 0.1;
  const back: Record<string, Part> = {
    up: b(inset, d - inset - t, w - inset, d - inset, seatY, backY, color),
    down: b(inset, inset, w - inset, inset + t, seatY, backY, color),
    left: b(w - inset - t, inset, w - inset, d - inset, seatY, backY, color),
    right: b(inset, inset, inset + t, d - inset, seatY, backY, color),
  };
  return [b(w / 2 - 0.04, d / 2 - 0.04, w / 2 + 0.04, d / 2 + 0.04, 0, 0.18, DARK), s, back[dir] ?? back.down!];
}

/** A table top on a central post. */
function table(w: number, d: number, h: number, color: string, inset = 0.04): Part[] {
  return [b(inset, inset, w - inset, d - inset, h - 0.05, h, color), b(w / 2 - 0.05, d / 2 - 0.05, w / 2 + 0.05, d / 2 + 0.05, 0, h - 0.05, DARK)];
}

/** A plant: pot plus foliage. */
function plant(w: number, d: number, tall: boolean, variant: string | undefined): Part[] {
  const leaf = FOLIAGE[variant ?? ''] ?? '#4f8f45';
  const potH = tall ? 0.4 : 0.22;
  const r = tall ? 0.16 : 0.11;
  const cx = w / 2;
  const cz = d / 2;
  const parts = [b(cx - r, cz - r, cx + r, cz + r, 0, potH, POT)];
  if (tall) parts.push(b(cx - 0.2, cz - 0.2, cx + 0.2, cz + 0.2, potH, 1.25, leaf), b(cx - 0.13, cz - 0.13, cx + 0.13, cz + 0.13, 1.25, 1.65, leaf));
  else parts.push(b(cx - 0.15, cz - 0.15, cx + 0.15, cz + 0.15, potH, 0.48, leaf));
  return parts;
}

/**
 * The boxes of a furniture kind. Footprint-relative metres; `variant` picks colors or the facing. Unknown kinds get a
 * plain crate so nothing is ever invisible.
 */
export function furnitureParts(kind: FurnitureKind, variant?: string): Part[] {
  const fp = FURNITURE[kind].footprint;
  const w = fp.w * TILE_M;
  const d = Math.max(1, fp.h) * TILE_M;
  switch (kind) {
    case 'desk':
    case 'desk_back': {
      const top = WOOD[variant ?? 'wood'] ?? WOOD.wood!;
      // desk: the monitor sits at the back (north), facing south; desk_back: the other way round
      const mz0 = kind === 'desk' ? 0.06 : d - 0.12;
      const sz0 = kind === 'desk' ? mz0 + 0.04 : mz0 - 0.01;
      return [
        b(0.03, 0.03, w - 0.03, d - 0.03, 0.71, 0.75, top),
        b(0.05, 0.05, 0.1, d - 0.05, 0, 0.71, DARK),
        b(w - 0.1, 0.05, w - 0.05, d - 0.05, 0, 0.71, DARK),
        b(w / 2 - 0.3, mz0, w / 2 + 0.3, mz0 + 0.06, 0.8, 1.15, DARK),
        b(w / 2 - 0.27, sz0, w / 2 + 0.27, sz0 + 0.02, 0.83, 1.12, SCREEN, 'glow'),
        b(w / 2 - 0.04, mz0, w / 2 + 0.04, mz0 + 0.06, 0.75, 0.8, DARK),
      ];
    }
    case 'office_chair':
      return seat(w, d, 'up', CHAIR[variant ?? 'black'] ?? CHAIR.black!, 0.46, 0.95);
    case 'office_chair_front':
      return seat(w, d, 'down', CHAIR[variant ?? 'black'] ?? CHAIR.black!, 0.46, 0.95);
    case 'cafe_chair':
      return seat(w, d, variant ?? 'down', '#a8784f', 0.45, 0.85);
    case 'armchair':
      return seat(w, d, variant ?? 'down', '#5a7fa8', 0.42, 0.8, 0.02);
    case 'sofa':
      return [...seat(w, d, variant === 'up' ? 'up' : 'down', '#5d7895', 0.42, 0.8, 0.02), b(0, 0.02, 0.1, d - 0.02, 0.18, 0.6, '#55708c'), b(w - 0.1, 0.02, w, d - 0.02, 0.18, 0.6, '#55708c')];
    case 'bench':
      return [b(0.04, 0.12, w - 0.04, d - 0.08, 0.38, 0.45, '#b98a5e'), b(0.08, 0.2, 0.14, d - 0.15, 0, 0.38, DARK), b(w - 0.14, 0.2, w - 0.08, d - 0.15, 0, 0.38, DARK)];
    case 'stool':
      return [b(0.1, 0.1, w - 0.1, d - 0.1, 0.58, 0.64, '#3d4248'), b(w / 2 - 0.03, d / 2 - 0.03, w / 2 + 0.03, d / 2 + 0.03, 0, 0.58, METAL)];
    case 'beanbag':
      return [b(0.04, 0.04, w - 0.04, d - 0.04, 0, 0.3, BEANBAG[variant ?? 'red'] ?? BEANBAG.red!), b(0.1, 0.1, w - 0.1, d - 0.1, 0.3, 0.42, BEANBAG[variant ?? 'red'] ?? BEANBAG.red!)];
    case 'bookshelf':
      return [b(0.02, 0.02, w - 0.02, d - 0.15, 0, 1.8, '#8a6a4f'), b(0.08, d - 0.17, w - 0.08, d - 0.15, 0.2, 1.7, '#c95f4a'), b(0.08, d - 0.17, w / 2, d - 0.15, 0.95, 1.3, '#4a78b5')];
    case 'binder_shelf':
      return [b(0.04, 0.04, w - 0.04, d - 0.1, 0, 1.6, '#d9d6cf'), b(0.08, d - 0.12, w - 0.08, d - 0.1, 0.3, 1.5, '#e08a3c')];
    case 'filing_cabinet':
      return [b(0.05, 0.05, w - 0.05, d - 0.05, 0, 1.0, '#8d96a0')];
    case 'printer':
      return [b(0.04, 0.04, w - 0.04, d - 0.04, 0, 0.6, '#d9d6cf'), b(0.06, 0.06, w - 0.06, d - 0.06, 0.6, 0.9, '#eceae6')];
    case 'trash_bin':
      return [b(0.15, 0.15, w - 0.15, d - 0.15, 0, 0.35, '#7d858e')];
    case 'plant_small':
      return plant(w, d, false, variant);
    case 'plant_tall':
      return plant(w, d, true, variant);
    case 'glass_partition': {
      const v = variant ?? 'h';
      const base = v === 'v' ? b(w / 2 - 0.05, 0, w / 2 + 0.05, d, 0, 0.3, '#f2f2ef') : v === 'h' ? b(0, d / 2 - 0.05, w, d / 2 + 0.05, 0, 0.3, '#f2f2ef') : b(w / 2 - 0.08, d / 2 - 0.08, w / 2 + 0.08, d / 2 + 0.08, 0, 1.2, '#f2f2ef');
      const glass = v === 'v' ? b(w / 2 - 0.02, 0, w / 2 + 0.02, d, 0.3, 1.2, GLASS, 'glass') : v === 'h' ? b(0, d / 2 - 0.02, w, d / 2 + 0.02, 0.3, 1.2, GLASS, 'glass') : null;
      return glass ? [base, glass] : [base];
    }
    case 'meeting_table':
      return [b(0.08, 0.08, w - 0.08, d - 0.08, 0.71, 0.75, '#e9e6e0'), b(0.3, d / 2 - 0.1, w - 0.3, d / 2 + 0.1, 0, 0.71, DARK)];
    case 'cafe_table':
      return table(w, d, 0.75, '#e9e6e0', 0.08);
    case 'coffee_table':
      return table(w, d, 0.4, '#b98a5e', 0.06);
    case 'floor_lamp':
      return [b(w / 2 - 0.12, d / 2 - 0.12, w / 2 + 0.12, d / 2 + 0.12, 0, 0.04, DARK), b(w / 2 - 0.02, d / 2 - 0.02, w / 2 + 0.02, d / 2 + 0.02, 0.04, 1.5, DARK), b(w / 2 - 0.15, d / 2 - 0.15, w / 2 + 0.15, d / 2 + 0.15, 1.5, 1.75, '#fff1c9', 'glow')];
    case 'water_cooler':
      return [b(0.12, 0.12, w - 0.12, d - 0.12, 0, 0.95, '#e9ecef'), b(0.15, 0.15, w - 0.15, d - 0.15, 0.95, 1.35, '#7fb6e6', 'glass')];
    case 'counter':
      return [b(0, 0.02, w, d - 0.05, 0, 0.88, variant === 'drawers' ? '#d9d2c4' : '#e3ddd1'), b(0, 0.02, w, d - 0.02, 0.88, 0.92, '#bfb8ab')];
    case 'counter_sink':
    case 'sink':
      return [b(0, 0.02, w, d - 0.05, 0, 0.86, '#e3ddd1'), b(0, 0.02, w, d - 0.02, 0.86, 0.9, '#bfb8ab'), b(0.12, 0.1, w - 0.12, d - 0.15, 0.88, 0.91, '#9fb8c6')];
    case 'coffee_machine':
      return [b(0, 0.02, w, d - 0.05, 0, 0.88, '#e3ddd1'), b(0, 0.02, w, d - 0.02, 0.88, 0.92, '#bfb8ab'), b(0.1, 0.05, w - 0.1, d - 0.2, 0.92, 1.3, '#2f3236'), b(0.18, d - 0.21, w - 0.18, d - 0.19, 1.1, 1.22, '#ff9f43', 'glow')];
    case 'microwave':
      return [b(0, 0.02, w, d - 0.05, 0, 0.88, '#e3ddd1'), b(0, 0.02, w, d - 0.02, 0.88, 0.92, '#bfb8ab'), b(0.05, 0.05, w - 0.05, d - 0.15, 0.92, 1.2, '#cfd3d6')];
    case 'fridge':
      return [b(0.03, 0.03, w - 0.03, d - 0.05, 0, 1.9, '#e9ecef')];
    case 'vending_machine':
      return [b(0.03, 0.03, w - 0.03, d - 0.05, 0, 1.85, '#c0392b'), b(0.08, d - 0.07, w - 0.08, d - 0.05, 0.6, 1.7, '#ffe8a3', 'glow')];
    case 'pingpong_table':
      return [b(0.05, 0.1, w - 0.05, d - 0.1, 0.72, 0.76, '#2f7a4f'), b(w / 2 - 0.01, 0.1, w / 2 + 0.01, d - 0.1, 0.76, 0.9, '#f2f2ef'), b(0.3, d / 2 - 0.05, w - 0.3, d / 2 + 0.05, 0, 0.72, DARK)];
    case 'arcade':
      return [b(0.06, 0.06, w - 0.06, d - 0.06, 0, 1.75, '#4b3f8f'), b(0.1, d - 0.08, w - 0.1, d - 0.06, 1.05, 1.5, '#8de0ff', 'glow')];
    case 'toilet_stall':
      return [
        b(0, 0, 0.05, d, 0, 1.9, '#9fb8c6'),
        b(w - 0.05, 0, w, d, 0, 1.9, '#9fb8c6'),
        b(0, 0, w, 0.05, 0, 1.9, '#9fb8c6'),
        b(0.05, d - 0.05, w - 0.05, d, 0.15, 1.9, '#b9cfdb'),
        b(w / 2 - 0.2, 0.1, w / 2 + 0.2, 0.55, 0, 0.42, '#f4f6f7'),
      ];
    case 'reception_desk':
      return [b(0, 0.05, w, d - 0.05, 0, 1.05, '#8a6a4f'), b(0, 0, w, d, 1.05, 1.1, '#e9e6e0')];
    default:
      return [b(0.1, 0.1, w - 0.1, d - 0.1, 0, 0.5, '#b0a99f')];
  }
}

/** Height (m) of a wall item's centre, and its size (m) along and up the wall. */
export interface WallItemShape {
  y: number;
  h: number;
  color: string;
  mat?: PartMaterial;
  /** Shown on a cut wall too (low enough, or important). */
  low?: boolean;
}

export function wallItemShape(kind: FurnitureKind): WallItemShape | null {
  switch (kind) {
    case 'whiteboard':
      return { y: 1.45, h: 0.9, color: '#f7f7f4' };
    case 'window':
      return { y: 1.6, h: 1.1, color: '#cfe8f5', mat: 'glass' };
    case 'clock':
      return { y: 2.15, h: 0.32, color: '#f2f2ef' };
    case 'poster':
      return { y: 1.6, h: 0.6, color: '#e0a458' };
    case 'painting':
      return { y: 1.6, h: 0.7, color: '#6d8fb3' };
    case 'tv':
      return { y: 1.5, h: 0.65, color: '#1d2126', mat: 'glow' };
    case 'light_switch':
      return { y: 0.3, h: 0.12, color: '#f2f2ef', low: true };
    case 'elevator':
      return { y: 1.1, h: 2.2, color: '#b8c0c8' };
    case 'door_frame':
      return null;
    case 'sign':
      return { y: 2.35, h: 0.3, color: '#33373d' };
    case 'mirror':
      return { y: 1.5, h: 0.6, color: '#d9eef7', mat: 'glass' };
    case 'shelf_wall':
      return { y: 1.7, h: 0.1, color: '#b98a5e' };
    default:
      return { y: 1.5, h: 0.5, color: '#b0a99f' };
  }
}
