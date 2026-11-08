// Building meshes (P2-06): floors, rugs, walls with doorways and the cutaway, wall items and procedural furniture.
// One group per area, each merged into at most three meshes (solid, glass, glow), so the whole office stays far below
// the draw-call budget. Reads the sim's layout; never writes it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILDING_H, COL_W } from '../core/constants';
import { RECEPTION_ID } from '../core/layout/core';
import { mulberry32 } from '../../../shared/hash';
import type { AreaLayout, WallSegment } from '../core/layout/types';
import type { RoomState } from '../core/sim/room-state';
import type { Sim } from '../core/sim/sim';
import { FURNITURE, TILE, type FurnitureKind } from '../core/vocab';
import { roomGain, type LightLevels } from '../core/daylight';
import type { Look, SurfacePattern } from '../themes/look';
import { busyAbove, busySpans, decorFor, doorParts, fixturesFor, switchBoxes, windowBoxes, type DecorBox, type FullWall } from './decor';
import { exteriorBoxes, mixHex } from './exterior';
import { createGlassMaterial, setGlassGlow, type GlassMaterial } from './glass';
import { furnitureParts, wallItemShape, type PartMaterial } from './kit';
import { SignView, type SignStyle } from './signs';
import { besideDoor, pickSpan, signLabel, signSize, type SignSpec } from './signs-model';
import { CUT_H, mx, mz, TILE_M, UNIT_M } from './units';

/** Wall display: walls facing the camera cut to CUT_H ('cut') or almost removed ('hide'). */
export type Cutaway = 'cut' | 'hide';

/** Which outer sides of the building face away from the camera, from the camera's yaw (degrees). */
export function farSides(yawDeg: number): { north: boolean; south: boolean; west: boolean; east: boolean } {
  const r = (yawDeg * Math.PI) / 180;
  // the camera sits at (+sin, +cos) from its target: a side whose outward normal points the other way is "far"
  const cx = Math.sin(r);
  const cz = Math.cos(r);
  return { north: cz > 0.01, south: cz < -0.01, west: cx > 0.01, east: cx < -0.01 };
}

/** A key that changes only when the set of far sides changes (walls are re-laid only then). */
export function cutKey(yawDeg: number): string {
  const f = farSides(yawDeg);
  return `${+f.north}${+f.south}${+f.west}${+f.east}`;
}

type Bucket = Record<PartMaterial, THREE.BufferGeometry[]>;

const tmpColor = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

function colored(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  tmpColor.set(color).convertSRGBToLinear();
  const n = g.attributes.position!.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) tmpColor.toArray(cols, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.deleteAttribute('uv');
  return g;
}

/** An axis-aligned box in metres. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string): THREE.BufferGeometry {
  const w = Math.max(0.001, x1 - x0);
  const h = Math.max(0.001, y1 - y0);
  const d = Math.max(0.001, z1 - z0);
  return colored(new THREE.BoxGeometry(w, h, d).translate(x0 + w / 2, y0 + h / 2, z0 + d / 2), color);
}

/** A flat rectangle on the floor (y up), in metres. */
function slab(x0: number, z0: number, w: number, d: number, y: number, color: string): THREE.BufferGeometry {
  return colored(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x0 + w / 2, y, z0 + d / 2), color);
}

function shade(hex: string, k: number): string {
  return tmpColor.set(hex).multiplyScalar(k).getHexString().replace(/^/, '#');
}

/** Pattern cell size (m) and the shade jitter between neighbouring cells. */
const PATTERN: Record<SurfacePattern, { cell: number; jitter: number; strips?: boolean } | null> = {
  plain: null,
  tile: { cell: 0.5, jitter: 0.05 },
  carpet: { cell: 1, jitter: 0.04 },
  marble: { cell: 1, jitter: 0.025 },
  concrete: { cell: 2, jitter: 0.035 },
  wood: { cell: 0.2, jitter: 0.07, strips: true },
  brick: { cell: 0.5, jitter: 0.06 },
};

