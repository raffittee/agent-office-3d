// Shapes for the procedural kit (P10-05): turns a kit `Part` (a box, a chamfered box, a cylinder or cone, a dome, a
// sphere or a tapered box, all inside the part's x/y/z extents) into geometry with vertex colors. Every shape comes
// out with the same attributes as a plain box (position, normal, color, an index), so building.ts can merge them with
// everything else into its three buckets. Parts that touch the floor get a baked ambient-occlusion ramp: their
// vertex colors darken over the lowest AO_HEIGHT metres, so furniture sits on the floor instead of floating above it.
import * as THREE from 'three';
import type { Part } from './kit';

/** Height (m) of the dark band at the foot of floor-standing parts, and how bright it is at the floor itself. */
export const AO_HEIGHT = 0.08;
export const AO_FLOOR = 0.55;

type V3 = [number, number, number];
type Pt = [number, number];
interface Ring {
  y: number;
  /** A closed polygon in x/z. */
  p: Pt[];
}

const tmpColor = new THREE.Color();

/** A rectangle ring. */
function rect(x0: number, z0: number, x1: number, z1: number, y: number): Ring {
  return {
    y,
    p: [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ],
  };
}

/** An ellipse ring with n points. */
function ellipse(cx: number, cz: number, rx: number, rz: number, y: number, n: number): Ring {
  const p: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    p.push([cx + Math.cos(a) * rx, cz + Math.sin(a) * rz]);
  }
  return { y, p };
}

/** Collects polygons and turns them into one indexed geometry: flat faces get their own vertices, smooth ones share them. */
class Faces {
  position: number[] = [];
  normal: number[] = [];
  index: number[] = [];
  private shared = new Map<string, number>();
  constructor(private centre: V3) {}

  /** A convex polygon (3+ points). `smooth` averages the normals of faces that meet at a point. */
  add(poly: V3[], smooth: boolean): void {
    // drop repeated points (a collapsed edge at a cone's tip or a sphere's pole)
    const pts: V3[] = [];
    for (const v of poly) {
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - v[0]) + Math.abs(last[1] - v[1]) + Math.abs(last[2] - v[2]) > 1e-7) pts.push(v);
    }
    const first = pts[0];
    const end = pts[pts.length - 1];
    if (first && end && pts.length > 1 && Math.abs(first[0] - end[0]) + Math.abs(first[1] - end[1]) + Math.abs(first[2] - end[2]) <= 1e-7) pts.pop();
    if (pts.length < 3) return;
    // Newell's normal (area weighted)
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
      cx += a[0];
      cy += a[1];
      cz += a[2];
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) return;
    // face outwards (every shape here is convex, so "away from the middle" is outwards)
    const k = pts.length;
    if (nx * (cx / k - this.centre[0]) + ny * (cy / k - this.centre[1]) + nz * (cz / k - this.centre[2]) < 0) {
      pts.reverse();
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const ids = pts.map((v) => this.vertex(v, smooth, nx, ny, nz, len));
    for (let i = 1; i < ids.length - 1; i++) this.index.push(ids[0]!, ids[i]!, ids[i + 1]!);
  }

  private vertex(v: V3, smooth: boolean, nx: number, ny: number, nz: number, len: number): number {
    if (smooth) {
      const key = `${v[0].toFixed(5)},${v[1].toFixed(5)},${v[2].toFixed(5)}`;
      const at = this.shared.get(key);
      if (at !== undefined) {
        // accumulate the raw (area weighted) normal; normalised at the end
        this.normal[at * 3]! += nx;
        this.normal[at * 3 + 1]! += ny;
        this.normal[at * 3 + 2]! += nz;
        return at;
      }
      const id = this.position.length / 3;
      this.shared.set(key, id);
      this.position.push(v[0], v[1], v[2]);
      this.normal.push(nx, ny, nz);
      return id;
    }
    const id = this.position.length / 3;
    this.position.push(v[0], v[1], v[2]);
    this.normal.push(nx / len, ny / len, nz / len);
    return id;
  }

  /** The bands between consecutive rings (they must have the same number of points). */
  loft(rings: Ring[], smooth: boolean): void {
    for (let j = 0; j + 1 < rings.length; j++) {
      const a = rings[j]!;
      const b = rings[j + 1]!;
      const n = a.p.length;
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n;
        this.add(
          [
            [a.p[i]![0], a.y, a.p[i]![1]],
            [a.p[i2]![0], a.y, a.p[i2]![1]],
            [b.p[i2]![0], b.y, b.p[i2]![1]],
            [b.p[i]![0], b.y, b.p[i]![1]],
          ],
          smooth,
        );
      }
    }
  }

  /** A flat lid on a ring. */
  cap(r: Ring): void {
    this.add(
      r.p.map((q) => [q[0], r.y, q[1]] as V3),
      false,
    );
  }
}

