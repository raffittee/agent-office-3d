// Pure placement maths for theme models (P4-02): which way a model faces, and how it fits its footprint. Convention for
// pack authors (docs/themes.md): a model's front faces +Z (towards the camera), Y is up, the unit is the metre, and the
// front is the side a person uses (sits at, works at, takes a coffee from).
import { FURNITURE, type FurnitureKind } from '../core/vocab';
import { TILE_M } from './units';

const DIR_YAW: Record<string, number> = { down: 0, right: 90, up: 180, left: -90 };

/** The yaw (degrees, about +Y) that turns a model's front the way this placement faces. */
export function modelYaw(kind: FurnitureKind, variant: string | undefined, extra = 0): number {
  let yaw = 0;
  switch (kind) {
    // the person sits south of a desk, north of a desk_back
    case 'desk_back':
    case 'office_chair':
      yaw = 180;
      break;
    case 'cafe_chair':
    case 'armchair':
    case 'sofa':
      yaw = DIR_YAW[variant ?? 'down'] ?? 0;
      break;
    default:
      yaw = 0;
  }
  return yaw + extra;
}

export interface Box3Like {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface ModelFit {
  /** Uniform scale. */
  scale: number;
  /** Translation (m) from the footprint's top-left corner, applied after yaw and scale. */
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Fits a model (its bounding box in model space) into a kind's footprint: rotated by `yaw`, scaled uniformly so it
 * fills the footprint (times `scale`), centred on it and standing on the floor.
 */
export function fitModel(bbox: Box3Like, kind: FurnitureKind, yawDeg: number, scale = 1): ModelFit {
  const fp = FURNITURE[kind].footprint;
  const w = fp.w * TILE_M;
  const d = Math.max(1, fp.h) * TILE_M;
  const quarter = Math.round(yawDeg / 90) % 2 !== 0;
  const sx = bbox.max.x - bbox.min.x;
  const sz = bbox.max.z - bbox.min.z;
  const ex = Math.max(1e-6, quarter ? sz : sx);
  const ez = Math.max(1e-6, quarter ? sx : sz);
  const s = Math.min(w / ex, d / ez) * scale;
  // the rotated box's centre, in model units
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;
  const r = (yawDeg * Math.PI) / 180;
  const rcx = cx * Math.cos(r) + cz * Math.sin(r);
  const rcz = -cx * Math.sin(r) + cz * Math.cos(r);
  return { scale: s, x: w / 2 - rcx * s, y: -bbox.min.y * s, z: d / 2 - rcz * s, yaw: yawDeg };
}
