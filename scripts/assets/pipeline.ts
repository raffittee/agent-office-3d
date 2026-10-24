// The asset pipeline's transforms (P3-01, ADR 0004), on glTF Transform documents. Each one is tested on synthetic
// files in test/assets.test.ts; build.ts chains them for each character profile.
//
// Character budget (ADR 0004): one skinned mesh, one material (colors baked into vertex colors, with a mask for the
// slots a character's appearance recolors), ≤ 25 joints (no fingers), meshopt compression.
import { type Document, type Node, type Primitive, type Skin } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

/** Removes KHR_materials_unlit, so the office's lights shade the model. */
export function stripUnlit(doc: Document): void {
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'KHR_materials_unlit') ext.dispose();
}

/** Drops morph targets (facial expressions): a merged character can't keep per-part morphs. */
export function dropMorphTargets(doc: Document): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) for (const t of prim.listTargets()) prim.removeTarget(t);
    mesh.setWeights([]);
  }
}

/**
 * Bakes each primitive's material color into COLOR_0 and marks the vertices of `tintSlots` materials in a `_TINT`
 * attribute (1 = recolored per character), then gives every primitive one shared material.
 */
export function bakeSlots(doc: Document, tintSlots: readonly string[], materialName = 'Character'): void {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const shared = doc.createMaterial(materialName).setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.75).setMetallicFactor(0);
  const old = new Set(root.listMaterials().filter((m) => m !== shared));
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const n = prim.getAttribute('POSITION')!.getCount();
      const [r, g, b] = mat?.getBaseColorFactor() ?? [1, 1, 1, 1];
      const prev = prim.getAttribute('COLOR_0');
      const colors = new Float32Array(n * 3);
      const el: number[] = [];
      for (let i = 0; i < n; i++) {
        const c = prev ? prev.getElement(i, el) : [1, 1, 1];
        colors[i * 3] = (c[0] ?? 1) * r;
        colors[i * 3 + 1] = (c[1] ?? 1) * g;
        colors[i * 3 + 2] = (c[2] ?? 1) * b;
      }
      const tint = new Float32Array(n).fill(mat && tintSlots.includes(mat.getName()) ? 1 : 0);
      prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(colors).setBuffer(buffer));
      prim.setAttribute('_TINT', doc.createAccessor().setType('SCALAR').setArray(tint).setBuffer(buffer));
      prim.setMaterial(shared);
    }
  }
  for (const m of old) m.dispose();
}

/** Skinned primitives and the skin they use. */
function skinnedPrims(doc: Document): { node: Node; prim: Primitive; skin: Skin }[] {
  const out: { node: Node; prim: Primitive; skin: Skin }[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (skin && mesh) for (const prim of mesh.listPrimitives()) out.push({ node, prim, skin });
  }
  return out;
}

/**
 * Removes the joints `keep` rejects (finger bones): their vertex weights move to the nearest kept ancestor, the skin
 * and its inverse bind matrices shrink, and animation channels on the removed joints go. Throws if a removed joint has
 * a kept descendant (that would cut the skeleton).
 */
