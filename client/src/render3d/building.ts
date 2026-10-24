// Building meshes (P2-06): floors, rugs, walls with doorways and the cutaway, wall items and procedural furniture.
// One group per area, each merged into at most three meshes (solid, glass, glow), so the whole office stays far below
// the draw-call budget. Reads the sim's layout; never writes it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILDING_H, COL_W } from '../core/constants';
import { RECEPTION_ID } from '../core/layout/core';
import type { AreaLayout, WallSegment } from '../core/layout/types';
import type { RoomState } from '../core/sim/room-state';
import type { Sim } from '../core/sim/sim';
import { FURNITURE, TILE, type FloorKind } from '../core/vocab';
import { furnitureParts, wallItemShape, type PartMaterial } from './kit';
import { CUT_H, mx, mz, TILE_M, UNIT_M, WALL_H } from './units';

/** Wall display: walls facing the camera cut to CUT_H ('cut') or almost removed ('hide'). */
export type Cutaway = 'cut' | 'hide';

const FLOOR_COLORS: Record<FloorKind, string> = {
  carpet: '#c9d1dc',
  wood: '#c79a6b',
  tile_check: '#e7e2d8',
  tile_white: '#e9eef0',
  concrete: '#c4c2bd',
  marble: '#e8e4dc',
  grass: '#8fbf6a',
  sidewalk: '#cfcac0',
  street: '#6b6e73',
};

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

export interface AreaView {
  group: THREE.Group;
  solid: THREE.MeshLambertMaterial;
  glass: THREE.MeshLambertMaterial;
  glow: THREE.MeshBasicMaterial;
  dispose(): void;
}

