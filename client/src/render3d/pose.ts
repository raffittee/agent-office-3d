// Procedural animation for the placeholder "capsule people" (P2-07): a pose, its time and a seed → joint angles.
// Pure (no three), so it's tested; characters.ts turns the rig into instance matrices.
import type { Dir, HeldItem, Pose } from '../core/vocab';

/** Joint angles in radians; pitch > 0 swings a limb forward (towards the face), roll > 0 lifts it sideways. */
export interface PoseRig {
  /** Vertical offset of the whole body (m): seated poses sink onto the seat. */
  rootY: number;
  /** Torso lean forward (rad). */
  lean: number;
  /** Head nod forward (rad). */
  head: number;
  legL: number;
  legR: number;
  armL: { pitch: number; roll: number };
  armR: { pitch: number; roll: number };
  /** Draw the held item in front of the hands. */
  showHeld: boolean;
}

/** Hip height of the model standing (m), and the seat height seated poses sink to. */
export const HIP_Y = 0.8;
export const SEAT_Y = 0.46;

const SEATED: ReadonlySet<Pose> = new Set(['sit', 'type', 'sleep', 'wait']);

export function isSeatedPose(pose: Pose, seated: boolean): boolean {
  return SEATED.has(pose) || (seated && (pose === 'raise_hand' || pose === 'read' || pose === 'talk' || pose === 'cheer' || pose === 'laugh' || pose === 'game' || pose === 'sulk'));
}

const D = Math.PI / 180;

/** The rig for a pose at time `t` (ms in the pose); `seed` desynchronises characters. */
export function poseRig(pose: Pose, t: number, seed: number, seated: boolean, held: HeldItem = 'none'): PoseRig {
  const ph = (seed % 1000) / 1000;
  const s = (hz: number, off = 0) => Math.sin((t / 1000) * hz * Math.PI * 2 + (ph + off) * Math.PI * 2);
  const sit = isSeatedPose(pose, seated);
  const rig: PoseRig = {
    rootY: sit ? SEAT_Y - HIP_Y : 0,
    lean: 0,
    head: 0,
    legL: sit ? 90 * D : 0,
    legR: sit ? 90 * D : 0,
    armL: { pitch: sit ? 15 * D : 0, roll: 6 * D },
    armR: { pitch: sit ? 15 * D : 0, roll: 6 * D },
    showHeld: held !== 'none',
  };
  switch (pose) {
    case 'walk':
    case 'run': {
      const run = pose === 'run';
      const hz = run ? 2.6 : 1.8;
      const swing = (run ? 40 : 28) * D;
      rig.legL = s(hz) * swing;
      rig.legR = -s(hz) * swing;
      rig.rootY = Math.abs(s(hz)) * (run ? 0.06 : 0.035);
      rig.lean = run ? 12 * D : 3 * D;
      if (held !== 'none') rig.armL.pitch = rig.armR.pitch = 55 * D;
      else {
        rig.armL.pitch = -s(hz) * swing * 0.8;
        rig.armR.pitch = s(hz) * swing * 0.8;
      }
      break;
    }
    case 'type':
      rig.lean = 8 * D;
      rig.armL.pitch = (68 + s(5.5) * 6) * D;
      rig.armR.pitch = (68 + s(5.5, 0.5) * 6) * D;
      rig.armL.roll = rig.armR.roll = 10 * D;
      rig.head = 6 * D;
      break;
    case 'raise_hand':
      rig.armR.pitch = 170 * D;
      rig.armR.roll = (10 + s(1.6) * 10) * D;
      break;
    case 'drink':
      rig.armR.pitch = 120 * D;
      rig.armR.roll = 25 * D;
      rig.head = -8 * D;
      break;
    case 'use':
      rig.armL.pitch = rig.armR.pitch = (75 + s(1.2) * 6) * D;
      break;
    case 'talk':
    case 'laugh':
      rig.armL.pitch = (30 + s(1.4) * 18) * D;
      rig.armR.pitch = (30 + s(1.1, 0.3) * 22) * D;
      rig.head = s(0.9) * 5 * D;
      break;
    case 'stretch':
    case 'cheer':
      rig.armL.pitch = rig.armR.pitch = 170 * D;
      rig.armL.roll = rig.armR.roll = (18 + s(2) * 6) * D;
      rig.rootY += pose === 'cheer' ? Math.max(0, s(2)) * 0.08 : 0;
      break;
    case 'read':
    case 'game':
      rig.armL.pitch = rig.armR.pitch = 62 * D;
      rig.armL.roll = rig.armR.roll = 14 * D;
      rig.head = 14 * D;
      rig.showHeld = true;
      break;
    case 'sleep':
      rig.lean = 24 * D;
      rig.head = 30 * D + s(0.25) * 3 * D;
      rig.armL.pitch = rig.armR.pitch = 55 * D;
      break;
    case 'wait':
      // seated, arms crossed (or eating popcorn: one hand going to the mouth)
      rig.lean = -6 * D;
      rig.armL.pitch = 55 * D;
      rig.armL.roll = -25 * D;
      rig.armR.pitch = held === 'popcorn' ? (85 + Math.max(0, s(0.7)) * 50) * D : 55 * D;
      rig.armR.roll = -25 * D;
      break;
    case 'play':
      rig.armR.pitch = (60 + s(1.6) * 35) * D;
      rig.armR.roll = 20 * D;
      break;
    case 'sulk':
      rig.lean = 12 * D;
      rig.head = 28 * D;
      break;
    default:
      break;
  }
  return rig;
}

/** Yaw (rad) for a facing direction; the model looks towards +z (south) at 0. */
export function dirYaw(dir: Dir): number {
  switch (dir) {
    case 'down':
      return 0;
    case 'up':
      return Math.PI;
    case 'right':
      return Math.PI / 2;
    case 'left':
      return -Math.PI / 2;
  }
}

/** Turns `cur` towards `goal` by the shortest way, at most `maxStep` rad. */
export function turnTowards(cur: number, goal: number, maxStep: number): number {
  let d = goal - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxStep) return goal;
  return cur + Math.sign(d) * maxStep;
}

const SKINS = ['#f2d0b1', '#e5b48f', '#c98f65', '#a86b45', '#7d4a2f', '#f6dcc4'];
const HAIRS = ['#2b2420', '#4a3426', '#7b4f2c', '#c79a55', '#1d1d22', '#8c8c8c', '#b5552f'];

/** Deterministic colors from a character's seed: skin, hair and shirt. */
export function lookColors(seed: number, sub: boolean): { skin: string; hair: string; shirt: string; pants: string } {
  const u = (k: number) => {
    let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return (h >>> 0) / 4294967296;
  };
  const hue = Math.floor(u(3) * 360);
  return {
    skin: SKINS[Math.floor(u(1) * SKINS.length)]!,
    hair: HAIRS[Math.floor(u(2) * HAIRS.length)]!,
    shirt: `hsl(${hue}, ${sub ? 45 : 55}%, ${sub ? 62 : 52}%)`,
    pants: `hsl(${(hue + 200) % 360}, 18%, ${28 + Math.floor(u(4) * 14)}%)`,
  };
}
