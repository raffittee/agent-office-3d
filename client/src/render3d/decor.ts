// Theme decor generators (P4-02): pipes, beams, factory windows, plant walls, neon, certificates, string lights on the
// full-height walls; pendant bulbs and fluorescent strips overhead. Pure data (boxes in metres, no three): building.ts
// merges them with the area. Decor never touches the floor, so it can't change where anyone walks.
import { hash32, mulberry32 } from '../../../shared/hash';
import type { DecorSpec } from '../../../shared/theme';
import type { AreaLayout } from '../core/layout/types';
import type { PartMaterial } from './kit';
import { mx, TILE_M, UNIT_M } from './units';

/** A box in absolute metres. */
export interface DecorBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  color: string;
  mat: PartMaterial;
}

/**
 * A full-height wall run, seen from the room: `axis` is the direction it runs along, `plane` its room-side face (the
 * other coordinate), `normal` points into the room. `busy` are spans (along) taken by wall items.
 */
export interface FullWall {
  axis: 'x' | 'z';
  a0: number;
  a1: number;
  plane: number;
  normal: 1 | -1;
  busy: [number, number][];
}

export interface DecorContext {
  wallHeight: number;
  accent: string;
  practical: string;
}

/** Does a decor spec apply to an area? */
export function decorApplies(spec: DecorSpec, area: AreaLayout): boolean {
  if (spec.on === 'everywhere') return true;
  return spec.on === 'rooms' ? area.kind === 'room' : area.kind !== 'room';
}

/** A box against a wall: `a0..a1` along it, `d0..d1` out from its face into the room. */
function onWall(w: FullWall, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number, color: string, mat: PartMaterial = 'solid'): DecorBox {
  const p0 = w.plane + w.normal * d0;
  const p1 = w.plane + w.normal * d1;
  const [n0, n1] = p0 < p1 ? [p0, p1] : [p1, p0];
  return w.axis === 'x' ? { x0: a0, x1: a1, z0: n0, z1: n1, y0, y1, color, mat } : { x0: n0, x1: n1, z0: a0, z1: a1, y0, y1, color, mat };
}

function free(w: FullWall, a0: number, a1: number): boolean {
  return a0 >= w.a0 + 0.1 && a1 <= w.a1 - 0.1 && !w.busy.some(([b0, b1]) => a1 > b0 - 0.1 && a0 < b1 + 0.1);
}

/** Places items of `width` along a wall every `step` metres, where they fit. */
function along(w: FullWall, width: number, step: number, fn: (a0: number, a1: number, i: number) => void): void {
  let i = 0;
  for (let a = w.a0 + step / 2 - width / 2; a + width <= w.a1; a += step) {
    if (free(w, a, a + width)) fn(a, a + width, i++);
  }
}

/** Overhead points on a grid over an area's floor (for lights). */
function overhead(area: AreaLayout, step: number, fn: (x: number, z: number) => void): void {
  const r = area.rect;
  const x0 = r.x * TILE_M + 0.6;
  const x1 = (r.x + r.w) * TILE_M - 0.6;
  const z0 = (r.y + 2) * TILE_M;
  const z1 = (r.y + r.h - 1) * TILE_M;
  const nx = Math.max(1, Math.floor((x1 - x0) / step));
  const nz = Math.max(1, Math.floor((z1 - z0) / step));
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) fn(x0 + ((i + 0.5) * (x1 - x0)) / nx, z0 + ((j + 0.5) * (z1 - z0)) / nz);
}

