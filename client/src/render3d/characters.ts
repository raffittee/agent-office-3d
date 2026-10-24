// Placeholder characters (P2-07): procedural "capsule people", all drawn with a handful of InstancedMeshes (legs,
// torso, head, hair, arms, provider badge, held item, blob shadow), so 30 agents cost ~8 draw calls. Body and hair
// colors come from the agent's seed; the badge from its provider. Reads the sim's characters; never writes them.
import * as THREE from 'three';
import type { Character } from '../core/sim/character';
import type { HeldItem } from '../core/vocab';
import { dirYaw, HIP_Y, lookColors, poseRig, turnTowards } from './pose';
import { mx, mz } from './units';

const HELD_COLORS: Partial<Record<HeldItem, string>> = {
  coffee: '#f4efe6',
  water: '#8cc6f0',
  papers: '#f7f5ef',
  laptop: '#3a3d42',
  book: '#b5452f',
  box: '#c9a46b',
  paddle: '#c0392b',
  popcorn: '#f2c94c',
  controller: '#2f3236',
  phone: '#1d2126',
};

interface Slot {
  index: number;
  yaw: number;
  look: ReturnType<typeof lookColors>;
  provider: string;
}

/** A pool of instances for one body part. */
class Part {
  readonly mesh: THREE.InstancedMesh;
  constructor(
    readonly geo: THREE.BufferGeometry,
    readonly mat: THREE.Material,
    readonly perChar: number,
    cap: number,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap * perChar);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }
}

