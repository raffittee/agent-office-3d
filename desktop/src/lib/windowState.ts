// Where the window goes: remembered bounds, kept on screen when a monitor was unplugged or the resolution changed.

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Mode = 'window' | 'widget';

export const MIN_SIZE: Record<Mode, { width: number; height: number }> = {
  window: { width: 640, height: 420 },
  widget: { width: 260, height: 180 },
};

const MARGIN = 16;
/** At least this much of the window must be on a screen, or it is moved back. */
const VISIBLE = { width: 120, height: 60 };

/** First-run bounds: a big centered window, or a small widget in the corner of the work area. */
export function defaultBounds(mode: Mode, work: Bounds): Bounds {
  if (mode === 'window') {
    const width = Math.min(1280, work.width);
    const height = Math.min(800, work.height);
    return { x: work.x + Math.round((work.width - width) / 2), y: work.y + Math.round((work.height - height) / 2), width, height };
  }
  const width = Math.min(420, work.width);
  const height = Math.min(300, work.height);
  return { x: work.x + work.width - width - MARGIN, y: work.y + work.height - height - MARGIN, width, height };
}

function overlap(a: Bounds, b: Bounds): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * `saved` bounds made safe: not smaller than the mode's minimum, not bigger than the screen, and visible on one of the
 * `works` (work areas of the connected displays). If it is nowhere near a screen, the default for the primary one.
 */
export function fitBounds(saved: Bounds | undefined, mode: Mode, works: readonly Bounds[]): Bounds {
  const primary = works[0] ?? { x: 0, y: 0, width: 1280, height: 800 };
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return defaultBounds(mode, primary);
  const min = MIN_SIZE[mode];
  const home = works.find((w) => {
    const o = overlap(saved, w);
    return o.width >= Math.min(VISIBLE.width, saved.width) && o.height >= Math.min(VISIBLE.height, saved.height);
  });
  if (!home) return defaultBounds(mode, primary);
  const width = Math.max(min.width, Math.min(saved.width, home.width));
  const height = Math.max(min.height, Math.min(saved.height, home.height));
  const x = Math.max(home.x, Math.min(saved.x, home.x + home.width - width));
  const y = Math.max(home.y, Math.min(saved.y, home.y + home.height - height));
  return { x, y, width, height };
}