/** A floor patch drawn with its pattern: checker cells, slabs or planks (vertex colors, no textures). */
function patternedFloor(out: THREE.BufferGeometry[], x0: number, z0: number, w: number, d: number, color: string, pattern: SurfacePattern, seed: number): void {
  const p = PATTERN[pattern];
  if (!p) {
    out.push(slab(x0, z0, w, d, 0, color));
    return;
  }
  const rng = mulberry32(seed >>> 0);
  if (p.strips) {
    // planks run east-west
    for (let z = z0; z < z0 + d - 1e-6; z += p.cell) out.push(slab(x0, z, w, Math.min(p.cell, z0 + d - z), 0, shade(color, 1 + (rng() - 0.5) * 2 * p.jitter)));
    return;
  }
  // cells aligned to the world grid, so neighbouring areas line up
  const gx0 = Math.floor(x0 / p.cell + 1e-6);
  const gz0 = Math.floor(z0 / p.cell + 1e-6);
  for (let gz = gz0; gz * p.cell < z0 + d - 1e-6; gz++) {
    for (let gx = gx0; gx * p.cell < x0 + w - 1e-6; gx++) {
      const cx0 = Math.max(x0, gx * p.cell);
      const cz0 = Math.max(z0, gz * p.cell);
      const cx1 = Math.min(x0 + w, (gx + 1) * p.cell);
      const cz1 = Math.min(z0 + d, (gz + 1) * p.cell);
      const k = pattern === 'tile' ? ((gx + gz) % 2 ? 1 - p.jitter : 1) : 1 + (rng() - 0.5) * 2 * p.jitter;
      out.push(slab(cx0, cz0, cx1 - cx0, cz1 - cz0, 0, shade(color, k)));
    }
  }
}

/** A wall box; brick walls are built from courses of slightly different shades. */
function wallBox(out: THREE.BufferGeometry[], x0: number, x1: number, h: number, z0: number, z1: number, color: string, pattern: SurfacePattern, seed: number): void {
  if (pattern !== 'brick' || h < 0.5) {
    out.push(box(x0, x1, 0, h, z0, z1, color));
    return;
  }
  const rng = mulberry32(seed >>> 0);
  const course = 0.3;
  for (let y = 0; y < h - 1e-6; y += course) out.push(box(x0, x1, y, Math.min(h, y + course), z0, z1, shade(color, 1 + (rng() - 0.5) * 0.14)));
}

export interface AreaView {
  group: THREE.Group;
  solid: THREE.MeshLambertMaterial;
  glass: GlassMaterial;
  glow: THREE.MeshBasicMaterial;
  /** Plaques for the area's name (backing built into the meshes; the lettering is drawn by SignView). */
  signs: { spec: SignSpec; style: SignStyle }[];
  dispose(): void;
}

export interface BuildCtx {
  cols: number;
  far: ReturnType<typeof farSides>;
  cutaway: Cutaway;
  look: Look;
  /** Kinds drawn as theme models (render3d/models.ts) instead of the procedural kit. */
  modelled: ReadonlySet<FurnitureKind>;
  /** The sky's environment map, reflected by window glass (null: no reflections yet, or low quality). */
  env?: THREE.Texture | null;
  /** The sun casts shadows: solid meshes cast and receive them. */
  shadows?: boolean;
}

/** Is a wall segment on the building's outer side that faces away from the camera (so it stays full height)? */
function wallFull(w: WallSegment, area: AreaLayout, ctx: BuildCtx): boolean {
  const widthU = ctx.cols * COL_W * TILE;
  if (w.kind === 'face') return w.y <= 0 && ctx.far.north;
  if (w.kind === 'south') return w.y + TILE >= BUILDING_H * TILE - 0.5 && ctx.far.south;
  if (w.x <= 0.5) return ctx.far.west;
  if (w.x + w.w >= widthU - 0.5) return ctx.far.east;
  void area;
  return false;
}

/** Splits [x, x+w] around doorways. */
function runs(x: number, w: number, doorways: { x: number; w: number }[] | undefined): [number, number][] {
  const out: [number, number][] = [];
  let cur = x;
  for (const d of [...(doorways ?? [])].sort((a, b) => a.x - b.x)) {
    if (d.x > cur) out.push([cur, d.x]);
    cur = Math.max(cur, d.x + d.w);
  }
  if (cur < x + w) out.push([cur, x + w]);
  return out;
}

/** The cap stone of an outer wall: its trim, lightened. */
function copingColor(trim: string): string {
  return mixHex(trim, '#ffffff', 0.3);
}

