// From the sim's world units (16 per tile, +y south) to the scene's metres (+z south, +y up).
import { TILE } from '../core/vocab';

/** One tile is half a metre: a 16x12-tile room is 8 m by 6 m. */
export const TILE_M = 0.5;
/** Metres per world unit. */
export const UNIT_M = TILE_M / TILE;

/** Full wall height and the cutaway height (ADR 0003). */
export const WALL_H = 2.8;
export const CUT_H = 0.4;

export const mx = (worldX: number): number => worldX * UNIT_M;
export const mz = (worldY: number): number => worldY * UNIT_M;
/** Tiles to metres. */
export const tm = (tiles: number): number => tiles * TILE_M;
