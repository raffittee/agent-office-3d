// Ported from habblaud client/src/world/sim/character.ts (MIT, © 2026 Márcio Junior)
// A character's state: position, pose, animation, step queue and visual markers. Renderer-neutral: the 3D view reads
// these fields every frame (position, direction, pose, held item, icon, bubble) and never writes them.
// Not ported: the 2D appearance (Phase 3 derives it from info.seed) and social gatherings (Phase 6).
import { mulberry32 } from '../../../../shared/hash';
import type { AgentInfo } from '../../../../shared/protocol';
import { FOOT_DX, FOOT_DY, TILE } from '../constants';
import type { Dir, HeldItem, IconName, Pose } from '../vocab';
import type { Mode } from './behavior';
import type { ShellStage } from './shell';
import type { Step } from './steps';

export class Character {
  readonly id: string;
  info: AgentInfo;
  readonly rng: () => number;

  // position (world units; the feet) and logical tile (always walkable when standing still)
  x = 0;
  y = 0;
  tx = 0;
  ty = 0;
  dir: Dir = 'down';
  pose: Pose = 'stand';
  held: HeldItem = 'none';
  seated = false;
  alpha = 1;
  visible = true;
  /** Forced depth (seats). null = use y. */
  sortY: number | null = null;
  /** Time (ms) in the current pose, to pick the animation frame. */
  animT = 0;

  // behavior
  mode: Mode = 'idle';
  queue: Step[] = [];
  step: Step | null = null;
  stepT = 0;
  stepStarted = false;
  /** Replan as soon as the current (uninterruptible) step ends. */
  replan = false;
  /** The desk, stool or standing place (reserved while the character exists). */
  homeSpot: string | null = null;
  /** The spot it is at now (a seat or machine), besides home. */
  atSpot: string | null = null;
  /** Spots reserved for the duration of an outing. */
  tempSpots: string[] = [];
  roomId: string;
  leaving = false;
  gone = false;
  arriving = false;
  missingSince: number | null = null;
  /** The idle character's next outing (epoch ms). */
  nextOutingAt = 0;
  /** Drawn only after this moment (the elevator queue). */
  hiddenUntil = 0;
  /** Hidden (inside a stall or a closed elevator). */
  inside = false;
  /** The next time the planner may run (avoids replanning every frame). */
  thinkAt = 0;
  /** A subagent that has delivered its result to its parent. */
  delivered = false;
  /** When the stall visit ends (epoch ms). */
  stallUntil = 0;
  /** Where a seat entry or exit started (a short interpolation). */
  enterFrom: { x: number; y: number } | null = null;
  /** Room full: the tile it works on standing up (no reserved place). */
  standTile: { x: number; y: number } | null = null;
  /** Its own walking pace (±8%), so people leaving together don't walk in perfect lockstep. */
  readonly speedK: number;
  /** Side lane (world units) while walking, so two people on the same path don't overlap. */
  readonly lane: number;
  /** The current visual offset (world units), eased towards the lane while walking. */
  offX = 0;
  offY = 0;

  // markers
  icon: IconName | null = null;
  iconUntil = 0;
  iconAt = 0;
  bubbleText: string | null = null;
  bubbleIcon = '';
  bubbleAt = 0;
  bubbleUntil = 0;
  /** A tiny chat bubble (emoji). */
  chatEmoji = '';
  chatUntil = 0;
  lastActivityId: string | null = null;
  activityChangedAt = 0;

  // waiting for a job ('shell' mode; rules in sim/shell.ts)
  /** When (epoch ms) the current wait started: the oldest job. 0 = not waiting. */
  shellSince = 0;
  /** How many jobs it waits for (the hourglass's "×N"). */
  shellCount = 0;
  shellLabel = '';
  /** The gag's stage (recomputed every frame from the wait's age). */
  shellStage: ShellStage | null = null;
  /** When it entered 'shell' mode (world clock): the bubble's rhythm in 'important' mode. */
  shellEnteredAt = 0;
  /** The bubble's cached text: rebuilt only when the time shown changes (no new string per frame). */
  shellText = '';
  shellTextKey = -1;
  /**
   * A reaction to a job ending (cheer or sulk) runs until this moment: a mode change doesn't cut it (the queue ends
   * back at the desk and the planner follows the current status).
   */
  reactUntil = 0;
  /** `at` of the last job-done Activity handled (earlier ones, from before arriving, don't celebrate). */
  shellDoneAt = 0;

  constructor(info: AgentInfo) {
    this.id = info.id;
    this.info = info;
    this.roomId = info.roomId;
    this.rng = mulberry32((info.seed ^ 0x9e3779b9) >>> 0);
    // from another generator, so the behavior's draw sequence is unchanged
    const r = mulberry32((info.seed ^ 0x51ed27a3) >>> 0);
    this.speedK = 0.92 + r() * 0.16;
    this.lane = Math.round((r() * 2 - 1) * 3.5);
  }

  /** Eases the visual offset towards the lane (walking) or the centre (standing). */
  updateLane(dt: number): void {
    const walking = this.pose === 'walk' || this.pose === 'run';
    const horiz = this.dir === 'left' || this.dir === 'right';
    const tx = walking && !horiz ? this.lane : 0;
    const ty = walking && horiz ? this.lane * 0.6 : 0;
    const k = Math.min(1, dt * 5);
    this.offX += (tx - this.offX) * k;
    this.offY += (ty - this.offY) * k;
    if (Math.abs(this.offX) < 0.05) this.offX = 0;
    if (Math.abs(this.offY) < 0.05) this.offY = 0;
  }

  /** Puts the feet at a tile's default point. */
  placeAtTile(tx: number, ty: number): void {
    this.tx = tx;
    this.ty = ty;
    this.x = tx * TILE + FOOT_DX;
    this.y = ty * TILE + FOOT_DY;
  }

  setPose(pose: Pose, held: HeldItem = 'none'): void {
    if (this.pose !== pose) {
      this.pose = pose;
      this.animT = 0;
    }
    this.held = held;
  }

  setIcon(icon: IconName | null, ms: number, now: number): void {
    this.icon = icon;
    this.iconAt = now;
    this.iconUntil = icon ? now + ms : 0;
  }

  showBubble(icon: string, text: string, ms: number, now: number): void {
    this.bubbleIcon = icon;
    this.bubbleText = text;
    this.bubbleAt = now;
    this.bubbleUntil = now + ms;
  }

  depth(): number {
    return this.sortY ?? this.y;
  }
}

/** The dominant direction of a movement. */
export function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** The direction of A looking at B. */
export function facing(ax: number, ay: number, bx: number, by: number): Dir {
  return dirOf(bx - ax, by - ay, 'down');
}
