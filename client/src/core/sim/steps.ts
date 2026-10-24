// Ported from habblaud client/src/world/sim/steps.ts (MIT, © 2026 Márcio Junior)
// The steps of a character's action queue. Made while planning (never per frame).
// Not ported: 'gather' (social gatherings, Phase 6).
import type { Dir, HeldItem, IconName, Pose } from '../vocab';

export type Step =
  /** Walk (or run) to tile (tx, ty); then, optionally, to the fine position (fx, fy), and turn to `dir`. */
  | { t: 'go'; tx: number; ty: number; run?: boolean; fx?: number; fy?: number; dir?: Dir; held?: HeldItem; path?: number[]; i?: number; fine?: boolean }
  /** Snap into a spot (a seat or a place of use). Must be on its approach tile. */
  | { t: 'enter'; spot: string }
  /** Leave the current spot, back to its approach tile (stand up). */
  | { t: 'exit' }
  /** Hold a pose for a while. */
  | { t: 'act'; pose: Pose; ms: number; held?: HeldItem; dir?: Dir; icon?: IconName; machine?: string; seated?: boolean }
  /** Wait for a condition (or the maximum time), in a pose. */
  | { t: 'until'; cond: () => boolean; minMs: number; maxMs: number; pose?: Pose; held?: HeldItem; dir?: Dir }
  /** Appear inside the elevator and step out to the tile in front. */
  | { t: 'elevOut'; elev: number; phase: number }
  /** Step into the elevator and vanish. */
  | { t: 'elevIn'; elev: number; phase: number }
  /** Use a restroom stall: go in, vanish, the door closes; then come out. */
  | { t: 'stall'; spot: string; ms: number; phase: number }
  /** Switch the room's light on or off (must be at the switch spot). */
  | { t: 'switch'; room: string; on: boolean; phase: number; onlyIfLast?: boolean }
  /** An immediate side effect. */
  | { t: 'do'; fn: () => void }
  /** Remove the character from the world. */
  | { t: 'remove' };