interface BuildCtx {
  cols: number;
  far: ReturnType<typeof farSides>;
  cutaway: Cutaway;
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

/** Builds one area's meshes. */
export function buildArea(area: AreaLayout, ctx: BuildCtx): AreaView {
  const bucket: Bucket = { solid: [], glass: [], glow: [] };

  // ---- floors and rugs
  for (const f of area.floors) {
    const base = f.kind === 'carpet' && f.tint ? f.tint : FLOOR_COLORS[f.kind];
    const tinted = area.floorTint ? tmpColor.set(base).lerp(new THREE.Color(area.floorTint), 0.18).getHexString() : null;
    bucket.solid.push(slab(mx(f.x), mz(f.y), mx(f.w), mz(f.h), 0, tinted ? `#${tinted}` : base));
  }
  for (const r of area.rugs) bucket.solid.push(slab(mx(r.x), mz(r.y), mx(r.w), mz(r.h), 0.006, r.color));

  // ---- walls
  const fullWalls: WallSegment[] = [];
  for (const w of area.walls) {
    const full = wallFull(w, area, ctx);
    if (full) fullWalls.push(w);
    const h = full ? WALL_H : ctx.cutaway === 'hide' ? 0.06 : CUT_H;
    const base = w.style.exterior ? shade(w.style.base, 0.9) : w.style.base;
    const trim = w.style.trim ?? shade(base, 0.75);
    if (w.kind === 'cap') {
      bucket.solid.push(box(mx(w.x), mx(w.x + w.w), 0, h, mz(w.y), mz(w.y + w.h), base), box(mx(w.x), mx(w.x + w.w), h, h + 0.02, mz(w.y), mz(w.y + w.h), trim));
      continue;
    }
    // a north face is 2 tiles deep (Habblaud draws its face there); a south wall 1 tile
    const depth = w.kind === 'face' ? 2 * TILE : TILE;
    for (const [a, c] of runs(w.x, w.w, w.doorways)) {
      bucket.solid.push(box(mx(a), mx(c), 0, h, mz(w.y), mz(w.y + depth), base), box(mx(a), mx(c), h, h + 0.02, mz(w.y), mz(w.y + depth), trim));
      // skirting on the room side
      const zs = w.kind === 'face' ? mz(w.y + depth) : mz(w.y);
      bucket.solid.push(box(mx(a), mx(c), 0, Math.min(h, 0.1), zs - 0.012, zs + 0.012, trim));
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
    const dz = it.on === 'face' ? 0.03 : -0.03;
    bucket[shape.mat ?? 'solid'].push(box(mx(it.cx) - half, mx(it.cx) + half, shape.y - shape.h / 2, shape.y + shape.h / 2, Math.min(z, z + dz), Math.max(z, z + dz), shape.color));
    if (it.kind === 'whiteboard') bucket.solid.push(box(mx(it.cx) - half - 0.03, mx(it.cx) + half + 0.03, shape.y - shape.h / 2 - 0.04, shape.y - shape.h / 2, z, z + 0.06, '#9aa3ad'));
  }

  // ---- furniture
  for (const f of area.furniture) {
    const ox = f.tx * TILE_M + (f.dx ?? 0) * UNIT_M;
    const oz = f.ty * TILE_M + (f.dy ?? 0) * UNIT_M;
    for (const p of furnitureParts(f.kind, f.variant)) bucket[p.mat ?? 'solid'].push(box(ox + p.x0, ox + p.x1, p.y0, p.y1, oz + p.z0, oz + p.z1, p.color));
  }

  const group = new THREE.Group();
  group.name = area.id;
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  const glass = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  const add = (parts: THREE.BufferGeometry[], mat: THREE.Material, order = 0) => {
    if (!parts.length) return;
    const geo = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  };
  add(bucket.solid, solid);
  add(bucket.glow, glow);
  add(bucket.glass, glass, 1);
  return {
    group,
    solid,
    glass,
    glow,
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
  private ground: THREE.Mesh;
  private cols = -1;

  constructor() {
    this.root.name = 'building';
    // a ground plate under the building, so it reads as a diorama
    this.ground = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1), new THREE.MeshLambertMaterial({ color: '#cbc6bc' }));
    this.ground.position.y = -0.151;
    this.root.add(this.ground);
  }

  /** Brings meshes in line with the sim; call every frame (cheap when nothing changed). */
  sync(sim: Sim, yawDeg: number, cutaway: Cutaway, now: number): void {
    const b = sim.building;
    const quad = cutKey(yawDeg);
    const ctx: BuildCtx = { cols: b.cols, far: farSides(yawDeg), cutaway };
    const areas: { layout: AreaLayout; room?: RoomState }[] = [...b.core.map((layout) => ({ layout })), { layout: b.corridor }];
    for (const room of sim.rooms.values()) if (room.present) areas.push({ layout: room.layout, room });
    const seen = new Set<string>();
    for (const { layout, room } of areas) {
      const key = `${b.cols}|${quad}|${cutaway}|${room?.version ?? 0}`;
      seen.add(layout.id);
      let cur = this.views.get(layout.id);
      if (!cur || cur.key !== key || cur.layout !== layout) {
        if (cur) {
          this.root.remove(cur.view.group);
          cur.view.dispose();
        }
        cur = { key, layout, view: buildArea(layout, ctx) };
        this.views.set(layout.id, cur);
        this.root.add(cur.view.group);
      }
      const g = cur.view.group;
      if (room) {
        g.scale.y = buildScale(room.phase, room.progress(now));
        const k = roomBrightness(room.light(now));
        cur.view.solid.color.setScalar(k);
        cur.view.glass.color.setScalar(k);
        cur.view.glow.color.setScalar(0.15 + 0.85 * Math.max(0, Math.min(1, room.light(now))));
      }
    }
    for (const [id, cur] of this.views) {
      if (seen.has(id)) continue;
      this.root.remove(cur.view.group);
      cur.view.dispose();
      this.views.delete(id);
    }
    if (b.cols !== this.cols) {
      this.cols = b.cols;
      const w = b.rect.w * TILE_M;
      const d = b.rect.h * TILE_M;
      this.ground.scale.set(w + 1.2, 1, d + 1.2);
      this.ground.position.set(w / 2, -0.151, d / 2);
    }
    this.syncDoors(sim);
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
  }
}
