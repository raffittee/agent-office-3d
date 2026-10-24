// The procedural kit: each furniture kind as a few boxes (P2-06). Pure data, no three: building.ts turns the boxes
// into merged geometry. Theme packs (P4-02) recolor parts by role, pick a procedural alternative look, or replace a
// kind with a model (render3d/models.ts); a kind the pack leaves out falls back to the defaults here.
import type { KitRole, Procedural } from '../../../shared/theme';
import { FURNITURE, type FurnitureKind } from '../core/vocab';
import { TILE_M } from './units';

export type PartMaterial = 'solid' | 'glass' | 'glow';

/** How a theme restyles the kit (themes/look.ts builds one from a pack). */
export interface KitStyle {
  /** A theme color for a part role of a kind, or undefined to keep the kit's own. */
  color(kind: FurnitureKind, role: KitRole): string | undefined;
  /** A procedural alternative look for a kind. */
  procedural(kind: FurnitureKind): Procedural | undefined;
  /** A seasonal overlay (P6-07, themes/seasonal.ts) redraws plants as seasonal props. */
  season?: 'none' | 'halloween' | 'holiday';
}

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
  /** What the part is, so a theme can recolor it. */
  role?: KitRole;
  /** The color came from the room (a hex variant): themes don't override it. */
  fixed?: boolean;
}

const WOOD: Record<string, string> = { wood: '#b98a5e', white: '#e9e6e0', dark: '#4d4844' };
const CHAIR: Record<string, string> = { black: '#2f3236', blue: '#3d6fb6', red: '#c0463b', green: '#3f8f5b', gray: '#8a8f96' };
const BEANBAG: Record<string, string> = { red: '#d0543f', blue: '#4579c4', yellow: '#e7b53c', green: '#4f9e63' };
const FOLIAGE: Record<string, string> = { fern: '#4f8f45', succulent: '#6aa36d', flower: '#d46a8c', palm: '#3f8a4a', ficus: '#4a7d3c', monstera: '#2f7a4f', bonsai: '#5b8a3a' };
const METAL = '#9aa3ad';
const DARK = '#3a3d42';
const POT = '#c9845c';
const GLASS = '#bfe3f2';

/** Box helper in metres. The role defaults from the color: dark and metal parts are the frame, the rest the body. */
function b(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, color: string, mat?: PartMaterial, role?: KitRole): Part {
  const r: KitRole = role ?? (mat === 'glow' ? 'accent' : color === DARK || color === METAL ? 'frame' : 'body');
  return mat ? { x0, x1, z0, z1, y0, y1, color, mat, role: r } : { x0, x1, z0, z1, y0, y1, color, role: r };
}

/** Sets a role on parts (and marks them fixed when the color is the room's own). */
function as(role: KitRole, parts: Part[], fixed = false): Part[] {
  for (const p of parts) {
    if (p.role === 'frame' && role !== 'frame') continue;
    p.role = role;
    if (fixed) p.fixed = true;
  }
  return parts;
}

