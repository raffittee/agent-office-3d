// The procedural kit: each furniture kind as a handful of shapes (P2-06, kit v2 in P10-05). Pure data, no three:
// building.ts turns the parts into merged geometry through kit-shapes.ts. A part is a box, a chamfered box, a cylinder
// or cone, a dome, a sphere or a tapered box, always inside its x/y/z extents, so a kind never leaves its footprint.
// Theme packs (P4-02) recolor parts by role, pick a procedural alternative look, or replace a kind with a model
// (render3d/models.ts); a kind the pack leaves out falls back to the defaults here.
import { mulberry32 } from '../../../shared/hash';
import type { KitRole, Procedural } from '../../../shared/theme';
import { FURNITURE, type FurnitureKind } from '../core/vocab';
import { TILE_M } from './units';

export type PartMaterial = 'solid' | 'glass' | 'glow';

/**
 * What a part looks like inside its extents (kit-shapes.ts draws them):
 * `box` (the default), `bevel` (chamfered top edges, `k` = the chamfer in m), `taper` (the top is `k` times the base,
 * default 0.7), `cyl` (an ellipse inscribed in the x/z extents; `k` = top radius over base radius, a cone for a small
 * `k`, wider at the top above 1), `dome` (the upper half of an ellipsoid) and `sphere`.
 */
export type PartShape = 'box' | 'bevel' | 'taper' | 'cyl' | 'dome' | 'sphere';

export interface KitStyle {
  /** A theme color for a part role of a kind, or undefined to keep the kit's own. */
  color(kind: FurnitureKind, role: KitRole): string | undefined;
  /** A procedural alternative look for a kind. */
  procedural(kind: FurnitureKind): Procedural | undefined;
  /** A seasonal overlay (P6-07, themes/seasonal.ts) redraws plants as seasonal props. */
  season?: 'none' | 'halloween' | 'holiday';
}

/** A part in metres: x/z relative to the footprint's top-left corner (+z = south), y up from the floor. */
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
  /** The shape inside the extents (a box when absent). */
  shape?: PartShape;
  /** Shape parameter, see PartShape. */
  k?: number;
  /** Points around a round shape (default 10). */
  seg?: number;
  /** Brightness relative to `color` (it survives theme recoloring: cushions, drawer fronts, buttons). */
  tone?: number;
}

const WOOD: Record<string, string> = { wood: '#b98a5e', white: '#e9e6e0', dark: '#4d4844' };
const CHAIR: Record<string, string> = { black: '#3a3e45', blue: '#3d6fb6', red: '#c0463b', green: '#3f8f5b', gray: '#8a8f96' };
const BEANBAG: Record<string, string> = { red: '#d0543f', blue: '#4579c4', yellow: '#e7b53c', green: '#4f9e63' };
const FOLIAGE: Record<string, string> = { fern: '#4f8f45', succulent: '#6aa36d', flower: '#d46a8c', palm: '#3f8a4a', ficus: '#4a7d3c', monstera: '#2f7a4f', bonsai: '#5b8a3a' };
const METAL = '#9aa3ad';
const DARK = '#3a3d42';
const POT = '#c9845c';
const GLASS = '#bfe3f2';
const PAPER = '#f4f1ea';
const KEYS = '#3a3f47';
const BOOKS = ['#c95f4a', '#4a78b5', '#e0a458', '#5a8f6a', '#8a5aa8', '#d9d6cf', '#3d4a5c', '#b84a6a'];
const MUGS = ['#f2f2ef', '#e07a5f', '#4a78b5', '#f2c14e'];

interface Opts {
  mat?: PartMaterial;
  role?: KitRole;
  fixed?: boolean;
  tone?: number;
  seg?: number;
  /** A cylinder's z radius, when it isn't round. */
  rz?: number;
}

/** Details: small things whose color is theirs (keyboards, handles, books): themes leave them alone. */
const D: Opts = { role: 'accent', fixed: true };

/** The role of a part that names none: glow is an accent, dark and metal parts the frame, the rest the body. */
function roleOf(color: string, o: Opts | undefined): KitRole {
  return o?.role ?? (o?.mat === 'glow' ? 'accent' : color === DARK || color === METAL ? 'frame' : 'body');
}

function make(shape: PartShape | undefined, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, color: string, k: number | undefined, o?: Opts): Part {
  const p: Part = { x0, x1, z0, z1, y0, y1, color, role: roleOf(color, o) };
  if (o?.mat) p.mat = o.mat;
  if (shape && shape !== 'box') p.shape = shape;
  if (k !== undefined) p.k = k;
  if (o?.seg) p.seg = o.seg;
  if (o?.tone !== undefined) p.tone = o.tone;
  if (o?.fixed || p.role === 'accent') p.fixed = true;
  return p;
}

/** Box helper in metres. The role defaults from the color: dark and metal parts are the frame, the rest the body. */
function b(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, color: string, mat?: PartMaterial, role?: KitRole): Part {
  return make('box', x0, z0, x1, z1, y0, y1, color, undefined, { mat, role });
}

/** A box with chamfered top edges (`r` metres). */
function bv(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, color: string, r = 0.012, o?: Opts): Part {
  return make('bevel', x0, z0, x1, z1, y0, y1, color, r, o);
}

/** A box whose top is `k` times its base. */
function tp(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, color: string, k = 0.7, o?: Opts): Part {
  return make('taper', x0, z0, x1, z1, y0, y1, color, k, o);
}

/** A cylinder (a cone for a small `k`, wider at the top above 1) centred on (cx, cz). */
function cy(cx: number, cz: number, r: number, y0: number, y1: number, color: string, k = 1, o?: Opts): Part {
  const rz = o?.rz ?? r;
  return make('cyl', cx - r, cz - rz, cx + r, cz + rz, y0, y1, color, k, o);
}

/** The upper half of an ellipsoid. */
function dm(cx: number, cz: number, r: number, y0: number, y1: number, color: string, o?: Opts): Part {
  return make('dome', cx - r, cz - (o?.rz ?? r), cx + r, cz + (o?.rz ?? r), y0, y1, color, undefined, o);
}

/** An ellipsoid. */
function sp(cx: number, cz: number, r: number, y0: number, y1: number, color: string, o?: Opts): Part {
  return make('sphere', cx - r, cz - (o?.rz ?? r), cx + r, cz + (o?.rz ?? r), y0, y1, color, undefined, o);
}

