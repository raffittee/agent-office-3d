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

/**
 * Places items of `width` along a wall wherever they fit, from the left, at least `step` apart (centre to centre):
 * unlike `along` it doesn't keep to a fixed grid, so a few gaps between wall items are enough.
 */
function spaced(w: FullWall, width: number, step: number, fn: (a0: number, a1: number, i: number) => void): void {
  let last = -Infinity;
  let i = 0;
  for (let a = w.a0 + 0.1; a + width <= w.a1 - 0.1 + 1e-9; a += 0.1) {
    if (a + width / 2 - last < step || !free(w, a, a + width)) continue;
    last = a + width / 2;
    fn(a, a + width, i++);
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

// ---- rooms and the building (P10-06): window frames, door frames, and light fixtures that hang off the far walls

function sortedZ(plane: number, dir: 1 | -1, d0: number, d1: number): [number, number] {
  const a = plane + dir * d0;
  const b = plane + dir * d1;
  return a < b ? [a, b] : [b, a];
}

/** A window on a wall running along x: its centre, size (outer frame), the wall's room-side plane and which way the room lies. */
export interface WindowSpec {
  cx: number;
  /** Height of the window's centre (m). */
  y: number;
  w: number;
  h: number;
  plane: number;
  dir: 1 | -1;
  frame: string;
  /** The sky seen through the window. */
  sky: string;
}

/**
 * A window with depth: a frame standing out of the wall, a sill and a head, a sky-colored backing, thin mullions and a
 * glass pane set back from the frame's face. The pane is the only 'glass' box (it carries the sky reflection).
 */
export function windowBoxes(s: WindowSpec): DecorBox[] {
  const out: DecorBox[] = [];
  const x0 = s.cx - s.w / 2;
  const x1 = s.cx + s.w / 2;
  const y0 = s.y - s.h / 2;
  const y1 = s.y + s.h / 2;
  const B = 0.06;
  const add = (ax0: number, ax1: number, ay0: number, ay1: number, d0: number, d1: number, color: string, mat: PartMaterial = 'solid') => {
    const [z0, z1] = sortedZ(s.plane, s.dir, d0, d1);
    out.push({ x0: ax0, x1: ax1, y0: ay0, y1: ay1, z0, z1, color, mat });
  };
  const sill = shadeHex(s.frame, 0.25);
  // the frame
  add(x0, x0 + B, y0, y1, 0, 0.07, s.frame);
  add(x1 - B, x1, y0, y1, 0, 0.07, s.frame);
  add(x0 + B, x1 - B, y1 - B, y1, 0, 0.07, s.frame);
  add(x0 + B, x1 - B, y0, y0 + B, 0, 0.07, s.frame);
  // sill and head
  add(x0 - 0.05, x1 + 0.05, y0 - 0.045, y0 + 0.01, 0, 0.15, sill);
  add(x0 - 0.03, x1 + 0.03, y1, y1 + 0.04, 0, 0.09, sill);
  // the sky: a lighter band at the horizon
  const mid = y0 + B + (y1 - y0 - 2 * B) * 0.42;
  add(x0 + B, x1 - B, y0 + B, mid, 0.012, 0.02, shadeHex(s.sky, 0.5));
  add(x0 + B, x1 - B, mid, y1 - B, 0.012, 0.02, s.sky);
  // mullions: one vertical, one horizontal
  add(s.cx - 0.015, s.cx + 0.015, y0 + B, y1 - B, 0.02, 0.058, s.frame);
  add(x0 + B, x1 - B, s.y - 0.015, s.y + 0.015, 0.02, 0.058, s.frame);
  // the pane, set back 3 cm from the frame's face
  add(x0 + B, x1 - B, y0 + B, y1 - B, 0.036, 0.043, '#cfe8f5', 'glass');
  return out;
}

/** A doorway through a wall run along x: between `x0` and `x1`, the wall's depth `z0..z1`. */
export interface DoorSpec {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The wall's drawn height: full height, or the cutaway height. */
  h: number;
  /** A full-height wall: it gets a lintel over the opening and an open door. */
  full: boolean;
  wallHeight: number;
  base: string;
  trim: string;
  coping: string;
  leaf: string;
  /** Which way the room lies from the wall: +1 = towards +z (north walls), -1 = towards -z (south walls). */
  roomSide: 1 | -1;
}

export interface DoorParts {
  boxes: DecorBox[];
  /** An open door leaf: hinge point (x, z), length, height and the angle (radians) it is open by, towards the room. */
  leaf: { hx: number; hz: number; len: number; h: number; angle: number; roomSide: 1 | -1; color: string } | null;
}

/** Height of a door opening (m) in a wall of a given height. */
export function doorHeight(wallHeight: number): number {
  return Math.min(2.1, wallHeight - 0.3);
}

/** Jambs and a lintel (on a full wall: a wall piece over the opening with a header bar), plus an open leaf. */
export function doorParts(d: DoorSpec): DoorParts {
  const boxes: DecorBox[] = [];
  const J = 0.07;
  const P = 0.03;
  const add = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string) => boxes.push({ x0, x1, y0, y1, z0, z1, color, mat: 'solid' });
  if (!d.full) {
    // a cut wall: just the jambs, as high as the wall
    if (d.h >= 0.2) {
      add(d.x0, d.x0 + J, 0, d.h + 0.02, d.z0 - P, d.z1 + P, d.trim);
      add(d.x1 - J, d.x1, 0, d.h + 0.02, d.z0 - P, d.z1 + P, d.trim);
    }
    return { boxes, leaf: null };
  }
  const dh = doorHeight(d.wallHeight);
  add(d.x0, d.x0 + J, 0, dh, d.z0 - P, d.z1 + P, d.trim);
  add(d.x1 - J, d.x1, 0, dh, d.z0 - P, d.z1 + P, d.trim);
  add(d.x0, d.x1, dh - 0.07, dh, d.z0 - P, d.z1 + P, d.trim);
  // the wall over the door, with the same top as its neighbours
  if (d.wallHeight - dh > 0.02) {
    add(d.x0, d.x1, dh, d.wallHeight, d.z0, d.z1, d.base);
    add(d.x0, d.x1, d.wallHeight, d.wallHeight + 0.02, d.z0, d.z1, d.trim);
    add(d.x0 - 0.05, d.x1 + 0.05, d.wallHeight + 0.02, d.wallHeight + 0.07, d.z0 - 0.05, d.z1 + 0.05, d.coping);
  }
  const face = d.roomSide === 1 ? d.z1 : d.z0;
  const len = d.x1 - d.x0 - 2 * J - 0.02;
  return { boxes, leaf: { hx: d.x0 + J, hz: face + d.roomSide * 0.04, len, h: dh - 0.05, angle: (75 * Math.PI) / 180, roomSide: d.roomSide, color: d.leaf } };
}

/** A light switch plate on a full-height wall (centre `cx`, 1.25 m up): a plate and a toggle. */
export function switchBoxes(cx: number, plane: number, dir: 1 | -1, on: boolean): DecorBox[] {
  const out: DecorBox[] = [];
  const add = (x0: number, x1: number, y0: number, y1: number, d0: number, d1: number, color: string) => {
    const [z0, z1] = sortedZ(plane, dir, d0, d1);
    out.push({ x0, x1, y0, y1, z0, z1, color, mat: 'solid' });
  };
  add(cx - 0.05, cx + 0.05, 1.16, 1.34, 0, 0.014, '#efede6');
  add(cx - 0.013, cx + 0.013, on ? 1.255 : 1.2, on ? 1.3 : 1.245, 0.014, 0.03, '#8d9298');
  return out;
}

export type FixtureStyle = 'bulb' | 'lantern' | 'panel' | 'tube' | 'disc';

/** Which light fixture a theme hangs: from its decor kinds (neon tubes, fluorescent panels, bare bulbs, lanterns, discs). */
export function fixtureStyle(specs: readonly DecorSpec[]): FixtureStyle {
  const has = (k: DecorSpec['kind']) => specs.some((s) => s.kind === k);
  if (has('neon')) return 'tube';
  if (has('fluorescent')) return 'panel';
  if (has('beams') && has('string_lights')) return 'lantern';
  if (has('pendant_bulbs')) return 'bulb';
  return 'disc';
}

/** The spans along a wall taken by items whose top is above `minTop`: the zone the fixtures hang in. */
export function busyAbove(area: AreaLayout, on: 'face' | 'south', widthTiles: (kind: AreaLayout['wallItems'][number]['kind']) => number, minTop: number, topOf: (kind: AreaLayout['wallItems'][number]['kind']) => number): [number, number][] {
  return area.wallItems.filter((w) => w.on === on && topOf(w.kind) > minTop).map((w) => [mx(w.cx) - (widthTiles(w.kind) * TILE_M) / 2, mx(w.cx) + (widthTiles(w.kind) * TILE_M) / 2] as [number, number]);
}

/**
 * Light fixtures that hang from the full-height far walls on short brackets, so the cutaway (which has no ceiling) still
 * shows lamps over the rooms. The glowing part is a 'glow' box: it lights up at night with the room. `walls` carry the
 * spans to keep clear (see `busyAbove`). Nothing reaches more than ~0.8 m from the wall or lower than 0.7 m under its top.
 */
export function fixturesFor(walls: readonly FullWall[], specs: readonly DecorSpec[], ctx: DecorContext): DecorBox[] {
  const out: DecorBox[] = [];
  const H = ctx.wallHeight;
  const style = fixtureStyle(specs);
  const dark = '#2a2c30';
  const glow = ctx.practical;
  const step = style === 'tube' ? 3.4 : 3.0;
  for (const w of walls) {
    const widthAlong = style === 'panel' || style === 'tube' ? 1.3 : 0.5;
    spaced(w, widthAlong, step, (a0, a1) => {
      const c = (a0 + a1) / 2;
      const box = (ax0: number, ax1: number, y0: number, y1: number, d0: number, d1: number, color: string, mat: PartMaterial = 'solid') => out.push(onWall(w, ax0, ax1, y0, y1, d0, d1, color, mat));
      switch (style) {
        case 'bulb':
        case 'lantern': {
          // a bracket arm out from the wall, with the lamp hanging from its end
          box(c - 0.05, c + 0.05, H - 0.2, H - 0.08, 0, 0.03, dark);
          box(c - 0.015, c + 0.015, H - 0.16, H - 0.12, 0, 0.6, dark);
          box(c - 0.008, c + 0.008, H - 0.42, H - 0.16, 0.592, 0.608, dark);
          if (style === 'bulb') {
            box(c - 0.03, c + 0.03, H - 0.5, H - 0.42, 0.57, 0.63, dark);
            box(c - 0.06, c + 0.06, H - 0.68, H - 0.5, 0.54, 0.66, glow, 'glow');
          } else {
            // a lantern: roof, base, four posts, a glowing core
            box(c - 0.11, c + 0.11, H - 0.46, H - 0.42, 0.49, 0.71, dark);
            box(c - 0.07, c + 0.07, H - 0.66, H - 0.46, 0.53, 0.67, glow, 'glow');
            for (const [ax, ad] of [[-0.1, 0.5], [0.1, 0.5], [-0.1, 0.7], [0.1, 0.7]] as const) box(c + ax - 0.012, c + ax + 0.012, H - 0.68, H - 0.46, ad - 0.012, ad + 0.012, dark);
            box(c - 0.11, c + 0.11, H - 0.7, H - 0.66, 0.49, 0.71, dark);
          }
          break;
        }
        case 'panel': {
          // a linear fixture hung on one rod from a bracket; its top is a glowing strip (indirect light)
          box(c - 0.05, c + 0.05, H - 0.2, H - 0.08, 0, 0.03, '#9a9da1');
          box(c - 0.015, c + 0.015, H - 0.16, H - 0.12, 0, 0.62, '#9a9da1');
          box(c - 0.01, c + 0.01, H - 0.5, H - 0.16, 0.6, 0.62, '#9a9da1');
          box(c - 0.62, c + 0.62, H - 0.54, H - 0.47, 0.54, 0.7, '#d4d7da');
          box(c - 0.56, c + 0.56, H - 0.47, H - 0.455, 0.585, 0.655, glow, 'glow');
          break;
        }
        case 'tube': {
          // a neon tube standing off the wall on two brackets, and a short one under it
          for (const k of [-0.5, 0.5]) box(c + k - 0.012, c + k + 0.012, H - 0.46, H - 0.34, 0, 0.14, dark);
          box(c - 0.62, c + 0.62, H - 0.43, H - 0.37, 0.12, 0.18, glow, 'glow');
          box(c - 0.32, c + 0.32, H - 0.57, H - 0.52, 0.12, 0.17, glow, 'glow');
          break;
        }
        case 'disc': {
          // a round shade hung on a cord from a bracket; the top of the shade glows softly
          box(c - 0.05, c + 0.05, H - 0.2, H - 0.08, 0, 0.03, '#d9d6cf');
          box(c - 0.015, c + 0.015, H - 0.16, H - 0.12, 0, 0.6, '#d9d6cf');
          box(c - 0.008, c + 0.008, H - 0.46, H - 0.16, 0.592, 0.608, '#d9d6cf');
          box(c - 0.21, c + 0.21, H - 0.54, H - 0.47, 0.39, 0.81, '#ecebe6');
          box(c - 0.15, c + 0.15, H - 0.47, H - 0.455, 0.45, 0.75, glow, 'glow');
          break;
        }
      }
    });
  }
  return out;
}