const tmpM = new THREE.Matrix4();
const tmpL = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class CharacterView {
  readonly root = new THREE.Group();
  private cap = 0;
  private parts: Record<'leg' | 'torso' | 'head' | 'hair' | 'arm' | 'badge' | 'held' | 'shadow', Part> | null = null;
  private slots = new Map<string, Slot>();
  private order: string[] = [];
  private readonly mat = new THREE.MeshLambertMaterial();
  private readonly shadowMat = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.18, depthWrite: false });
  /** Provider badge colors (from the snapshot's meta.providers). */
  providerColors = new Map<string, string>();

  constructor() {
    this.root.name = 'characters';
    this.ensure(32);
  }

  private ensure(n: number): void {
    if (n <= this.cap && this.parts) return;
    const cap = Math.max(32, 2 ** Math.ceil(Math.log2(n)));
    if (this.parts) for (const p of Object.values(this.parts)) this.root.remove(p.mesh);
    const torso = new THREE.CapsuleGeometry(0.17, 0.3, 4, 10);
    const legs = new THREE.BoxGeometry(0.13, 0.78, 0.15).translate(0, -0.39, 0);
    const arm = new THREE.BoxGeometry(0.09, 0.56, 0.09).translate(0, -0.28, 0);
    const head = new THREE.SphereGeometry(0.15, 14, 10);
    const hair = new THREE.SphereGeometry(0.158, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.01, -0.005);
    const badge = new THREE.CylinderGeometry(0.045, 0.045, 0.02, 12).rotateX(Math.PI / 2);
    const held = new THREE.BoxGeometry(0.16, 0.1, 0.12);
    const shadow = new THREE.CircleGeometry(0.28, 16).rotateX(-Math.PI / 2);
    this.parts = {
      leg: new Part(legs, this.mat, 2, cap),
      torso: new Part(torso, this.mat, 1, cap),
      head: new Part(head, this.mat, 1, cap),
      hair: new Part(hair, this.mat, 1, cap),
      arm: new Part(arm, this.mat, 2, cap),
      badge: new Part(badge, new THREE.MeshBasicMaterial(), 1, cap),
      held: new Part(held, this.mat, 1, cap),
      shadow: new Part(shadow, this.shadowMat, 1, cap),
    };
    for (const p of Object.values(this.parts)) this.root.add(p.mesh);
    this.cap = cap;
    // colors are per slot; re-apply them to the new buffers
    for (const [id, slot] of this.slots) this.paint(id, slot);
  }

  private paint(_id: string, slot: Slot): void {
    const p = this.parts!;
    const i = slot.index;
    const set = (part: Part, k: number, color: string) => part.mesh.setColorAt(i * part.perChar + k, tmpC.set(color));
    set(p.leg, 0, slot.look.pants);
    set(p.leg, 1, slot.look.pants);
    set(p.torso, 0, slot.look.shirt);
    set(p.head, 0, slot.look.skin);
    set(p.hair, 0, slot.look.hair);
    set(p.arm, 0, slot.look.shirt);
    set(p.arm, 1, slot.look.shirt);
    set(p.badge, 0, this.providerColors.get(slot.provider) ?? '#888888');
    set(p.held, 0, '#cccccc');
    for (const part of Object.values(p)) if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
  }

  /** Brings instances in line with the sim's characters; `dt` in seconds for turning. */
  sync(chars: Iterable<Character>, dt: number): void {
    const list = [...chars].filter((c) => !c.gone);
    this.ensure(list.length);
    const p = this.parts!;
    // stable slots: keep existing indices, compact when someone leaves
    const ids = new Set(list.map((c) => c.id));
    let reorder = false;
    for (const id of this.slots.keys()) if (!ids.has(id)) reorder = true;
    for (const c of list) if (!this.slots.has(c.id)) reorder = true;
    if (reorder) {
      const prev = this.slots;
      this.slots = new Map();
      this.order = list.map((c) => c.id);
      list.forEach((c, index) => {
        const old = prev.get(c.id);
        const slot: Slot = { index, yaw: old?.yaw ?? dirYaw(c.dir), look: old?.look ?? lookColors(c.info.seed, c.info.kind === 'sub'), provider: c.info.provider };
        this.slots.set(c.id, slot);
        this.paint(c.id, slot);
      });
    }
    const n = list.length;
    for (const part of Object.values(p)) part.mesh.count = n * part.perChar;

    for (const c of list) {
      const slot = this.slots.get(c.id)!;
      const i = slot.index;
      const visible = c.alpha > 0.02 && !c.inside;
      if (!visible) {
        for (const part of Object.values(p)) for (let k = 0; k < part.perChar; k++) part.mesh.setMatrixAt(i * part.perChar + k, ZERO);
        continue;
      }
      slot.yaw = turnTowards(slot.yaw, dirYaw(c.dir), dt * 10);
      const rig = poseRig(c.pose, c.animT, c.info.seed, c.seated, c.held);
      const scale = (c.info.kind === 'sub' ? 0.86 : 1) * Math.min(1, 0.4 + c.alpha * 0.6);
      // the body's frame: feet position, facing, size
      tmpV.set(mx(c.x + c.offX), rig.rootY * scale, mz(c.y + c.offY));
      tmpQ.setFromEuler(tmpE.set(0, slot.yaw, 0));
      tmpS.setScalar(scale);
      const body = new THREE.Matrix4().compose(tmpV, tmpQ, tmpS);
      const at = (part: Part, k: number, local: THREE.Matrix4) => part.mesh.setMatrixAt(i * part.perChar + k, tmpM.multiplyMatrices(body, local));

      for (const [k, side, pitch] of [
        [0, -1, rig.legL],
        [1, 1, rig.legR],
      ] as const) {
        tmpL.makeRotationX(-pitch).setPosition(side * 0.085, HIP_Y, 0);
        at(p.leg, k, tmpL);
      }
      // torso, leaning around the hips
      const lean = new THREE.Matrix4().makeRotationX(rig.lean).setPosition(0, HIP_Y, 0);
      at(p.torso, 0, tmpL.copy(lean).multiply(new THREE.Matrix4().makeTranslation(0, 0.33, 0)));
      const headM = new THREE.Matrix4().copy(lean).multiply(new THREE.Matrix4().makeTranslation(0, 0.74, 0)).multiply(new THREE.Matrix4().makeRotationX(rig.head));
      at(p.head, 0, headM);
      at(p.hair, 0, headM);
      at(p.badge, 0, tmpL.copy(lean).multiply(new THREE.Matrix4().makeTranslation(0.07, 0.45, 0.17)));
      for (const [k, side, a] of [
        [0, -1, rig.armL],
        [1, 1, rig.armR],
      ] as const) {
        const m = new THREE.Matrix4()
          .copy(lean)
          .multiply(new THREE.Matrix4().makeTranslation(side * 0.235, 0.52, 0))
          .multiply(new THREE.Matrix4().makeRotationZ(side * a.roll))
          .multiply(new THREE.Matrix4().makeRotationX(-a.pitch));
        at(p.arm, k, m);
      }
      if (rig.showHeld && c.held !== 'none') {
        p.held.mesh.setColorAt(i, tmpC.set(HELD_COLORS[c.held] ?? '#cccccc'));
        if (p.held.mesh.instanceColor) p.held.mesh.instanceColor.needsUpdate = true;
        at(p.held, 0, tmpL.copy(lean).multiply(new THREE.Matrix4().makeTranslation(0, 0.18, 0.3)));
      } else p.held.mesh.setMatrixAt(i, ZERO);
      // blob shadow on the floor, not lifted with the body
      tmpL.makeTranslation(mx(c.x + c.offX), 0.012, mz(c.y + c.offY));
      p.shadow.mesh.setMatrixAt(i, tmpL);
    }
    for (const part of Object.values(p)) part.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The point above a character's head (m), for labels and picking. */
  headPoint(c: Character, out: THREE.Vector3): THREE.Vector3 {
    const sub = c.info.kind === 'sub' ? 0.86 : 1;
    const seated = c.seated || c.pose === 'sit' || c.pose === 'type' || c.pose === 'sleep' || c.pose === 'wait';
    return out.set(mx(c.x + c.offX), (seated ? 1.42 : 1.8) * sub, mz(c.y + c.offY));
  }

  /** Repaints badges after provider colors change. */
  repaint(): void {
    for (const [id, slot] of this.slots) this.paint(id, slot);
  }

  dispose(): void {
    if (this.parts) for (const part of Object.values(this.parts)) part.geo.dispose();
    this.mat.dispose();
    this.shadowMat.dispose();
  }
}
