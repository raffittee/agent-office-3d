// The kit's shapes (P10-05): every shape comes out as clean, mergeable geometry inside its extents, and every
// furniture kind (all variants, all procedural looks) still draws inside its footprint with a sane triangle count.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import { PROCEDURALS } from '../../../shared/theme';
import { FURNITURE, FURNITURE_KINDS } from '../core/vocab';
import { furnitureParts, type KitStyle, type Part, type PartShape } from './kit';
import { AO_FLOOR, AO_HEIGHT, partGeometry, partTriangles } from './kit-shapes';
import { TILE_M } from './units';

const SHAPES: PartShape[] = ['box', 'bevel', 'taper', 'cyl', 'dome', 'sphere'];

function part(shape: PartShape, extra: Partial<Part> = {}): Part {
  return { x0: 0.1, x1: 0.4, z0: 0.05, z1: 0.35, y0: 0, y1: 0.5, color: '#c9845c', role: 'body', shape, ...extra };
}

/** The same attributes as building.ts's box(): a BoxGeometry with a color attribute and no uv. */
function plainBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const n = g.attributes.position!.count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));
  g.deleteAttribute('uv');
  return g;
}

function bounds(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}

describe('shapes', () => {
  it.each(SHAPES)('%s: position, normal, color and an index, no NaN, inside its extents', (shape) => {
    const p = part(shape, { k: shape === 'taper' ? 0.5 : shape === 'cyl' ? 1.3 : undefined });
    const g = partGeometry(p, 1, 2);
    for (const name of ['position', 'normal', 'color']) {
      const a = g.getAttribute(name);
      expect(a, name).toBeDefined();
      expect(a!.itemSize, name).toBe(3);
      for (const v of a!.array) expect(Number.isFinite(v), `${shape} ${name}`).toBe(true);
    }
    expect(g.getAttribute('uv')).toBeUndefined();
    expect(g.index).not.toBeNull();
    expect(g.index!.count % 3).toBe(0);
    expect(g.index!.count / 3).toBeGreaterThanOrEqual(5);
    // the part's extents are offset by the footprint corner
    const b = bounds(g);
    const eps = 1e-5;
    expect(b.min.x).toBeGreaterThanOrEqual(1 + p.x0 - eps);
    expect(b.max.x).toBeLessThanOrEqual(1 + p.x1 + eps);
    expect(b.min.z).toBeGreaterThanOrEqual(2 + p.z0 - eps);
    expect(b.max.z).toBeLessThanOrEqual(2 + p.z1 + eps);
    expect(b.min.y).toBeGreaterThanOrEqual(p.y0 - eps);
    expect(b.max.y).toBeLessThanOrEqual(p.y1 + eps);
    // every index points at a vertex, and normals are unit length
    const count = g.getAttribute('position')!.count;
    for (const i of g.index!.array) expect(i).toBeLessThan(count);
    const nor = g.getAttribute('normal')!;
    for (let i = 0; i < nor.count; i++) expect(Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))).toBeCloseTo(1, 4);
    g.dispose();
  });

  it('boxes, bevels and cylinders reach their extents', () => {
    const box = bounds(partGeometry(part('box')));
    expect(box.max.y).toBeCloseTo(0.5);
    expect(box.max.x).toBeCloseTo(0.4);
    const bev = bounds(partGeometry(part('bevel', { k: 0.03 })));
    expect(bev.max.x).toBeCloseTo(0.4);
    expect(bev.max.y).toBeCloseTo(0.5);
    const cyl = bounds(partGeometry(part('cyl', { seg: 12 })));
    expect(cyl.max.y).toBeCloseTo(0.5);
    expect(cyl.max.x - cyl.min.x).toBeGreaterThan(0.28);
    expect(cyl.max.x - cyl.min.x).toBeLessThanOrEqual(0.3 + 1e-6);
    const dome = bounds(partGeometry(part('dome')));
    expect(dome.max.y).toBeCloseTo(0.5);
    expect(dome.min.y).toBeCloseTo(0);
    const sphere = bounds(partGeometry(part('sphere', { y0: 0.2, y1: 0.4 })));
    expect(sphere.min.y).toBeCloseTo(0.2);
    expect(sphere.max.y).toBeCloseTo(0.4);
  });

  it('a taper narrows towards the top (or widens above 1, still inside its extents)', () => {
    const top = (g: THREE.BufferGeometry, atTop: boolean): number => {
      const pos = g.getAttribute('position')!;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i) - (atTop ? 0.5 : 0)) < 1e-6) (lo = Math.min(lo, pos.getX(i)), (hi = Math.max(hi, pos.getX(i))));
      return hi - lo;
    };
    const narrow = partGeometry(part('taper', { k: 0.5 }));
    expect(top(narrow, true)).toBeCloseTo(top(narrow, false) * 0.5, 4);
    const wide = partGeometry(part('cyl', { k: 1.25, seg: 12 }));
    expect(top(wide, true)).toBeGreaterThan(top(wide, false));
    expect(top(wide, true)).toBeLessThanOrEqual(0.3 + 1e-6);
    // a cone ends in a point
    const cone = partGeometry(part('cyl', { k: 0 }));
    expect(top(cone, true)).toBeLessThan(1e-6);
  });

  it('normals point outwards', () => {
    for (const shape of SHAPES) {
      const g = partGeometry(part(shape));
      const pos = g.getAttribute('position')!;
      const nor = g.getAttribute('normal')!;
      const c = new THREE.Vector3(0.25, 0.25, 0.2);
      let outwards = 0;
      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).sub(c);
        if (v.dot(new THREE.Vector3().fromBufferAttribute(nor, i)) > 0) outwards++;
      }
      expect(outwards / pos.count, shape).toBeGreaterThan(0.95);
    }
  });

  it('merges with building.ts boxes and with each other', () => {
    const geos = [plainBox(), ...SHAPES.map((s) => partGeometry(part(s)))];
    const merged = mergeGeometries(geos);
    expect(merged).not.toBeNull();
    expect(merged!.index).not.toBeNull();
    expect(merged!.getAttribute('color')!.count).toBe(merged!.getAttribute('position')!.count);
    expect(merged!.getAttribute('normal')!.count).toBe(merged!.getAttribute('position')!.count);
  });

  it('parts that stand on the floor are darker at its foot, others are not', () => {
    const lum = (g: THREE.BufferGeometry, y: number): number => {
      const pos = g.getAttribute('position')!;
      const col = g.getAttribute('color')!;
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i) - y) < 1e-6) return col.getX(i);
      return NaN;
    };
    const standing = partGeometry(part('box', { color: '#808080' }));
    const base = lum(standing, 0);
    const lifted = lum(standing, AO_HEIGHT);
    expect(base / lifted).toBeCloseTo(AO_FLOOR, 2);
    expect(lum(standing, 0.5)).toBeCloseTo(lifted, 6);
    const shelf = partGeometry(part('box', { color: '#808080', y0: 0.4, y1: 0.9 }));
    expect(lum(shelf, 0.4)).toBeCloseTo(lifted, 6);
    // glow parts are not shaded, tone scales the color
    const glow = partGeometry(part('box', { color: '#808080', mat: 'glow' }));
    expect(lum(glow, 0)).toBeCloseTo(lifted, 6);
    const plain = lum(partGeometry(part('box', { color: '#404040' })), 0.5);
    expect(lum(partGeometry(part('box', { color: '#404040', tone: 2 })), 0.5)).toBeCloseTo(plain * 2, 6);
  });
});