/** An open door leaf (hinge at the jamb, swung into the room) as a box geometry. */
function leafGeometry(l: NonNullable<ReturnType<typeof doorParts>['leaf']>): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(l.len, l.h, 0.04).translate(l.len / 2, l.h / 2 + 0.02, 0);
  g.rotateY(-l.roomSide * l.angle);
  g.translate(l.hx, 0, l.hz);
  return colored(g, l.color);
}

const pushBoxes = (out: THREE.BufferGeometry[] | Bucket, boxes: readonly DecorBox[]): void => {
  for (const d of boxes) (Array.isArray(out) ? out : out[d.mat]).push(box(d.x0, d.x1, d.y0, d.y1, d.z0, d.z1, d.color));
};

/** Builds one area's meshes. `accent` = the room's accent color (door leaves); default the theme's. */
export function buildArea(area: AreaLayout, ctx: BuildCtx, accent: string = ctx.look.pack.palette.accent): AreaView {
  const bucket: Bucket = { solid: [], glass: [], glow: [] };

  const look = ctx.look;
  const H = look.wallHeight;
  // plaques with the area's name: the backing is built here, the lettering by SignView
  const signs: AreaView['signs'] = [];
  const signStyle: SignStyle = { bg: '#33373d', fg: '#f4f1ea', accent };
  const plaque = (kind: SignSpec['kind'], cx: number, y: number, plane: number, dir: 1 | -1, h: number): void => {
    const q = signSize(h);
    const z0 = Math.min(plane, plane + dir * 0.035);
    const z1 = Math.max(plane, plane + dir * 0.035);
    bucket.solid.push(box(cx - q.w / 2 - 0.03, cx + q.w / 2 + 0.03, y - h / 2 - 0.03, y + h / 2 + 0.03, z0, z1, signStyle.bg));
    signs.push({ spec: { kind, x: cx, y, z: plane + dir * 0.04, nx: 0, nz: dir, w: q.w, h: q.h }, style: signStyle });
  };
  const hasSignItem = area.wallItems.some((i) => i.kind === 'sign');
  // ---- floors and rugs
  for (const f of area.floors) {
    const { color, pattern } = look.floor(area.kind, f.kind, f.tint);
    const tinted = area.floorTint ? `#${tmpColor.set(color).lerp(new THREE.Color(area.floorTint), 0.18).getHexString()}` : color;
    patternedFloor(bucket.solid, mx(f.x), mz(f.y), mx(f.w), mz(f.h), tinted, pattern, f.seed);
  }
  for (const r of area.rugs) bucket.solid.push(slab(mx(r.x), mz(r.y), mx(r.w), mz(r.h), 0.006, look.rugTint ? `#${tmpColor.set(r.color).lerp(new THREE.Color(look.rugTint), 0.5).getHexString()}` : r.color));

  // ---- walls
  const fullWalls: WallSegment[] = [];
  const decorWalls: FullWall[] = [];
  /** Cut north-wall runs (room side up), for a name plaque when there is no full wall to hang it on. */
  const cutFaces: { a0: number; a1: number; plane: number; h: number }[] = [];
  const wainscot = look.decor.find((d) => d.kind === 'wainscot' && (d.on === 'everywhere' || (d.on === 'rooms') === (area.kind === 'room')));
  const widthOf = (k: FurnitureKind) => FURNITURE[k].footprint.w;
  /** How high a wall item reaches (m). */
  const topOf = (k: FurnitureKind): number => {
    const s = wallItemShape(k);
    return s ? s.y + s.h / 2 : 0;
  };
  let wallSeed = 0;
  for (const w of area.walls) {
    wallSeed++;
    const partition = w.style.partition;
    const full = !partition && wallFull(w, area, ctx);
    if (full) fullWalls.push(w);
    const h = full ? H : ctx.cutaway === 'hide' ? 0.06 : CUT_H;
    const wl = look.wall(area.kind, w.style);
    const base = w.style.exterior ? shade(wl.color, 0.9) : wl.color;
    const trim = wl.trim;
    // the wall's boxes: x0..x1 and z0..z1 in metres
    const pieces: [number, number, number, number][] = [];
    if (w.kind === 'cap') pieces.push([mx(w.x), mx(w.x + w.w), mz(w.y), mz(w.y + w.h)]);
    else {
      // a north face is 2 tiles deep (Habblaud draws its face there); a south wall 1 tile
      const depth = w.kind === 'face' ? 2 * TILE : TILE;
      for (const [a, c] of runs(w.x, w.w, w.doorways)) pieces.push([mx(a), mx(c), mz(w.y), mz(w.y + depth)]);
    }
    for (const [x0, x1, z0, z1] of pieces) {
      if (partition) {
        // open templates: a glass partition on a low base, or a low divider topped with planters
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        const thin = w.kind === 'cap' ? [cx - 0.04, cx + 0.04, z0, z1] : [x0, x1, cz - 0.04, cz + 0.04];
        const [px0, px1, pz0, pz1] = thin as [number, number, number, number];
        if (partition === 'glass') {
          bucket.solid.push(box(px0, px1, 0, 0.12, pz0, pz1, trim), box(px0, px1, 1.18, 1.22, pz0, pz1, trim));
          bucket.glass.push(box(px0 + (w.kind === 'cap' ? 0.02 : 0), px1 - (w.kind === 'cap' ? 0.02 : 0), 0.12, 1.18, pz0 + (w.kind === 'cap' ? 0 : 0.02), pz1 - (w.kind === 'cap' ? 0 : 0.02), '#cfe6f2'));
        } else {
          bucket.solid.push(box(px0, px1, 0, 0.5, pz0, pz1, base), box(px0, px1, 0.5, 0.54, pz0, pz1, trim));
        }
        continue;
      }
      wallBox(bucket.solid, x0, x1, h, z0, z1, base, wl.pattern, area.id.length * 31 + wallSeed);
      bucket.solid.push(box(x0, x1, h, h + 0.02, z0, z1, trim));
      // the roof edge of an outer wall facing away from the camera: a coping that overhangs a little
      if (full) bucket.solid.push(box(x0 - 0.05, x1 + 0.05, h + 0.02, h + 0.07, z0 - 0.05, z1 + 0.05, copingColor(trim)));
      if (w.kind !== 'cap') {
        // skirting on the room side
        const zs = w.kind === 'face' ? z1 : z0;
        bucket.solid.push(box(x0, x1, 0, Math.min(h, 0.1), zs - 0.012, zs + 0.012, trim));
        if (wainscot) bucket.solid.push(box(x0, x1, 0.1, Math.max(0.12, Math.min(h - 0.04, 0.95)), zs - 0.014, zs + 0.014, wainscot.color ?? '#8a6a4a'));
      }
      if (!full) {
        if (w.kind === 'face' && ctx.cutaway === 'cut') cutFaces.push({ a0: x0, a1: x1, plane: z1, h });
        continue;
      }
      // full walls carry the theme's wall decor
      if (w.kind === 'face') decorWalls.push({ axis: 'x', a0: x0, a1: x1, plane: z1, normal: 1, busy: busySpans(area, 'face', widthOf) });
      else if (w.kind === 'south') decorWalls.push({ axis: 'x', a0: x0, a1: x1, plane: z0, normal: -1, busy: busySpans(area, 'south', widthOf) });
      else if (x0 <= 0.5) decorWalls.push({ axis: 'z', a0: z0, a1: z1, plane: x1, normal: 1, busy: [] });
      else decorWalls.push({ axis: 'z', a0: z0, a1: z1, plane: x0, normal: -1, busy: [] });
    }

    // ---- doorways: jambs and a lintel (a post on each side of a glass or low partition), an open door, a plaque
    if (w.kind === 'cap') continue;
    const depth = w.kind === 'face' ? 2 * TILE : TILE;
    const wz0 = mz(w.y);
    const wz1 = mz(w.y + depth);
    const roomSide: 1 | -1 = w.kind === 'face' ? 1 : -1;
    for (const dw of w.doorways ?? []) {
      const dx0 = mx(dw.x);
      const dx1 = mx(dw.x + dw.w);
      // the name by the door of a room: on the camera side of a cut wall or a partition, or inside a full south wall
      const pw = signSize(0.22).w + 0.06;
      const run = { a0: mx(w.x), a1: mx(w.x + w.w) };
      const named = area.kind !== 'corridor';
      if (partition) {
        const cz = (wz0 + wz1) / 2;
        const ph = partition === 'glass' ? 1.22 : 0.54;
        bucket.solid.push(box(dx0, dx0 + 0.05, 0, ph, cz - 0.05, cz + 0.05, trim), box(dx1 - 0.05, dx1, 0, ph, cz - 0.05, cz + 0.05, trim));
        const a = named ? besideDoor({ x0: dx0, x1: dx1 }, run, [], pw) : null;
        if (a !== null) plaque('door', a + pw / 2, partition === 'glass' ? 0.62 : 0.3, cz + 0.04, 1, 0.22);
        continue;
      }
      const parts = doorParts({ x0: dx0, x1: dx1, z0: wz0, z1: wz1, h, full, wallHeight: H, base, trim, coping: copingColor(trim), leaf: accent, roomSide });
      pushBoxes(bucket, parts.boxes);
      if (parts.leaf) bucket.solid.push(leafGeometry(parts.leaf));
      if (named && full && w.kind === 'south') {
        const a = besideDoor({ x0: dx0, x1: dx1 }, run, busySpans(area, 'south', widthOf), pw);
        if (a !== null) plaque('door', a + pw / 2, 1.75, wz0, -1, 0.22);
      } else if (named && !full && ctx.cutaway === 'cut') {
        const a = besideDoor({ x0: dx0, x1: dx1 }, run, [], pw);
        if (a !== null) plaque('door', a + pw / 2, h / 2, wz1, 1, 0.22);
      }
    }
  }

  // ---- wall items
  for (const it of area.wallItems) {
    const shape = wallItemShape(it.kind);
    if (!shape) continue;
    // the item hangs on the face wall it belongs to (or on the inside of the low south wall)
    const z = it.on === 'face' ? mz(it.baseY) : mz(it.baseY - TILE);
    const onFull = fullWalls.some((w) => (w.kind === 'face') === (it.on === 'face') && it.cx >= w.x && it.cx <= w.x + w.w && Math.abs((w.kind === 'face' ? w.y + 2 * TILE : w.y) - (it.on === 'face' ? it.baseY : it.baseY - TILE)) < 1);
    if (!onFull && !shape.low) continue;
    const half = (FURNITURE[it.kind].footprint.w * TILE_M) / 2 - 0.05;
    const dir: 1 | -1 = it.on === 'face' ? 1 : -1;
    if (onFull && it.kind === 'window') {
      // a framed window with a sill, mullions and a pane set back from the frame
      const wall = fullWalls[0];
      const trim = wall ? look.wall(area.kind, wall.style).trim : '#9aa3ad';
      pushBoxes(bucket, windowBoxes({ cx: mx(it.cx), y: shape.y, w: half * 2, h: shape.h, plane: z, dir, frame: shade(trim, 0.9), sky: mixHex('#8fc4ea', look.lighting.sky, 0.25) }));
      continue;
    }
    if (onFull && it.kind === 'sign') {
      plaque('wall', mx(it.cx), shape.y, z, dir, 0.3);
      continue;
    }
    if (onFull && it.kind === 'light_switch') {
      pushBoxes(bucket, switchBoxes(mx(it.cx), z, dir, it.variant !== 'off'));
      continue;
    }
    const dz = it.on === 'face' ? 0.03 : -0.03;
    bucket[shape.mat ?? 'solid'].push(box(mx(it.cx) - half, mx(it.cx) + half, shape.y - shape.h / 2, shape.y + shape.h / 2, Math.min(z, z + dz), Math.max(z, z + dz), shape.color));
    if (it.kind === 'whiteboard') bucket.solid.push(box(mx(it.cx) - half - 0.03, mx(it.cx) + half + 0.03, shape.y - shape.h / 2 - 0.04, shape.y - shape.h / 2, z, z + 0.06, '#9aa3ad'));
  }

  // ---- furniture (kinds the theme draws as models are instanced by models.ts)
  for (const f of area.furniture) {
    if (ctx.modelled.has(f.kind)) continue;
    const ox = f.tx * TILE_M + (f.dx ?? 0) * UNIT_M;
    const oz = f.ty * TILE_M + (f.dy ?? 0) * UNIT_M;
    for (const p of furnitureParts(f.kind, f.variant, look.kit)) bucket[p.mat ?? 'solid'].push(box(ox + p.x0, ox + p.x1, p.y0, p.y1, oz + p.z0, oz + p.z1, p.color));
  }

  // ---- theme decor
  for (const d of decorFor(area, decorWalls, look.decor, { wallHeight: H, accent: look.pack.palette.accent, practical: look.lighting.practical })) bucket[d.mat].push(box(d.x0, d.x1, d.y0, d.y1, d.z0, d.z1, d.color));

  // ---- the area's name where it has no sign item or named doorway: on the widest free stretch of a full north wall
  if (!hasSignItem && !signs.length && area.kind !== 'corridor') {
    const q = signSize(0.3);
    const py = Math.min(2.35, H - 0.4);
    const faces = decorWalls.filter((fw) => fw.axis === 'x' && fw.normal === 1).sort((a, b) => b.a1 - b.a0 - (a.a1 - a.a0));
    for (const fw of faces) {
      // only what reaches up to the plaque's height is in its way
      const a = pickSpan(fw.a0, fw.a1, busyAbove(area, 'face', widthOf, py - 0.18, topOf), q.w + 0.06);
      if (a === null) continue;
      plaque('wall', a + (q.w + 0.06) / 2, py, fw.plane, 1, 0.3);
      break;
    }
    // no full wall (the south row): low on the camera side of a cut one, like a door plaque
    if (!signs.length) {
      const pw = signSize(0.22).w + 0.06;
      for (const cf of [...cutFaces].sort((a, b) => b.a1 - b.a0 - (a.a1 - a.a0))) {
        const a = pickSpan(cf.a0, cf.a1, [], pw);
        if (a === null) continue;
        plaque('door', a + pw / 2, cf.h / 2, cf.plane, 1, 0.22);
        break;
      }
    }
  }

  // ---- light fixtures hanging from the far walls (clear of the items that reach up there)
  const lampWalls: FullWall[] = decorWalls.map((fw) => ({ ...fw, busy: fw.axis === 'x' ? busyAbove(area, fw.normal === 1 ? 'face' : 'south', widthOf, H - 0.85, topOf) : [] }));
  pushBoxes(bucket, fixturesFor(lampWalls, look.decor, { wallHeight: H, accent: look.pack.palette.accent, practical: look.lighting.practical }));

  const group = new THREE.Group();
  group.name = area.id;
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  const glass = createGlassMaterial(ctx.env ?? null);
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  const add = (parts: THREE.BufferGeometry[], mat: THREE.Material, order = 0, cast = false, receive = false) => {
    if (!parts.length) return;
    const geo = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = order;
    mesh.castShadow = cast && !!ctx.shadows;
    mesh.receiveShadow = receive && !!ctx.shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  };
  add(bucket.solid, solid, 0, true, true);
  add(bucket.glow, glow, 0, false, true);
  add(bucket.glass, glass, 1);
  return {
    group,
    solid,
    glass,
    glow,
    signs,
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      solid.dispose();
      glass.dispose();
      glow.dispose();
    },
  };
}

