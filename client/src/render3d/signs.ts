// Room signs (P10-06): the plaques that carry a room's name (and the core areas' fixed names). Every plaque is one
// instance of a single quad, textured from a shared canvas atlas (one slot per distinct label and style), so all the
// signs in the office are one draw call. The plaque's backing (frame, bracket) is built with the area's own boxes in
// building.ts; this draws only the lettering, in front of it. Pure parts (slots, fitting, placement): signs-model.ts.
import * as THREE from 'three';
import { ATLAS_H, ATLAS_W, fitLabel, SignAtlas, signSize, signYaw, slotRect, slotUv, SLOT_H, SLOT_W, type SignSpec } from './signs-model';

/** The colors of a plaque's lettering and ground. */
export interface SignStyle {
  bg: string;
  fg: string;
  accent: string;
}

const FONT = '600 {px}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export class SignView {
  readonly mesh: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly tiles: THREE.InstancedBufferAttribute;
  private readonly atlas = new SignAtlas();
  private readonly cap: number;
  private n = 0;
  private dirty = false;

  constructor(cap = 160) {
    this.cap = cap;
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const geo = new THREE.PlaneGeometry(1, 1);
    // aTile = the slot's UV offset (xy) and size (zw)
    this.tiles = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.tiles.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTile', this.tiles);
    // lit like the walls it hangs on; pulled a little towards the camera so it never fights the backing box
    const mat = new THREE.MeshLambertMaterial({ map: this.texture, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aTile;').replace('#include <uv_vertex>', '#include <uv_vertex>\n vMapUv = uv * aTile.zw + aTile.xy;');
    };
    mat.customProgramCacheKey = () => 'agent-office-signs';
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'signs';
  }

  /** Start of a frame's signs. */
  begin(): void {
    this.n = 0;
    this.atlas.beginFrame();
  }

  /** One plaque this frame: `scaleY` follows the room's build animation, `tint` its brightness. */
  add(spec: SignSpec, label: string, style: SignStyle, scaleY: number, tint: THREE.Color): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    if (scaleY < 0.02) {
      this.mesh.setMatrixAt(i, HIDDEN);
      return;
    }
    const got = this.atlas.slotFor(`${label}|${style.bg}|${style.fg}|${style.accent}`);
    if (!got) {
      this.mesh.setMatrixAt(i, HIDDEN);
      return;
    }
    if (got.fresh) this.draw(got.slot, label, style);
    const uv = slotUv(got.slot);
    this.tiles.setXYZW(i, uv.u, uv.v, uv.du, uv.dv);
    const q = signSize(spec.h);
    tmpPos.set(spec.x, spec.y * scaleY, spec.z);
    tmpQuat.setFromAxisAngle(AXIS_Y, signYaw(spec.nx, spec.nz));
    tmpScale.set(q.w, q.h * scaleY, 1);
    this.mesh.setMatrixAt(i, tmpM.compose(tmpPos, tmpQuat, tmpScale));
    this.mesh.setColorAt(i, tint);
  }

  /** End of a frame's signs: uploads what changed. */
  end(): void {
    this.mesh.count = this.n;
    this.tiles.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.dirty) {
      this.dirty = false;
      this.texture.needsUpdate = true;
    }
  }

  private draw(slot: number, label: string, style: SignStyle): void {
    const c = this.ctx;
    const r = slotRect(slot);
    c.fillStyle = style.bg;
    c.fillRect(r.x, r.y, r.w, r.h);
    // a thin accent rule along the bottom and a hairline frame
    c.fillStyle = style.accent;
    c.fillRect(r.x + 10, r.y + r.h - 9, r.w - 20, 3);
    c.strokeStyle = style.fg;
    c.globalAlpha = 0.25;
    c.lineWidth = 2;
    c.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    c.globalAlpha = 1;
    const measure = (text: string, px: number) => {
      c.font = FONT.replace('{px}', String(px));
      return c.measureText(text).width;
    };
    const fit = fitLabel(label, SLOT_W - 36, measure, 38, 20);
    c.font = FONT.replace('{px}', String(fit.font));
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = style.fg;
    c.fillText(fit.text, r.x + SLOT_W / 2, r.y + SLOT_H / 2 - 3);
    this.dirty = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}