/** Sets a role on parts (and marks them fixed when the color is the room's own). */
function as(role: KitRole, parts: Part[], fixed = false): Part[] {
  for (const p of parts) {
    if (p.role === 'frame' && role !== 'frame') continue;
    if (p.fixed && p.role === 'accent') continue;
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

/** Mirrors parts north-south inside a footprint of depth d. */
function flipZ(parts: Part[], d: number): Part[] {
  return parts.map((p) => ({ ...p, z0: d - p.z1, z1: d - p.z0 }));
}

/** Turns parts drawn for a sitter facing south ('down') to face another way (the footprint is square except for sofas). */
function facing(parts: Part[], dir: string, w: number, d: number): Part[] {
  switch (dir) {
    case 'up':
      return flipZ(parts, d);
    case 'right':
      return parts.map((p) => ({ ...p, x0: p.z0, x1: p.z1, z0: p.x0, z1: p.x1 }));
    case 'left':
      return parts.map((p) => ({ ...p, x0: w - p.z1, x1: w - p.z0, z0: p.x0, z1: p.x1 }));
    default:
      return parts;
  }
}

/** A table top on a round pedestal. */
function pedestalTable(w: number, d: number, h: number, color: string, round: boolean, inset = 0.04): Part[] {
  const cx = w / 2;
  const cz = d / 2;
  const top = round
    ? cy(cx, cz, Math.min(w, d) / 2 - inset, h - 0.035, h, color, 1, { role: 'top', seg: 14, rz: Math.min(w, d) / 2 - inset })
    : bv(inset, inset, w - inset, d - inset, h - 0.04, h, color, 0.012, { role: 'top' });
  return [top, cy(cx, cz, 0.025, 0.035, h - 0.035, DARK), cy(cx, cz, 0.14, 0, 0.035, DARK, 0.75)];
}

/** A hash of a variant name, to vary the props. */
function pickOf(variant: string | undefined, n: number): number {
  let h = 7;
  for (const ch of variant ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

/** Rows of books standing on a shelf at height y, in runs of one color (a run reads as a few books side by side). */
function books(out: Part[], x0: number, x1: number, z0: number, z1: number, y: number, maxH: number, seed: number, palette = BOOKS): void {
  const r = mulberry32(seed);
  let x = x0;
  while (x < x1 - 0.04) {
    const wd = 0.07 + r() * 0.09;
    if (x + wd > x1) break;
    const h = maxH * (0.6 + r() * 0.4);
    out.push(b(x, z0, x + wd, z1, y, y + h, palette[Math.floor(r() * palette.length)]!, undefined, 'accent'));
    x += wd + (r() < 0.22 ? 0.04 + r() * 0.06 : 0.003);
  }
}

/** A plant: a round pot of soil, a trunk and layered blobs of leaves, per variant. */
function plant(w: number, d: number, tall: boolean, variant: string | undefined): Part[] {
  const leaf = FOLIAGE[variant ?? ''] ?? '#4f8f45';
  const cx = w / 2;
  const cz = d / 2;
  const f = (dx: number, dz: number, r: number, y0: number, y1: number, tone = 1, rz?: number): Part => sp(cx + dx, cz + dz, r, y0, y1, leaf, { role: 'foliage', tone, seg: 8, rz });
  const trunk = (r: number, y0: number, y1: number): Part => cy(cx, cz, r, y0, y1, '#7a5b3a', 1, { ...D, seg: 6 });
  if (tall) {
    const potH = 0.38;
    const parts: Part[] = [cy(cx, cz, 0.16, 0, potH, POT, 1.22, { role: 'pot', seg: 12 })];
    switch (variant) {
      case 'palm':
        parts.push(trunk(0.022, potH, 1.18));
        for (const [dx, dz] of [[0.12, 0], [-0.12, 0], [0, 0.12], [0, -0.12]] as const) parts.push(f(dx, dz, 0.12, 1.08, 1.26, 0.92));
        parts.push(f(0, 0, 0.13, 1.18, 1.62, 1.1), f(0.07, 0.07, 0.09, 0.9, 1.1, 0.85), f(-0.07, -0.06, 0.09, 0.88, 1.08, 0.95));
        break;
      case 'monstera':
        parts.push(f(0, 0, 0.21, 0.4, 0.82, 0.95, 0.2), f(-0.1, -0.08, 0.13, 0.7, 1.05, 1.1), f(0.11, 0.06, 0.12, 0.66, 1.0, 1), f(0.04, -0.13, 0.1, 0.85, 1.2, 1.15), f(-0.07, 0.11, 0.09, 0.9, 1.25, 0.9));
        break;
      case 'bonsai':
        parts.push(trunk(0.03, potH, 0.82));
        parts.push(f(0, 0, 0.17, 0.74, 0.96, 1), f(-0.11, 0.05, 0.1, 0.66, 0.84, 0.9), f(0.11, -0.03, 0.1, 0.8, 1.0, 1.1), f(0.02, 0.1, 0.07, 0.9, 1.08, 1.15));
        break;
      default:
        parts.push(trunk(0.025, potH, 0.85));
        parts.push(f(0, 0, 0.2, 0.62, 1.14, 1), f(-0.06, 0.05, 0.15, 1.0, 1.46, 1.1), f(0.07, -0.04, 0.12, 1.28, 1.64, 0.95), f(0.12, 0.09, 0.1, 0.78, 1.06, 1.12));
    }
    return parts;
  }
  const potH = 0.22;
  const parts: Part[] = [cy(cx, cz, 0.11, 0, potH, POT, 1.2, { role: 'pot', seg: 10 })];
  switch (variant) {
    case 'succulent':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        parts.push(cy(cx + Math.cos(a) * 0.06, cz + Math.sin(a) * 0.06, 0.035, potH, potH + 0.1, leaf, 0.25, { role: 'foliage', seg: 6, tone: 0.92 + (i % 2) * 0.16 }));
      }
      parts.push(cy(cx, cz, 0.04, potH, potH + 0.16, leaf, 0.2, { role: 'foliage', seg: 6, tone: 1.1 }));
      break;
    case 'flower': {
      const g = FOLIAGE.fern!;
      parts.push(dm(cx, cz, 0.14, potH, potH + 0.13, g, { role: 'foliage', seg: 8 }));
      for (const [dx, dz, y] of [[0, 0, 0.3], [-0.07, 0.04, 0.27], [0.07, -0.03, 0.28], [0.03, 0.08, 0.26]] as const) parts.push(sp(cx + dx, cz + dz, 0.035, y, y + 0.06, leaf, { ...D, seg: 6 }));
      break;
    }
    default:
      parts.push(dm(cx, cz, 0.15, potH, potH + 0.17, leaf, { role: 'foliage', seg: 8 }));
      for (const [dx, dz, s] of [[0, 0, 1.15], [-0.08, 0.06, 0.95], [0.08, -0.05, 1.05]] as const)
        parts.push(cy(cx + dx, cz + dz, 0.035, potH + 0.1, potH + 0.26 * s, leaf, 0.15, { role: 'foliage', seg: 6, tone: 1.12 }));
  }
  return parts;
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

// ---- desks

/** The monitor on a desk, drawn for the `desk` (north edge, facing south); the screen itself is drawn by screens.ts. */
function monitor(w: number): Part[] {
  const mz0 = 0.06;
  const mc = mz0 + 0.03;
  return as('screen', [
    bv(w / 2 - 0.3, mz0, w / 2 + 0.3, mz0 + 0.06, 0.8, 1.15, DARK, 0.01, { role: 'screen' }),
    tp(w / 2 - 0.13, mz0 - 0.04, w / 2 + 0.13, mz0, 0.86, 1.1, DARK, 0.6),
    b(w / 2 - 0.025, mz0 + 0.01, w / 2 + 0.025, mz0 + 0.05, 0.765, 0.8, DARK),
    bv(w / 2 - 0.1, mc - 0.07, w / 2 + 0.1, mc + 0.07, 0.75, 0.765, DARK, 0.006),
  ]);
}

/** Keyboard, mouse and a mug (or a lamp, or a notebook) on a desk top at height y, for the `desk` side. */
function deskProps(w: number, d: number, y: number, variant: string | undefined): Part[] {
  const mug = MUGS[pickOf(variant, MUGS.length)]!;
  const parts: Part[] = [
    bv(w / 2 - 0.14, 0.25, w / 2 + 0.14, 0.36, y, y + 0.012, KEYS, 0.004, D),
    bv(w / 2 + 0.2, 0.26, w / 2 + 0.245, 0.325, y, y + 0.016, '#2d3036', 0.008, D),
    cy(w - 0.1, 0.13, 0.028, y, y + 0.065, mug, 1, { ...D, seg: 8 }),
  ];
  if (variant === 'white') {
    // a small desk lamp: weighted base, a thin arm and a conical head
    parts.push(cy(0.1, 0.12, 0.03, y, y + 0.012, DARK, 1, { ...D, seg: 8 }), b(0.097, 0.117, 0.107, 0.127, y + 0.012, y + 0.2, METAL, undefined, 'accent'), cy(0.105, 0.14, 0.045, y + 0.17, y + 0.215, '#e8e4da', 0.55, { ...D, seg: 8 }));
  } else {
    parts.push(bv(0.07, 0.2, 0.19, 0.38, y, y + 0.008, PAPER, 0.003, D), b(0.1, 0.24, 0.17, 0.26, y + 0.008, y + 0.011, '#5a6b8a', undefined, 'accent'));
  }
  void d;
  return parts;
}

/** Drawer fronts on a pedestal, facing +z at plane zf, between x0..x1 and y0..y1. */
function drawers(x0: number, x1: number, zf: number, y0: number, y1: number, color: string, n = 3): Part[] {
  const out: Part[] = [];
  const hh = (y1 - y0) / n;
  for (let i = 0; i < n; i++) {
    const ya = y0 + i * hh + 0.006;
    const yb = y0 + (i + 1) * hh - 0.006;
    out.push(bv(x0 + 0.006, zf - 0.006, x1 - 0.006, zf + 0.003, ya, yb, color, 0.004, { role: 'top', tone: 1.05 }));
    out.push(b((x0 + x1) / 2 - 0.035, zf + 0.003, (x0 + x1) / 2 + 0.035, zf + 0.011, (ya + yb) / 2 + 0.005, (ya + yb) / 2 + 0.014, METAL, undefined, 'accent'));
  }
  return out;
}

/** A whole desk drawn for the `desk` side (monitor north, sitter south); `desk_back` mirrors it. */
function deskParts(w: number, d: number, variant: string | undefined, top: { color: string; fixed: boolean }): Part[] {
  const px0 = w - 0.27;
  const px1 = w - 0.09;
  return [
    ...as('top', [bv(0.02, 0.02, w - 0.02, d - 0.02, 0.715, 0.75, top.color, 0.012)], top.fixed),
    // two side panels, a modesty panel, and a drawer pedestal under the right half
    bv(0.06, 0.05, 0.1, d - 0.05, 0, 0.715, DARK, 0.006),
    bv(w - 0.1, 0.05, w - 0.06, d - 0.05, 0, 0.715, DARK, 0.006),
    b(0.1, 0.05, w - 0.1, 0.07, 0.3, 0.7, DARK),
    ...as('top', [bv(px0, 0.07, px1, d - 0.07, 0.04, 0.715, top.color, 0.006, { tone: 0.82 })], top.fixed),
    ...as('top', drawers(px0, px1, d - 0.07, 0.04, 0.715, top.color), top.fixed),
    ...monitor(w),
    ...deskProps(w, d, 0.75, variant),
  ];
}

/** Procedural alternatives (FurnitureSpec.procedural). Returns null when the look doesn't apply to the kind. */
function alternative(look: Procedural, kind: FurnitureKind, variant: string | undefined, w: number, d: number): Part[] | null {
  const desk = kind === 'desk' || kind === 'desk_back';
  const top = variantColor(WOOD, variant, WOOD.wood!);
  const finish = (parts: Part[]): Part[] => (kind === 'desk_back' ? flipZ(parts, d) : parts);
  switch (look) {
    case 'stool':
      // a backless stool for any seat that faces one way (office chairs, cafe chairs, armchairs)
      if (!FURNITURE[kind].seat || kind === 'sofa' || kind === 'bench') return null;
      return [
        ...as('seat', [cy(w / 2, d / 2, Math.min(w, d) / 2 - 0.1, 0.6, 0.66, variantColor(CHAIR, variant, '#3d4248').color, 1, { seg: 12 })], variantColor(CHAIR, variant, '').fixed),
        cy(w / 2, d / 2, 0.03, 0.04, 0.6, METAL, 1, { seg: 8 }),
        cy(w / 2, d / 2, 0.15, 0, 0.04, METAL, 0.8, { seg: 10 }),
        cy(w / 2, d / 2, 0.12, 0.25, 0.275, METAL, 1, { seg: 10 }),
      ];
    case 'trestle': {
      // a wooden top on steel A-frame legs (desks and tables)
      if (!desk && !['meeting_table', 'cafe_table', 'coffee_table', 'reception_desk'].includes(kind)) return null;
      const h = kind === 'coffee_table' ? 0.4 : kind === 'reception_desk' ? 1.05 : 0.75;
      const parts: Part[] = [...as('top', [bv(0.02, 0.02, w - 0.02, d - 0.02, h - 0.05, h, top.color, 0.012)], top.fixed)];
      for (const x of [0.08, w - 0.115]) for (const z of [0.08, d - 0.115]) parts.push(bv(x, z, x + 0.035, z + 0.035, 0, h - 0.05, METAL, 0.004));
      parts.push(b(0.08, 0.1, 0.115, d - 0.1, 0.11, 0.14, METAL), b(w - 0.115, 0.1, w - 0.08, d - 0.1, 0.11, 0.14, METAL), b(0.1, d / 2 - 0.015, w - 0.1, d / 2 + 0.015, 0.11, 0.14, METAL));
      return desk ? finish([...parts, ...monitor(w), ...deskProps(w, d, 0.75, variant)]) : parts;
    }
    case 'cubicle': {
      // a desk inside low partition panels (back and sides, within the desk's own footprint)
      if (!desk) return null;
      const panel = '#8f98a3';
      const parts: Part[] = [
        ...as('top', [bv(0.05, 0.05, w - 0.05, d - 0.05, 0.71, 0.75, top.color, 0.01)], top.fixed),
        bv(0, 0, w, 0.05, 0, 1.3, panel, 0.015, { role: 'body' }),
        bv(0, 0, 0.05, d, 0, 1.15, panel, 0.012, { role: 'body' }),
        bv(w - 0.05, 0, w, d, 0, 1.15, panel, 0.012, { role: 'body' }),
        // a trim along the top of the back panel, and notes pinned to it
        b(0, 0, w, 0.05, 1.3, 1.315, DARK),
        b(0.12, 0.05, 0.24, 0.054, 0.95, 1.07, PAPER, undefined, 'accent'),
        b(0.3, 0.05, 0.4, 0.054, 1.02, 1.12, '#f2c14e', undefined, 'accent'),
        b(w - 0.3, 0.05, w - 0.16, 0.054, 0.9, 1.04, '#8dc0e0', undefined, 'accent'),
        bv(0.1, 0.1, 0.45, d - 0.1, 0, 0.68, '#7d858e', 0.006, { role: 'frame' }),
        ...monitor(w),
        ...deskProps(w, d, 0.75, variant),
      ];
      return finish(parts);
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
        parts.push(bv(0.04, 0.04, w - 0.04, d - 0.04, y + 0.07, y + h / layers - 0.005, wood, 0.006, { role: i === layers - 1 ? 'top' : 'body' }));
        for (const fx of [0.06, w / 2 - 0.05, w - 0.16]) parts.push(b(fx, 0.06, fx + 0.1, d - 0.06, y, y + 0.07, '#9c7a4c', undefined, 'body'));
      }
      return desk ? finish([...parts, ...monitor(w), ...deskProps(w, d, 0.75, variant)]) : parts;
    }
    case 'pipe-shelf': {
      // black pipe uprights and wooden boards (shelves)
      if (!['bookshelf', 'binder_shelf'].includes(kind)) return null;
      const h = kind === 'bookshelf' ? 1.8 : 1.6;
      const parts: Part[] = [];
      for (const x of [0.04, w - 0.08]) for (const z of [0.04, d - 0.2]) parts.push(cy(x + 0.02, z + 0.02, 0.02, 0, h, '#2b2d30', 1, { role: 'frame', seg: 6 }));
      for (let i = 0; i < 4; i++) {
        const y = 0.25 + i * ((h - 0.3) / 3);
        parts.push(bv(0.02, 0.02, w - 0.02, d - 0.15, y, y + 0.04, '#a77b4f', 0.008, { role: 'top' }));
        if (i < 3) {
          const shelf: Part[] = [];
          books(shelf, 0.07, w * (0.45 + 0.15 * i), 0.06, d - 0.2, y + 0.04, kind === 'bookshelf' ? 0.3 : 0.26, 11 + i * 7 + w * 100, [['#c95f4a', '#4a78b5', '#e0a458'][i]!, '#d9d6cf', '#3d4a5c']);
          parts.push(...shelf);
        }
      }
      return parts;
    }
    case 'tufted': {
      // a deep buttoned sofa or armchair with rolled arms (traditional)
      if (kind !== 'sofa' && kind !== 'armchair') return null;
      const dir = kind === 'sofa' ? (variant === 'up' ? 'up' : 'down') : (variant ?? 'down');
      return facing(upholstered(w, d, '#6b3a2a', { seatY: 0.44, backY: 0.9, arm: kind === 'sofa' ? 0.14 : 0.1, rolled: true, tufted: true }), dir, w, d);
    }
    case 'default':
      return null;
  }
}

/**
 * Upholstered seating drawn for a sitter facing south: a plinth on short feet, side arms, a thick back and one seat and
 * back cushion per half metre. The sitter's seat height is `seatY`.
 */
function upholstered(w: number, d: number, color: string, o: { seatY: number; backY: number; arm: number; rolled?: boolean; tufted?: boolean }): Part[] {
  const { seatY, backY, arm } = o;
  const s = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, r: number, tone = 1): Part => bv(x0, z0, x1, z1, y0, y1, color, r, { role: 'seat', tone });
  const bt = 0.14;
  const front = d - 0.02;
  const parts: Part[] = [];
  for (const x of [0.05, w - 0.09]) for (const z of [0.07, front - 0.06]) parts.push(b(x, z, x + 0.04, z + 0.04, 0, 0.07, DARK));
  parts.push(s(0, 0.03, w, front, 0.07, seatY - 0.17, 0.02, 0.78));
  parts.push(s(0, 0.03, arm, front, 0.07, o.rolled ? 0.62 : 0.58, o.rolled ? 0.06 : 0.035, 0.92));
  parts.push(s(w - arm, 0.03, w, front, 0.07, o.rolled ? 0.62 : 0.58, o.rolled ? 0.06 : 0.035, 0.92));
  parts.push(s(arm * 0.6, 0.03, w - arm * 0.6, 0.03 + bt, 0.07, backY, 0.04, 0.88));
  const n = Math.max(1, Math.round((w - 2 * arm) / 0.5));
  const cw = (w - 2 * arm) / n;
  for (let i = 0; i < n; i++) {
    const x0 = arm + i * cw + 0.004;
    const x1 = arm + (i + 1) * cw - 0.004;
    parts.push(s(x0, 0.03 + bt, x1, front, seatY - 0.17, seatY, 0.035, 1.06));
    parts.push(s(x0 + 0.01, 0.03 + bt, x1 - 0.01, 0.03 + bt + 0.1, seatY, backY - 0.05, 0.04, 1.1));
    if (o.tufted)
      for (const [u, y] of [[0.3, 0.5], [0.7, 0.5], [0.5, 0.68], [0.5, 0.58]] as const)
        if (y < backY - 0.1) parts.push(bv(x0 + (x1 - x0) * u - 0.012, 0.03 + bt + 0.1, x0 + (x1 - x0) * u + 0.012, 0.03 + bt + 0.108, seatY + (y - 0.4) * 0.55, seatY + (y - 0.4) * 0.55 + 0.024, color, 0.004, { role: 'seat', tone: 0.45 }));
  }
  return parts;
}

/** An office chair drawn for a sitter facing south: a four-armed base on casters, a gas lift, seat, backrest and arms. */
function officeChair(w: number, d: number, color: string): Part[] {
  const cx = w / 2;
  const cz = d / 2 + 0.02;
  const parts: Part[] = [
    b(cx - 0.19, cz - 0.016, cx + 0.19, cz + 0.016, 0.045, 0.08, METAL),
    b(cx - 0.016, cz - 0.19, cx + 0.016, cz + 0.19, 0.045, 0.08, METAL),
    cy(cx, cz, 0.04, 0.08, 0.13, DARK, 0.8, { seg: 8 }),
    cy(cx, cz, 0.02, 0.13, 0.36, METAL, 1, { seg: 6 }),
  ];
  for (const [dx, dz] of [[-0.19, 0], [0.19, 0], [0, -0.19], [0, 0.19]] as const) parts.push(cy(cx + dx, cz + dz, 0.022, 0, 0.05, DARK, 1, { seg: 6 }));
  parts.push(bv(cx - 0.1, cz - 0.1, cx + 0.1, cz + 0.1, 0.36, 0.39, DARK, 0.01));
  parts.push(bv(0.06, 0.12, w - 0.06, d - 0.06, 0.39, 0.46, color, 0.025, { role: 'seat' }));
  // backrest on a short stem, at the north edge
  parts.push(b(cx - 0.03, 0.07, cx + 0.03, 0.12, 0.39, 0.6, DARK));
  parts.push(bv(0.08, 0.03, w - 0.08, 0.1, 0.5, 0.95, color, 0.03, { role: 'seat', tone: 1.04 }));
  // armrests
  for (const x of [0.04, w - 0.09]) {
    parts.push(b(x + 0.01, 0.25, x + 0.04, 0.29, 0.42, 0.6, DARK));
    parts.push(bv(x, 0.19, x + 0.05, 0.39, 0.6, 0.63, DARK, 0.008));
  }
  return parts;
}

/** A wooden cafe chair drawn for a sitter facing south. */
function cafeChair(w: number, d: number, color: string): Part[] {
  const parts: Part[] = [];
  for (const x of [0.07, w - 0.11]) for (const z of [0.07, d - 0.11]) parts.push(bv(x, z, x + 0.04, z + 0.04, 0, 0.42, color, 0.004, { role: 'seat', tone: 0.85 }));
  parts.push(bv(0.05, 0.05, w - 0.05, d - 0.05, 0.39, 0.45, color, 0.012, { role: 'seat' }));
  // back: two posts, a top rail and a slat
  for (const x of [0.07, w - 0.11]) parts.push(bv(x, 0.06, x + 0.04, 0.1, 0.45, 0.86, color, 0.006, { role: 'seat', tone: 0.85 }));
  parts.push(bv(0.07, 0.055, w - 0.07, 0.105, 0.72, 0.86, color, 0.01, { role: 'seat' }));
  parts.push(b(0.11, 0.065, w - 0.11, 0.095, 0.52, 0.6, color, undefined, 'seat'));
  return parts;
}

// ---- kitchen

/** A base cabinet with a worktop (height 0.92), doors or drawers on its south face. */
function cabinet(w: number, d: number, body: string, drawerFronts: boolean): Part[] {
  const zf = d - 0.05;
  const parts: Part[] = [b(0.03, 0.06, w - 0.03, d - 0.1, 0, 0.08, DARK), bv(0, 0.02, w, zf, 0.08, 0.88, body, 0.006)];
  if (drawerFronts) {
    for (const [ya, yb] of [[0.58, 0.85], [0.35, 0.57], [0.12, 0.34]] as const) {
      parts.push(bv(0.03, zf - 0.004, w - 0.03, zf + 0.004, ya, yb, body, 0.004, { tone: 1.05 }));
      parts.push(b(w / 2 - 0.07, zf + 0.004, w / 2 + 0.07, zf + 0.012, yb - 0.05, yb - 0.04, METAL, undefined, 'accent'));
    }
  } else {
    parts.push(bv(0.03, zf - 0.004, w - 0.03, zf + 0.004, 0.12, 0.85, body, 0.004, { tone: 1.05 }));
    parts.push(b(w - 0.1, zf + 0.004, w - 0.085, zf + 0.012, 0.55, 0.75, METAL, undefined, 'accent'));
  }
  parts.push(bv(0, 0.01, w, d - 0.02, 0.88, 0.92, '#bfb8ab', 0.01, { role: 'top' }));
  return parts;
}

/** Procedural parts, plus the soft contact shadow that grounds the kind on the floor. */
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
  const shadow = contactShadow(kind, parts, w, d);
  return shadow ? [...parts, shadow] : parts;
}

const ROUND_BASE: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>(['stool', 'floor_lamp', 'trash_bin', 'plant_small', 'plant_tall', 'cafe_table', 'beanbag', 'office_chair', 'office_chair_front']);

/** A soft dark patch on the floor under (and a hand's width around) what stands on it: baked ambient occlusion. */
function contactShadow(kind: FurnitureKind, parts: Part[], w: number, d: number): Part | null {
  if (FURNITURE[kind].mount !== 'floor' || kind === 'glass_partition') return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of parts) {
    if (p.y0 > 0.05 || (p.mat && p.mat !== 'solid')) continue;
    x0 = Math.min(x0, p.x0);
    x1 = Math.max(x1, p.x1);
    z0 = Math.min(z0, p.z0);
    z1 = Math.max(z1, p.z1);
  }
  if (!(x1 > x0)) return null;
  const pad = 0.02;
  const shadow: Part = {
    x0: Math.max(0, x0 - pad),
    x1: Math.min(w, x1 + pad),
    z0: Math.max(0, z0 - pad),
    z1: Math.min(d, z1 + pad),
    y0: 0.01,
    y1: 0.0115,
    color: '#1b1b20',
    mat: 'glass',
    role: 'accent',
    fixed: true,
  };
  // what stands on a round base gets a round patch
  if (ROUND_BASE.has(kind)) {
    shadow.shape = 'cyl';
    shadow.seg = 14;
  }
  return shadow;
}

