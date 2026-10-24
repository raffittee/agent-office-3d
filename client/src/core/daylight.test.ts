import { describe, expect, it } from 'vitest';
import { ambientAt, approachAmbient, effectiveHour, FIXED_NIGHT_HOUR, parseHourParam, phaseOf, sunAt, wrapHour } from './daylight';

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
