// Rigged characters (P3-02..P3-04): one skinned mesh per agent from the pipeline's GLB (ADR 0004, ADR 0005), an
// AnimationMixer with crossfades between base clips, procedural pose layers for what the clips lack (typing, raised
// hand while seated, sleep, popcorn…), a per-character tint from the seed, and instanced attachments (provider badge,
// subagent lanyard, held items) placed from bone matrices so they cost a fixed number of draw calls.
// Reads the sim's characters; never writes them. Falls back to capsule people (characters.ts) until the model loads.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterProfile, RigBone, RigClip } from '../../../shared/character-profile';
import type { Character } from '../core/sim/character';
import type { HeldItem, Pose } from '../core/vocab';
import { dirYaw, isSeatedPose, lookColors, poseRig, turnTowards } from './pose';
import { mx, mz } from './units';

export interface RigModel {
  gltf: GLTF;
  profile: CharacterProfile;
}

/** Loads a character profile and its GLB (meshopt-compressed). */
export async function loadRigModel(base: string, id: string): Promise<RigModel> {
  const res = await fetch(`${base}/${id}.json`);
  if (!res.ok) throw new Error(`character profile ${id}: HTTP ${res.status}`);
  const profile = (await res.json()) as CharacterProfile;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(`${base}/${profile.file}`);
  return { gltf, profile };
}

/** The base clip for a pose; layers on top add what the clip lacks. Pure (tested). */
export function baseClipFor(pose: Pose, seated: boolean, have: (c: RigClip) => boolean): RigClip {
  if (pose === 'walk') return 'walk';
  if (pose === 'run') return have('run') ? 'run' : 'walk';
  if (isSeatedPose(pose, seated)) return 'sit';
  if (pose === 'raise_hand' && have('wave')) return 'wave';
  if (pose === 'cheer' && have('dance')) return 'dance';
  if ((pose === 'talk' || pose === 'laugh') && have('yes')) return 'yes';
  if (pose === 'sulk' && have('no')) return 'no';
  return 'idle';
}

/** Which procedural layers apply on top of a base clip (the clip already does the rest). */
export function layersFor(pose: Pose, base: RigClip): { arms: boolean; head: boolean; lean: boolean } {
  const clipCovers = (base === 'wave' && pose === 'raise_hand') || (base === 'dance' && pose === 'cheer') || base === 'walk' || base === 'run';
  if (clipCovers) return { arms: false, head: false, lean: false };
  if (base === 'yes' || base === 'no') return { arms: true, head: false, lean: false };
  return { arms: pose !== 'stand' && pose !== 'sit', head: true, lean: true };
}

const TINT_VERT = /* glsl */ `
attribute float _tint;
varying float vTint;
`;

/** One material per character: vertex colors, with the `_tint` mask recolored by `uTint`. */
function tintedMaterial(base: THREE.Material, tint: THREE.Color): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  if ('color' in base && base.color instanceof THREE.Color) m.color.copy(base.color);
  const uTint = { value: tint };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = uTint;
    shader.vertexShader = TINT_VERT + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vTint = _tint;');
    shader.fragmentShader =
      'uniform vec3 uTint;\nvarying float vTint;\n' + shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= mix(vec3(1.0), uTint, vTint);');
  };
  m.customProgramCacheKey = () => 'agent-office-tint';
  return m;
}

interface Rigged {
  root: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<RigClip, THREE.AnimationAction>>;
  current: RigClip | null;
  bones: Partial<Record<RigBone, THREE.Bone>>;
  /** Rest rotations of the layered bones: restored before each mixer update, so layers never accumulate on bones a
   * clip doesn't animate. */
  rest: Map<THREE.Bone, THREE.Quaternion>;
  yaw: number;
  material: THREE.MeshLambertMaterial;
  /** Accumulated time for reduced-rate updates. */
  pending: number;
  sub: boolean;
  provider: string;
}

const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpC = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
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
const HELD_SIZE: Partial<Record<HeldItem, [number, number, number]>> = {
  coffee: [0.08, 0.1, 0.08],
  water: [0.07, 0.11, 0.07],
  papers: [0.2, 0.02, 0.26],
  laptop: [0.3, 0.02, 0.22],
  book: [0.16, 0.04, 0.22],
  box: [0.3, 0.22, 0.24],
  paddle: [0.15, 0.02, 0.2],
  popcorn: [0.14, 0.16, 0.14],
  controller: [0.14, 0.03, 0.08],
  phone: [0.07, 0.01, 0.13],
};

/**
 * Rotates `bone` about an axis given in the character's own space (x = its right, y = up, z = forward), whatever the
 * bone's local axes are: the axis is carried into the bone's parent space and pre-multiplied.
 */
function rotateInCharacterSpace(bone: THREE.Bone, root: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  if (!angle || !bone.parent) return;
  // parent's rotation relative to the character root
  root.getWorldQuaternion(tmpQ2).invert();
  bone.parent.getWorldQuaternion(tmpQ).premultiply(tmpQ2);
  const local = tmpV.copy(axis).applyQuaternion(tmpQ.invert());
  bone.quaternion.premultiply(tmpQ.setFromAxisAngle(local.normalize(), angle));
  bone.updateMatrixWorld(true);
}

