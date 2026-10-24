// Ported from habblaud client/src/world/sim/behavior.ts (MIT, © 2026 Márcio Junior)
// Behavior decisions: PURE functions (tested without a DOM).
import type { ActivityKind, AgentKind, AgentStatus, ShellJob } from '../../../../shared/protocol';
import type { SpotDef } from '../layout/types';
import type { WorldOptions } from '../options';
import type { ScreenMode } from '../vocab';
import { foregroundWaiting } from './shell';

/**
 * A character's high-level mode (derived from the agent's status).
 * 'shell' = waiting for a shell to finish: stays at the desk (no wandering) with the waiting gag (sim/shell.ts).
 */
export type Mode = 'work' | 'wait' | 'idle' | 'shell' | 'deliver' | 'leave';

export function modeFor(
  status: AgentStatus,
  opts: { kind: AgentKind; missing?: boolean; parentGone?: boolean; jobs?: readonly ShellJob[]; now?: number },
): Mode {
  if (opts.missing || status === 'offline') return 'leave';
  if (status === 'done') return opts.kind === 'sub' ? 'deliver' : 'idle';
  if (opts.kind === 'sub' && opts.parentGone) return 'leave';
  if (status === 'waiting') return 'wait';
  if (status === 'shell') return 'shell';
  // working, but stopped waiting for a long foreground command
  if (status === 'working') return opts.now !== undefined && foregroundWaiting(opts.jobs, opts.now) ? 'shell' : 'work';
  return 'idle';
}

/** What the monitor of someone working shows, by activity kind. */
export function screenModeFor(kind: ActivityKind | undefined): ScreenMode {
  switch (kind) {
    case 'edit':
    case 'write':
    case 'think':
      return 'code';
    case 'run':
    case 'test':
    case 'git':
      return 'terminal';
    case 'web':
    case 'browser':
    case 'mcp':
      return 'browser';
    case 'search':
      return 'search';
    case 'read':
    case 'respond':
    case 'compact':
      return 'docs';
    case 'plan':
      return 'tasks';
    case 'communicate':
    case 'ask':
    case 'prompt':
    case 'delegate':
      return 'chat';
    case 'wait':
    case 'error':
      return 'alert';
    case 'skill':
      return 'tasks';
    case 'done':
      return 'idle';
    default:
      return 'code';
  }
}

export type IdleActivity = 'coffee' | 'water' | 'bathroom' | 'lounge' | 'pingpong' | 'talk' | 'window' | 'shelf' | 'stretch' | 'arcade' | 'snack' | 'mirror' | 'phone';

export const IDLE_WEIGHTS: Readonly<Record<IdleActivity, number>> = {
  coffee: 18,
  water: 12,
  bathroom: 8,
  lounge: 12,
  pingpong: 9,
  talk: 13,
  window: 7,
  shelf: 6,
  stretch: 8,
  arcade: 5,
  snack: 5,
  mirror: 3,
  phone: 6,
};

/** A weighted draw among the available activities (`avail[k] === false` excludes one). */
export function pickIdleActivity(
  rng: () => number,
  avail: Partial<Record<IdleActivity, boolean>> = {},
  weights: Readonly<Record<IdleActivity, number>> = IDLE_WEIGHTS,
): IdleActivity | null {
  let total = 0;
  for (const k of Object.keys(IDLE_WEIGHTS) as IdleActivity[]) if (avail[k] !== false) total += weights[k];
  if (total <= 0) return null;
  let r = rng() * total;
  for (const k of Object.keys(IDLE_WEIGHTS) as IdleActivity[]) {
    if (avail[k] === false) continue;
    r -= weights[k];
    if (r < 0) return k;
  }
  return null;
}

const SIT_RANGE: Record<WorldOptions['liveliness'], [number, number]> = {
  calm: [16_000, 42_000],
  normal: [6_000, 20_000],
  lively: [3_000, 10_000],
};

/** How long an idle agent sits at the desk before the next outing. */
export function idleSitMs(rng: () => number, liveliness: WorldOptions['liveliness']): number {
  const [a, b] = SIT_RANGE[liveliness] ?? SIT_RANGE.normal;
  return a + rng() * (b - a);
}

/** Idle for longer than this: dozes at the desk and stops wandering. */
export const LONG_IDLE_MS = 10 * 60_000;

export function isLongIdle(status: AgentStatus, statusSince: number, now: number): boolean {
  return status === 'idle' && now - statusSince > LONG_IDLE_MS;
}

/**
 * Workplace: a free desk (by preference); without one, a meeting-corner stool, then an armchair or beanbag in the
 * room, and finally a standing place.
 */
export function chooseSeat(spots: readonly SpotDef[], isFree: (id: string) => boolean, _kind: AgentKind): SpotDef | null {
  const desks = spots.filter((s) => s.kind === 'desk' && isFree(s.id)).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  if (desks.length) return desks[0]!;
  for (const kind of ['stool', 'nook', 'stand'] as const) {
    const free = spots.find((s) => s.kind === kind && isFree(s.id));
    if (free) return free;
  }
  return null;
}

/** Runs to the desk when far away (or whenever the user is needed). Waiting for a shell: only when very far. */
export function shouldRun(pathTiles: number, mode: Mode): boolean {
  if (mode === 'wait') return pathTiles > 2;
  if (mode === 'work') return pathTiles > 12;
  if (mode === 'shell') return pathTiles > 20;
  return false;
}

/** Is this the last character (not leaving) that belongs to the room? */
export function isLastInRoom(roomId: string, selfId: string, chars: Iterable<{ id: string; roomId: string; leaving: boolean }>): boolean {
  for (const c of chars) if (c.id !== selfId && c.roomId === roomId && !c.leaving) return false;
  return true;
}

/** A room can be dismantled: the server no longer lists it, nobody is inside and the light has been off a while. */
export function canDismantle(r: { listed: boolean; occupants: number; lightOn: boolean; dark: boolean; unlistedForMs: number }, delayMs: number): boolean {
  return !r.listed && r.occupants === 0 && !r.lightOn && r.dark && r.unlistedForMs >= delayMs;
}

/**
 * Light level (0–1) of the on/off animation.
 * On: flickers a few times before settling. Off: a slight flicker and a ~0.6 s fade.
 */
export function lightLevel(on: boolean, elapsedMs: number): number {
  const e = Math.max(0, elapsedMs);
  if (on) {
    if (e < 70) return 0.75;
    if (e < 160) return 0.1;
    if (e < 220) return 0.9;
    if (e < 330) return 0.25;
    return Math.min(1, 0.25 + (e - 330) / 220);
  }
  if (e < 60) return 0.55;
  if (e < 120) return 0.95;
  return Math.max(0, 0.95 * (1 - (e - 120) / 480));
}

