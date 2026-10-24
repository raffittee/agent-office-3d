// npm run assets:build
// Turns fetched sources (assets-src/) into the committed runtime assets (client/public/assets/): one GLB plus a
// profile JSON per character, within the ADR 0004 budget. Fails if a profile names a bone or clip the model lacks.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import type { CharacterProfile } from '../../shared/character-profile';
import { sourcePath } from './fetch';
import { bakeSlots, budgetOf, checkCharacterBudget, dropMorphTargets, mergeSkinned, optimize, rigidToSkinned, stripUnlit, trimJoints } from './pipeline';
import { CHARACTERS, type CharacterBuild } from './sources';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const OUT_DIR = join(root, 'client/public/assets/characters');

export async function io(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

async function buildCharacter(c: CharacterBuild): Promise<void> {
  const src = sourcePath(c.source);
  if (!existsSync(src)) throw new Error(`${c.id}: ${src} is missing; run npm run assets:fetch -- ${c.source}`);
  const nodeIO = await io();
  const doc = await nodeIO.read(src);
  const names = new Set(doc.getRoot().listNodes().map((n) => n.getName()));
  const clips = new Set(doc.getRoot().listAnimations().map((a) => a.getName()));
  const missing = [...Object.values(c.profile.bones).filter((b) => !names.has(b)).map((b) => `bone ${b}`), ...Object.values(c.profile.clips).filter((k) => !clips.has(k)).map((k) => `clip ${k}`)];
  if (missing.length) throw new Error(`${c.id}: the model lacks ${missing.join(', ')}`);

  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
  const bounds = getBounds(scene);
  const height = bounds.max[1] - bounds.min[1];

  stripUnlit(doc);
  dropMorphTargets(doc);
  const { removed } = trimJoints(doc, c.keepJoint);
  bakeSlots(doc, c.profile.tintSlots);
  rigidToSkinned(doc);
  mergeSkinned(doc);
  await optimize(doc);

  const budget = budgetOf(doc);
  const problems = checkCharacterBudget(budget);
  if (problems.length) throw new Error(`${c.id}: over budget: ${problems.join(', ')}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${c.id}.glb`;
  await nodeIO.write(join(OUT_DIR, file), doc);
  const profile: CharacterProfile = { file, asset: c.source, height: +height.toFixed(3), scale: +(c.targetHeight / height).toFixed(4), ...c.profile };
  writeFileSync(join(OUT_DIR, `${c.id}.json`), `${JSON.stringify(profile, null, 2)}\n`);
  const kb = (statSync(join(OUT_DIR, file)).size / 1024).toFixed(0);
  process.stdout.write(
    `${c.id}: ${budget.triangles} triangles, ${budget.joints} joints (${removed.length} removed), ${budget.materials} material, ${budget.primitives} draw call, ${budget.animations.length} clips, ${kb} KB, height ${height.toFixed(2)} → scale ${profile.scale}\n`,
  );
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let failed = 0;
  for (const c of CHARACTERS.filter((x) => !ids.length || ids.includes(x.id))) {
    try {
      await buildCharacter(c);
    } catch (err) {
      failed++;
      process.stderr.write(`${(err as Error).message}\n`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