export class RigView {
  readonly root = new THREE.Group();
  private chars = new Map<string, Rigged>();
  private readonly shadows: THREE.InstancedMesh;
  private readonly badges: THREE.InstancedMesh;
  private readonly lanyards: THREE.InstancedMesh;
  private readonly held: THREE.InstancedMesh;
  private cap = 64;
  providerColors = new Map<string, string>();
  /** Frame counter for reduced-rate updates. */
  private frame = 0;

  constructor(readonly model: RigModel) {
    this.root.name = 'rigged-characters';
    this.shadows = this.pool(new THREE.CircleGeometry(0.28, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.18, depthWrite: false }));
    this.badges = this.pool(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial());
    this.lanyards = this.pool(new THREE.BoxGeometry(0.07, 0.1, 0.015), new THREE.MeshLambertMaterial({ color: '#2f6fdd' }));
    this.held = this.pool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial());
  }

  private pool(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, this.cap);
    m.count = 0;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(m);
    return m;
  }

  private grow(n: number): void {
    if (n <= this.cap) return;
    const cap = 2 ** Math.ceil(Math.log2(n));
    for (const key of ['shadows', 'badges', 'lanyards', 'held'] as const) {
      const old = this[key];
      this.root.remove(old);
      const m = new THREE.InstancedMesh(old.geometry, old.material, cap);
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(m);
      (this as unknown as Record<string, THREE.InstancedMesh>)[key] = m;
    }
    this.cap = cap;
  }

  private create(c: Character): Rigged {
    const { gltf, profile } = this.model;
    const root = cloneSkinned(gltf.scene);
    root.name = c.id;
    let mesh: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    if (!mesh) throw new Error('character model has no skinned mesh');
    const sm = mesh as THREE.SkinnedMesh;
    const look = lookColors(c.info.seed, c.info.kind === 'sub');
    const material = tintedMaterial(sm.material as THREE.Material, new THREE.Color(look.shirt));
    sm.material = material;
    sm.frustumCulled = false;
    const bones: Partial<Record<RigBone, THREE.Bone>> = {};
    for (const [k, name] of Object.entries(profile.bones) as [RigBone, string][]) {
      const b = root.getObjectByName(name);
      if (b && (b as THREE.Bone).isBone) bones[k] = b as THREE.Bone;
    }
    const mixer = new THREE.AnimationMixer(root);
    const actions: Rigged['actions'] = {};
    for (const [k, name] of Object.entries(profile.clips) as [RigClip, string][]) {
      const clip = gltf.animations.find((a) => a.name === name);
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      if (profile.holdClips?.includes(k)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      actions[k] = a;
    }
    const scale = profile.scale * (c.info.kind === 'sub' ? 0.86 : 1);
    root.scale.setScalar(scale);
    this.root.add(root);
    const rest = new Map<THREE.Bone, THREE.Quaternion>();
    for (const b of Object.values(bones)) if (b) rest.set(b, b.quaternion.clone());
    return { root, mesh: sm, mixer, actions, current: null, bones, rest, yaw: dirYaw(c.dir), material, pending: 0, sub: c.info.kind === 'sub', provider: c.info.provider };
  }

  private play(r: Rigged, clip: RigClip): void {
    if (r.current === clip) return;
    const next = r.actions[clip] ?? r.actions.idle!;
    const prev = r.current ? r.actions[r.current] : undefined;
    next.reset().setEffectiveWeight(1).fadeIn(0.25).play();
    if (prev && prev !== next) prev.fadeOut(0.25);
    r.current = clip;
  }

  /** Procedural layers on top of the clip (after the mixer has posed the skeleton). */
  private layer(r: Rigged, c: Character, base: RigClip): void {
    const L = layersFor(c.pose, base);
    if (!L.arms && !L.head && !L.lean) return;
    const rig = poseRig(c.pose, c.animT, c.info.seed, c.seated, c.held);
    const b = r.bones;
    r.root.updateMatrixWorld(true);
    if (L.lean && b.spine) rotateInCharacterSpace(b.spine, r.root, X, rig.lean);
    if (L.head && b.head) rotateInCharacterSpace(b.head, r.root, X, rig.head);
    if (L.arms) {
      // the clip's arms hang down; pitch them forward (about the character's x) and out (about z)
      if (b.upperArmL) {
        rotateInCharacterSpace(b.upperArmL, r.root, X, -rig.armL.pitch);
        rotateInCharacterSpace(b.upperArmL, r.root, Z, -rig.armL.roll * 0.5);
      }
      if (b.upperArmR) {
        rotateInCharacterSpace(b.upperArmR, r.root, X, -rig.armR.pitch);
        rotateInCharacterSpace(b.upperArmR, r.root, Z, rig.armR.roll * 0.5);
      }
    }
  }

  /** Brings the rigged characters in line with the sim. `visible(c)` = on screen (full-rate animation). */
  sync(list: Iterable<Character>, dt: number, visible: (c: Character) => boolean): void {
    this.frame++;
    const seen = new Set<string>();
    const all = [...list].filter((c) => !c.gone);
    this.grow(all.length);
    let i = 0;
    for (const c of all) {
      seen.add(c.id);
      let r = this.chars.get(c.id);
      if (!r) {
        r = this.create(c);
        this.chars.set(c.id, r);
      }
      const show = c.alpha > 0.02 && !c.inside;
      r.root.visible = show;
      if (!show) {
        for (const m of [this.shadows, this.badges, this.lanyards, this.held]) m.setMatrixAt(i, ZERO);
        i++;
        continue;
      }
      r.yaw = turnTowards(r.yaw, dirYaw(c.dir), dt * 10);
      const seated = isSeatedPose(c.pose, c.seated);
      const base = baseClipFor(c.pose, c.seated, (k) => !!r!.actions[k]);
      this.play(r, base);
      // off-screen characters animate at a quarter of the rate (P3-06)
      r.pending += dt;
      const onScreen = visible(c);
      if (onScreen || this.frame % 4 === 0) {
        for (const [bone, q] of r.rest) bone.quaternion.copy(q);
        r.mixer.update(r.pending);
        r.pending = 0;
        if (onScreen) this.layer(r, c, base);
      }
      const prof = this.model.profile;
      const s = prof.scale * (r.sub ? 0.86 : 1) * Math.min(1, 0.4 + c.alpha * 0.6);
      r.root.scale.setScalar(s);
      r.root.position.set(mx(c.x + c.offX), seated ? prof.seat.up : 0, mz(c.y + c.offY));
      r.root.rotation.set(0, r.yaw, 0);
      r.root.updateMatrixWorld(true);
      // attachments
      this.shadows.setMatrixAt(i, tmpM.makeTranslation(mx(c.x + c.offX), 0.012, mz(c.y + c.offY)));
      const chest = r.bones.chest ?? r.bones.spine;
      if (chest) {
        chest.getWorldPosition(tmpV);
        tmpQ.setFromEuler(new THREE.Euler(0, r.yaw, 0));
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(tmpQ);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(tmpQ);
        this.badges.setMatrixAt(i, tmpM.compose(tmpV.clone().addScaledVector(fwd, 0.17).addScaledVector(right, 0.08).add(new THREE.Vector3(0, 0.05, 0)), tmpQ, new THREE.Vector3(1, 1, 1)));
        this.badges.setColorAt(i, tmpC.set(this.providerColors.get(c.info.provider) ?? '#888888'));
        this.lanyards.setMatrixAt(i, r.sub ? tmpM.compose(tmpV.clone().addScaledVector(fwd, 0.18).addScaledVector(right, -0.06), tmpQ, new THREE.Vector3(1, 1, 1)) : ZERO);
      } else {
        this.badges.setMatrixAt(i, ZERO);
        this.lanyards.setMatrixAt(i, ZERO);
      }
      const hand = r.bones.handR ?? r.bones.lowerArmR;
      const size = HELD_SIZE[c.held];
      if (hand && size && c.held !== 'none') {
        hand.getWorldPosition(tmpV);
        tmpQ.setFromEuler(new THREE.Euler(0, r.yaw, 0));
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(tmpQ);
        const at = c.held === 'laptop' && seated ? tmpV.clone().addScaledVector(fwd, 0.12).setY(Math.max(0.68, tmpV.y - 0.05)) : tmpV.clone().addScaledVector(fwd, 0.06);
        this.held.setMatrixAt(i, tmpM.compose(at, tmpQ, new THREE.Vector3(...size)));
        this.held.setColorAt(i, tmpC.set(HELD_COLORS[c.held] ?? '#cccccc'));
      } else this.held.setMatrixAt(i, ZERO);
      i++;
    }
    for (const m of [this.shadows, this.badges, this.lanyards, this.held]) {
      m.count = i;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    for (const [id, r] of this.chars) {
      if (seen.has(id)) continue;
      this.root.remove(r.root);
      r.mixer.stopAllAction();
      r.material.dispose();
      this.chars.delete(id);
    }
  }

  /** The point above a character's head (m), for labels and picking. */
  headPoint(c: Character, out: THREE.Vector3): THREE.Vector3 {
    const p = this.model.profile;
    const h = p.height * p.scale * (c.info.kind === 'sub' ? 0.86 : 1);
    const seated = isSeatedPose(c.pose, c.seated);
    return out.set(mx(c.x + c.offX), seated ? h * 0.78 : h + 0.08, mz(c.y + c.offY));
  }

  repaint(): void {
    // badge colors are written every frame
  }

  dispose(): void {
    for (const r of this.chars.values()) {
      r.mixer.stopAllAction();
      r.material.dispose();
    }
    this.chars.clear();
  }
}