export function trimJoints(doc: Document, keep: (name: string) => boolean): { removed: string[] } {
  const removed = new Set<Node>();
  for (const skin of doc.getRoot().listSkins()) for (const j of skin.listJoints()) if (!keep(j.getName())) removed.add(j);
  const allJoints = new Set(doc.getRoot().listSkins().flatMap((s) => s.listJoints()));
  const keptBelow = (n: Node): Node | null => {
    for (const c of n.listChildren()) {
      if (allJoints.has(c) && !removed.has(c)) return c;
      const deeper = keptBelow(c);
      if (deeper) return deeper;
    }
    return null;
  };
  for (const n of removed) {
    const bad = keptBelow(n);
    if (bad) throw new Error(`joint ${n.getName()} is removed but its descendant ${bad.getName()} is kept`);
  }
  const target = (n: Node, joints: Node[]): number => {
    for (let cur: Node | null = n; cur; cur = cur.getParentNode()) {
      if (!removed.has(cur) && joints.includes(cur)) return joints.indexOf(cur);
    }
    return 0;
  };
  const prims = skinnedPrims(doc);
  for (const skin of doc.getRoot().listSkins()) {
    const joints = skin.listJoints();
    const kept = joints.filter((j) => !removed.has(j));
    const remap = joints.map((j) => kept.indexOf(joints[target(j, joints)]!));
    for (const { prim } of prims.filter((p) => p.skin === skin)) remapWeights(doc, prim, remap);
    const ibm = skin.getInverseBindMatrices();
    if (ibm) {
      const arr = new Float32Array(kept.length * 16);
      const el: number[] = [];
      kept.forEach((j, i) => arr.set(ibm.getElement(joints.indexOf(j), el), i * 16));
      skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(arr).setBuffer(ibm.getBuffer()));
    }
    for (const j of joints) if (removed.has(j)) skin.removeJoint(j);
  }
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      if (node && removed.has(node)) {
        ch.getSampler()?.dispose();
        ch.dispose();
      }
    }
  }
  const names = [...removed].map((n) => n.getName());
  for (const n of removed) n.dispose();
  return { removed: names };
}

/** Rewrites JOINTS_0/WEIGHTS_0 through `remap` (old joint index → new), keeping the 4 largest weights, normalized. */
function remapWeights(doc: Document, prim: Primitive, remap: number[]): void {
  const J = prim.getAttribute('JOINTS_0');
  const W = prim.getAttribute('WEIGHTS_0');
  if (!J || !W) return;
  const n = J.getCount();
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  const je: number[] = [];
  const we: number[] = [];
  for (let i = 0; i < n; i++) {
    J.getElement(i, je);
    W.getElement(i, we);
    const acc = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const w = we[k] ?? 0;
      if (w <= 0) continue;
      const t = remap[je[k] ?? 0] ?? 0;
      acc.set(t, (acc.get(t) ?? 0) + w);
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    top.forEach(([j, w], k) => {
      joints[i * 4 + k] = j;
      weights[i * 4 + k] = w / sum;
    });
    if (!top.length) weights[i * 4] = 1;
  }
  prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(J.getBuffer()));
  prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(W.getBuffer()));
}

// ---------------------------------------------------------------- column-major 4x4 helpers

type Mat4 = number[];

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}

function invert(m: Mat4): Mat4 {
  // Gauss-Jordan on a row-major copy
  const a = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]!));
  const inv = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (r === c ? 1 : 0)));
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-12) throw new Error('singular matrix');
    [a[c], a[p]] = [a[p]!, a[c]!];
    [inv[c], inv[p]] = [inv[p]!, inv[c]!];
    const d = a[c]![c]!;
    for (let k = 0; k < 4; k++) {
      a[c]![k]! /= d;
      inv[c]![k]! /= d;
    }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      for (let k = 0; k < 4; k++) {
        a[r]![k]! -= f * a[c]![k]!;
        inv[r]![k]! -= f * inv[c]![k]!;
      }
    }
  }
  const o = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = inv[r]![c]!;
  return o;
}

function apply(m: Mat4, v: number[], w: number): number[] {
  return [0, 1, 2].map((r) => m[r]! * v[0]! + m[4 + r]! * v[1]! + m[8 + r]! * v[2]! + m[12 + r]! * w);
}

/**
 * Turns meshes rigidly parented to a joint (no skin) into skinned meshes of that joint's skin: weight 1 on the joint,
 * vertices moved into bind space (v' = inverse(IBM) · L · v, L = the mesh's transform below the joint). The result
 * looks the same in every pose, and can then be merged with the skinned parts.
 */
