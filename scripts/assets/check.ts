// Checks run by test/assets.test.ts (so CI runs them): every committed third-party asset file is listed in ASSETS.md,
// and every committed character GLB is within the ADR 0004 budget. GLBs are read without decoding (JSON chunk only).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** File types that count as assets (our own JSON profiles and code don't). */
export const ASSET_EXT = /\.(glb|gltf|bin|png|jpe?g|webp|ktx2|ogg|mp3|wav|hdr)$/i;

export function listAssetFiles(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (ASSET_EXT.test(n)) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  for (const d of dirs) walk(resolve(root, d));
  return out.sort();
}

/** Paths in ASSETS.md's "Committed files" table (first column, in backticks). */
export function listedFiles(assetsMd: string): Set<string> {
  const section = assetsMd.split(/^## Committed files\s*$/m)[1] ?? '';
  const out = new Set<string>();
  for (const line of section.split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

export interface GlbSummary {
  triangles: number;
  joints: number;
  materials: number;
  primitives: number;
  maxTextureBytes: number;
}

/** Reads a GLB's JSON chunk and summarises it (no buffer decoding needed: counts come from accessors). */
export function summariseGlb(file: string): GlbSummary {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as {
    meshes?: { primitives: { indices?: number; attributes: Record<string, number> }[] }[];
    accessors?: { count: number }[];
    skins?: { joints: number[] }[];
    materials?: unknown[];
    images?: { bufferView?: number }[];
    bufferViews?: { byteLength: number }[];
  };
  let triangles = 0;
  let primitives = 0;
  for (const m of j.meshes ?? []) {
    for (const p of m.primitives) {
      primitives++;
      const acc = j.accessors?.[p.indices ?? p.attributes.POSITION ?? -1];
      triangles += Math.floor((acc?.count ?? 0) / 3);
    }
  }
  const maxTextureBytes = Math.max(0, ...(j.images ?? []).map((i) => (i.bufferView !== undefined ? (j.bufferViews?.[i.bufferView]?.byteLength ?? 0) : 0)));
  return { triangles, joints: Math.max(0, ...(j.skins ?? []).map((s) => s.joints.length)), materials: j.materials?.length ?? 0, primitives, maxTextureBytes };
}
