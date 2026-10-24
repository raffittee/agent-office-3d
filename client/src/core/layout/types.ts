// Ported from habblaud client/src/world/layout/types.ts (MIT, © 2026 Márcio Junior)
// Office layout types. Layout modules are PURE (no DOM, no three): they produce descriptions that the renderer turns
// into meshes and the simulation uses for paths and points of interest. Positions are in world units (see vocab.ts).
import type { Dir, FloorKind, FurnitureKind, WallStyle } from '../vocab';

export type AreaKind = 'reception' | 'restroom' | 'cafe' | 'lounge' | 'room' | 'corridor';

/** A rectangle in tiles (absolute world coordinates). */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A placed floor item. */
export interface FurniturePlacement {
  id: string;
  kind: FurnitureKind;
  variant?: string;
  /** Top-left tile of the footprint (absolute). */
  tx: number;
  ty: number;
  /** Visual offset in world units (e.g. a chair centred on a 2-tile desk). Doesn't move the footprint. */
  dx?: number;
  dy?: number;
  /** Relative order in the build animation (0..1). */
  order: number;
  /** Desks: the seat whose occupant drives the screen. */
  seat?: string;
}

/** A wall-mounted item. `cx` = centre along the wall, `baseY` = the wall's base line (world units). */
export interface WallItemPlacement {
  id: string;
  kind: FurnitureKind;
  variant?: string;
  cx: number;
  baseY: number;
  /** 'face' = on the north wall face; 'south' = on the low south wall. */
  on: 'face' | 'south';
  order: number;
}

export interface Doorway {
  x: number;
  w: number;
}

/**
 * A wall run (world units). 'face' is a north wall (full height, its face towards the room), 'south' a south wall
 * (the side towards the camera, cut away in 3D), 'cap' a side wall seen from above.
 */
export type WallSegment =
  | { kind: 'face'; x: number; y: number; w: number; style: WallStyle; doorways?: Doorway[] }
  | { kind: 'south'; x: number; y: number; w: number; style: WallStyle; doorways?: Doorway[] }
  | { kind: 'cap'; x: number; y: number; w: number; h: number; style: WallStyle };

export interface FloorPatch {
  kind: FloorKind;
  /** World units. */
  x: number;
  y: number;
  w: number;
  h: number;
  seed: number;
  tint?: string;
  tint2?: string;
}

export interface RugPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  seed: number;
}

export type SpotKind =
  | 'desk' // a workplace (desk + chair)
  | 'stool' // a meeting-table stool
  | 'nook' // an armchair or beanbag inside a project room (an extra workplace, with a laptop)
  | 'stand' // a standing place inside the room (work without a desk)
  | 'switch' // the light switch
  | 'whiteboard'
  | 'coffee'
  | 'water'
  | 'snack'
  | 'fridge'
  | 'cafe_seat'
  | 'sofa'
  | 'armchair'
  | 'beanbag'
  | 'bench'
  | 'pingpong'
  | 'arcade'
  | 'shelf'
  | 'window'
  | 'stall'
  | 'sink'
  | 'elevator'
  | 'talk'
  | 'watch'; // a standing place to watch a match

/**
 * A point of interest. The character walks to the approach tile (tx, ty), which is walkable, then "snaps" to the
 * final position (x, y) in world units, facing `dir`.
 */
export interface SpotDef {
  id: string;
  kind: SpotKind;
  areaId: string;
  tx: number;
  ty: number;
  x: number;
  y: number;
  dir: Dir;
  seated?: boolean;
  /** The furniture involved (chair, machine, stall…). */
  furnitureId?: string;
  /** Depth to use while taken (seats: just after the furniture). */
  sortY?: number;
  /** Paired spots (ping-pong, a chat) share a group. */
  group?: string;
  /** The desk whose screen follows whoever sits here. */
  deskId?: string;
  /** Preference order (desks). */
  rank?: number;
  /** Side of the desk island: 'S' = back to the camera, 'N' = facing it (desk_back). */
  side?: 'S' | 'N';
}

export interface AreaLayout {
  id: string;
  kind: AreaKind;
  /** The area's rectangle in absolute tiles. */
  rect: TileRect;
  floors: FloorPatch[];
  rugs: RugPatch[];
  walls: WallSegment[];
  wallItems: WallItemPlacement[];
  furniture: FurniturePlacement[];
  spots: SpotDef[];
  /** Walkable tiles (absolute), before furniture blocks some of them. */
  walkable: TileRect[];
  /** Explicitly blocked tiles. */
  blocked?: TileRect[];
  /** The door's tiles (absolute). */
  door?: TileRect;
  /** Project rooms: which side of the corridor. */
  side?: 'north' | 'south';
  /** A light tint over the floor (hex), so each room has its own identity. */
  floorTint?: string;
  /** The rectangle (world units) that darkens when the lights are off. */
  shade?: { x: number; y: number; w: number; h: number };
  /** The wall item that carries the room's name. */
  signId?: string;
}
