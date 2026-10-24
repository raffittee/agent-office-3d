// Ported from habblaud client/src/audio/scheduler.ts (MIT, © 2026 Márcio Junior)
// The sound scheduler (P6-05), pure: decides whether a sound plays now and how loud, from the settings (master
// switch, volume, categories), whether the tab is visible, and rate limits.

/** Sounds the world suggests (who plays them, and whether, is the UI's call). */
export type SoundCueKind = 'keys' | 'elevator' | 'pingpong' | 'table' | 'arcade';
/** Sounds: the "needs you" bell, the click of a finished task, and the ambient ones. */
export type SoundKind = 'chime' | 'pop' | SoundCueKind;

/** Categories the user turns on and off in the settings. */
export type SoundCategory = 'alerts' | 'keys' | 'elevator' | 'social';

export const SOUND_CATEGORIES: readonly SoundCategory[] = ['alerts', 'keys', 'elevator', 'social'];

export interface SoundCue {
  kind: SoundCueKind;
  /** 0..1: closeness (zoom, off screen…). */
  gain: number;
  /** -1 (left) .. 1 (right): position on screen. */
  pan: number;
  /** Keys: how many keystrokes in the burst. */
  count?: number;
}

export const CATEGORY_OF: Readonly<Record<SoundKind, SoundCategory>> = {
  chime: 'alerts',
  pop: 'alerts',
  keys: 'keys',
  elevator: 'elevator',
  pingpong: 'social',
  table: 'social',
  arcade: 'social',
};

/** Minimum gap (ms) between two sounds on the same channel. */
export const MIN_GAP_MS: Readonly<Record<SoundKind, number>> = {
  chime: 1_200,
  pop: 1_200,
  keys: 600,
  elevator: 1_500,
  pingpong: 200,
  table: 200,
  arcade: 450,
};

/** The bell and the click share a channel (one never tramples the other). */
const CHANNEL: Readonly<Record<SoundKind, string>> = {
  chime: 'alerts',
  pop: 'alerts',
  keys: 'keys',
  elevator: 'elevator',
  pingpong: 'pingpong',
  table: 'pingpong',
  arcade: 'arcade',
};

/** Global cap: at most this many sounds per second (the alert bell always gets through). */
export const MAX_PER_SECOND = 7;

export interface SoundSettings {
  /** Master volume (0–1). */
  volume: number;
  alerts: boolean;
  keys: boolean;
  elevator: boolean;
  social: boolean;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { volume: 0.6, alerts: true, keys: true, elevator: true, social: true };

/** Validates field by field (a corrupted preference falls back to the default). */
export function sanitizeSoundSettings(raw: unknown): SoundSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SOUND_SETTINGS;
  const bool = (v: unknown, f: boolean) => (typeof v === 'boolean' ? v : f);
  const vol = typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : d.volume;
  return { volume: vol, alerts: bool(o.alerts, d.alerts), keys: bool(o.keys, d.keys), elevator: bool(o.elevator, d.elevator), social: bool(o.social, d.social) };
}

/** The master volume curve: the slider feels linear. */
export function masterGain(volume: number): number {
  const v = Math.min(1, Math.max(0, volume));
  return v * v;
}

export class SoundScheduler {
  private enabled = false;
  private settings: SoundSettings = { ...DEFAULT_SOUND_SETTINGS };
  private last = new Map<string, number>();
  private recent: number[] = [];

  configure(enabled: boolean, settings: SoundSettings): void {
    this.enabled = enabled;
    this.settings = settings;
  }

  /** Is the sound allowed by the settings (master switch, category and volume)? */
  allowed(kind: SoundKind): boolean {
    return this.enabled && this.settings.volume > 0 && this.settings[CATEGORY_OF[kind]];
  }

  /**
   * The final gain (0–1) to play `kind` now, or null if it shouldn't play. With the tab hidden only the "needs you"
   * bell plays. `gain` is the closeness the world suggests.
   */
  decide(kind: SoundKind, now: number, opts: { hidden?: boolean; gain?: number } = {}): number | null {
    if (!this.allowed(kind)) return null;
    if (opts.hidden && kind !== 'chime') return null;
    const ch = CHANNEL[kind];
    const prev = this.last.get(ch);
    if (prev !== undefined && now - prev < MIN_GAP_MS[kind]) return null;
    while (this.recent.length && now - this.recent[0]! >= 1_000) this.recent.shift();
    if (kind !== 'chime' && this.recent.length >= MAX_PER_SECOND) return null;
    const g = masterGain(this.settings.volume) * Math.min(1, Math.max(0, opts.gain ?? 1));
    if (g <= 0.0005) return null;
    this.last.set(ch, now);
    this.recent.push(now);
    return g;
  }
}