/** The geometry of a part, in metres, with its footprint corner at (ox, oz): position, normal, color and an index. */
export function partGeometry(p: Part, ox = 0, oz = 0): THREE.BufferGeometry {
  const x0 = ox + p.x0;
  const x1 = Math.max(x0 + 0.001, ox + p.x1);
  const z0 = oz + p.z0;
  const z1 = Math.max(z0 + 0.001, oz + p.z1);
  const y0 = p.y0;
  const y1 = Math.max(y0 + 0.001, p.y1);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const rx = (x1 - x0) / 2;
  const rz = (z1 - z0) / 2;
  const h = y1 - y0;
  const solid = (p.mat ?? 'solid') === 'solid';
  const ao = solid && y0 < 0.012;
  const shape = p.shape ?? 'box';
  const f = new Faces([cx, (y0 + y1) / 2, cz]);
  // small round things need fewer points to read as round
  const seg = Math.max(5, Math.min(rx < 0.04 ? 6 : rx < 0.08 ? 8 : 16, p.seg ?? 10));
  /** Heights where a ring is needed for the floor shadow ramp. */
  const ramp = (ys: number[]): number[] => (ao && h > AO_HEIGHT * 1.6 ? [ys[0]!, y0 + AO_HEIGHT, ...ys.slice(1)] : ys);

  if (h < 0.004 && (shape === 'box' || shape === 'cyl')) {
    // a decal (the contact shadow): only its top face is ever seen
    f.cap(shape === 'cyl' ? ellipse(cx, cz, rx, rz, y1, seg) : rect(x0, z0, x1, z1, y1));
  } else if (shape === 'bevel') {
    const r = Math.max(0, Math.min(p.k ?? 0.012, rx - 0.0005, rz - 0.0005, h * 0.5));
    // a chamfer under 8 mm is invisible at the camera's distance: a plain box costs half the triangles
    if (r < 0.008) {
      f.loft(ramp([y0, y1]).map((y) => rect(x0, z0, x1, z1, y)), false);
      f.cap(rect(x0, z0, x1, z1, y1));
    } else {
      f.loft([...ramp([y0, y1 - r]).map((y) => rect(x0, z0, x1, z1, y)), rect(x0 + r, z0 + r, x1 - r, z1 - r, y1)], false);
      f.cap(rect(x0 + r, z0 + r, x1 - r, z1 - r, y1));
    }
  } else if (shape === 'taper') {
    const k = Math.max(0.05, p.k ?? 0.7);
    const s0 = k > 1 ? 1 / k : 1;
    const s1 = k > 1 ? 1 : k;
    const at = (y: number): Ring => {
      const s = s0 + (s1 - s0) * ((y - y0) / h);
      return rect(cx - rx * s, cz - rz * s, cx + rx * s, cz + rz * s, y);
    };
    f.loft(ramp([y0, y1]).map(at), false);
    f.cap(at(y1));
  } else if (shape === 'cyl') {
    const k = Math.max(0, p.k ?? 1);
    const s0 = k > 1 ? 1 / k : 1;
    const s1 = k > 1 ? 1 : k;
    const at = (y: number): Ring => {
      const s = s0 + (s1 - s0) * ((y - y0) / h);
      return ellipse(cx, cz, rx * s, rz * s, y, seg);
    };
    f.loft(ramp([y0, y1]).map(at), true);
    if (s1 > 0.03) f.cap(at(y1));
  } else if (shape === 'dome' || shape === 'sphere') {
    const stacks = shape === 'dome' ? 2 : 3;
    const rings: Ring[] = [];
    for (let j = 0; j <= stacks; j++) {
      const phi = shape === 'dome' ? (j / stacks) * (Math.PI / 2) : -Math.PI / 2 + (j / stacks) * Math.PI;
      const rr = Math.max(0, Math.cos(phi));
      const y = shape === 'dome' ? y0 + h * Math.sin(phi) : (y0 + y1) / 2 + (h / 2) * Math.sin(phi);
      rings.push(ellipse(cx, cz, rx * rr, rz * rr, y, seg));
    }
    f.loft(rings, true);
  } else {
    f.loft(ramp([y0, y1]).map((y) => rect(x0, z0, x1, z1, y)), false);
    f.cap(rect(x0, z0, x1, z1, y1));
  }

  // normals of shared vertices were accumulated: normalise them
  const nor = f.normal;
  for (let i = 0; i < nor.length; i += 3) {
    const l = Math.hypot(nor[i]!, nor[i + 1]!, nor[i + 2]!) || 1;
    nor[i] = nor[i]! / l;
    nor[i + 1] = nor[i + 1]! / l;
    nor[i + 2] = nor[i + 2]! / l;
  }

  // the same color treatment as building.ts's box(): sRGB to linear, then the floor shadow and the part's tone
  tmpColor.set(p.color).convertSRGBToLinear();
  const tone = p.tone ?? 1;
  const n = f.position.length / 3;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = f.position[i * 3 + 1]!;
    const k = (ao ? AO_FLOOR + (1 - AO_FLOOR) * Math.min(1, Math.max(0, y / AO_HEIGHT)) : 1) * tone;
    colors[i * 3] = Math.min(1, tmpColor.r * k);
    colors[i * 3 + 1] = Math.min(1, tmpColor.g * k);
    colors[i * 3 + 2] = Math.min(1, tmpColor.b * k);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(f.position), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(f.normal), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(f.index);
  return geo;
}

/** Triangles in a part's geometry (for budgets). */
export function partTriangles(p: Part): number {
  const g = partGeometry(p);
  const n = g.index ? g.index.count / 3 : g.attributes.position!.count / 3;
  g.dispose();
  return n;
}