/** Ease-out for the build animation. */
export function buildScale(phase: RoomState['phase'], progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const ease = 1 - (1 - p) ** 3;
  if (phase === 'building') return Math.max(0.001, ease);
  if (phase === 'dismantling') return Math.max(0.001, 1 - ease);
  return 1;
}

/** Brightness of a room's materials for a light level (0..1): never pitch black, so the room stays readable. */
export function roomBrightness(light: number): number {
  return 0.32 + 0.68 * Math.max(0, Math.min(1, light));
}

/**
 * The whole building: keeps one AreaView per area, rebuilt only when its layout, the building width or the cutaway
 * quadrant changes; animates room build/dismantle and lights; moves the elevator doors.
 */
export class BuildingView {
  readonly root = new THREE.Group();
  private views = new Map<string, { key: string; layout: AreaLayout; view: AreaView }>();
  private doors: THREE.Mesh[] = [];
  private doorMat = new THREE.MeshLambertMaterial({ color: '#9aa4ae' });
  /** The surroundings (foundation, sidewalk, lawn, lamps, trees): one solid mesh and one glow mesh, rebuilt with the cutaway side. */
  private exterior: THREE.Mesh[] = [];
  private exteriorMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private exteriorGlow = new THREE.MeshBasicMaterial({ vertexColors: true });
  private exteriorKey = '';
  /** The room name plaques: one instanced quad for all of them. */
  private signs = new SignView();
  private look: Look;
  private lookRev = 0;
  private modelled: ReadonlySet<FurnitureKind> = new Set();
  /** Day and night (P6-02, P10-19): the light levels, and `inside`, the tint of lit interiors (lamp light at night). */
  private levels: LightLevels | null = null;
  private inside = new THREE.Color(1, 1, 1);
  private env: THREE.Texture | null = null;
  private shadows = false;

