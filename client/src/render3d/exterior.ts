// The building's surroundings (P10-06), the pure part: a foundation strip round the walls, a tiled sidewalk with a curb,
// a lawn, and lamp posts, planters and trees on it. Boxes in metres (the building occupies x 0..w, z 0..d); building.ts
// merges them into one mesh. Trees and lamp posts stand only on the sides that face away from the camera, so nothing
// tall hides the rooms; the near sides get low planters. Nothing here is walkable: it all lies outside the footprint.
import { mulberry32 } from '../../../shared/hash';
import { CORRIDOR_H, CORRIDOR_Y } from '../core/constants';
import type { DecorBox } from './decor';
import { TILE_M } from './units';

/** Widths (m) of the foundation strip, the sidewalk (from the foundation out) and the curb, and of the lawn beyond it. */
export const PLINTH = 0.16;
export const SIDEWALK = 0.95;
export const CURB = 0.11;
export const LAWN = 1.25;

export interface ExteriorSpec {
  /** The building's footprint in metres. */
  w: number;
  d: number;
  /** The theme's ground color: the sidewalk. */
  ground: string;
  /** The color of practical lights (the lamp posts). */
  practical: string;
  /** Which sides face away from the camera. */
  far: { north: boolean; south: boolean; west: boolean; east: boolean };
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mixes two colors (t = 0 gives a, 1 gives b). */
export function mixHex(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  const c = (i: number) => Math.max(0, Math.min(255, Math.round(x[i]! + (y[i]! - x[i]!) * t)));
  return `#${((c(0) << 16) | (c(1) << 8) | c(2)).toString(16).padStart(6, '0')}`;
}

/** The z span (m) of the corridor, where the building's two ends open: no foundation strip there. */
export function entranceSpan(): [number, number] {
  return [CORRIDOR_Y * TILE_M, (CORRIDOR_Y + CORRIDOR_H) * TILE_M];
}

/** Positions along a side of length `len`, `step` apart, at least `edge` from each end (centred in the run). */
export function spread(len: number, step: number, edge: number): number[] {
  const room = len - 2 * edge;
  if (room < 0) return [];
  const n = Math.max(1, Math.floor(room / step) + 1);
  if (n === 1) return [len / 2];
  const gap = room / (n - 1);
  return Array.from({ length: n }, (_, i) => edge + i * gap);
}

/** The exterior as boxes. */
export function exteriorBoxes(s: ExteriorSpec): DecorBox[] {
  const out: DecorBox[] = [];
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string, mat: DecorBox['mat'] = 'solid') => out.push({ x0, x1, y0, y1, z0, z1, color, mat });
  const { w, d } = s;
  const S = SIDEWALK;
  const P = PLINTH;
  const pave = s.ground;
  const lawn = mixHex('#7ea35f', s.ground, 0.12);
  const curb = mixHex(pave, '#ffffff', 0.4);
  const rng = mulberry32(Math.round(w * 31 + d * 17));

  // lawn, then the sidewalk plate (its joints), the curb between them
  const L = S + CURB + LAWN;
  box(-L, w + L, -0.3, -0.07, -L, d + L, lawn);
  box(-S, w + S, -0.3, -0.012, -S, d + S, mixHex(pave, '#000000', 0.14));
  const c0 = S + CURB;
  box(-c0, w + c0, -0.07, 0.09, -c0, -S, curb);
  box(-c0, w + c0, -0.07, 0.09, d + S, d + c0, curb);
  box(-c0, -S, -0.07, 0.09, -S, d + S, curb);
  box(w + S, w + c0, -0.07, 0.09, -S, d + S, curb);

  // sidewalk slabs: ~1 m cells with 3 cm joints and a slight shade shift, per strip
  const cell = (x0: number, x1: number, z0: number, z1: number) => {
    const k = 1 + (rng() - 0.5) * 0.07;
    box(x0 + 0.015, x1 - 0.015, -0.02, -0.001, z0 + 0.015, z1 - 0.015, mixHex(pave, k > 1 ? '#ffffff' : '#000000', Math.abs(k - 1)));
  };
  const strip = (a0: number, a1: number, fn: (p0: number, p1: number) => void) => {
    const n = Math.max(1, Math.round((a1 - a0) / 1.0));
    for (let i = 0; i < n; i++) fn(a0 + ((a1 - a0) * i) / n, a0 + ((a1 - a0) * (i + 1)) / n);
  };
  strip(-S, w + S, (a, b) => cell(a, b, -S, -P));
  strip(-S, w + S, (a, b) => cell(a, b, d + P, d + S));
  strip(-P, d + P, (a, b) => cell(-S, -P, a, b));
  strip(-P, d + P, (a, b) => cell(w + P, w + S, a, b));

  // the foundation strip round the walls, opened where the corridor meets the street; a threshold step in each opening
  const found = mixHex('#8d8b86', pave, 0.2);
  const foundTop = mixHex(found, '#ffffff', 0.25);
  const [e0, e1] = entranceSpan();
  box(-P, w + P, -0.012, 0.15, -P, 0, found);
  box(-P - 0.02, w + P + 0.02, 0.15, 0.17, -P - 0.02, 0.02, foundTop);
  box(-P, w + P, -0.012, 0.15, d, d + P, found);
  box(-P - 0.02, w + P + 0.02, 0.15, 0.17, d - 0.02, d + P + 0.02, foundTop);
  for (const [x0, x1] of [[-P, 0], [w, w + P]] as const) {
    box(x0, x1, -0.012, 0.15, 0, e0, found);
    box(x0, x1, -0.012, 0.15, e1, d, found);
    box(x0 - (x0 < 0 ? 0.02 : 0), x1 + (x0 < 0 ? 0 : 0.02), 0.15, 0.17, 0, e0, foundTop);
    box(x0 - (x0 < 0 ? 0.02 : 0), x1 + (x0 < 0 ? 0 : 0.02), 0.15, 0.17, e1, d, foundTop);
    // the doormat step
    box(x0 < 0 ? -S : w, x0 < 0 ? 0 : w + S, -0.012, 0.025, e0 + 0.15, e1 - 0.15, mixHex(pave, '#000000', 0.2));
  }