/** A variant that names a color directly (a theme's room variant: '#rrggbb'), or a named entry of a table. */
function variantColor(table: Record<string, string>, variant: string | undefined, fallback: string): { color: string; fixed: boolean } {
  if (variant && /^#[0-9a-f]{6}$/i.test(variant)) return { color: variant, fixed: true };
  return { color: table[variant ?? ''] ?? fallback, fixed: false };
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
  s.role = 'seat';
  const bk = back[dir] ?? back.down!;
  bk.role = 'seat';
  return [b(w / 2 - 0.04, d / 2 - 0.04, w / 2 + 0.04, d / 2 + 0.04, 0, 0.18, DARK), s, bk];
}

/** A table top on a central post. */
function table(w: number, d: number, h: number, color: string, inset = 0.04): Part[] {
  return [b(inset, inset, w - inset, d - inset, h - 0.05, h, color, undefined, 'top'), b(w / 2 - 0.05, d / 2 - 0.05, w / 2 + 0.05, d / 2 + 0.05, 0, h - 0.05, DARK)];
}

/** A plant: pot plus foliage. */
function plant(w: number, d: number, tall: boolean, variant: string | undefined): Part[] {
  const leaf = FOLIAGE[variant ?? ''] ?? '#4f8f45';
  const potH = tall ? 0.4 : 0.22;
  const r = tall ? 0.16 : 0.11;
  const cx = w / 2;
  const cz = d / 2;
  const parts = [b(cx - r, cz - r, cx + r, cz + r, 0, potH, POT, undefined, 'pot')];
  if (tall) parts.push(b(cx - 0.2, cz - 0.2, cx + 0.2, cz + 0.2, potH, 1.25, leaf, undefined, 'foliage'), b(cx - 0.13, cz - 0.13, cx + 0.13, cz + 0.13, 1.25, 1.65, leaf, undefined, 'foliage'));
  else parts.push(b(cx - 0.15, cz - 0.15, cx + 0.15, cz + 0.15, potH, 0.48, leaf, undefined, 'foliage'));
  return parts;
}

/** A small hash of a variant name, to vary the props. */
function pickOf(variant: string | undefined, n: number): number {
  let h = 7;
  for (const ch of variant ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

/** A jack-o'-lantern: a ribbed orange pumpkin with a stem and two glowing eyes facing south. */
function pumpkin(cx: number, cz: number, r: number, y0 = 0): Part[] {
  const h = r * 1.3;
  const o = '#e8792b';
  return [
    b(cx - r, cz - r * 0.8, cx + r, cz + r * 0.8, y0, y0 + h, o),
    b(cx - r * 0.8, cz - r, cx + r * 0.8, cz + r, y0 + h * 0.08, y0 + h * 0.92, '#d9661f'),
    b(cx - r * 0.12, cz - r * 0.12, cx + r * 0.12, cz + r * 0.12, y0 + h, y0 + h + r * 0.4, '#4f6b2a'),
    b(cx - r * 0.55, cz + r - 0.005, cx - r * 0.2, cz + r + 0.005, y0 + h * 0.55, y0 + h * 0.75, '#ffd25e', 'glow'),
    b(cx + r * 0.2, cz + r - 0.005, cx + r * 0.55, cz + r + 0.005, y0 + h * 0.55, y0 + h * 0.75, '#ffd25e', 'glow'),
    b(cx - r * 0.5, cz + r - 0.005, cx + r * 0.5, cz + r + 0.005, y0 + h * 0.22, y0 + h * 0.36, '#ffd25e', 'glow'),
  ];
}

/** Seasonal props for plants (P6-07): same footprint, so nothing about paths or spots changes. */
export function seasonalParts(season: 'halloween' | 'holiday', kind: FurnitureKind, variant: string | undefined, w: number, d: number): Part[] | null {
  if (kind !== 'plant_tall' && kind !== 'plant_small') return null;
  const cx = w / 2;
  const cz = d / 2;
  if (season === 'halloween') {
    if (kind === 'plant_small') return pumpkin(cx, cz, 0.13);
    if (pickOf(variant, 2) === 0) return [...pumpkin(cx, cz, 0.2), ...pumpkin(cx + 0.02, cz, 0.12, 0.26)];
    // a ghost: a white sheet that narrows upwards, with dark eyes
    const g = '#f4f2f8';
    return [
      b(cx - 0.2, cz - 0.18, cx + 0.2, cz + 0.18, 0, 0.7, g),
      b(cx - 0.16, cz - 0.15, cx + 0.16, cz + 0.15, 0.7, 1.05, g),
      b(cx - 0.11, cz - 0.11, cx + 0.11, cz + 0.11, 1.05, 1.2, g),
      b(cx - 0.1, cz + 0.145, cx - 0.04, cz + 0.155, 0.85, 0.95, '#2a2433'),
      b(cx + 0.04, cz + 0.145, cx + 0.1, cz + 0.155, 0.85, 0.95, '#2a2433'),
    ];
  }
  if (kind === 'plant_small') {
    // a gift: a box with a ribbon both ways and a bow
    const box = ['#c0392b', '#2e86c1', '#27ae60', '#8e44ad'][pickOf(variant, 4)]!;
    return [
      b(cx - 0.15, cz - 0.15, cx + 0.15, cz + 0.15, 0, 0.26, box),
      b(cx - 0.03, cz - 0.155, cx + 0.03, cz + 0.155, 0, 0.27, '#f1c40f'),
      b(cx - 0.155, cz - 0.03, cx + 0.155, cz + 0.03, 0, 0.27, '#f1c40f'),
      b(cx - 0.07, cz - 0.03, cx + 0.07, cz + 0.03, 0.27, 0.33, '#f1c40f'),
    ];
  }
  // a tree: a trunk, three tiers, a few lights and a star
  const green = '#2f6f3e';
  const parts = [
    b(cx - 0.05, cz - 0.05, cx + 0.05, cz + 0.05, 0, 0.2, '#6b4a2b'),
    b(cx - 0.23, cz - 0.23, cx + 0.23, cz + 0.23, 0.2, 0.65, green),
    b(cx - 0.17, cz - 0.17, cx + 0.17, cz + 0.17, 0.65, 1.05, '#357a45'),
    b(cx - 0.1, cz - 0.1, cx + 0.1, cz + 0.1, 1.05, 1.4, '#3b8a4c'),
    b(cx - 0.06, cz - 0.06, cx + 0.06, cz + 0.06, 1.4, 1.52, '#ffd84a', 'glow'),
  ];
  const lights = ['#ff5d5d', '#ffd84a', '#4aa3ff', '#ff8fc7'];
  [[-0.2, 0.4], [0.2, 0.5], [-0.14, 0.85], [0.14, 0.8], [-0.07, 1.2], [0.07, 1.25]].forEach(([dx, y], i) => {
    for (const s of [-1, 1]) {
      const z = cz + s * (Math.abs(dx!) + 0.025);
      parts.push(b(cx + dx! - 0.025, z - 0.02, cx + dx! + 0.025, z + 0.02, y!, y! + 0.05, lights[(i + (s > 0 ? 1 : 0)) % 4]!, 'glow'));
    }
  });
  return parts;
}

/** The monitor on a desk (its live screen is drawn by screens.ts, see deskScreen in screens-model.ts). */
function monitor(kind: FurnitureKind, w: number, d: number): Part[] {
  // desk: the monitor sits at the back (north), facing south; desk_back: the other way round
  const mz0 = kind === 'desk' ? 0.06 : d - 0.12;
  return as('screen', [b(w / 2 - 0.3, mz0, w / 2 + 0.3, mz0 + 0.06, 0.8, 1.15, DARK, undefined, 'screen'), b(w / 2 - 0.04, mz0, w / 2 + 0.04, mz0 + 0.06, 0.75, 0.8, DARK)]);
}

/** Procedural alternatives (FurnitureSpec.procedural). Returns null when the look doesn't apply to the kind. */
function alternative(look: Procedural, kind: FurnitureKind, variant: string | undefined, w: number, d: number): Part[] | null {
  const desk = kind === 'desk' || kind === 'desk_back';
  const top = variantColor(WOOD, variant, WOOD.wood!);
  switch (look) {
    case 'stool':
      // a backless stool for any seat that faces one way (office chairs, cafe chairs, armchairs)
      if (!FURNITURE[kind].seat || kind === 'sofa' || kind === 'bench') return null;
      return [
        ...as('seat', [b(0.12, 0.12, w - 0.12, d - 0.12, 0.6, 0.66, variantColor(CHAIR, variant, '#3d4248').color)], variantColor(CHAIR, variant, '').fixed),
        b(w / 2 - 0.03, d / 2 - 0.03, w / 2 + 0.03, d / 2 + 0.03, 0, 0.6, METAL),
        b(0.16, 0.16, w - 0.16, d - 0.16, 0.25, 0.28, METAL),
      ];
    case 'trestle': {
      // a wooden top on steel A-frame legs (desks and tables)
      if (!desk && !['meeting_table', 'cafe_table', 'coffee_table', 'reception_desk'].includes(kind)) return null;
      const h = kind === 'coffee_table' ? 0.4 : kind === 'reception_desk' ? 1.05 : 0.75;
      const parts = [
        ...as('top', [b(0.02, 0.02, w - 0.02, d - 0.02, h - 0.05, h, top.color)], top.fixed),
        b(0.08, 0.06, 0.12, d - 0.06, 0, h - 0.05, METAL),
        b(w - 0.12, 0.06, w - 0.08, d - 0.06, 0, h - 0.05, METAL),
        b(0.08, d / 2 - 0.02, w - 0.08, d / 2 + 0.02, 0.12, 0.16, METAL),
      ];
      return desk ? [...parts, ...monitor(kind, w, d)] : parts;
    }
    case 'cubicle': {
      // a desk inside low partition panels (back and sides, within the desk's own footprint)
      if (!desk) return null;
      const panel = '#8f98a3';
      const back = kind === 'desk' ? b(0, 0, w, 0.05, 0, 1.3, panel, undefined, 'body') : b(0, d - 0.05, w, d, 0, 1.3, panel, undefined, 'body');
      return [
        ...as('top', [b(0.05, 0.05, w - 0.05, d - 0.05, 0.71, 0.75, top.color)], top.fixed),
        back,
        b(0, 0, 0.05, d, 0, 1.15, panel, undefined, 'body'),
        b(w - 0.05, 0, w, d, 0, 1.15, panel, undefined, 'body'),
        b(0.1, 0.1, 0.45, d - 0.1, 0, 0.68, '#7d858e', undefined, 'frame'),
        ...monitor(kind, w, d),
      ];
    }
    case 'pallet': {
      // stacked shipping pallets (tables): slats on blocks
      if (!['meeting_table', 'cafe_table', 'coffee_table'].includes(kind) && !desk) return null;
      const h = kind === 'coffee_table' ? 0.4 : 0.75;
      const wood = top.fixed ? top.color : '#b8915e';
      const parts: Part[] = [];
      const layers = Math.max(2, Math.round(h / 0.14));
      for (let i = 0; i < layers; i++) {
        const y = (i * h) / layers;
        parts.push(b(0.04, 0.04, w - 0.04, d - 0.04, y + 0.07, y + h / layers - 0.005, wood, undefined, i === layers - 1 ? 'top' : 'body'));
        for (const fx of [0.06, w / 2 - 0.05, w - 0.16]) parts.push(b(fx, 0.06, fx + 0.1, d - 0.06, y, y + 0.07, '#9c7a4c', undefined, 'body'));
      }
      return desk ? [...parts, ...monitor(kind, w, d)] : parts;
    }
    case 'pipe-shelf': {
      // black pipe uprights and wooden boards (shelves)
      if (!['bookshelf', 'binder_shelf'].includes(kind)) return null;
      const h = kind === 'bookshelf' ? 1.8 : 1.6;
      const parts: Part[] = [];
      for (const x of [0.04, w - 0.08]) for (const z of [0.04, d - 0.2]) parts.push(b(x, z, x + 0.04, z + 0.04, 0, h, '#2b2d30', undefined, 'frame'));
      for (let i = 0; i < 4; i++) {
        const y = 0.25 + i * ((h - 0.3) / 3);
        parts.push(b(0.02, 0.02, w - 0.02, d - 0.15, y, y + 0.04, '#a77b4f', undefined, 'top'));
        if (i < 3) parts.push(b(0.1, 0.06, w * (0.4 + 0.15 * i), d - 0.2, y + 0.04, y + 0.3, ['#c95f4a', '#4a78b5', '#e0a458'][i]!, undefined, 'accent'));
      }
      return parts;
    }
    case 'tufted': {
      // a deep buttoned sofa or armchair with rolled arms (traditional)
      if (kind !== 'sofa' && kind !== 'armchair') return null;
      const dir = kind === 'sofa' ? (variant === 'up' ? 'up' : 'down') : (variant ?? 'down');
      const leather = '#6b3a2a';
      const parts = seat(w, d, dir, leather, 0.44, 0.9, 0.02);
      const vertical = dir === 'up' || dir === 'down';
      if (vertical) parts.push(b(0, 0.02, 0.14, d - 0.02, 0.18, 0.66, leather, undefined, 'seat'), b(w - 0.14, 0.02, w, d - 0.02, 0.18, 0.66, leather, undefined, 'seat'));
      else parts.push(b(0.02, 0, w - 0.02, 0.14, 0.18, 0.66, leather, undefined, 'seat'), b(0.02, d - 0.14, w - 0.02, d, 0.18, 0.66, leather, undefined, 'seat'));
      return parts;
    }
    case 'default':
      return null;
  }
}

/**
 * The boxes of a furniture kind. Footprint-relative metres; `variant` picks colors (a name, or '#rrggbb' from a theme's
 * room variant) or the facing; `style` is the theme. Unknown kinds get a plain crate so nothing is ever invisible.
 */
export function furnitureParts(kind: FurnitureKind, variant?: string, style?: KitStyle): Part[] {
  const fp = FURNITURE[kind].footprint;
  const w = fp.w * TILE_M;
  const d = Math.max(1, fp.h) * TILE_M;
  const seasonal = style?.season && style.season !== 'none' ? seasonalParts(style.season, kind, variant, w, d) : null;
  if (seasonal) return seasonal;
  const look = style?.procedural(kind);
  const parts = (look && alternative(look, kind, variant, w, d)) || defaultParts(kind, variant, w, d);
  if (style)
    for (const p of parts) {
      if (p.fixed || !p.role) continue;
      const c = style.color(kind, p.role);
      if (c) p.color = c;
    }
  return parts;
}

function defaultParts(kind: FurnitureKind, variant: string | undefined, w: number, d: number): Part[] {
  switch (kind) {
    case 'desk':
    case 'desk_back': {
      const top = variantColor(WOOD, variant, WOOD.wood!);
      return [
        ...as('top', [b(0.03, 0.03, w - 0.03, d - 0.03, 0.71, 0.75, top.color)], top.fixed),
        b(0.05, 0.05, 0.1, d - 0.05, 0, 0.71, DARK),
        b(w - 0.1, 0.05, w - 0.05, d - 0.05, 0, 0.71, DARK),
        ...monitor(kind, w, d),
      ];
    }
    case 'office_chair':
    case 'office_chair_front': {
      const c = variantColor(CHAIR, variant, CHAIR.black!);
      return as('seat', seat(w, d, kind === 'office_chair' ? 'up' : 'down', c.color, 0.46, 0.95), c.fixed);
    }
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
      return as('seat', [b(0.04, 0.04, w - 0.04, d - 0.04, 0, 0.3, BEANBAG[variant ?? 'red'] ?? BEANBAG.red!), b(0.1, 0.1, w - 0.1, d - 0.1, 0.3, 0.42, BEANBAG[variant ?? 'red'] ?? BEANBAG.red!)]);
    case 'bookshelf':
      return [b(0.02, 0.02, w - 0.02, d - 0.15, 0, 1.8, '#8a6a4f'), b(0.08, d - 0.17, w - 0.08, d - 0.15, 0.2, 1.7, '#c95f4a', undefined, 'accent'), b(0.08, d - 0.17, w / 2, d - 0.15, 0.95, 1.3, '#4a78b5', undefined, 'accent')];
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
      return [b(0.08, 0.08, w - 0.08, d - 0.08, 0.71, 0.75, '#e9e6e0', undefined, 'top'), b(0.3, d / 2 - 0.1, w - 0.3, d / 2 + 0.1, 0, 0.71, DARK)];
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
      return [b(0, 0.05, w, d - 0.05, 0, 1.05, '#8a6a4f'), b(0, 0, w, d, 1.05, 1.1, '#e9e6e0', undefined, 'top')];
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
