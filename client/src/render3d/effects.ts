// Shell-wait gags in 3D (P6-03): a confetti burst when a job succeeds, a little rain cloud with falling drops when it
// fails, and a cobweb that grows on a long wait (sim/shell.ts decides when). Three instanced meshes for everyone, so
// the cost doesn't grow with the number of agents. Reads the sim; never writes it.
import * as THREE from 'three';
import type { Character } from '../core/sim/character';
import type { Sim } from '../core/sim/sim';
import { SHELL_COBWEB_BIG_MS } from '../core/sim/shell';
import { mx, mz } from './units';

/** Anything that knows where a character's head is (the rig or the capsules). */
export interface HeadSource {
  headPoint(c: Character, out: THREE.Vector3): THREE.Vector3;
}

const CONFETTI_MAX = 600;
const CONFETTI_PER_BURST = 48;
const CONFETTI_LIFE = 1.8;
const GRAVITY = -3.2;
const CLOUD_MAX = 32;
const DROPS_PER_CLOUD = 6;
const WEB_MAX = 64;
const COLORS = ['#ff5d5d', '#ffcc33', '#4ecb71', '#4aa3ff', '#c77dff', '#ff8fc7'].map((c) => new THREE.Color(c));

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  age: number;
  color: THREE.Color;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const head = new THREE.Vector3();
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

/** A flat cobweb: radial threads and three rings, as line segments in the XY plane (radius 1). */
export function cobwebSegments(spokes = 8, rings = 3): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    pts.push(0, 0, 0, Math.cos(a), Math.sin(a), 0);
  }
  for (let r = 1; r <= rings; r++) {
    const rad = r / rings;
    for (let i = 0; i < spokes; i++) {
      const a0 = (i / spokes) * Math.PI * 2;
      const a1 = ((i + 1) / spokes) * Math.PI * 2;
      // threads sag a little between spokes
      const sag = 0.92;
      const am = (a0 + a1) / 2;
      pts.push(Math.cos(a0) * rad, Math.sin(a0) * rad, 0, Math.cos(am) * rad * sag, Math.sin(am) * rad * sag, 0);
      pts.push(Math.cos(am) * rad * sag, Math.sin(am) * rad * sag, 0, Math.cos(a1) * rad, Math.sin(a1) * rad, 0);
    }
  }
  return new Float32Array(pts);
}

export class EffectsView {
  readonly root = new THREE.Group();
  private confetti: THREE.InstancedMesh;
  private clouds: THREE.InstancedMesh;
  private drops: THREE.InstancedMesh;
  private webs: THREE.LineSegments;
  private webGeo: THREE.BufferGeometry;
  private particles: Particle[] = [];
  private seen = new Set<string>();
  private t = 0;

