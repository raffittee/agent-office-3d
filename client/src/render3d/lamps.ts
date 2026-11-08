// Warm lamp light pools at night (P10-19): after dark, every lit room's lamps (floor lamps and the theme's ceiling
// fixtures) throw a soft pool of warm light on the floor, and the desks and tables in reach catch it too. Each pool is
// one instance of a flat quad with a radial-gradient texture (a tiny shared canvas), drawn with additive-style
// blending and no depth writes, so the whole office costs ONE draw call and no real lights. A pool never leaves its
// area: the fragment shader fades it out at the area's walls. The placement and strengths are pure (lamps-model.ts).
import * as THREE from 'three';
import type { LightLevels } from '../core/daylight';
import type { AreaLayout } from '../core/layout/types';
import type { RoomState } from '../core/sim/room-state';
import type { Sim } from '../core/sim/sim';
import type { Look } from '../themes/look';
import { buildScale } from './building';
import { decorFor } from './decor';
import { lampsFromFurniture, lampsFromGlowBoxes, poolStrength, poolsFor, tablesFromFurniture, type Pool } from './lamps-model';
import { TILE_M } from './units';

/** The color of lamp light, in linear RGB (a warm tungsten white), and how much of it a full-strength pool adds. */
const WARM = new THREE.Color().setRGB(1.0, 0.62, 0.3);
const PEAK_GAIN = 0.5;
/** Walls are about this thick: pools fade to nothing at an area's edge, over `FADE` metres. */
const EDGE_INSET = 0.1;

/** The ceiling fixtures of the theme's decor; the same generator the building uses, so pools sit under visible lamps. */
const CEILING_DECOR = new Set(['pendant_bulbs', 'fluorescent']);

/** A soft round gradient: bright in the middle with a short plateau, easing to nothing at the rim. */
function gradientTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
      const u = Math.max(0, Math.min(1, (r - 0.1) / 0.9));
      const v = Math.round(255 * (1 - u * u * (3 - 2 * u)) ** 1.4);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // the texture is a brightness, not a color: no sRGB decoding
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

/** Patches the basic material: the pool is clipped to its area's rectangle (instance attribute `aClip`, metres). */
function clipToArea(material: THREE.MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute vec4 aClip;\nvarying vec4 vPoolClip;\nvarying vec2 vPoolXZ;\n' +
      shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n vPoolClip = aClip;\n vPoolXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader =
      'varying vec4 vPoolClip;\nvarying vec2 vPoolXZ;\n' +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n float poolEdge = min(min(vPoolXZ.x - vPoolClip.x, vPoolClip.z - vPoolXZ.x), min(vPoolXZ.y - vPoolClip.y, vPoolClip.w - vPoolXZ.y));\n diffuseColor.rgb *= smoothstep(0.0, 0.3, poolEdge);',
      );
  };
  material.customProgramCacheKey = () => 'agent-office-lamp-pools';
}

interface Entry {
  pool: Pool;
  /** Index of the area (in `areas`) this pool belongs to. */
  area: number;
}

interface AreaState {
  room: RoomState | null;
  /** The last strength written to the instance colors, to skip untouched frames. */
  strength: number;
}

const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();
const IDENTITY_Q = new THREE.Quaternion();

export class LampView {
  /** Add this to the scene; the pools' mesh lives inside it (and is replaced when the office outgrows it). */
  readonly root = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.Texture;
  private geometry = new THREE.PlaneGeometry(2, 2);
  private clip = new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
  private cap = 0;
  private entries: Entry[] = [];
  private areas: AreaState[] = [];
  private key = '';
  /** How strong the night is (`LightLevels.glassGlow`): 0 by day, so there are no pools and nothing is drawn. */
  private night = 0;
  private lastNight = -1;
  private look: Look | null = null;

