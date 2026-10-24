// Seasonal overlays (P6-07): the calendar, the look transform on every bundled theme, and the props' footprints.
import { describe, expect, it } from 'vitest';
import type { ThemePack } from '../../../shared/theme';
import cabinJson from '../../../themes/cabin/theme.json';
import industrialJson from '../../../themes/industrial/theme.json';
import modernJson from '../../../themes/modern/theme.json';
import startupJson from '../../../themes/startup/theme.json';
import traditionalJson from '../../../themes/traditional/theme.json';
import { FURNITURE } from '../core/vocab';
import { furnitureParts } from '../render3d/kit';
import { TILE_M } from '../render3d/units';
import { resolveLook } from './look';
import { SEASONAL_KINDS, seasonalEntry, seasonalLook, seasonFor } from './seasonal';

const looks = ([modernJson, industrialJson, traditionalJson, startupJson, cabinJson] as unknown as ThemePack[]).map(resolveLook);

describe('seasonal overlays', () => {
  it('follow the calendar unless forced', () => {
    expect(seasonFor('auto', new Date(2026, 9, 1))).toBe('halloween');
    expect(seasonFor('auto', new Date(2026, 9, 31, 23))).toBe('halloween');
    expect(seasonFor('auto', new Date(2026, 10, 1))).toBe('none');
    expect(seasonFor('auto', new Date(2026, 11, 1))).toBe('holiday');
    expect(seasonFor('auto', new Date(2027, 0, 1))).toBe('holiday');
    expect(seasonFor('auto', new Date(2027, 0, 2))).toBe('none');
    expect(seasonFor('none', new Date(2026, 9, 10))).toBe('none');
    expect(seasonFor('holiday', new Date(2026, 6, 10))).toBe('holiday');
    expect(seasonFor(undefined, new Date(2026, 3, 10))).toBe('none');
  });

  it('apply on top of every theme: tints only, the same layout template, plants redrawn', () => {
    for (const look of looks) {
      expect(seasonalLook(look, 'none')).toBe(look);
      for (const season of ['halloween', 'holiday'] as const) {
        const s = seasonalLook(look, season);
        expect(s.id).toBe(look.id);
        expect(s.template).toBe(look.template);
        const a = look.roomTheme(5);
        const b = s.roomTheme(5);
        expect(b.carpet).not.toBe(a.carpet);
        expect(b.deskVariant).toBe(a.deskVariant);
        expect(s.kit.season).toBe(season);
        for (const k of SEASONAL_KINDS) expect(s.furniture(k)).toBeUndefined();
        expect(s.furniture('desk')).toEqual(look.furniture('desk'));
      }
    }
  });

  it('the entry sets the pack’s plant models aside (the cabin’s cactus) and keeps the rest', () => {
    const cabin = looks.find((l) => l.id === 'cabin')!;
    const entry = { look: cabin, thumbnail: null, url: () => null };
    expect(Object.keys(cabin.pack.furniture ?? {})).toEqual(expect.arrayContaining(['plant_tall']));
    const s = seasonalEntry(entry, 'halloween');
    expect(s.look.pack.furniture?.plant_tall).toBeUndefined();
    expect(Object.keys(s.look.pack.furniture ?? {}).length).toBe(Object.keys(cabin.pack.furniture ?? {}).length - Object.keys(cabin.pack.furniture ?? {}).filter((k) => (SEASONAL_KINDS as readonly string[]).includes(k)).length);
    expect(seasonalEntry(entry, 'none')).toBe(entry);
  });

  it('props stay inside the plant footprints; other kinds are untouched', () => {
    for (const season of ['halloween', 'holiday'] as const) {
      const style = seasonalLook(looks[0]!, season).kit;
      for (const kind of SEASONAL_KINDS) {
        const fp = FURNITURE[kind].footprint;
        for (const variant of ['a', 'b', 'palm', 'fern', undefined]) {
          const parts = furnitureParts(kind, variant, style);
          expect(parts.length).toBeGreaterThan(2);
          for (const p of parts) {
            expect(p.x0).toBeGreaterThanOrEqual(-0.01);
            expect(p.x1).toBeLessThanOrEqual(fp.w * TILE_M + 0.01);
            expect(p.z0).toBeGreaterThanOrEqual(-0.01);
            expect(p.z1).toBeLessThanOrEqual(Math.max(1, fp.h) * TILE_M + 0.01);
          }
        }
      }
      expect(furnitureParts('desk', undefined, style)).toEqual(furnitureParts('desk', undefined, looks[0]!.kit));
    }
  });
});