  constructor() {
    this.root.name = 'effects';
    this.confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.05, 0.035), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), CONFETTI_MAX);
    this.confetti.count = 0;
    this.confetti.frustumCulled = false;
    const puff = new THREE.IcosahedronGeometry(0.12, 0);
    this.clouds = new THREE.InstancedMesh(puff, new THREE.MeshLambertMaterial({ color: '#7d8796' }), CLOUD_MAX * 3);
    this.clouds.count = 0;
    this.clouds.frustumCulled = false;
    this.drops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 0.07, 0.012), new THREE.MeshBasicMaterial({ color: '#7fb2ff' }), CLOUD_MAX * DROPS_PER_CLOUD);
    this.drops.count = 0;
    this.drops.frustumCulled = false;
    // all cobwebs in one line mesh: the geometry is rebuilt (small) when the set changes
    const unit = cobwebSegments();
    this.webGeo = new THREE.BufferGeometry();
    this.webGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(unit.length * WEB_MAX), 3));
    this.webGeo.setDrawRange(0, 0);
    this.webs = new THREE.LineSegments(this.webGeo, new THREE.LineBasicMaterial({ color: '#e8e8ec', transparent: true, opacity: 0.75 }));
    this.webs.frustumCulled = false;
    this.root.add(this.confetti, this.clouds, this.drops, this.webs);
  }

  /** Bursts of confetti for new effects; clouds and cobwebs from the characters' state. */
  sync(sim: Sim, heads: HeadSource, now: number, dt: number): void {
    this.t += dt;
    for (const e of sim.effects) {
      const key = `${e.charId}@${e.at}`;
      if (e.kind !== 'confetti' || this.seen.has(key)) continue;
      this.seen.add(key);
      const c = sim.chars.get(e.charId);
      if (c && c.visible && !c.inside) this.burst(heads.headPoint(c, head));
    }
    if (this.seen.size > 200) this.seen.clear();
    this.stepConfetti(dt);
    this.syncClouds(sim, heads, now);
    this.syncWebs(sim, now);
  }

  private burst(at: THREE.Vector3): void {
    for (let i = 0; i < CONFETTI_PER_BURST && this.particles.length < CONFETTI_MAX; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 1.1;
      this.particles.push({ x: at.x, y: at.y + 0.15, z: at.z, vx: Math.cos(a) * sp, vy: 1.6 + Math.random() * 1.4, vz: Math.sin(a) * sp, spin: Math.random() * 10, age: 0, color: COLORS[i % COLORS.length]! });
    }
  }

  private stepConfetti(dt: number): void {
    let n = 0;
    for (const p of this.particles) {
      p.age += dt;
      if (p.age > CONFETTI_LIFE) continue;
      p.vy += GRAVITY * dt;
      // flutter: air drag on the way down
      if (p.vy < 0) p.vy *= 0.96;
      p.vx *= 0.985;
      p.vz *= 0.985;
      p.x += p.vx * dt;
      p.y = Math.max(0.01, p.y + p.vy * dt);
      p.z += p.vz * dt;
      p.spin += dt * 9;
      const fade = 1 - Math.max(0, p.age - CONFETTI_LIFE + 0.4) / 0.4;
      tmpQ.setFromEuler(tmpE.set(p.spin, p.spin * 0.7, 0));
      tmpM.compose(tmpP.set(p.x, p.y, p.z), tmpQ, tmpS.setScalar(Math.max(0.01, fade)));
      this.confetti.setMatrixAt(n, tmpM);
      this.confetti.setColorAt(n, p.color);
      this.particles[n++] = p;
    }
    this.particles.length = n;
    this.confetti.count = n;
    this.confetti.instanceMatrix.needsUpdate = true;
    if (this.confetti.instanceColor) this.confetti.instanceColor.needsUpdate = true;
  }

  /** A rain cloud over everyone showing the 'storm' icon (a failed job). */
  private syncClouds(sim: Sim, heads: HeadSource, now: number): void {
    let n = 0;
    for (const c of sim.chars.values()) {
      if (n >= CLOUD_MAX) break;
      if (c.icon !== 'storm' || now >= c.iconUntil || c.inside || !c.visible) continue;
      heads.headPoint(c, head);
      const bob = Math.sin(this.t * 2 + n) * 0.02;
      const y = head.y + 0.45 + bob;
      for (let k = 0; k < 3; k++) {
        tmpM.compose(tmpP.set(head.x + (k - 1) * 0.13, y + (k === 1 ? 0.05 : 0), head.z), tmpQ.identity(), tmpS.setScalar(k === 1 ? 1.15 : 0.9));
        this.clouds.setMatrixAt(n * 3 + k, tmpM);
      }
      for (let d = 0; d < DROPS_PER_CLOUD; d++) {
        const phase = (this.t * 1.6 + d / DROPS_PER_CLOUD) % 1;
        tmpM.compose(tmpP.set(head.x + ((d % 3) - 1) * 0.1 + (d > 2 ? 0.05 : 0), y - 0.08 - phase * 0.35, head.z + (d % 2 ? 0.04 : -0.04)), tmpQ.identity(), tmpS.setScalar(phase > 0.9 ? 0 : 1));
        this.drops.setMatrixAt(n * DROPS_PER_CLOUD + d, tmpM);
      }
      n++;
    }
    this.clouds.count = n * 3;
    this.drops.count = n * DROPS_PER_CLOUD;
    this.clouds.instanceMatrix.needsUpdate = true;
    this.drops.instanceMatrix.needsUpdate = true;
    if (!n) {
      this.clouds.setMatrixAt(0, HIDE);
      this.drops.setMatrixAt(0, HIDE);
    }
  }

  /** A cobweb in the corner of the chair of whoever waits long for a job (twice as big after 20 minutes). */
  private syncWebs(sim: Sim, now: number): void {
    const unit = cobwebSegments();
    const pos = this.webGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    let n = 0;
    for (const c of sim.chars.values()) {
      if (n >= WEB_MAX) break;
      if ((c.shellStage !== 'cobweb' && c.shellStage !== 'nap') || c.inside || !c.visible) continue;
      const big = now - c.shellSince >= SHELL_COBWEB_BIG_MS;
      const r = big ? 0.32 : 0.18;
      // beside the head, facing the camera's general direction (+z), tilted
      const x0 = mx(c.x) + 0.28;
      const y0 = 1.05;
      const z0 = mz(c.y) + 0.05;
      const off = n * unit.length;
      for (let i = 0; i < unit.length; i += 3) {
        const ux = unit[i]! * r;
        const uy = unit[i + 1]! * r;
        arr[off + i] = x0 + ux * 0.85;
        arr[off + i + 1] = y0 + uy;
        arr[off + i + 2] = z0 + ux * 0.5;
      }
      n++;
    }
    this.webGeo.setDrawRange(0, (n * unit.length) / 3);
    pos.needsUpdate = n > 0;
  }

  dispose(): void {
    for (const m of [this.confetti, this.clouds, this.drops]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.webGeo.dispose();
    (this.webs.material as THREE.Material).dispose();
  }
}
