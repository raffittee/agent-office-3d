import { describe, expect, it } from 'vitest';
import { ambientAt, approachAmbient, clampNightBrightness, effectiveHour, FIXED_NIGHT_HOUR, lightLevelsAt, parseHourParam, phaseOf, relativeBrightness, roomGain, sunAt, wrapHour } from './daylight';

describe('day and night (P6-02)', () => {
  it('noon is full day, midnight full night, dusk warm', () => {
    expect(ambientAt(12)).toMatchObject({ night: 0, warm: 0, outside: [255, 255, 255], inside: [255, 255, 255], phase: 'day' });
    expect(ambientAt(0).night).toBe(1);
    expect(ambientAt(18).warm).toBe(1);
    expect(ambientAt(23.99).night).toBeCloseTo(ambientAt(0).night, 2);
    expect(ambientAt(22).inside).not.toEqual([255, 255, 255]);
    expect(phaseOf(5.5)).toBe('dawn');
    expect(wrapHour(-1)).toBe(23);
  });

  it('the sun rises in the east and sets in the west; it is down at night', () => {
    expect(sunAt(6.5)).toMatchObject({ up: true });
    expect(Math.cos(sunAt(7).azimuth)).toBeGreaterThan(0.5);
    expect(Math.cos(sunAt(17).azimuth)).toBeLessThan(-0.5);
    expect(sunAt(12).elevation).toBeCloseTo(1);
    expect(sunAt(23).up).toBe(false);
  });

  it('the setting, the URL override and smooth changes', () => {
    const d = new Date(2026, 9, 25, 21, 30);
    expect(effectiveHour('auto', null, d)).toBe(21.5);
    expect(effectiveHour('night', null, d)).toBe(FIXED_NIGHT_HOUR);
    expect(effectiveHour('day', 6, d)).toBe(6);
    expect(parseHourParam('?hour=21:30')).toBe(21.5);
    expect(parseHourParam('?hour=7h')).toBe(7);
    expect(parseHourParam('?hour=25')).toBeNull();
    expect(parseHourParam('?x=1')).toBeNull();
    const half = approachAmbient(ambientAt(12), ambientAt(0), 0.5);
    expect(half.night).toBeCloseTo(0.5);
    expect(approachAmbient(ambientAt(12), ambientAt(0), 1)).toEqual(ambientAt(0));
  });
});

describe('light levels (P10-19)', () => {
  // the built-in themes' fill and sun intensities span roughly these
  const themes = [
    { hemi: 1.9, sun: 1.6 },
    { hemi: 1.4, sun: 1.2 },
    { hemi: 2.2, sun: 0.9 },
  ];
  const at = (hour: number, base: { hemi: number; sun: number }, s?: number) => lightLevelsAt(ambientAt(hour), base, s);

  it('noon: lit rooms at full brightness, dark rooms lose only about 10%', () => {
    for (const base of themes) {
      const l = at(12, base);
      expect(relativeBrightness(l, base, l.litGain)).toBeCloseTo(1, 5);
      expect(relativeBrightness(l, base, l.darkGain)).toBeGreaterThanOrEqual(0.88);
      expect(l.sun).toBeGreaterThan(l.hemi * 1.5); // a strong sun over a softer fill: shadows and contrast
      expect(l.glint).toBeGreaterThan(0.9);
      expect(l.glassGlow).toBe(0);
    }
  });

  it('night: dark outside, but lit rooms keep ~85% and dark rooms ~45% of their daytime brightness', () => {
    for (const base of themes) {
      const l = at(22.5, base);
      expect(l.hemi).toBeLessThan(at(12, base).hemi * 0.6);
      expect(l.exposure).toBeGreaterThan(1.1);
      expect(relativeBrightness(l, base, l.litGain)).toBeGreaterThanOrEqual(0.85 - 1e-9);
      expect(relativeBrightness(l, base, l.darkGain)).toBeGreaterThanOrEqual(0.45);
      expect(relativeBrightness(l, base, l.charGain)).toBeGreaterThanOrEqual(0.8);
      // the outside (gain 1) is clearly darker than the inside
      expect(relativeBrightness(l, base, 1)).toBeLessThan(0.5);
      expect(l.glint).toBe(0);
      expect(l.glassGlow).toBe(1);
    }
  });

  it('every hour stays above the floors, and the setting scales the night', () => {
    const base = themes[0]!;
    for (let h = 0; h < 24; h += 0.25) {
      const l = at(h, base);
      expect(relativeBrightness(l, base, l.litGain)).toBeGreaterThanOrEqual(0.85 - 1e-9);
      expect(relativeBrightness(l, base, l.darkGain)).toBeGreaterThanOrEqual(0.45);
    }
    const dim = at(22.5, base, 0.4);
    const bright = at(22.5, base, 1);
    expect(relativeBrightness(dim, base, dim.litGain)).toBeCloseTo(0.4, 5);
    expect(relativeBrightness(bright, base, bright.litGain)).toBeCloseTo(1, 5);
    expect(clampNightBrightness(5)).toBe(1);
    expect(clampNightBrightness('x')).toBe(0.85);
  });

  it('a room fading its light passes smoothly between the two gains', () => {
    const base = themes[0]!;
    const l = at(22.5, base);
    expect(roomGain(l, 0)).toBe(l.darkGain);
    expect(roomGain(l, 1)).toBe(l.litGain);
    expect(roomGain(l, 0.5)).toBeCloseTo((l.darkGain + l.litGain) / 2);
  });

  it('the sun glints at dusk, weaker than at noon, and is gone after dark', () => {
    const base = themes[0]!;
    expect(at(17.5, base).glint).toBeGreaterThan(0);
    expect(at(17.5, base).glint).toBeLessThan(at(12, base).glint);
    expect(at(21, base).glint).toBe(0);
  });
});
