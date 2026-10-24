// Ported from habblaud client/src/world/render/daylight.ts (MIT, © 2026 Márcio Junior)
// Day and night (P6-02), pure: how dark it is, how warm the light is, and where the sun stands, from the local time.
// The 3D lighting that uses it is in render3d/scene.ts (applyDaylight).

export type DaylightMode = 'auto' | 'day' | 'night';
export type DayPhase = 'late-night' | 'dawn' | 'day' | 'dusk' | 'night';
export type Rgb = readonly [number, number, number];

export interface Ambient {
  hour: number;
  phase: DayPhase;
  /** 0 = full day, 1 = deep night. */
  night: number;
  /** 0..1: the warm tone of dawn and dusk. */
  warm: number;
  /** The sky's tint (outside). */
  outside: Rgb;
  /** Lit interiors: lamp light at night, a breath of low sun by day. */
  inside: Rgb;
}

/** The hours used when the cycle is fixed. */
export const FIXED_DAY_HOUR = 13.5;
export const FIXED_NIGHT_HOUR = 22.5;

export const WHITE: Rgb = [255, 255, 255];
const LAMP: Rgb = [244, 220, 184];
const SUN: Rgb = [255, 222, 184];

/**
 * Key points of the sky through the day: [hour, night, warm, outside color]. Linear in between, continuous over
 * midnight. Dawn passes through violet and pink; dusk through gold and orange to twilight purple.
 */
const KEYS: readonly (readonly [number, number, number, Rgb])[] = [
  [0, 1, 0, [70, 84, 140]],
  [4.5, 1, 0, [72, 86, 142]],
  [5.25, 0.86, 0.25, [104, 100, 156]],
  [5.9, 0.56, 0.8, [190, 146, 168]],
  [6.5, 0.2, 1, [255, 208, 174]],
  [7.25, 0, 0.35, [255, 238, 220]],
  [8, 0, 0, WHITE],
  [16.25, 0, 0, WHITE],
  [17.25, 0.04, 0.45, [255, 236, 206]],
  [18, 0.24, 1, [255, 202, 162]],
  [18.6, 0.55, 0.75, [194, 148, 164]],
  [19.25, 0.85, 0.3, [110, 108, 162]],
  [20, 1, 0, [80, 96, 150]],
  [24, 1, 0, [70, 84, 140]],
];

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** An hour folded into [0, 24). */
export function wrapHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return ((hour % 24) + 24) % 24;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

export function phaseOf(hour: number): DayPhase {
  const h = wrapHour(hour);
  if (h < 5) return 'late-night';
  if (h < 7) return 'dawn';
  if (h < 17) return 'day';
  if (h < 19) return 'dusk';
  return 'night';
}

/** Light level and colors for a fractional local hour (0–24). */
export function ambientAt(hour: number): Ambient {
  const h = wrapHour(hour);
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]![0] <= h) i++;
  const [h0, n0, w0, c0] = KEYS[i]!;
  const [h1, n1, w1, c1] = KEYS[i + 1]!;
  const u = (h - h0) / Math.max(1e-6, h1 - h0);
  const night = n0 + (n1 - n0) * u;
  const warm = w0 + (w1 - w0) * u;
  const outside = mixRgb(c0, c1, u);
  const inside = mixRgb(mixRgb(WHITE, LAMP, night), SUN, warm * (1 - night) * 0.55);
  return { hour: h, phase: phaseOf(h), night, warm, outside, inside };
}

/** Moves `cur` towards `target` (a smooth change when the setting or the fixed hour changes). */
export function approachAmbient(cur: Ambient, target: Ambient, k: number): Ambient {
  const t = clamp(k, 0, 1);
  if (t >= 1) return target;
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return { hour: target.hour, phase: target.phase, night: lerp(cur.night, target.night), warm: lerp(cur.warm, target.warm), outside: mixRgb(cur.outside, target.outside, t), inside: mixRgb(cur.inside, target.inside, t) };
}

/**
 * Where the sun stands: `azimuth` in radians (0 = east at sunrise, π = west at sunset), `elevation` 0..1 (0 at the
 * horizon, 1 at noon). Below the horizon at night: the renderer uses a moon instead.
 */
export function sunAt(hour: number): { azimuth: number; elevation: number; up: boolean } {
  const h = wrapHour(hour);
  const p = (h - 6) / 12;
  const up = p > 0 && p < 1;
  return { azimuth: clamp(p, 0, 1) * Math.PI, elevation: up ? Math.sin(p * Math.PI) : 0, up };
}

/** `?hour=21:30`, `21h30`, `21h`, `21` in the URL → a fractional hour, or null. */
export function parseHourParam(search: string | null | undefined): number | null {
  if (!search) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('hour');
  } catch {
    return null;
  }
  if (raw === null) return null;
  const m = /^\s*(\d{1,2})(?:\s*[:h]\s*(\d{2})?)?\s*$/i.exec(raw);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] === undefined ? 0 : Number(m[2]);
  if (hh > 24 || mm > 59 || (hh === 24 && mm > 0)) return null;
  return wrapHour(hh + mm / 60);
}

/** The hour the cycle shows: a forced one (URL) wins over the setting; otherwise the local time. */
export function effectiveHour(mode: DaylightMode, override: number | null, date: Date): number {
  if (override !== null && Number.isFinite(override)) return wrapHour(override);
  if (mode === 'day') return FIXED_DAY_HOUR;
  if (mode === 'night') return FIXED_NIGHT_HOUR;
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

export function rgbHex(c: Rgb): string {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
