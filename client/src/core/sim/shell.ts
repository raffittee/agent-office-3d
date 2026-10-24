// Ported from habblaud client/src/world/sim/shell.ts (MIT, © 2026 Márcio Junior)
// "Waiting for the shell to finish": the PURE rules (tested without a DOM) of the office gag.
//
// A comic escalation by the age of the oldest job the agent waits for:
// - 0–3 min   ('popcorn'):  leaning back with a bucket of popcorn, watching the terminal like a movie;
// - 3–10 min  ('restless'): the popcorn ran out; arms crossed and now and then a spin in the chair;
// - 10–25 min ('cobweb'):   a cobweb in the corner (2x after 20 min) and yawns;
// - > 25 min  ('nap'):      dozing at the desk, covered in cobweb.
// Always: an hourglass flipping above the head, the monitor on 'progress' and a "⏳ <label> · <time>" bubble.
import { JOB_DONE_TOOL } from '../../../../shared/activity';
import { t } from '../../../../shared/i18n';
import type { Activity, AgentStatus, ShellJob } from '../../../../shared/protocol';
import type { Dir, IconName } from '../vocab';

export type ShellStage = 'popcorn' | 'restless' | 'cobweb' | 'nap';

/** The tool of the Activity the server records when a job ends. */
export const SHELL_DONE_TOOL = JOB_DONE_TOOL;

/** Escalation thresholds (ms of waiting). */
export const SHELL_RESTLESS_MS = 3 * 60_000;
export const SHELL_COBWEB_MS = 10 * 60_000;
export const SHELL_COBWEB_BIG_MS = 20 * 60_000;
export const SHELL_NAP_MS = 25 * 60_000;

/**
 * A FOREGROUND command only becomes "waiting" after this. Quick commands (ls, git status…) don't stop the typing.
 */
export const FOREGROUND_WAIT_MS = 10_000;

/** A full spin in the chair: duration and gap between spins ('restless' stage). */
export const SPIN_MS = 800;
export const SPIN_GAP_MIN_MS = 15_000;
export const SPIN_GAP_MAX_MS = 25_000;
/** The first spin right after the popcorn runs out (not a whole gap later). */
const SPIN_FIRST_MS = 2_500;

/** A yawn ('cobweb' stage): duration and gap. */
export const YAWN_MS = 1_300;
export const YAWN_GAP_MIN_MS = 18_000;
export const YAWN_GAP_MAX_MS = 32_000;
const YAWN_FIRST_MS = 4_000;

/** The little rain cloud ('storm') sits a bit higher than other icons, so the drops fall to the head. */
export const STORM_LIFT = 3;

/** The hourglass flips this often (alternates 'hourglass' / 'hourglass_flip'). */
export const HOURGLASS_FLIP_MS = 1_200;

/** The bubble in 'important' mode: on entering the state, then for 4 s every ~30 s. */
export const SHELL_BUBBLE_ENTER_MS = 6_000;
export const SHELL_BUBBLE_EVERY_MS = 30_000;
export const SHELL_BUBBLE_SHOW_MS = 4_000;
const BUBBLE_FADE_IN_MS = 150;
const BUBBLE_FADE_OUT_MS = 400;

/** The gag's stage by the wait's age (ms). */
export function shellStage(ageMs: number): ShellStage {
  if (ageMs >= SHELL_NAP_MS) return 'nap';
  if (ageMs >= SHELL_COBWEB_MS) return 'cobweb';
  if (ageMs >= SHELL_RESTLESS_MS) return 'restless';
  return 'popcorn';
}

/** The cobweb's integer scale: 0 = none, 1x after 10 min, 2x after 20 min. */
export function cobwebScale(ageMs: number): 0 | 1 | 2 {
  if (ageMs < SHELL_COBWEB_MS) return 0;
  return ageMs >= SHELL_COBWEB_BIG_MS ? 2 : 1;
}

/** The animated hourglass frame. */
export function hourglassIcon(now: number): IconName {
  return Math.floor(now / HOURGLASS_FLIP_MS) % 2 ? 'hourglass_flip' : 'hourglass';
}

// ------------------------------------------------------------------ the agent's jobs

/** Does it count? In the foreground, only commands without a result (background === false). */
function counts(j: ShellJob, foregroundOnly: boolean): boolean {
  return !foregroundOnly || j.background === false;
}

/** The oldest job considered (no allocation). `foregroundOnly`: foreground ones only. */
export function oldestShell(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): ShellJob | null {
  if (!shells) return null;
  let best: ShellJob | null = null;
  for (const j of shells) {
    if (!counts(j, foregroundOnly) || !Number.isFinite(j.startedAt)) continue;
    if (!best || j.startedAt < best.startedAt) best = j;
  }
  return best;
}

/** How many jobs the agent waits for (same rule as `oldestShell`). */
export function countShells(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): number {
  if (!shells) return 0;
  let n = 0;
  for (const j of shells) if (counts(j, foregroundOnly)) n++;
  return n;
}

/**
 * Waiting on a foreground command for longer than FOREGROUND_WAIT_MS? (status 'working' with a long command still
 * without a result: the agent is just watching it run.)
 */
export function foregroundWaiting(shells: readonly ShellJob[] | undefined, now: number): boolean {
  const j = oldestShell(shells, true);
  return !!j && now - j.startedAt > FOREGROUND_WAIT_MS;
}

/**
 * When (epoch ms) an agent's wait in 'shell' mode started: the oldest job (foreground ones when the status is
 * 'working'); with none listed, when the status changed.
 */