  // lamp posts and trees on the far sides; low planters on every side
  const post = (x: number, z: number, towardX: number, towardZ: number) => {
    box(x - 0.03, x + 0.03, 0, 2.5, z - 0.03, z + 0.03, '#2d3035');
    box(x - 0.07, x + 0.07, 0, 0.12, z - 0.07, z + 0.07, '#2d3035');
    // the arm reaches over the sidewalk, the lamp hangs from its end
    const lx = x + towardX * 0.36;
    const lz = z + towardZ * 0.36;
    box(Math.min(x, lx) - 0.025, Math.max(x, lx) + 0.025, 2.46, 2.52, Math.min(z, lz) - 0.025, Math.max(z, lz) + 0.025, '#2d3035');
    box(lx - 0.1, lx + 0.1, 2.5, 2.54, lz - 0.1, lz + 0.1, '#2d3035');
    box(lx - 0.075, lx + 0.075, 2.38, 2.5, lz - 0.075, lz + 0.075, s.practical, 'glow');
  };
  const greens = ['#4f8a46', '#5b9a4c', '#437a3f', '#6aa656'];
  const tree = (x: number, z: number) => {
    const h = 1.7 + rng() * 0.9;
    const g = greens[Math.floor(rng() * greens.length)]!;
    const trunk = 0.5 + rng() * 0.2;
    box(x - 0.07, x + 0.07, 0, trunk + 0.1, z - 0.07, z + 0.07, '#6b4a2f');
    // a stack of three crowns, narrowing upwards
    const r1 = 0.5 + rng() * 0.12;
    box(x - r1, x + r1, trunk, trunk + (h - trunk) * 0.42, z - r1, z + r1, g);
    const r2 = r1 * 0.74;
    box(x - r2, x + r2, trunk + (h - trunk) * 0.4, trunk + (h - trunk) * 0.74, z - r2, z + r2, mixHex(g, '#ffffff', 0.08));
    const r3 = r1 * 0.46;
    box(x - r3, x + r3, trunk + (h - trunk) * 0.72, h, z - r3, z + r3, mixHex(g, '#ffffff', 0.16));
  };
  const planter = (x: number, z: number, bloom: boolean) => {
    box(x - 0.26, x + 0.26, 0, 0.36, z - 0.26, z + 0.26, '#7b756c');
    box(x - 0.28, x + 0.28, 0.36, 0.4, z - 0.28, z + 0.28, '#968f84');
    box(x - 0.23, x + 0.23, 0.4, 0.62, z - 0.23, z + 0.23, greens[Math.floor(rng() * greens.length)]!);
    if (bloom) {
      box(x - 0.07, x + 0.07, 0.62, 0.7, z - 0.1, z + 0.04, '#e8bf4a');
      box(x + 0.05, x + 0.17, 0.62, 0.69, z - 0.02, z + 0.1, '#e07a8a');
    }
  };

  const edge = 1.4;
  const lampStep = 6.5;
  const treeStep = 4.6;
  const outerS = S - 0.2;
  // north side (z < 0) and south side (z > d), along x
  for (const [side, far] of [[-1, s.far.north], [1, s.far.south]] as const) {
    const zs = side < 0 ? -outerS : d + outerS;
    const zl = side < 0 ? -(S + CURB + LAWN / 2) : d + S + CURB + LAWN / 2;
    if (far) {
      spread(w, lampStep, edge).forEach((x) => post(x, zs, 0, -side));
      spread(w, treeStep, edge + 1).forEach((x, i) => tree(x + (i % 2 ? 0.5 : -0.5), zl));
    } else {
      spread(w, 9, edge + 1).forEach((x, i) => planter(x, side < 0 ? -S + 0.4 : d + S - 0.4, i % 2 === 0));
    }
  }
  // west side (x < 0) and east side (x > w), along z; the corridor's opening stays clear
  for (const [side, far] of [[-1, s.far.west], [1, s.far.east]] as const) {
    const xs = side < 0 ? -outerS : w + outerS;
    const xl = side < 0 ? -(S + CURB + LAWN / 2) : w + S + CURB + LAWN / 2;
    const clear = (z: number) => z < e0 - 0.7 || z > e1 + 0.7;
    if (far) {
      spread(d, lampStep, edge).filter(clear).forEach((z) => post(xs, z, -side, 0));
      spread(d, treeStep, edge + 1).filter(clear).forEach((z, i) => tree(xl, z + (i % 2 ? 0.5 : -0.5)));
    } else {
      spread(d, 9, edge + 1).filter(clear).forEach((z, i) => planter(side < 0 ? -S + 0.4 : w + S - 0.4, z, i % 2 === 1));
    }
  }
  // the four corners: a planter each, whichever way the camera looks
  for (const [x, z] of [[-S + 0.4, -S + 0.4], [w + S - 0.4, -S + 0.4], [-S + 0.4, d + S - 0.4], [w + S - 0.4, d + S - 0.4]] as const) planter(x, z, true);
  return out;
}
