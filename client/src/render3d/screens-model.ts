// Live monitors (P3-05), the pure part: which screen mode a desk shows, and where its screen sits.
import type { Character } from '../core/sim/character';
import { screenModeFor } from '../core/sim/behavior';
import type { FurnitureKind, ScreenMode } from '../core/vocab';

/** Modes drawn in the shared texture atlas, in tile order. */
export const SCREEN_MODES: readonly ScreenMode[] = ['off', 'standby', 'idle', 'code', 'terminal', 'browser', 'search', 'chat', 'docs', 'tasks', 'alert', 'progress'];

/**
 * What a desk's screen shows: dark with the room's lights; on standby with nobody seated; otherwise it follows the
 * occupant (work → by activity kind, waiting for you → alert, waiting for a job → progress, idle → screensaver).
 */
export function deskScreenMode(occupant: Character | null, light: number): ScreenMode {
  if (light < 0.2) return 'off';
  if (!occupant) return 'standby';
  switch (occupant.mode) {
    case 'work':
      return screenModeFor(occupant.info.activity?.kind);
    case 'wait':
      return 'alert';
    case 'shell':
      return 'progress';
    default:
      return 'idle';
  }
}

/** A desk screen in metres, relative to the desk's footprint corner (+z south), and which way it faces. */
export interface ScreenPlacement {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** The screen faces south (+z) for `desk` (sitter to the south) and north for `desk_back`. */
  facing: 1 | -1;
}

export function deskScreen(kind: FurnitureKind): ScreenPlacement | null {
  if (kind === 'desk') return { x: 0.5, y: 0.975, z: 0.125, w: 0.54, h: 0.29, facing: 1 };
  if (kind === 'desk_back') return { x: 0.5, y: 0.975, z: 0.375, w: 0.54, h: 0.29, facing: -1 };
  return null;
}