export function shellWaitSince(a: { status: AgentStatus; jobs?: ShellJob[]; statusSince: number }): number {
  const j = oldestShell(a.jobs, a.status !== 'shell');
  return j ? j.startedAt : a.statusSince;
}

/** The bubble's label: the oldest job's, or a generic text. */
export function shellLabel(a: { status: AgentStatus; jobs?: ShellJob[] }): string {
  const fg = a.status !== 'shell';
  const j = oldestShell(a.jobs, fg);
  const label = j?.label?.trim();
  if (label) return label;
  if (j?.kind === 'monitor') return t('Monitoring a process');
  return fg ? t('Command in the terminal') : t('Command in the background');
}

/**
 * The agent's latest job-done Activity (the current one or among the recent ones: another activity may have arrived
 * in the same snapshot), or null. No allocation.
 */
export function latestShellDone(a: { activity?: Activity; recent?: readonly Activity[] }): Activity | null {
  let best: Activity | null = a.activity?.tool === SHELL_DONE_TOOL ? a.activity : null;
  const recent = a.recent;
  if (recent) {
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i]!;
      if (r.tool === SHELL_DONE_TOOL && (!best || r.at > best.at)) best = r;
    }
  }
  return best;
}

// ------------------------------------------------------------------ time and bubble

/** Waiting time: "45 s", "3 min", "1 h 05". */
export function formatShellAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} h ${mm < 10 ? '0' : ''}${mm}`;
}

/**
 * A key that changes exactly when `formatShellAge`'s text changes (the bubble only rebuilds the string when needed:
 * seconds in the first minute, then minutes).
 */
export function shellAgeKey(ms: number): number {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s : 60 + Math.floor(s / 60);
}

/** The bubble's text (⏳ is the bubble's icon). */
export function shellBubbleText(label: string, ageMs: number): string {
  return `${label} · ${formatShellAge(ageMs)}`;
}

/**
 * Opacity (0..1) of the waiting bubble in 'important' mode, `ms` after entering the state: visible for the first
 * SHELL_BUBBLE_ENTER_MS; then for SHELL_BUBBLE_SHOW_MS every SHELL_BUBBLE_EVERY_MS (shifted by `offsetMs`, so several
 * characters' bubbles don't blink together).
 */
export function shellBubbleAlpha(ms: number, offsetMs = 0): number {
  if (ms < 0) return 0;
  if (ms < SHELL_BUBBLE_ENTER_MS) return windowAlpha(ms, SHELL_BUBBLE_ENTER_MS);
  const off = ((offsetMs % SHELL_BUBBLE_EVERY_MS) + SHELL_BUBBLE_EVERY_MS) % SHELL_BUBBLE_EVERY_MS;
  // the first repeat ~30 s after entering
  const t = ms - SHELL_BUBBLE_EVERY_MS - off;
  if (t < 0) return 0;
  const inCycle = t % SHELL_BUBBLE_EVERY_MS;
  return inCycle < SHELL_BUBBLE_SHOW_MS ? windowAlpha(inCycle, SHELL_BUBBLE_SHOW_MS) : 0;
}

function windowAlpha(t: number, len: number): number {
  return Math.max(0, Math.min(1, t / BUBBLE_FADE_IN_MS, (len - t) / BUBBLE_FADE_OUT_MS));
}

// ------------------------------------------------------------------ spins and yawns

/** A pseudo-random number in [0, 1), deterministic per (seed, index, salt). */
export function unitHash(seed: number, k: number, salt: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Phase (0..1) of a periodic event at `ageMs`, or -1 outside one. Events of `durMs` start at `fromMs + firstMs` and
 * repeat with gaps drawn (by seed) in [gapMin, gapMax], only while `ageMs < toMs`. No allocation (a short loop: tens
 * of iterations at worst).
 */
export function periodicPhase(ageMs: number, fromMs: number, toMs: number, firstMs: number, gapMin: number, gapMax: number, durMs: number, seed: number, salt: number): number {
  if (ageMs < fromMs || ageMs >= toMs) return -1;
  let t = fromMs + firstMs;
  for (let k = 0; t <= ageMs && k < 10_000; k++) {
    if (ageMs < t + durMs) return (ageMs - t) / durMs;
    t += gapMin + unitHash(seed, k, salt) * (gapMax - gapMin);
  }
  return -1;
}

/** Phase (0..1) of the chair spin, or -1. Spins every 15–25 s in the 'restless' stage. */
export function spinPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_RESTLESS_MS, SHELL_COBWEB_MS, SPIN_FIRST_MS, SPIN_GAP_MIN_MS, SPIN_GAP_MAX_MS, SPIN_MS, seed, 1);
}

/** Phase (0..1) of a yawn, or -1. Now and then in the 'cobweb' stage. */
export function yawnPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_COBWEB_MS, SHELL_NAP_MS, YAWN_FIRST_MS, YAWN_GAP_MIN_MS, YAWN_GAP_MAX_MS, YAWN_MS, seed, 2);
}

/** Clockwise seen from above: north → east → south → west. */
const CLOCKWISE: readonly Dir[] = ['up', 'right', 'down', 'left'];

/**
 * Direction during the spin (phase 0..1): one full clockwise turn, a quarter at a time, ending back at `base`.
 */
export function spinDir(phase: number, base: Dir): Dir {
  if (phase < 0) return base;
  const i = CLOCKWISE.indexOf(base);
  const q = Math.min(3, Math.floor(phase * 4));
  return CLOCKWISE[(i + q + 1) % 4]!;
}
