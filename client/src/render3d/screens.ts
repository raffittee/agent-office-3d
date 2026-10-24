// Live monitors (P3-05): every desk screen is one instance of a single mesh, textured from a shared 512×512 canvas
// atlas with one tile per screen mode. Animated tiles (code, terminal, progress, alert…) are redrawn a few times a
// second; brightness follows the room's light. One draw call for all screens.
import * as THREE from 'three';
import type { Sim } from '../core/sim/sim';
import type { Character } from '../core/sim/character';
import type { ScreenMode } from '../core/vocab';
import { deskScreen, deskScreenMode, SCREEN_MODES } from './screens-model';
import { TILE_M, UNIT_M } from './units';

const TILE_PX = 128;
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpM = new THREE.Matrix4();
const FLAT = new THREE.Vector3(1, 0.001, 1);
const tmpColor = new THREE.Color();
const GRID = 4;
const REDRAW_MS = 250;

function drawTile(ctx: CanvasRenderingContext2D, mode: ScreenMode, x0: number, y0: number, t: number): void {
  const s = TILE_PX;
  const bg: Record<string, string> = { off: '#0d1626', standby: '#1c3d70', idle: '#203a5c', terminal: '#0f1512', progress: '#0f1512', alert: '#5a2a00' };
  ctx.fillStyle = bg[mode] ?? '#f4f6fa';
  ctx.fillRect(x0, y0, s, s);
  const line = (x: number, y: number, w: number, color: string, h = 6) => {
    ctx.fillStyle = color;
    ctx.fillRect(x0 + x, y0 + y, w, h);
  };
  const tick = Math.floor(t / REDRAW_MS);
  switch (mode) {
    case 'off':
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x0 + s * 0.6, y0);
      ctx.lineTo(x0 + s, y0);
      ctx.lineTo(x0 + s * 0.3, y0 + s);
      ctx.lineTo(x0, y0 + s);
      ctx.fill();
      return;
    case 'standby': {
      const r = 14 + 4 * Math.sin(t / 600);
      ctx.fillStyle = '#7fb2ff';
      ctx.beginPath();
      ctx.arc(x0 + s / 2, y0 + s / 2, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case 'idle':
      for (let i = 0; i < 5; i++) {
        const k = (tick * 3 + i * 23) % s;
        line((i * 29 + k) % (s - 12), k, 10, ['#6fd1ff', '#ffd36f', '#ff8fb1', '#9dff8f', '#c49bff'][i]!, 10);
      }
      return;
    case 'code':
      line(0, 0, s, '#e3e8f0', 12);
      for (let i = 0; i < 12; i++) {
        const k = (i + tick) % 17;
        line(8 + (k % 4) * 8, 18 + i * 9, 24 + ((k * 37) % 60), ['#4a78d6', '#c2543c', '#3f9b5a', '#8a5bc4'][k % 4]!);
      }
      return;
    case 'terminal':
    case 'progress':
      for (let i = 0; i < 10; i++) line(6, 8 + i * 10, 18 + (((i + tick) * 29) % 80), '#4fe07a');
      if (mode === 'progress') {
        line(10, s - 22, s - 20, '#24402c', 10);
        line(10, s - 22, ((tick * 6) % (s - 20)) + 4, '#4fe07a', 10);
      }
      return;
    case 'browser':
    case 'search':
      line(0, 0, s, '#d7dce3', 14);
      line(8, 4, s - 40, '#ffffff', 6);
      if (mode === 'search') {
        line(20, 30, s - 40, '#ffffff', 12);
        for (let i = 0; i < 4; i++) line(14, 54 + i * 16, 60 + ((i * 41) % 40), '#3b6fd8', 5);
      } else {
        line(10, 24, s - 20, '#9fc0f2', 34);
        for (let i = 0; i < 6; i++) line(10, 66 + i * 9, s - 30 - ((i * 17) % 40), '#9aa3ad', 5);
      }
      return;
    case 'chat':
      for (let i = 0; i < 5; i++) {
        const left = (i + tick) % 2 === 0;
        line(left ? 8 : 48, 10 + i * 22, 70, left ? '#dfe6f2' : '#4a86e8', 16);
      }
      return;
    case 'docs':
      line(14, 12, s - 28, '#cfd6e0', 10);
      for (let i = 0; i < 10; i++) line(14, 32 + i * 9, s - 28 - ((i * 23) % 30), '#9aa3ad', 4);
      return;
    case 'tasks':
      for (let i = 0; i < 6; i++) {
        line(12, 12 + i * 18, 10, i < 3 ? '#3f9b5a' : '#b8c0c8', 10);
        line(30, 14 + i * 18, 60 + ((i * 19) % 30), '#7b8794', 6);
      }
      return;
    case 'alert':
      ctx.fillStyle = tick % 2 ? '#ffb347' : '#e0861f';
      ctx.fillRect(x0 + 8, y0 + 8, s - 16, s - 16);
      ctx.fillStyle = '#3a2300';
      ctx.fillRect(x0 + s / 2 - 6, y0 + 28, 12, 50);
      ctx.fillRect(x0 + s / 2 - 6, y0 + 88, 12, 12);
      return;
    default:
      return;
  }
}

/** Where a mode's tile sits in the atlas (UV offset; tiles are 1/GRID of the texture). */
function tileOffset(mode: ScreenMode): [number, number] {
  const i = Math.max(0, SCREEN_MODES.indexOf(mode));
  return [(i % GRID) / GRID, 1 - (Math.floor(i / GRID) + 1) / GRID];
}

export class ScreenView {
  readonly mesh: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly tiles: THREE.InstancedBufferAttribute;
  private desks: { id: string; roomId: string | null; matrix: THREE.Matrix4 }[] = [];
  private layoutVersion = -1;
  private lastDraw = 0;

  constructor(cap = 256) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = TILE_PX * GRID;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.tiles = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.tiles.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTile', this.tiles);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nattribute vec2 aTile;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n vMapUv = uv * ${(1 / GRID).toFixed(4)} + aTile;`);
    };
    mat.customProgramCacheKey = () => 'agent-office-screens';
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.redraw(0);
  }

  private redraw(t: number): void {
    SCREEN_MODES.forEach((mode, i) => drawTile(this.ctx, mode, (i % GRID) * TILE_PX, Math.floor(i / GRID) * TILE_PX, t));
    this.texture.needsUpdate = true;
  }

  /** Re-collects desks when the building changes. */
  private collect(sim: Sim): void {
    this.desks = [];
    const areas = [...sim.rooms.values()].filter((r) => r.present).map((r) => r.layout);
    for (const area of areas) {
      for (const f of area.furniture) {
        const p = deskScreen(f.kind);
        if (!p) continue;
        const x = f.tx * TILE_M + (f.dx ?? 0) * UNIT_M + p.x;
        const z = f.ty * TILE_M + (f.dy ?? 0) * UNIT_M + p.z;
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, p.y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.facing === 1 ? 0 : Math.PI, 0)), new THREE.Vector3(p.w, p.h, 1));
        this.desks.push({ id: f.id, roomId: area.id, matrix: m });
      }
    }
    if (this.desks.length > this.mesh.instanceMatrix.count) this.desks.length = this.mesh.instanceMatrix.count;
  }

  sync(sim: Sim, now: number): void {
    if (sim.layoutVersion !== this.layoutVersion) {
      this.layoutVersion = sim.layoutVersion;
      this.collect(sim);
    }
    if (now - this.lastDraw >= REDRAW_MS) {
      this.lastDraw = now;
      this.redraw(now);
    }
    // who sits at which desk
    const occupant = new Map<string, Character>();
    for (const c of sim.chars.values()) {
      const spot = c.atSpot ? sim.spots.get(c.atSpot) : undefined;
      if (spot?.deskId && c.atSpot === c.homeSpot) occupant.set(spot.deskId, c);
    }
    this.desks.forEach((d, i) => {
      const room = d.roomId ? sim.rooms.get(d.roomId) : undefined;
      const light = room ? room.light(now) : 1;
      const mode = deskScreenMode(occupant.get(d.id) ?? null, light);
      const [u, v] = tileOffset(mode);
      this.tiles.setXY(i, u, v);
      // rooms build up from the floor: screens appear with them
      const grow = room && room.phase !== 'ready' ? room.progress(now) : 1;
      const m = grow < 0.95 ? tmpM.copy(d.matrix).scale(FLAT) : d.matrix;
      this.mesh.setMatrixAt(i, room?.phase === 'dismantling' ? HIDDEN : m);
      this.mesh.setColorAt(i, tmpColor.setScalar(0.35 + 0.65 * Math.max(0, Math.min(1, light))));
    });
    this.mesh.count = this.desks.length;
    this.tiles.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}