export function rigidToSkinned(doc: Document): number {
  const skins = doc.getRoot().listSkins();
  const skin = skins[0];
  if (!skin) return 0;
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices();
  let converted = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || node.getSkin()) continue;
    // the nearest joint above, and the transform from it down to this node
    let L: Mat4 = node.getMatrix();
    let cur = node.getParentNode();
    while (cur && !joints.includes(cur)) {
      L = mul(cur.getMatrix(), L);
      cur = cur.getParentNode();
    }
    if (!cur) continue;
    const j = joints.indexOf(cur);
    const bind = ibm ? (ibm.getElement(j, []) as Mat4) : invert([...cur.getWorldMatrix()]);
    const M = mul(invert(bind), L);
    // normals: inverse transpose of the upper 3x3
    const Mi = invert(M);
    const N: Mat4 = [Mi[0]!, Mi[4]!, Mi[8]!, 0, Mi[1]!, Mi[5]!, Mi[9]!, 0, Mi[2]!, Mi[6]!, Mi[10]!, 0, 0, 0, 0, 1];
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!;
      const nor = prim.getAttribute('NORMAL');
      const n = pos.getCount();
      const P = new Float32Array(n * 3);
      const Nn = new Float32Array(n * 3);
      const el: number[] = [];
      for (let i = 0; i < n; i++) {
        P.set(apply(M, pos.getElement(i, el), 1), i * 3);
        if (nor) {
          const v = apply(N, nor.getElement(i, el), 0);
          const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
          Nn.set([v[0]! / l, v[1]! / l, v[2]! / l], i * 3);
        }
      }
      const buffer = pos.getBuffer();
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(P).setBuffer(buffer));
      if (nor) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(Nn).setBuffer(buffer));
      prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(n * 4).map((_, k) => (k % 4 === 0 ? j : 0))).setBuffer(buffer));
      prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(n * 4).map((_, k) => (k % 4 === 0 ? 1 : 0))).setBuffer(buffer));
    }
    // the vertices are in bind space now: the node itself must not move them
    node.setSkin(skin).setMatrix(IDENTITY as unknown as Parameters<Node['setMatrix']>[0]);
    node.getParentNode()?.removeChild(node);
    for (const scene of doc.getRoot().listScenes()) scene.addChild(node);
    converted++;
  }
  return converted;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const MERGED_ATTRS = ['POSITION', 'NORMAL', 'COLOR_0', '_TINT', 'JOINTS_0', 'WEIGHTS_0'] as const;
const SIZES: Record<(typeof MERGED_ATTRS)[number], number> = { POSITION: 3, NORMAL: 3, COLOR_0: 3, _TINT: 1, JOINTS_0: 4, WEIGHTS_0: 4 };

/**
 * Merges every skinned primitive into one primitive on one node with one skin (one draw call per character). Joint
 * indices are remapped onto the first skin's joints (all skins must use the same joint nodes). Run after bakeSlots.
 *
 * Skinned vertices live in bind space (glTF ignores a skinned mesh's node transform, and three.js renders them the
 * same way; checked against three's own skinning), so they are copied as they are and the merged node sits at the
 * scene root with no transform.
 */