const LOOKS: KitStyle[] = [undefined, ...PROCEDURALS].map((look) => ({ color: () => undefined, procedural: () => look }) as KitStyle);

describe('the kit', () => {
  it('every kind, variant and look draws inside its footprint, with valid parts', () => {
    for (const kind of FURNITURE_KINDS) {
      const def = FURNITURE[kind];
      if (def.mount !== 'floor') continue;
      const w = def.footprint.w * TILE_M;
      const d = Math.max(1, def.footprint.h) * TILE_M;
      for (const variant of [undefined, ...(def.variants ?? [])]) {
        for (const style of LOOKS) {
          const parts = furnitureParts(kind, variant, style);
          const tag = `${kind}/${variant ?? '-'}/${style.procedural(kind) ?? 'default'}`;
          expect(parts.length, tag).toBeGreaterThan(0);
          for (const p of parts) {
            expect(p.x0, tag).toBeGreaterThanOrEqual(-0.001);
            expect(p.x1, tag).toBeLessThanOrEqual(w + 0.001);
            expect(p.z0, tag).toBeGreaterThanOrEqual(-0.001);
            expect(p.z1, tag).toBeLessThanOrEqual(d + 0.001);
            expect(p.y0, tag).toBeGreaterThanOrEqual(0);
            expect(p.y1, tag).toBeGreaterThan(p.y0);
            expect(p.y1, tag).toBeLessThan(2.5);
            expect(p.x1, tag).toBeGreaterThan(p.x0);
            expect(p.z1, tag).toBeGreaterThan(p.z0);
            expect(p.color, tag).toMatch(/^#[0-9a-f]{6}$/i);
            expect(p.role, tag).toBeDefined();
            if (p.shape) expect(SHAPES, tag).toContain(p.shape);
          }
        }
      }
    }
  });

  it('every kind has a contact shadow under it and a sane triangle count', () => {
    let total = 0;
    for (const kind of FURNITURE_KINDS) {
      const def = FURNITURE[kind];
      if (def.mount !== 'floor') continue;
      const parts = furnitureParts(kind, def.variants?.[0]);
      const shadow = parts.filter((p) => p.mat === 'glass' && p.y1 < 0.02);
      if (kind !== 'glass_partition') expect(shadow.length, kind).toBe(1);
      const tris = parts.reduce((s, p) => s + partTriangles(p), 0);
      expect(tris, kind).toBeLessThan(900);
      total += tris;
    }
    // all floor kinds together stay well below a small scene's worth
    expect(total).toBeLessThan(14000);
  });

  it('every part of every kind builds finite geometry that merges into one mesh', () => {
    const geos: THREE.BufferGeometry[] = [];
    for (const kind of FURNITURE_KINDS) {
      if (FURNITURE[kind].mount !== 'floor') continue;
      for (const p of furnitureParts(kind, FURNITURE[kind].variants?.[0])) {
        const g = partGeometry(p, 3, 4);
        for (const v of g.getAttribute('position')!.array) if (!Number.isFinite(v)) throw new Error(`${kind}: NaN position`);
        geos.push(g);
      }
    }
    expect(mergeGeometries(geos)).not.toBeNull();
  });

  it('a hex room variant stays the seat color on every seat part', () => {
    for (const kind of ['office_chair', 'office_chair_front'] as const) {
      const seat = furnitureParts(kind, '#abcdef').filter((p) => p.role === 'seat');
      expect(seat.length).toBeGreaterThan(1);
      expect(seat.every((p) => p.color === '#abcdef')).toBe(true);
    }
  });
});
