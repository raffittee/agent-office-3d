// Ported from habblaud client/src/world/constants.ts (MIT, © 2026 Márcio Junior)
// World sizes and rhythms. In tiles unless noted; speeds and offsets in world units (TILE units per tile).
import { TILE } from './vocab';

export { TILE };

/** Width of one building column (one room north of the corridor and one south). */
export const COL_W = 16;
/** Height of a room: 2 rows of north wall face + 9 of floor + 1 of south wall. */
export const ROOM_H = 12;
/** Height of the corridor that runs through the building from west to east. */
export const CORRIDOR_H = 5;
/** Core columns (reception/restrooms and kitchen/lounge). */
export const CORE_COLS = 2;

export const NORTH_Y = 0;
export const CORRIDOR_Y = ROOM_H;
export const SOUTH_Y = ROOM_H + CORRIDOR_H;
export const BUILDING_H = ROOM_H * 2 + CORRIDOR_H;

/** First (local) column of the rooms' 2-tile door. */
export const DOOR_X = 7;
export const DOOR_W = 2;

/** Speeds in world units per second. */
export const WALK_SPEED = 3.2 * TILE;
export const RUN_SPEED = 6 * TILE;

/** Where the feet stand inside the tile a character is on. */
export const FOOT_DX = TILE / 2;
export const FOOT_DY = 11;

/** Room animation timings (ms). */
export const BUILD_MS = 2600;
export const DISMANTLE_MS = 2200;
export const DISMANTLE_DELAY_MS = 1500;
/** A free slot before the last room waits this long before the farthest room moves into it. */
export const COMPACT_DELAY_MS = 1200;
/** Debounce for agents that disappear from the snapshot. */
export const MISSING_DEBOUNCE_MS = 3000;
