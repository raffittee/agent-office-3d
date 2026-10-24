// The asset pipeline (P3-01): its transforms on synthetic models, and the checks over committed assets (every file
// listed in ASSETS.md, characters within the ADR 0004 budget).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, type Node } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { listAssetFiles, listedFiles, summariseGlb } from '../scripts/assets/check';
import { bakeSlots, budgetOf, checkCharacterBudget, mergeSkinned, rigidToSkinned, trimJoints } from '../scripts/assets/pipeline';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * A tiny character: a skeleton root → hand → finger, a skinned "body" (two materials) weighted to the hand and finger,
 * and a rigid "hat" parented to the root joint, offset by (0, 2, 0).
 */
function makeCharacter(): { doc: Document; joints: Node[] } {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const rootJ = doc.createNode('Root').setTranslation([0, 1, 0]);
  const hand = doc.createNode('Hand').setTranslation([1, 0, 0]);
  const finger = doc.createNode('Finger').setTranslation([0.5, 0, 0]);
  rootJ.addChild(hand);
  hand.addChild(finger);
  scene.addChild(rootJ);
  const joints = [rootJ, hand, finger];
  // inverse bind matrices = inverse of the joints' rest world transforms (pure translations here)
  const worlds = [
    [0, 1, 0],
    [1, 1, 0],
    [1.5, 1, 0],
  ];
  const ibm = new Float32Array(48);
  worlds.forEach(([x, y, z], i) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x!, -y!, -z!, 1], i * 16));
  const skin = doc.createSkin('Skin').setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
  for (const j of joints) skin.addJoint(j);
  const tri = (pos: number[], j: number[], w: number[], mat: string) =>
    doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
      .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(j)).setBuffer(buffer))
      .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(w)).setBuffer(buffer))
      .setMaterial(doc.createMaterial(mat).setBaseColorFactor(mat === 'Main' ? [1, 0, 0, 1] : [0.2, 0.2, 0.2, 1]));
  const body = doc
    .createMesh('Body')
    .addPrimitive(tri([1, 1, 0, 1.5, 1, 0, 1, 1.5, 0], [1, 0, 0, 0, 2, 0, 0, 0, 1, 2, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0], 'Main'))
    .addPrimitive(tri([0, 1, 0, 0.2, 1, 0, 0, 1.2, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 'Dark'));
  scene.addChild(doc.createNode('BodyNode').setMesh(body).setSkin(skin));
  const hatPrim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0])).setBuffer(buffer))
    .setMaterial(doc.getRoot().listMaterials()[1]!);
  rootJ.addChild(doc.createNode('Hat').setTranslation([0, 2, 0]).setMesh(doc.createMesh('Hat').addPrimitive(hatPrim)));
  return { doc, joints };
}

describe('asset pipeline', () => {
  it('trims finger joints: weights move to the nearest kept ancestor, the skin and its matrices shrink', () => {
    const { doc } = makeCharacter();
    const { removed } = trimJoints(doc, (n) => n !== 'Finger');
    expect(removed).toEqual(['Finger']);
    const skin = doc.getRoot().listSkins()[0]!;
    expect(skin.listJoints().map((j) => j.getName())).toEqual(['Root', 'Hand']);
    expect(skin.getInverseBindMatrices()!.getCount()).toBe(2);
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    // vertex 1 was all Finger → now all Hand (index 1); vertex 2 was half Hand, half Finger → all Hand
    expect(prim.getAttribute('JOINTS_0')!.getElement(1, [])[0]).toBe(1);
    expect(prim.getAttribute('WEIGHTS_0')!.getElement(2, [])).toEqual([1, 0, 0, 0]);
  });

  it('refuses to cut the skeleton (a removed joint above a kept one)', () => {
    const { doc } = makeCharacter();
    expect(() => trimJoints(doc, (n) => n !== 'Hand')).toThrow(/Finger is kept/);
  });

  it('bakes material colors into vertex colors with a tint mask, and leaves one material', () => {
    const { doc } = makeCharacter();
    bakeSlots(doc, ['Main']);
    expect(doc.getRoot().listMaterials().map((m) => m.getName())).toEqual(['Character']);
    const [main, dark] = doc.getRoot().listMeshes()[0]!.listPrimitives();
    expect(main!.getAttribute('COLOR_0')!.getElement(0, [])).toEqual([1, 0, 0]);
    expect(main!.getAttribute('_TINT')!.getScalar(0)).toBe(1);
    expect(dark!.getAttribute('_TINT')!.getScalar(0)).toBe(0);
  });

  it('turns a rigid part into a skinned one that lands where it was (bind space), then merges everything into one draw call', () => {
    const { doc } = makeCharacter();
    trimJoints(doc, (n) => n !== 'Finger');
    bakeSlots(doc, ['Main']);
    expect(rigidToSkinned(doc)).toBe(1);
    mergeSkinned(doc);
    const b = budgetOf(doc);
    expect(b).toMatchObject({ materials: 1, primitives: 1, joints: 2 });
    expect(checkCharacterBudget(b)).toEqual([]);
    // the hat (rigid under Root at +2) sits at Root's rest position + (0, 2, 0) = (0, 3, 0) in bind space
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const pos = prim.getAttribute('POSITION')!;
    const all = Array.from({ length: pos.getCount() }, (_, i) => (pos.getElement(i, []) as number[]).map((v) => +v.toFixed(4)));
    expect(all).toContainEqual([0, 3, 0]);
    expect(all).toContainEqual([0.1, 3, 0]);
    // and it is weighted to Root only
    const k = all.findIndex((p) => p[1] === 3);
    expect(prim.getAttribute('JOINTS_0')!.getElement(k, [])[0]).toBe(0);
    expect(prim.getAttribute('WEIGHTS_0')!.getElement(k, [])).toEqual([1, 0, 0, 0]);
  });

  it('flags a character over budget', () => {
    expect(checkCharacterBudget({ triangles: 20_000, joints: 53, materials: 2, primitives: 14, textures: 0, animations: [] })).toHaveLength(4);
  });
});

describe('committed assets', () => {
  const assetsMd = readFileSync(join(root, 'ASSETS.md'), 'utf8');
  const files = listAssetFiles(root, ['client/public', 'themes']);

  it('every committed asset file is listed in ASSETS.md', () => {
    const listed = listedFiles(assetsMd);
    expect(files.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('every committed character fits the ADR 0004 budget', () => {
    for (const f of files.filter((x) => x.startsWith('client/public/assets/characters/') && x.endsWith('.glb'))) {
      const s = summariseGlb(join(root, f));
      expect(s.materials, f).toBeLessThanOrEqual(1);
      expect(s.primitives, f).toBeLessThanOrEqual(1);
      expect(s.joints, f).toBeLessThanOrEqual(25);
      expect(s.triangles, f).toBeLessThanOrEqual(15_000);
    }
  });
});
