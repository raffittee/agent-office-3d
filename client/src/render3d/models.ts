// Theme models (P4-02): furniture kinds a pack draws with a glTF model. Each model is loaded once (cached by URL), its
// meshes flattened to one geometry per material, and every placement in the office drawn as one InstancedMesh per
// geometry — so a model costs the same few draw calls with 1 or 100 copies. Rooms dim and grow through the instance
// colors and matrices. A model that fails to load falls back to the procedural kit.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { AreaLayout } from '../core/layout/types';
import type { RoomState } from '../core/sim/room-state';
import type { Sim } from '../core/sim/sim';
import type { FurnitureKind } from '../core/vocab';
import type { ThemeEntry } from '../themes/registry';
import { buildScale, roomBrightness } from './building';
import { fitModel, modelYaw } from './models-fit';
import { TILE_M, UNIT_M } from './units';

interface LoadedModel {
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  bbox: THREE.Box3;
}

const cache = new Map<string, Promise<LoadedModel>>();
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** Loads a model and flattens it: one geometry per material, in model space, Lambert-shaded like the kit. */
function loadModel(url: string): Promise<LoadedModel> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
      const bbox = new THREE.Box3();
      gltf.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
        g.computeBoundingBox();
        bbox.union(g.boundingBox!);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const m = mats[0] as THREE.Material;
        const list = groups.get(m) ?? [];
        list.push(g);
        groups.set(m, list);
      });
      const parts = [...groups].map(([m, geos]) => {
        const src = m as THREE.MeshStandardMaterial;
        const material = new THREE.MeshLambertMaterial({ color: src.color ?? 0xffffff, map: src.map ?? null, vertexColors: !!geos[0]!.attributes.color, transparent: src.transparent, opacity: src.opacity });
        const geometry = geos.length === 1 ? geos[0]! : mergeAll(geos);
        return { geometry, material };
      });
      return { parts, bbox };
    });
    cache.set(url, p);
  }
  return p;
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // geometries of one material share attributes in practice; drop the ones that differ so the merge can't fail
  const common = Object.keys(geos[0]!.attributes).filter((a) => geos.every((g) => g.attributes[a]));
  for (const g of geos) for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
  const nonIndexed = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const a of common) {
    const size = nonIndexed[0]!.attributes[a]!.itemSize;
    const total = nonIndexed.reduce((n, g) => n + g.attributes[a]!.count, 0);
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const g of nonIndexed) {
      const attr = g.attributes[a]!;
      for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) arr[off++] = attr.getComponent(i, k);
    }
    out.setAttribute(a, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

export interface ModelArea {
  layout: AreaLayout;
  room: RoomState | null;
}

interface Placement {
  kind: FurnitureKind;
  room: RoomState | null;
  matrix: THREE.Matrix4;
}

const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Matrix4();
const tmpC = new THREE.Color();

export class ModelView {
  readonly root = new THREE.Group();
  /** Kinds whose model has loaded (the building skips them in the procedural kit). */
  ready = new Set<FurnitureKind>();
  private models = new Map<FurnitureKind, LoadedModel>();
  private meshes = new Map<FurnitureKind, THREE.InstancedMesh[]>();
  private placements = new Map<FurnitureKind, Placement[]>();
  private key = '';
  private entry: ThemeEntry | null = null;
  private gen = 0;

  constructor(private readonly onReady: (kinds: ReadonlySet<FurnitureKind>) => void) {
    this.root.name = 'theme-models';
  }

  /** Loads the theme's models; `onReady` fires as they arrive. */
  setTheme(entry: ThemeEntry): void {
    this.entry = entry;
    const gen = ++this.gen;
    this.clear();
    this.ready = new Set();
    this.onReady(this.ready);
    const furniture = entry.look.pack.furniture ?? {};
    for (const [kind, spec] of Object.entries(furniture) as [FurnitureKind, NonNullable<(typeof furniture)[string]>][]) {
      if (!spec.model) continue;
      const url = entry.url(spec.model);
      if (!url) {
        console.warn(`[themes] ${entry.look.id}: ${spec.model} is not bundled`);
        continue;
      }
      loadModel(url)
        .then((m) => {
          if (gen !== this.gen) return;
          this.models.set(kind, m);
          this.ready = new Set([...this.ready, kind]);
          this.key = '';
          this.onReady(this.ready);
        })
        .catch((err: unknown) => console.warn(`[themes] ${entry.look.id}: can't load ${spec.model}, using the procedural ${kind}`, err));
    }
  }

  private clear(): void {
    for (const list of this.meshes.values()) for (const m of list) this.root.remove(m);
    this.meshes.clear();
    this.models.clear();
    this.placements.clear();
    this.key = '';
  }

  /** Collects placements when the layout changes, then updates room light and growth. */
  sync(sim: Sim, now: number): void {
    if (!this.models.size || !this.entry) return;
    const key = `${sim.layoutVersion}|${[...sim.rooms.values()].map((r) => r.version).join(',')}`;
    this.syncAreas(() => {
      const areas: ModelArea[] = [...sim.building.core.map((layout) => ({ layout, room: null })), { layout: sim.building.corridor, room: null }];
      for (const room of sim.rooms.values()) if (room.present) areas.push({ layout: room.layout, room });
      return areas;
    }, key, now);
  }

  /** The same for any set of areas (the preview page); `key` changes when they do. */
  syncAreas(areas: () => ModelArea[], key: string, now: number): void {
    if (!this.models.size || !this.entry) return;
    const k = `${key}|${this.models.size}`;
    if (k !== this.key) {
      this.key = k;
      this.collect(areas());
    }
    for (const [kind, list] of this.placements) {
      for (const mesh of this.meshes.get(kind) ?? []) {
        list.forEach((p, i) => {
          const room = p.room;
          const grow = room ? buildScale(room.phase, room.progress(now)) : 1;
          mesh.setMatrixAt(i, grow === 1 ? p.matrix : tmpM.copy(tmpS.makeScale(1, grow, 1)).multiply(p.matrix));
          mesh.setColorAt(i, tmpC.setScalar(room ? roomBrightness(room.light(now)) : 1));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private collect(areas: ModelArea[]): void {
    const furniture = this.entry!.look.pack.furniture ?? {};
    this.placements.clear();
    for (const { layout, room } of areas) {
      for (const f of layout.furniture) {
        const model = this.models.get(f.kind);
        if (!model) continue;
        const spec = furniture[f.kind]!;
        const fit = fitModel(model.bbox, f.kind, modelYaw(f.kind, f.variant, spec.yaw ?? 0), spec.scale ?? 1);
        const ox = f.tx * TILE_M + (f.dx ?? 0) * UNIT_M + fit.x;
        const oz = f.ty * TILE_M + (f.dy ?? 0) * UNIT_M + fit.z;
        const m = new THREE.Matrix4().compose(new THREE.Vector3(ox, fit.y, oz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (fit.yaw * Math.PI) / 180), new THREE.Vector3(fit.scale, fit.scale, fit.scale));
        const list = this.placements.get(f.kind) ?? [];
        list.push({ kind: f.kind, room, matrix: m });
        this.placements.set(f.kind, list);
      }
    }
    // (re)size the instanced meshes to the placements
    for (const [kind, model] of this.models) {
      const n = this.placements.get(kind)?.length ?? 0;
      const cur = this.meshes.get(kind);
      if (cur && cur[0] && cur[0].instanceMatrix.count >= n) {
        for (const m of cur) m.count = n;
        continue;
      }
      for (const m of cur ?? []) this.root.remove(m);
      const cap = Math.max(8, Math.ceil(n * 1.5));
      const list = model.parts.map(({ geometry, material }) => {
        const mesh = new THREE.InstancedMesh(geometry, material, cap);
        mesh.count = n;
        mesh.frustumCulled = false;
        mesh.setColorAt(0, tmpC.setScalar(1));
        this.root.add(mesh);
        return mesh;
      });
      this.meshes.set(kind, list);
    }
  }

  dispose(): void {
    for (const list of this.meshes.values()) for (const m of list) m.dispose();
    this.clear();
  }
}