/** The decor boxes for one area. */
export function decorFor(area: AreaLayout, walls: readonly FullWall[], specs: readonly DecorSpec[], ctx: DecorContext): DecorBox[] {
  const out: DecorBox[] = [];
  const H = ctx.wallHeight;
  for (const spec of specs) {
    if (!decorApplies(spec, area)) continue;
    const density = Math.max(0, Math.min(1, spec.density ?? 0.5));
    const rng = mulberry32(hash32(`${area.id}|${spec.kind}`));
    switch (spec.kind) {
      case 'pipes': {
        const c = spec.color ?? '#5a5d61';
        for (const w of walls) {
          out.push(onWall(w, w.a0 + 0.05, w.a1 - 0.05, H - 0.24, H - 0.13, 0.04, 0.15, c));
          out.push(onWall(w, w.a0 + 0.05, w.a1 - 0.05, H - 0.1, H - 0.04, 0.03, 0.09, '#7b7f84'));
          along(w, 0.07, 9 - 6 * density, (a0, a1) => out.push(onWall(w, a0, a1, 0.25, H - 0.24, 0.06, 0.13, c)));
        }
        break;
      }
      case 'beams': {
        const c = spec.color ?? '#3b3e43';
        for (const w of walls) {
          out.push(onWall(w, w.a0, w.a1, H - 0.22, H, 0, 0.26, c));
          // columns stand at regular steps even behind wall items (they're structural)
          const step = 6 - 3.5 * density;
          for (let a = w.a0 + step / 2; a + 0.22 <= w.a1; a += step) out.push(onWall(w, a, a + 0.22, 0, H - 0.22, 0, 0.18, c));
        }
        break;
      }
      case 'factory_windows': {
        const top = Math.min(H - 0.45, 3.0);
        for (const w of walls)
          along(w, 1.8, 2.6 + 3 * (1 - density), (a0, a1) => {
            out.push(onWall(w, a0 - 0.05, a1 + 0.05, 1.05, top + 0.05, 0, 0.03, '#2f3236'));
            out.push(onWall(w, a0, a1, 1.1, top, 0.03, 0.035, '#cfe3ee', 'glass'));
            // mullions: a 3 x 3 grid
            for (let k = 1; k < 3; k++) {
              const a = a0 + ((a1 - a0) * k) / 3;
              out.push(onWall(w, a - 0.02, a + 0.02, 1.1, top, 0.03, 0.05, '#2f3236'));
              const y = 1.1 + ((top - 1.1) * k) / 3;
              out.push(onWall(w, a0, a1, y - 0.02, y + 0.02, 0.03, 0.05, '#2f3236'));
            }
          });
        break;
      }
      case 'plant_wall': {
        const c = spec.color ?? '#3f7d3a';
        for (const w of walls)
          along(w, 1.6, 3 + 5 * (1 - density), (a0, a1) => {
            out.push(onWall(w, a0, a1, 0.9, 2.1, 0, 0.05, shadeHex(c, -0.25)));
            for (let k = 0; k < 9; k++) {
              const a = a0 + 0.05 + rng() * (a1 - a0 - 0.3);
              const y = 0.95 + rng() * 0.9;
              out.push(onWall(w, a, a + 0.18 + rng() * 0.1, y, y + 0.18 + rng() * 0.12, 0.05, 0.1 + rng() * 0.06, k % 3 === 0 ? shadeHex(c, 0.25) : c));
            }
          });
        break;
      }
      case 'neon': {
        const c = spec.color ?? ctx.accent;
        for (const w of walls)
          along(w, 1.1, 3.5 + 5 * (1 - density), (a0, a1, i) => {
            const y0 = 1.65;
            const y1 = 2.05;
            const t = 0.035;
            if (i % 2 === 0) {
              // a rectangle outline
              out.push(onWall(w, a0, a1, y0, y0 + t, 0.02, 0.05, c, 'glow'), onWall(w, a0, a1, y1 - t, y1, 0.02, 0.05, c, 'glow'));
              out.push(onWall(w, a0, a0 + t, y0, y1, 0.02, 0.05, c, 'glow'), onWall(w, a1 - t, a1, y0, y1, 0.02, 0.05, c, 'glow'));
            } else {
              // a zig-zag ("lightning") of short bars
              for (let k = 0; k < 5; k++) {
                const a = a0 + (k * (a1 - a0)) / 5;
                const y = k % 2 ? y1 - 0.15 : y0 + 0.05;
                out.push(onWall(w, a, a + (a1 - a0) / 5 + t, y, y + t, 0.02, 0.05, c, 'glow'), onWall(w, a, a + t, y0 + 0.05, y1 - 0.12, 0.02, 0.05, c, 'glow'));
              }
            }
          });
        break;
      }
      case 'certificates': {
        for (const w of walls)
          along(w, 1.15, 3 + 5 * (1 - density), (a0) => {
            for (let k = 0; k < 3; k++) {
              const a = a0 + k * 0.42;
              out.push(onWall(w, a, a + 0.3, 1.45, 1.83, 0, 0.025, spec.color ?? '#6b4a2b'));
              out.push(onWall(w, a + 0.04, a + 0.26, 1.5, 1.78, 0.025, 0.03, '#f4efe2'));
            }
          });
        break;
      }
      case 'string_lights': {
        const c = spec.color ?? ctx.practical;
        for (const w of walls) {
          const span = 2;
          for (let a = w.a0 + 0.2; a < w.a1 - 0.2; a += 0.32) {
            const f = ((a - w.a0) % span) / span;
            const y = H - 0.32 - 0.14 * Math.sin(Math.PI * f);
            out.push(onWall(w, a, a + 0.05, y, y + 0.06, 0.05, 0.1, c, 'glow'));
          }
        }
        break;
      }
      case 'pendant_bulbs': {
        const c = spec.color ?? ctx.practical;
        const bulb = (x: number, z: number) => {
          out.push({ x0: x - 0.01, x1: x + 0.01, z0: z - 0.01, z1: z + 0.01, y0: 2.2, y1: H, color: '#222326', mat: 'solid' });
          out.push({ x0: x - 0.07, x1: x + 0.07, z0: z - 0.07, z1: z + 0.07, y0: 2.06, y1: 2.2, color: c, mat: 'glow' });
        };
        if (area.kind === 'room') {
          // one over each pair of facing desks (where 'desk' meets its 'desk_back')
          for (const f of area.furniture) if (f.kind === 'desk' && rng() < density) bulb(f.tx * TILE_M + (f.dx ?? 0) * UNIT_M + TILE_M, f.ty * TILE_M + (f.dy ?? 0) * UNIT_M);
        } else overhead(area, 3.2 + 3 * (1 - density), bulb);
        break;
      }
      case 'fluorescent': {
        const c = spec.color ?? ctx.practical;
        overhead(area, 2.6 + 3 * (1 - density), (x, z) => {
          out.push({ x0: x - 0.6, x1: x + 0.6, z0: z - 0.1, z1: z + 0.1, y0: 2.4, y1: 2.45, color: '#c9ccd0', mat: 'solid' });
          out.push({ x0: x - 0.55, x1: x + 0.55, z0: z - 0.06, z1: z + 0.06, y0: 2.38, y1: 2.4, color: c, mat: 'glow' });
        });
        break;
      }
      case 'wainscot':
        // drawn by building.ts along every wall run (it follows the cutaway height)
        break;
    }
  }
  return out;
}

/** Lighten (k > 0) or darken a hex color (local copy: decor stays free of the theme modules). */
function shadeHex(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16) || 0;
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `#${((ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).padStart(6, '0')}`;
}

/** Spans along a wall taken by wall items (whiteboards, signs, windows…), for wall decor to avoid. */
export function busySpans(area: AreaLayout, on: 'face' | 'south', widthTiles: (kind: AreaLayout['wallItems'][number]['kind']) => number): [number, number][] {
  return area.wallItems.filter((w) => w.on === on).map((w) => [mx(w.cx) - (widthTiles(w.kind) * TILE_M) / 2, mx(w.cx) + (widthTiles(w.kind) * TILE_M) / 2] as [number, number]);
}

