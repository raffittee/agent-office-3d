// Seasonal overlays (P6-07): Halloween and the year-end holidays on top of any theme. An overlay changes only how
// things look — wall and rug tints, lamp color, and tall and small plants drawn as jack-o'-lanterns, ghosts, a
// decorated tree or gifts (same footprints, so no path or spot changes). Pure: no three, no DOM. Idea from Habblaud's
// client/src/world/render/seasonal.ts (MIT, © 2026 Márcio Junior); the 3D props are new (render3d/kit.ts).
import type { WallStyle } from '../core/vocab';
import { mix, type Look } from './look';
import type { ThemeEntry } from './registry';

export type Season = 'none' | 'halloween' | 'holiday';
/** The setting: follow the calendar, or force one. */
export type SeasonMode = 'auto' | Season;

/** Kinds an overlay redraws (their packs' models are set aside while it's on). */
export const SEASONAL_KINDS = ['plant_tall', 'plant_small'] as const;

/** On the calendar (local date): Halloween through October, the holidays from December 1 to January 1. */
export function seasonFor(mode: SeasonMode | undefined, date: Date): Season {
  if (mode && mode !== 'auto') return mode;
  const month = date.getMonth();
  if (month === 9) return 'halloween';
  if (month === 11 || (month === 0 && date.getDate() === 1)) return 'holiday';
  return 'none';
}

const TONE: Record<Exclude<Season, 'none'>, { wall: string; trim: string; rug: string; practical: string; accent: string }> = {
  halloween: { wall: '#bc97d1', trim: '#725486', rug: '#60416f', practical: '#ff9a3c', accent: '#e8792b' },
  holiday: { wall: '#ffe3b4', trim: '#4e7756', rug: '#a93649', practical: '#ffd27a', accent: '#c0392b' },
};

function tintWall(style: WallStyle, season: Exclude<Season, 'none'>): WallStyle {
  if (style.pattern === 'glass' || style.exterior) return style;
  return { ...style, base: mix(style.base, TONE[season].wall, 0.18), trim: TONE[season].trim };
}

/** The look with the overlay on (the same object when the season is 'none'). */
export function seasonalLook(look: Look, season: Season): Look {
  if (season === 'none') return look;
  const tone = TONE[season];
  return {
    ...look,
    lighting: { ...look.lighting, practical: mix(look.lighting.practical, tone.practical, 0.6) },
    roomTheme(seed) {
      const r = look.roomTheme(seed);
      const carpet = mix(r.carpet, tone.rug, 0.55);
      return { ...r, carpet, carpet2: mix(r.carpet2, tone.rug, 0.6), wall: tintWall(r.wall, season), accent: mix(r.accent, tone.accent, 0.4) };
    },
    wall(area, style) {
      const w = look.wall(area, style);
      if (style.exterior || style.pattern === 'glass') return w;
      return { ...w, color: mix(w.color, tone.wall, 0.18), trim: tone.trim };
    },
    kit: { ...look.kit, season },
    furniture(kind) {
      return (SEASONAL_KINDS as readonly string[]).includes(kind) ? undefined : look.furniture(kind);
    },
  };
}

/** A theme entry with the overlay on: its pack's models for the redrawn kinds are left out. */
export function seasonalEntry(entry: ThemeEntry, season: Season): ThemeEntry {
  if (season === 'none') return entry;
  const furniture = { ...(entry.look.pack.furniture ?? {}) };
  for (const k of SEASONAL_KINDS) delete furniture[k];
  const look = seasonalLook(entry.look, season);
  return { ...entry, look: { ...look, pack: { ...entry.look.pack, furniture } } };
}