export function mergeSkinned(doc: Document, name = 'Character'): void {
  const prims = skinnedPrims(doc);
  if (!prims.length) throw new Error('no skinned mesh to merge');
  const skin = prims[0]!.skin;
  const joints = skin.listJoints();
  for (const p of prims) {
    for (const j of p.skin.listJoints()) if (!joints.includes(j)) throw new Error(`skins don't share joint ${j.getName()}`);
    if (p.prim.listTargets().length) throw new Error('drop morph targets before merging');
  }
  const count = prims.reduce((s, p) => s + p.prim.getAttribute('POSITION')!.getCount(), 0);
  const indexCount = prims.reduce((s, p) => s + (p.prim.getIndices()?.getCount() ?? p.prim.getAttribute('POSITION')!.getCount()), 0);
  const out = Object.fromEntries(MERGED_ATTRS.map((a) => [a, a === 'JOINTS_0' ? new Uint16Array(count * 4) : new Float32Array(count * SIZES[a])])) as Record<(typeof MERGED_ATTRS)[number], Float32Array | Uint16Array>;
  const indices = new Uint32Array(indexCount);
  let base = 0;
  let ib = 0;
  const el: number[] = [];
  for (const { prim, skin: s } of prims) {
    const n = prim.getAttribute('POSITION')!.getCount();
    const local = s.listJoints().map((j) => joints.indexOf(j));
    for (const a of MERGED_ATTRS) {
      const acc = prim.getAttribute(a);
      const size = SIZES[a];
      for (let i = 0; i < n; i++) {
        const v = acc ? acc.getElement(i, el) : a === '_TINT' ? [0] : a === 'COLOR_0' ? [1, 1, 1] : a === 'WEIGHTS_0' ? [1, 0, 0, 0] : [0, 0, 0, 0];
        for (let k = 0; k < size; k++) out[a][(base + i) * size + k] = a === 'JOINTS_0' ? (local[v[k] ?? 0] ?? 0) : (v[k] ?? 0);
      }
    }
    const idx = prim.getIndices();
    if (idx) for (let i = 0; i < idx.getCount(); i++) indices[ib++] = idx.getScalar(i) + base;
    else for (let i = 0; i < n; i++) indices[ib++] = base + i;
    base += n;
  }
  const buffer = doc.getRoot().listBuffers()[0]!;
  const prim = doc.createPrimitive().setMaterial(prims[0]!.prim.getMaterial());
  for (const a of MERGED_ATTRS) prim.setAttribute(a, doc.createAccessor().setType(SIZES[a] === 1 ? 'SCALAR' : SIZES[a] === 3 ? 'VEC3' : 'VEC4').setArray(out[a]).setBuffer(buffer));
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(base > 65535 ? indices : new Uint16Array(indices)).setBuffer(buffer));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(mesh).setSkin(skin);
  for (const scene of doc.getRoot().listScenes()) scene.addChild(node);
  const oldMeshes = new Set(prims.map((p) => p.node.getMesh()!));
  const oldSkins = new Set(prims.map((p) => p.skin).filter((s) => s !== skin));
  for (const { node: n } of prims) n.setMesh(null).setSkin(null);
  for (const m of oldMeshes) m.dispose();
  for (const s of oldSkins) s.dispose();
}

/** Resamples animations, removes duplicates and unused data, and compresses with meshopt. */
export async function optimize(doc: Document): Promise<void> {
  await MeshoptEncoder.ready;
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await doc.transform(resample(), dedup(), prune({ keepAttributes: true }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
}

export interface Budget {
  triangles: number;
  joints: number;
  materials: number;
  /** Primitives = draw calls for one instance. */
  primitives: number;
  textures: number;
  animations: string[];
}

export function budgetOf(doc: Document): Budget {
  const root = doc.getRoot();
  let triangles = 0;
  let primitives = 0;
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      primitives++;
      triangles += Math.floor((p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3);
    }
  }
  return {
    triangles,
    joints: Math.max(0, ...root.listSkins().map((s) => s.listJoints().length)),
    materials: root.listMaterials().length,
    primitives,
    textures: root.listTextures().length,
    animations: root.listAnimations().map((a) => a.getName()),
  };
}

/** The character budget from ADR 0004. Returns the problems found (empty = within budget). */
export function checkCharacterBudget(b: Budget): string[] {
  const out: string[] = [];
  if (b.materials > 1) out.push(`${b.materials} materials (budget 1)`);
  if (b.primitives > 1) out.push(`${b.primitives} draw calls (budget 1)`);
  if (b.joints > 25) out.push(`${b.joints} joints (budget 25)`);
  if (b.triangles > 15_000) out.push(`${b.triangles} triangles (budget 15k)`);
  return out;
}