function defaultParts(kind: FurnitureKind, variant: string | undefined, w: number, d: number): Part[] {
  switch (kind) {
    case 'desk':
    case 'desk_back': {
      const top = variantColor(WOOD, variant, WOOD.wood!);
      const parts = deskParts(w, d, variant, top);
      return kind === 'desk_back' ? flipZ(parts, d) : parts;
    }
    case 'office_chair':
    case 'office_chair_front': {
      const c = variantColor(CHAIR, variant, CHAIR.black!);
      return as('seat', facing(officeChair(w, d, c.color), kind === 'office_chair' ? 'up' : 'down', w, d), c.fixed);
    }
    case 'cafe_chair':
      return facing(cafeChair(w, d, '#a8784f'), variant ?? 'down', w, d).map((p) => ({ ...p, role: 'seat' as KitRole }));
    case 'armchair':
      return facing(upholstered(w, d, '#5a7fa8', { seatY: 0.42, backY: 0.8, arm: 0.1 }), variant ?? 'down', w, d);
    case 'sofa':
      return facing(upholstered(w, d, '#5d7895', { seatY: 0.42, backY: 0.8, arm: 0.1 }), variant === 'up' ? 'up' : 'down', w, d);
    case 'bench': {
      const wood = '#b98a5e';
      const parts: Part[] = [];
      for (const [z0, z1] of [[0.12, 0.2], [0.215, 0.295], [0.31, 0.42]] as const) parts.push(bv(0.04, z0, w - 0.04, z1, 0.38, 0.45, wood, 0.008));
      for (const x of [0.08, w - 0.12]) parts.push(bv(x, 0.17, x + 0.04, 0.37, 0, 0.38, DARK, 0.005));
      parts.push(b(0.12, 0.26, w - 0.12, 0.3, 0.12, 0.16, DARK));
      return parts;
    }
    case 'stool':
      return [
        cy(w / 2, d / 2, 0.15, 0.58, 0.64, '#3d4248', 1.05, { seg: 12 }),
        cy(w / 2, d / 2, 0.028, 0.04, 0.58, METAL, 1, { seg: 8 }),
        cy(w / 2, d / 2, 0.14, 0, 0.04, METAL, 0.8, { seg: 10 }),
        cy(w / 2, d / 2, 0.11, 0.24, 0.26, METAL, 1, { seg: 10 }),
      ];
    case 'beanbag': {
      const c = BEANBAG[variant ?? 'red'] ?? BEANBAG.red!;
      return as('seat', [dm(w / 2, d / 2, 0.22, 0, 0.3, c, { seg: 10 }), dm(w / 2 + 0.02, d / 2 - 0.06, 0.15, 0.2, 0.42, c, { seg: 8, tone: 1.08 }), dm(w / 2 - 0.05, d / 2 + 0.07, 0.1, 0.22, 0.34, c, { seg: 8, tone: 0.94 })]);
    }
    case 'bookshelf': {
      const wood = '#8a6a4f';
      const zf = d - 0.15;
      const parts: Part[] = [
        b(0.06, 0.08, w - 0.06, zf - 0.04, 0, 0.05, DARK),
        bv(0.02, 0.02, 0.06, zf, 0, 1.8, wood, 0.006),
        bv(w - 0.06, 0.02, w - 0.02, zf, 0, 1.8, wood, 0.006),
        b(0.06, 0.02, w - 0.06, 0.04, 0.05, 1.76, wood, undefined, 'body'),
        bv(0, 0, w, zf + 0.01, 1.76, 1.8, wood, 0.01),
      ];
      parts[parts.length - 2]!.tone = 0.7;
      for (let i = 0; i < 4; i++) {
        const y = 0.05 + i * 0.42;
        if (i > 0) parts.push(bv(0.06, 0.04, w - 0.06, zf, y, y + 0.03, wood, 0.005, { tone: 1.08 }));
        const shelf: Part[] = [];
        if (i === 2) {
          books(shelf, 0.08, w * 0.55, 0.1, zf - 0.04, y + (i > 0 ? 0.03 : 0), 0.3, 5 + i, BOOKS);
          // a framed picture and a small box on the empty half
          shelf.push(b(w * 0.62, 0.2, w * 0.82, 0.225, y + 0.03, y + 0.2, '#e0a458', undefined, 'accent'), b(w * 0.84, 0.12, w - 0.1, 0.3, y + 0.03, y + 0.13, '#6d8fb3', undefined, 'accent'));
        } else books(shelf, 0.08, w - 0.08, 0.1, zf - 0.04, y + (i > 0 ? 0.03 : 0), 0.3, 3 + i * 17);
        parts.push(...shelf);
      }
      return parts;
    }
    case 'binder_shelf': {
      const parts: Part[] = [
        b(0.06, 0.08, w - 0.06, d - 0.18, 0, 0.05, DARK),
        bv(0.04, 0.04, 0.08, d - 0.1, 0, 1.6, '#d9d6cf', 0.006),
        bv(w - 0.08, 0.04, w - 0.04, d - 0.1, 0, 1.6, '#d9d6cf', 0.006),
        b(0.08, 0.04, w - 0.08, 0.06, 0.05, 1.56, '#d9d6cf', undefined, 'body'),
        bv(0.03, 0.03, w - 0.03, d - 0.09, 1.56, 1.6, '#d9d6cf', 0.008),
        // closed lower part: doors with handles
        bv(0.08, d - 0.115, w - 0.08, d - 0.1, 0.05, 0.5, '#d9d6cf', 0.004, { tone: 0.95 }),
        b(w / 2 - 0.004, d - 0.11, w / 2 + 0.004, d - 0.098, 0.05, 0.5, '#9aa0a6', undefined, 'accent'),
      ];
      for (let i = 0; i < 3; i++) {
        const y = 0.5 + i * 0.37;
        parts.push(bv(0.08, 0.06, w - 0.08, d - 0.1, y, y + 0.025, '#d9d6cf', 0.004, { tone: 1.04 }));
        books(parts, 0.09, w - 0.09, 0.1, d - 0.16, y + 0.025, 0.3, 21 + i * 13, ['#e08a3c', '#4a78b5', '#5a8f6a', '#e0a458', '#8a5aa8']);
      }
      return parts;
    }
    case 'filing_cabinet': {
      const zf = d - 0.05;
      const body = '#8d96a0';
      const parts: Part[] = [bv(0.05, 0.05, w - 0.05, zf, 0, 1.0, body, 0.012)];
      for (const [ya, yb] of [[0.7, 0.98], [0.37, 0.69], [0.04, 0.36]] as const) {
        parts.push(bv(0.075, zf - 0.004, w - 0.075, zf + 0.004, ya, yb, body, 0.004, { tone: 1.1 }));
        parts.push(b(w / 2 - 0.06, zf + 0.004, w / 2 + 0.06, zf + 0.014, yb - 0.075, yb - 0.065, DARK, undefined, 'accent'));
        parts.push(b(w / 2 - 0.035, zf + 0.004, w / 2 + 0.035, zf + 0.008, yb - 0.04, yb - 0.02, PAPER, undefined, 'accent'));
      }
      return parts;
    }
    case 'printer': {
      const zf = d - 0.04;
      const parts: Part[] = [
        bv(0.04, 0.04, w - 0.04, zf, 0, 0.62, '#d9d6cf', 0.012),
        bv(0.05, 0.05, w - 0.05, zf - 0.01, 0.62, 0.78, '#eceae6', 0.02),
        // the scanner glass on the lid, the control panel, a green light, the paper in its tray
        b(0.1, 0.1, w - 0.1, zf - 0.08, 0.78, 0.782, '#3b4b5c', undefined, 'accent'),
        bv(w - 0.2, zf - 0.07, w - 0.07, zf, 0.62, 0.66, DARK, 0.006, { role: 'accent', fixed: true }),
        bv(0.1, zf - 0.02, w - 0.1, zf + 0.04 > d ? d : zf + 0.04, 0.34, 0.36, PAPER, 0.004, D),
      ];
      parts.push(b(w - 0.17, zf - 0.04, w - 0.14, zf - 0.02, 0.66, 0.664, '#6bdc7f', 'glow', 'accent'));
      return parts;
    }
    case 'trash_bin':
      return [cy(w / 2, d / 2, 0.12, 0, 0.34, '#7d858e', 1.18, { seg: 12 }), cy(w / 2, d / 2, 0.14, 0.34, 0.36, '#5f666e', 1, { seg: 12 }), cy(w / 2, d / 2, 0.115, 0.358, 0.362, '#25282c', 1, { ...D, seg: 12 })];
    case 'plant_small':
      return plant(w, d, false, variant);
    case 'plant_tall':
      return plant(w, d, true, variant);
    case 'glass_partition': {
      const v = variant ?? 'h';
      const plinth = '#f2f2ef';
      if (v === 'end') return [bv(w / 2 - 0.08, d / 2 - 0.08, w / 2 + 0.08, d / 2 + 0.08, 0, 1.2, plinth, 0.02), cy(w / 2, d / 2, 0.1, 0, 0.03, DARK, 1, { seg: 8 })];
      const vertical = v === 'v';
      const [ax0, az0, ax1, az1] = vertical ? [w / 2 - 0.05, 0, w / 2 + 0.05, d] : [0, d / 2 - 0.05, w, d / 2 + 0.05];
      const [gx0, gz0, gx1, gz1] = vertical ? [w / 2 - 0.02, 0.02, w / 2 + 0.02, d - 0.02] : [0.02, d / 2 - 0.02, w - 0.02, d / 2 + 0.02];
      const [rx0, rz0, rx1, rz1] = vertical ? [w / 2 - 0.03, 0, w / 2 + 0.03, d] : [0, d / 2 - 0.03, w, d / 2 + 0.03];
      return [bv(ax0, az0, ax1, az1, 0, 0.3, plinth, 0.012), b(gx0, gz0, gx1, gz1, 0.3, 1.2, GLASS, 'glass'), b(rx0, rz0, rx1, rz1, 1.2, 1.23, METAL)];
    }
    case 'meeting_table': {
      const parts: Part[] = [
        bv(0.08, 0.08, w - 0.08, d - 0.08, 0.7, 0.75, '#e9e6e0', 0.014, { role: 'top' }),
        bv(0.3, 0.2, 0.34, d - 0.2, 0, 0.7, DARK, 0.006),
        bv(w - 0.34, 0.2, w - 0.3, d - 0.2, 0, 0.7, DARK, 0.006),
        bv(0.3, d / 2 - 0.02, w - 0.3, d / 2 + 0.02, 0.4, 0.44, DARK, 0.004),
        // a speakerphone, two notebooks, cups and loose pages
        cy(w / 2, d / 2, 0.07, 0.75, 0.765, '#2b2e33', 1, { ...D, seg: 10 }),
        bv(w / 2 - 0.62, d / 2 - 0.3, w / 2 - 0.4, d / 2 - 0.12, 0.75, 0.758, PAPER, 0.003, D),
        bv(w / 2 + 0.4, d / 2 + 0.12, w / 2 + 0.62, d / 2 + 0.3, 0.75, 0.758, '#d9e2ef', 0.003, D),
        bv(w / 2 - 0.36, d / 2 + 0.16, w / 2 - 0.16, d / 2 + 0.3, 0.75, 0.762, '#3d4a5c', 0.004, D),
        cy(w / 2 + 0.24, d / 2 - 0.2, 0.028, 0.75, 0.81, '#f2f2ef', 1, { ...D, seg: 8 }),
        cy(w / 2 - 0.2, d / 2 - 0.12, 0.028, 0.75, 0.81, '#e07a5f', 1, { ...D, seg: 8 }),
      ];
      return parts;
    }
    case 'cafe_table': {
      const parts = pedestalTable(w, d, 0.75, '#e9e6e0', true, 0.04);
      parts.push(cy(w / 2 + 0.05, d / 2 - 0.04, 0.045, 0.75, 0.765, '#f2f2ef', 1.1, { ...D, seg: 8 }), cy(w / 2 + 0.05, d / 2 - 0.04, 0.026, 0.765, 0.82, '#e07a5f', 1, { ...D, seg: 8 }));
      return parts;
    }
    case 'coffee_table': {
      const parts: Part[] = [bv(0.06, 0.06, w - 0.06, d - 0.06, 0.35, 0.4, '#b98a5e', 0.012, { role: 'top' })];
      for (const x of [0.1, w - 0.14]) for (const z of [0.1, d - 0.14]) parts.push(bv(x, z, x + 0.04, z + 0.04, 0, 0.35, DARK, 0.004));
      parts.push(bv(0.1, 0.1, w - 0.1, d - 0.1, 0.12, 0.14, '#9a7650', 0.004, { role: 'top', tone: 0.85 }));
      parts.push(bv(w * 0.3, d * 0.3, w * 0.3 + 0.2, d * 0.3 + 0.14, 0.4, 0.416, '#c95f4a', 0.004, D), bv(w * 0.3 + 0.01, d * 0.3 + 0.01, w * 0.3 + 0.19, d * 0.3 + 0.13, 0.416, 0.428, '#4a78b5', 0.004, D), cy(w * 0.72, d * 0.5, 0.03, 0.4, 0.46, '#f2f2ef', 1, { ...D, seg: 8 }));
      return parts;
    }
    case 'floor_lamp':
      return [
        cy(w / 2, d / 2, 0.11, 0, 0.03, DARK, 0.9, { seg: 10 }),
        cy(w / 2, d / 2, 0.012, 0.03, 1.5, DARK, 1, { seg: 6 }),
        cy(w / 2, d / 2, 0.15, 1.5, 1.75, '#fff1c9', 0.68, { mat: 'glow', seg: 10 }),
      ];
    case 'water_cooler': {
      const zf = d - 0.12;
      return [
        bv(0.12, 0.12, w - 0.12, zf, 0, 0.9, '#e9ecef', 0.014),
        // the tap panel, two taps, a drip tray, and the jug on top
        b(0.16, zf - 0.004, w - 0.16, zf + 0.004, 0.62, 0.8, '#cfd6dc', undefined, 'accent'),
        b(0.2, zf + 0.004, 0.26, zf + 0.03, 0.68, 0.74, '#4a90d9', undefined, 'accent'),
        b(w - 0.26, zf + 0.004, w - 0.2, zf + 0.03, 0.68, 0.74, '#d9534a', undefined, 'accent'),
        b(0.17, zf - 0.02, w - 0.17, zf + 0.04, 0.5, 0.52, METAL, undefined, 'accent'),
        cy(w / 2, d / 2 - 0.02, 0.13, 0.9, 0.95, '#d6dce1', 1, { seg: 10 }),
        cy(w / 2, d / 2 - 0.02, 0.12, 0.95, 1.33, '#7fb6e6', 0.95, { ...D, mat: 'glass', seg: 10 }),
        cy(w / 2, d / 2 - 0.02, 0.05, 1.33, 1.37, '#7fb6e6', 1, { ...D, mat: 'glass', seg: 8 }),
      ];
    }
    case 'counter':
      return cabinet(w, d, variant === 'drawers' ? '#d9d2c4' : '#e3ddd1', variant === 'drawers');
    case 'counter_sink':
    case 'sink': {
      const parts = cabinet(w, d, '#e3ddd1', false);
      parts.push(bv(0.1, 0.14, w - 0.1, d - 0.2, 0.92, 0.926, '#c4ced4', 0.004, D), bv(0.13, 0.17, w - 0.13, d - 0.23, 0.926, 0.928, '#9fb8c6', 0.002, D), cy(w / 2, (0.14 + d - 0.2) / 2, 0.015, 0.928, 0.93, DARK, 1, { ...D, seg: 6 }));
      parts.push(cy(w / 2, 0.09, 0.012, 0.92, 1.06, METAL, 1, { ...D, seg: 6 }), b(w / 2 - 0.01, 0.09, w / 2 + 0.01, 0.2, 1.04, 1.06, METAL, undefined, 'accent'));
      return parts;
    }
    case 'coffee_machine': {
      const parts = cabinet(w, d, '#e3ddd1', false);
      const zf = d - 0.2;
      parts.push(
        bv(0.1, 0.05, w - 0.1, zf, 0.92, 1.3, '#2f3236', 0.02),
        // the head: a darker block that overhangs the carafe, with a spout, a glowing panel and two buttons
        bv(0.1, 0.05, w - 0.1, zf + 0.08, 1.12, 1.3, '#2f3236', 0.02, { tone: 1.2 }),
        b(0.2, zf + 0.03, w - 0.2, zf + 0.085, 1.06, 1.1, DARK, undefined, 'accent'),
        b(0.18, zf - 0.006, w - 0.18, zf + 0.081, 1.22, 1.27, '#ff9f43', 'glow', 'accent'),
        b(0.17, zf + 0.081, 0.23, zf + 0.09, 1.14, 1.19, '#e8e4da', undefined, 'accent'),
        b(w - 0.23, zf + 0.081, w - 0.17, zf + 0.09, 1.14, 1.19, '#e8e4da', undefined, 'accent'),
        // the warming plate and a glass carafe of coffee
        bv(0.14, 0.1, w - 0.14, zf + 0.06, 0.92, 0.935, DARK, 0.004, D),
        cy(w / 2, (0.1 + zf + 0.06) / 2 + 0.01, 0.085, 0.935, 1.08, GLASS, 1.05, { ...D, mat: 'glass', seg: 10 }),
        cy(w / 2, (0.1 + zf + 0.06) / 2 + 0.01, 0.075, 0.936, 1.02, '#3b2418', 1, { ...D, seg: 10 }),
      );
      return parts;
    }
    case 'microwave': {
      const parts = cabinet(w, d, '#e3ddd1', false);
      const zf = d - 0.15;
      parts.push(
        bv(0.05, 0.05, w - 0.05, zf, 0.92, 1.2, '#cfd3d6', 0.015),
        bv(0.08, zf, w - 0.2, zf + 0.012, 0.96, 1.16, '#23272b', 0.006, D),
        bv(w - 0.18, zf, w - 0.07, zf + 0.012, 0.96, 1.16, '#a9b0b6', 0.004, D),
        b(w - 0.15, zf + 0.012, w - 0.1, zf + 0.02, 1.08, 1.13, '#7cd6a1', 'glow', 'accent'),
        b(w - 0.15, zf + 0.012, w - 0.1, zf + 0.02, 1.0, 1.05, '#d9534a', undefined, 'accent'),
        b(w - 0.21, zf + 0.012, w - 0.195, zf + 0.022, 0.98, 1.14, METAL, undefined, 'accent'),
      );
      return parts;
    }
    case 'fridge': {
      const zf = d - 0.05;
      const parts: Part[] = [
        b(0.06, 0.06, w - 0.06, d - 0.1, 0, 0.04, DARK),
        bv(0.03, 0.03, w - 0.03, zf, 0.04, 1.9, '#e9ecef', 0.02, { tone: 0.78 }),
        bv(0.03, zf - 0.004, w - 0.03, zf + 0.004, 1.33, 1.88, '#e9ecef', 0.012),
        bv(0.03, zf - 0.004, w - 0.03, zf + 0.004, 0.06, 1.31, '#e9ecef', 0.01),
        b(0.07, zf + 0.004, 0.095, zf + 0.025, 1.4, 1.65, METAL, undefined, 'accent'),
        b(0.07, zf + 0.004, 0.095, zf + 0.025, 0.95, 1.25, METAL, undefined, 'accent'),
        b(0.17, zf + 0.004, 0.23, zf + 0.009, 1.5, 1.56, '#e0a458', undefined, 'accent'),
        b(0.25, zf + 0.004, 0.31, zf + 0.009, 1.58, 1.65, '#d9534a', undefined, 'accent'),
        b(0.2, zf + 0.004, 0.3, zf + 0.007, 1.3 - 0.0, 1.31, '#3a3d42', undefined, 'accent'),
      ];
      return parts;
    }
    case 'vending_machine': {
      const zf = d - 0.05;
      const parts: Part[] = [
        b(0.06, 0.06, w - 0.06, d - 0.1, 0, 0.04, DARK),
        bv(0.03, 0.03, w - 0.03, zf, 0.04, 1.85, '#c0392b', 0.02),
        // the lit window with its shelves of products, the keypad, the dispenser and the marquee
        bv(0.07, zf - 0.002, 0.34, zf + 0.006, 0.52, 1.72, '#26292d', 0.004, D),
        b(0.09, zf + 0.006, 0.32, zf + 0.008, 0.56, 1.69, '#ffe8a3', 'glow', 'accent'),
        bv(0.37, zf - 0.002, w - 0.07, zf + 0.006, 1.1, 1.62, '#26292d', 0.004, D),
        b(0.07, zf - 0.002, 0.34, zf + 0.006, 0.1, 0.38, '#1c1e21', undefined, 'accent'),
        b(0.1, zf + 0.006, 0.31, zf + 0.012, 0.14, 0.34, '#101214', undefined, 'accent'),
        b(0.08, zf - 0.002, w - 0.08, zf + 0.004, 1.75, 1.82, '#ffffff', 'glow', 'accent'),
        b(0.38, zf + 0.006, 0.42, zf + 0.012, 1.5, 1.57, '#7cd6a1', 'glow', 'accent'),
      ];
      const r = mulberry32(99);
      const cols = ['#e04a3a', '#f2c14e', '#4aa3ff', '#7cd6a1', '#ff8fc7', '#ffffff'];
      for (let i = 0; i < 5; i++) {
        const y = 0.6 + i * 0.22;
        parts.push(b(0.09, zf + 0.008, 0.32, zf + 0.014, y, y + 0.012, '#4a4d52', undefined, 'accent'));
        let x = 0.1;
        for (let j = 0; j < 3; j++) {
          const wd = 0.05 + r() * 0.03;
          parts.push(b(x, zf + 0.008, x + wd, zf + 0.03, y + 0.012, y + 0.012 + 0.09 + r() * 0.05, cols[Math.floor(r() * cols.length)]!, 'glow', 'accent'));
          x += wd + 0.015;
        }
      }
      for (const y of [1.2, 1.28, 1.36]) for (const x of [0.378, 0.404]) parts.push(b(x, zf + 0.006, x + 0.02, zf + 0.012, y, y + 0.05, '#cfd3d6', undefined, 'accent'));
      return parts;
    }
    case 'pingpong_table': {
      const parts: Part[] = [
        bv(0.05, 0.1, w - 0.05, d - 0.1, 0.71, 0.76, '#2f7a4f', 0.01),
        bv(0.1, 0.16, 0.14, d - 0.16, 0.45, 0.48, DARK, 0.004),
        bv(w - 0.14, 0.16, w - 0.1, d - 0.16, 0.45, 0.48, DARK, 0.004),
      ];
      for (const x of [0.1, w - 0.14]) for (const z of [0.15, d - 0.19]) parts.push(bv(x, z, x + 0.04, z + 0.04, 0, 0.71, DARK, 0.004));
      // white lines, the net and its posts, a ball and two paddles
      const line = (x0: number, z0: number, x1: number, z1: number): Part => b(x0, z0, x1, z1, 0.76, 0.761, '#f2f2ef', undefined, 'accent');
      parts.push(line(0.09, 0.14, w - 0.09, 0.155), line(0.09, d - 0.155, w - 0.09, d - 0.14), line(0.09, 0.14, 0.105, d - 0.14), line(w - 0.105, 0.14, w - 0.09, d - 0.14), line(0.105, d / 2 - 0.004, w - 0.105, d / 2 + 0.004));
      parts.push(
        b(w / 2 - 0.004, 0.1, w / 2 + 0.004, d - 0.1, 0.78, 0.88, '#ffffff', 'glass', 'accent'),
        b(w / 2 - 0.006, 0.1, w / 2 + 0.006, d - 0.1, 0.88, 0.9, '#f2f2ef', undefined, 'accent'),
        cy(w / 2, 0.09, 0.008, 0.76, 0.91, METAL, 1, { ...D, seg: 6 }),
        cy(w / 2, d - 0.09, 0.008, 0.76, 0.91, METAL, 1, { ...D, seg: 6 }),
        sp(w * 0.66, d * 0.4, 0.02, 0.761, 0.801, '#fafafa', { ...D, seg: 6 }),
        cy(w * 0.2, d * 0.7, 0.045, 0.761, 0.768, '#d0543f', 1, { ...D, seg: 8 }),
        b(w * 0.2 - 0.01, d * 0.7 + 0.045, w * 0.2 + 0.01, d * 0.7 + 0.1, 0.761, 0.768, '#8a6a4f', undefined, 'accent'),
        cy(w * 0.82, d * 0.3, 0.045, 0.761, 0.768, '#4579c4', 1, { ...D, seg: 8 }),
        b(w * 0.82 - 0.01, d * 0.3 - 0.1, w * 0.82 + 0.01, d * 0.3 - 0.045, 0.761, 0.768, '#8a6a4f', undefined, 'accent'),
      );
      return parts;
    }
    case 'arcade': {
      const parts: Part[] = [
        bv(0.07, 0.07, w - 0.07, d - 0.04, 0, 0.86, '#4b3f8f', 0.012),
        bv(0.07, 0.07, w - 0.07, 0.34, 0.86, 1.75, '#4b3f8f', 0.02),
        // the control deck, joystick and buttons
        bv(0.06, 0.3, w - 0.06, d - 0.02, 0.86, 0.93, '#2a2d44', 0.01, D),
        cy(0.18, 0.4, 0.022, 0.93, 0.945, DARK, 1, { ...D, seg: 8 }),
        cy(0.18, 0.4, 0.007, 0.945, 0.985, METAL, 1, { ...D, seg: 6 }),
        sp(0.18, 0.4, 0.018, 0.98, 1.016, '#d9534a', { ...D, seg: 8 }),
        cy(0.3, 0.39, 0.016, 0.93, 0.942, '#f2c14e', 1, { ...D, seg: 8 }),
        cy(0.36, 0.41, 0.016, 0.93, 0.942, '#4aa3ff', 1, { ...D, seg: 8 }),
        cy(0.3, 0.44, 0.016, 0.93, 0.942, '#7cd6a1', 1, { ...D, seg: 8 }),
        // screen, marquee, coin door and side stripes
        b(0.1, 0.34, w - 0.1, 0.345, 1.05, 1.55, '#8de0ff', 'glow', 'accent'),
        b(0.1, 0.34, w - 0.1, 0.345, 1.62, 1.72, '#ff7ac8', 'glow', 'accent'),
        b(0.17, d - 0.04, w - 0.17, d - 0.034, 0.4, 0.66, '#1e2030', undefined, 'accent'),
        b(0.22, d - 0.034, 0.26, d - 0.03, 0.55, 0.6, '#ffd25e', 'glow', 'accent'),
        b(w - 0.26, d - 0.034, w - 0.22, d - 0.03, 0.55, 0.6, '#ffd25e', 'glow', 'accent'),
        b(0.062, 0.1, 0.07, 0.4, 0.2, 0.26, '#ff7ac8', undefined, 'accent'),
        b(w - 0.07, 0.1, w - 0.062, 0.4, 0.2, 0.26, '#ff7ac8', undefined, 'accent'),
        b(0.062, 0.1, 0.07, 0.4, 0.65, 0.7, '#8de0ff', undefined, 'accent'),
        b(w - 0.07, 0.1, w - 0.062, 0.4, 0.65, 0.7, '#8de0ff', undefined, 'accent'),
      ];
      return parts;
    }
    case 'toilet_stall': {
      const panel = '#9fb8c6';
      const cx = w / 2;
      const parts: Part[] = [
        bv(0, 0, 0.05, d, 0.1, 1.9, panel, 0.01),
        bv(w - 0.05, 0, w, d, 0.1, 1.9, panel, 0.01),
        bv(0.05, 0, w - 0.05, 0.05, 0.1, 1.9, panel, 0.01),
        // the door, closed, with a handle and hinges, and chrome feet under every panel
        bv(0.05, d - 0.07, w - 0.05, d - 0.02, 0.15, 1.85, '#b9cfdb', 0.01),
        b(w - 0.2, d - 0.02, w - 0.15, d, 0.95, 1.02, METAL, undefined, 'accent'),
        b(0.08, d - 0.02, 0.1, d, 0.35, 0.45, METAL, undefined, 'accent'),
        b(0.08, d - 0.02, 0.1, d, 1.5, 1.6, METAL, undefined, 'accent'),
        b(0, d - 0.04, 0.05, d, 0, 0.1, METAL, undefined, 'accent'),
        b(w - 0.05, d - 0.04, w, d, 0, 0.1, METAL, undefined, 'accent'),
        b(0, 0, 0.05, 0.04, 0, 0.1, METAL, undefined, 'accent'),
        b(w - 0.05, 0, w, 0.04, 0, 0.1, METAL, undefined, 'accent'),
        // the toilet: a bowl with a seat, a cistern at the back and a roll of paper on the wall
        cy(cx, 0.4, 0.15, 0, 0.4, '#f4f6f7', 1.18, { ...D, rz: 0.2, seg: 12 }),
        cy(cx, 0.4, 0.14, 0.4, 0.415, '#e6eaec', 1, { ...D, rz: 0.19, seg: 12 }),
        cy(cx, 0.42, 0.095, 0.415, 0.418, '#8fb3c9', 1, { ...D, rz: 0.13, seg: 10 }),
        bv(cx - 0.17, 0.06, cx + 0.17, 0.2, 0.25, 0.8, '#f4f6f7', 0.012, D),
        cy(0.09, 0.4, 0.035, 0.7, 0.8, '#ffffff', 1, { ...D, seg: 8 }),
      ];
      return parts;
    }
    case 'reception_desk': {
      const zf = d - 0.06;
      const parts: Part[] = [
        b(0.04, 0.08, w - 0.04, d - 0.1, 0, 0.07, DARK),
        bv(0.02, 0.06, w - 0.02, zf, 0.07, 1.05, '#8a6a4f', 0.01, { tone: 0.88 }),
        bv(0, 0, w, d, 1.05, 1.1, '#e9e6e0', 0.014, { role: 'top' }),
      ];
      // fluted front
      const n = 9;
      for (let i = 0; i < n; i++) {
        const x = 0.08 + (i * (w - 0.16)) / n;
        parts.push(b(x, zf, x + (w - 0.16) / n - 0.016, zf + 0.012, 0.14, 0.98, '#8a6a4f'));
        parts[parts.length - 1]!.tone = 1.06;
      }
      parts.push(
        dm(w * 0.72, 0.34, 0.04, 1.1, 1.14, METAL, { ...D, seg: 8 }),
        bv(w * 0.3, 0.26, w * 0.3 + 0.18, 0.42, 1.1, 1.118, PAPER, 0.004, D),
        bv(w * 0.3 + 0.005, 0.265, w * 0.3 + 0.175, 0.415, 1.07, 1.1, '#8a2b2b', 0.004, D),
        cy(w * 0.55, 0.3, 0.025, 1.1, 1.16, '#3a3d42', 1, { ...D, seg: 8 }),
      );
      return parts;
    }
    default:
      return [bv(0.1, 0.1, w - 0.1, d - 0.1, 0, 0.5, '#b0a99f', 0.02)];
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
