// Builds the example theme's models (P4-10): low-poly shapes made from code, so the files are our own work (CC0) and
// show pack authors the model conventions: metres, Y up, the front facing +Z, one material per color.
//
//   npx tsx scripts/themes/example-models.ts   → themes/cabin/models/{cactus,side-table}.glb
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Document, NodeIO, type Material } from '@gltf-transform/core';

type Vec3 = [number, number, number];

/** A mesh in progress: triangles with flat normals. */
class Shape {
  pos: number[] = [];
  nor: number[] = [];

  private tri(a: Vec3, b: Vec3, c: Vec3): void {
    const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.nor.push(nx / l, ny / l, nz / l);
    }
  }

  /** A cylinder (n sides) along Y, from y0 to y1, centred on (x, z); `r1` tapers the top. */
  cylinder(x: number, z: number, y0: number, y1: number, r0: number, r1 = r0, n = 8): this {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (r: number, a: number, y: number): Vec3 => [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
      this.tri(p(r0, a0, y0), p(r1, a1, y1), p(r0, a1, y0));
      this.tri(p(r0, a0, y0), p(r1, a0, y1), p(r1, a1, y1));
      this.tri([x, y1, z], p(r1, a1, y1), p(r1, a0, y1));
      this.tri([x, y0, z], p(r0, a0, y0), p(r0, a1, y0));
    }
    return this;
  }

  /** An axis-aligned box. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): this {
    const c = (x: number, y: number, z: number): Vec3 => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
    const quad = (a: Vec3, b: Vec3, cc: Vec3, d: Vec3) => {
      this.tri(a, b, cc);
      this.tri(a, cc, d);
    };
    quad(c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1));
    quad(c(1, 0, 0), c(0, 0, 0), c(0, 1, 0), c(1, 1, 0));
    quad(c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0));
    quad(c(1, 0, 1), c(1, 0, 0), c(1, 1, 0), c(1, 1, 1));
    quad(c(0, 1, 1), c(1, 1, 1), c(1, 1, 0), c(0, 1, 0));
    quad(c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1));
    return this;
  }
}

async function write(file: string, parts: [Shape, string, number][]): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('model');
  const mats = new Map<string, Material>();
  for (const [shape, color, roughness] of parts) {
    let mat = mats.get(color);
    if (!mat) {
      const n = parseInt(color.slice(1), 16);
      const lin = (v: number) => ((v / 255) <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      mat = doc.createMaterial(color).setBaseColorFactor([lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255), 1]).setRoughnessFactor(roughness).setMetallicFactor(0);
      mats.set(color, mat);
    }
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(shape.pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(shape.nor)).setBuffer(buffer))
      .setMaterial(mat);
    mesh.addPrimitive(prim);
  }
  doc.createScene('scene').addChild(doc.createNode('model').setMesh(mesh));
  doc.getRoot().getAsset().generator = 'Agent Office scripts/themes/example-models.ts';
  mkdirSync(dirname(file), { recursive: true });
  await new NodeIO().write(file, doc);
  console.log(`wrote ${file}`);
}

const out = resolve('themes/cabin/models');

// a saguaro in a terracotta pot (~1.4 m)
const pot = new Shape().cylinder(0, 0, 0, 0.32, 0.17, 0.21).cylinder(0, 0, 0.32, 0.37, 0.23, 0.23);
const soil = new Shape().cylinder(0, 0, 0.37, 0.38, 0.2, 0.2);
const cactus = new Shape()
  .cylinder(0, 0, 0.38, 1.3, 0.09, 0.08, 8)
  .cylinder(0, 0, 1.3, 1.38, 0.08, 0.03, 8)
  .box(0.06, 0.78, -0.045, 0.22, 0.86, 0.045)
  .cylinder(0.2, 0, 0.78, 1.1, 0.055, 0.05, 6)
  .cylinder(0.2, 0, 1.1, 1.15, 0.05, 0.02, 6)
  .box(-0.2, 0.62, -0.04, -0.06, 0.7, 0.04)
  .cylinder(-0.19, 0, 0.62, 0.9, 0.05, 0.045, 6)
  .cylinder(-0.19, 0, 0.9, 0.94, 0.045, 0.02, 6);
const flower = new Shape().box(-0.03, 1.36, -0.03, 0.03, 1.41, 0.03);
await write(`${out}/cactus.glb`, [
  [pot, '#c4703f', 0.9],
  [soil, '#4a3527', 1],
  [cactus, '#4f8a3c', 0.7],
  [flower, '#f2c94c', 0.6],
]);

// a round wooden side table on a turned stem (~0.75 m)
const top = new Shape().cylinder(0, 0, 0.7, 0.75, 0.32, 0.32, 12);
const stem = new Shape().cylinder(0, 0, 0.06, 0.7, 0.04, 0.035, 8).cylinder(0, 0, 0.3, 0.38, 0.06, 0.06, 8);
const foot = new Shape().cylinder(0, 0, 0, 0.06, 0.22, 0.18, 12);
await write(`${out}/side-table.glb`, [
  [top, '#b07a4a', 0.6],
  [stem, '#6e4a2c', 0.7],
  [foot, '#6e4a2c', 0.7],
]);