  setAmbient(levels: LightLevels, inside: readonly [number, number, number]): void {
    this.levels = levels;
    this.inside.setRGB(inside[0] / 255, inside[1] / 255, inside[2] / 255, THREE.SRGBColorSpace);
  }

  /** The sky's environment map for the window glass (rebuilt now and then as the sky changes). */
  setEnv(env: THREE.Texture | null): void {
    const had = !!this.env;
    this.env = env;
    for (const cur of this.views.values()) {
      cur.view.glass.envMap = env;
      if (had !== !!env) cur.view.glass.needsUpdate = true;
    }
  }

  /** Whether the sun casts shadows (from the renderer's quality); set before the first sync. */
  setShadows(on: boolean): void {
    this.shadows = on;
    for (const m of this.exterior) m.receiveShadow = on;
    this.exteriorKey = ''; // rebuilt on the next sync with the new setting
  }

  constructor(look: Look) {
    this.root.name = 'building';
    this.look = look;
    // the plaques sit in the scene root's space: their matrices follow each room's build animation themselves
    this.root.add(this.signs.mesh);
  }

  /** A new theme (or the same one, reloaded): every area is rebuilt on the next sync. */
  setLook(look: Look, modelled: ReadonlySet<FurnitureKind> = this.modelled): void {
    this.look = look;
    this.modelled = modelled;
    this.lookRev++;
  }