  constructor() {
    this.texture = gradientTexture();
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // "screen" blending: adds light like an additive blend, but can't blow a bright floor out to white
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: false,
      toneMapped: false,
    });
    clipToArea(this.material);
    this.root.name = 'lamp-pools';
    this.mesh = this.build(32);
    this.root.add(this.mesh);
    this.root.visible = false;
  }

  private build(cap: number): THREE.InstancedMesh {
    this.cap = cap;
    this.clip = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.clip.setUsage(THREE.DynamicDrawUsage);
    this.geometry.dispose();
    this.geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.geometry.setAttribute('aClip', this.clip);
    const m = new THREE.InstancedMesh(this.geometry, this.material, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 2;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, tmpC.setScalar(0));
    return m;
  }

  /** The night amount for the frame (from the light levels). */
  setLevels(levels: LightLevels): void {
    this.night = levels.glassGlow;
  }

  /** Brings the pools in line with the sim: rebuilt when the layout or theme changes, dimmed per room every frame. */
  sync(sim: Sim, look: Look, now: number): void {
    const on = this.night > 0.002;
    if (!on) {
      this.root.visible = false;
      // by day nothing is drawn; remember to repaint when the dark comes back
      this.lastNight = -1;
      for (const a of this.areas) a.strength = -1;
      return;
    }
    const key = `${look.id}|${sim.layoutVersion}|${[...sim.rooms.values()].map((r) => r.version).join(',')}`;
    if (key !== this.key || look !== this.look) {
      this.key = key;
      this.look = look;
      this.collect(sim, look);
    }
    this.root.visible = this.entries.length > 0;
    let dirty = this.night !== this.lastNight;
    this.lastNight = this.night;
    for (const a of this.areas) {
      let s: number;
      if (a.room) {
        const grow = buildScale(a.room.phase, a.room.progress(now));
        // pools appear once the room is built, and go with its light
        s = poolStrength(this.night, a.room.light(now)) * Math.max(0, Math.min(1, (grow - 0.9) / 0.1));
      } else s = poolStrength(this.night, null);
      if (Math.abs(s - a.strength) > 0.002) {
        a.strength = s;
        dirty = true;
      }
    }
    if (!dirty) return;
    this.entries.forEach((e, i) => {
      const k = this.areas[e.area]!.strength * e.pool.peak * PEAK_GAIN;
      this.mesh.setColorAt(i, tmpC.copy(WARM).multiplyScalar(k));
    });
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private collect(sim: Sim, look: Look): void {
    const specs = look.decor.filter((d) => CEILING_DECOR.has(d.kind));
    const ctx = { wallHeight: look.wallHeight, accent: look.pack.palette.accent, practical: look.lighting.practical };
    const list: { layout: AreaLayout; room: RoomState | null }[] = [...sim.building.core.map((layout) => ({ layout, room: null })), { layout: sim.building.corridor, room: null }];
    for (const room of sim.rooms.values()) if (room.present) list.push({ layout: room.layout, room });
    this.entries = [];
    this.areas = [];
    list.forEach(({ layout, room }, ai) => {
      this.areas.push({ room, strength: -1 });
      const lamps = [...lampsFromFurniture(layout.furniture), ...(specs.length ? lampsFromGlowBoxes(decorFor(layout, [], specs, ctx)) : [])];
      if (!lamps.length) return;
      for (const pool of poolsFor(lamps, tablesFromFurniture(layout.furniture))) this.entries.push({ pool, area: ai });
    });
    if (this.entries.length > this.cap) {
      this.root.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = this.build(Math.ceil(this.entries.length * 1.5));
      this.root.add(this.mesh);
    }
    const clip = this.clip.array as Float32Array;
    this.entries.forEach((e, i) => {
      const p = e.pool;
      const r = list[e.area]!.layout.rect;
      tmpM.compose(tmpP.set(p.x, p.y, p.z), IDENTITY_Q, tmpS.set(p.rx, 1, p.rz));
      this.mesh.setMatrixAt(i, tmpM);
      clip[i * 4] = r.x * TILE_M + EDGE_INSET;
      clip[i * 4 + 1] = r.y * TILE_M + EDGE_INSET;
      clip[i * 4 + 2] = (r.x + r.w) * TILE_M - EDGE_INSET;
      clip[i * 4 + 3] = (r.y + r.h) * TILE_M - EDGE_INSET;
    });
    this.mesh.count = this.entries.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.clip.needsUpdate = true;
    this.lastNight = -1;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