  /** (Re)builds the surroundings: a diorama base with a foundation strip, sidewalk, curb, lawn, lamps and trees. */
  private buildExterior(w: number, d: number, far: ReturnType<typeof farSides>): void {
    for (const m of this.exterior) {
      this.root.remove(m);
      m.geometry.dispose();
    }
    this.exterior = [];
    const boxes = exteriorBoxes({ w, d, ground: this.look.groundColor, practical: this.look.lighting.practical, far });
    const solid: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];
    for (const b of boxes) (b.mat === 'glow' ? glow : solid).push(box(b.x0, b.x1, b.y0, b.y1, b.z0, b.z1, b.color));
    for (const [parts, mat] of [[solid, this.exteriorMat], [glow, this.exteriorGlow]] as const) {
      if (!parts.length) continue;
      const geo = mergeGeometries(parts);
      for (const p of parts) p.dispose();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'exterior';
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = this.shadows;
      mesh.castShadow = this.shadows && mat === this.exteriorMat;
      this.exterior.push(mesh);
      this.root.add(mesh);
    }
  }

  /** Brings meshes in line with the sim; call every frame (cheap when nothing changed). */
  sync(sim: Sim, yawDeg: number, cutaway: Cutaway, now: number): void {
    const b = sim.building;
    const quad = cutKey(yawDeg);
    const ctx: BuildCtx = { cols: b.cols, far: farSides(yawDeg), cutaway, look: this.look, modelled: this.modelled, env: this.env, shadows: this.shadows };
    const areas: { layout: AreaLayout; room?: RoomState }[] = [...b.core.map((layout) => ({ layout })), { layout: b.corridor }];
    if (b.edge) areas.push({ layout: b.edge });
    for (const room of sim.rooms.values()) if (room.present) areas.push({ layout: room.layout, room });
    const seen = new Set<string>();
    this.signs.begin();
    for (const { layout, room } of areas) {
      const key = `${b.cols}|${quad}|${cutaway}|${room?.version ?? 0}|${this.lookRev}`;
      seen.add(layout.id);
      let cur = this.views.get(layout.id);
      if (!cur || cur.key !== key || cur.layout !== layout) {
        if (cur) {
          this.root.remove(cur.view.group);
          cur.view.dispose();
        }
        cur = { key, layout, view: buildArea(layout, ctx, room?.theme.accent) };
        this.views.set(layout.id, cur);
        this.root.add(cur.view.group);
      }
      const g = cur.view.group;
      const lv = this.levels;
      if (room) {
        g.scale.y = buildScale(room.phase, room.progress(now));
        const light = Math.max(0, Math.min(1, room.light(now)));
        // by day a dark room is still lit by daylight; after dark a lit room is lit by its lamps (the gain makes up
        // for the dim sky) and a dark one falls to a dim but readable level (core/daylight.ts)
        const k = lv ? roomGain(lv, light) : roomBrightness(light);
        cur.view.solid.color.copy(this.inside).lerp(WHITE, 1 - light).multiplyScalar(k);
        cur.view.glass.color.setScalar(Math.min(1, k));
        cur.view.glow.color.setScalar(0.15 + 0.85 * light);
        if (lv) setGlassGlow(cur.view.glass, lv, light);
      } else {
        // common areas (reception, kitchen, lounge, corridor) keep their lights on
        const k = lv ? lv.litGain : 1;
        cur.view.solid.color.copy(this.inside).multiplyScalar(k);
        cur.view.glass.color.copy(this.inside);
        if (lv) setGlassGlow(cur.view.glass, lv, 1, 0.6);
      }
      // the area's name on its plaques (a room's own name; the core areas' fixed names)
      if (cur.view.signs.length) {
        const label = signLabel(layout.id, room?.info.name);
        if (label) for (const s of cur.view.signs) this.signs.add(s.spec, label, s.style, g.scale.y, cur.view.solid.color);
      }
    }
    this.signs.end();
    for (const [id, cur] of this.views) {
      if (seen.has(id)) continue;
      this.root.remove(cur.view.group);
      cur.view.dispose();
      this.views.delete(id);
    }
    const w = b.rect.w * TILE_M;
    const d = b.rect.h * TILE_M;
    const extKey = `${w}|${d}|${quad}|${this.lookRev}`;
    if (extKey !== this.exteriorKey) {
      this.exteriorKey = extKey;
      this.buildExterior(w, d, farSides(yawDeg));
    }
    // street lamps are brighter at night
    this.exteriorGlow.color.setScalar(0.6 + 0.4 * (this.levels ? this.levels.glassGlow : 0));
    this.syncDoors(sim);
    this.doorMat.color.set('#9aa4ae').multiplyScalar(this.levels ? this.levels.litGain : 1);
    this.exteriorMat.color.setScalar(this.levels ? this.levels.litGain : 1);
  }

  /** Elevator doors: two panels per elevator that slide apart with the door state (0..4). */
  private syncDoors(sim: Sim): void {
    const reception = sim.building.core.find((a) => a.id === RECEPTION_ID);
    const items = reception?.wallItems.filter((w) => w.kind === 'elevator') ?? [];
    while (this.doors.length < items.length * 2) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2.1, 0.04), this.doorMat);
      this.doors.push(m);
      this.root.add(m);
    }
    items.forEach((it, i) => {
      const open = Math.max(0, Math.min(1, (sim.elevators[i]?.door ?? 0) / 4));
      const half = (FURNITURE.elevator.footprint.w * TILE_M) / 2 - 0.12;
      const panel = half;
      const z = mz(it.baseY) + 0.05;
      for (const side of [0, 1] as const) {
        const m = this.doors[i * 2 + side]!;
        const sign = side === 0 ? -1 : 1;
        m.scale.x = Math.max(0.02, panel * (1 - open * 0.92));
        m.position.set(mx(it.cx) + sign * (panel - m.scale.x / 2), 1.05, z);
      }
    });
  }

  /** Bounds of the building in metres (x0, z0, x1, z1). */
  bounds(sim: Sim): { x0: number; z0: number; x1: number; z1: number } {
    const r = sim.building.rect;
    return { x0: r.x * TILE_M, z0: r.y * TILE_M, x1: (r.x + r.w) * TILE_M, z1: (r.y + r.h) * TILE_M };
  }

  dispose(): void {
    for (const cur of this.views.values()) cur.view.dispose();
    this.views.clear();
    this.doorMat.dispose();
    for (const m of this.exterior) m.geometry.dispose();
    this.exterior = [];
    this.exteriorMat.dispose();
    this.exteriorGlow.dispose();
    this.signs.dispose();
  }
}
