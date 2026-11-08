// Room signs (P10-06), the pure part: labels, fitting, the atlas and the plaque placement.
import { describe, expect, it } from 'vitest';
import { CAFE_ID, LOUNGE_ID, RECEPTION_ID, RESTROOM_ID } from '../core/layout/core';
import { ATLAS_COLS, ATLAS_H, ATLAS_ROWS, ATLAS_W, besideDoor, fitLabel, pickSpan, SIGN_ASPECT, signLabel, SignAtlas, signSize, signYaw, slotRect, slotUv } from './signs-model';

/** Every glyph is 0.55 em wide. */
const measure = (text: string, px: number) => text.length * px * 0.55;

describe('signLabel', () => {
  it('names the core areas and uses the project name for rooms', () => {
    expect(signLabel(RECEPTION_ID)).toBe('Reception');
    expect(signLabel(CAFE_ID)).toBe('Kitchen');
    expect(signLabel(LOUNGE_ID)).toBe('Lounge');
    expect(signLabel(RESTROOM_ID)).toBe('Restrooms');
    expect(signLabel('/home/dev/online-store', '  online-store ')).toBe('online-store');
  });

  it('has no sign for the corridor or a nameless room', () => {
    expect(signLabel('core:corridor')).toBeNull();
    expect(signLabel('/p/x', '   ')).toBeNull();
    expect(signLabel('/p/x')).toBeNull();
  });
});

describe('fitLabel', () => {
  it('keeps a short name at the biggest font', () => {
    expect(fitLabel('api', 230, measure)).toEqual({ text: 'api', font: 40 });
  });

  it('shrinks a longer name before cutting it', () => {
    const r = fitLabel('payments-service', 230, measure);
    expect(r.text).toBe('payments-service');
    expect(r.font).toBeLessThan(40);
    expect(r.font).toBeGreaterThanOrEqual(22);
    expect(measure(r.text, r.font)).toBeLessThanOrEqual(230);
  });

  it('cuts a very long name with an ellipsis at the smallest font', () => {
    const r = fitLabel('a-really-long-project-folder-name-that-never-fits', 230, measure);
    expect(r.font).toBe(22);
    expect(r.text.endsWith('…')).toBe(true);
    expect(measure(r.text, r.font)).toBeLessThanOrEqual(230);
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('collapses whitespace and never returns an empty cut', () => {
    expect(fitLabel('  my   app ', 230, measure).text).toBe('my app');
    expect(fitLabel('x'.repeat(40), 5, measure).text).toBe('x…');
  });
});

describe('atlas geometry', () => {
  it('lays slots out row by row inside the canvas', () => {
    expect(slotRect(0)).toEqual({ x: 0, y: 0, w: 256, h: 64 });
    expect(slotRect(ATLAS_COLS)).toEqual({ x: 0, y: 64, w: 256, h: 64 });
    const last = slotRect(ATLAS_COLS * ATLAS_ROWS - 1);
    expect(last.x + last.w).toBe(ATLAS_W);
    expect(last.y + last.h).toBe(ATLAS_H);
  });

  it('gives UVs that stay inside their own slot', () => {
    const a = slotUv(0);
    const b = slotUv(1);
    expect(a.u).toBeGreaterThan(0);
    expect(a.u + a.du).toBeLessThan(b.u);
    // slot 0 is the top row: its v range is the highest
    const row1 = slotUv(ATLAS_COLS);
    expect(a.v).toBeGreaterThan(row1.v + row1.dv);
    expect(a.v + a.dv).toBeLessThan(1);
  });

  it('draws text quads at the atlas aspect', () => {
    expect(signSize(0.3)).toEqual({ w: 0.3 * SIGN_ASPECT, h: 0.3 });
    expect(signSize(0.3).w / signSize(0.3).h).toBeCloseTo(4, 6);
  });

  it('turns a quad to face a wall normal', () => {
    expect(signYaw(0, 1)).toBeCloseTo(0);
    expect(signYaw(0, -1)).toBeCloseTo(Math.PI);
    expect(signYaw(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(signYaw(-1, 0)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('SignAtlas', () => {
  it('keeps a key in its slot and says when to draw', () => {
    const a = new SignAtlas(4);
    a.beginFrame();
    expect(a.slotFor('a')).toEqual({ slot: 0, fresh: true });
    expect(a.slotFor('b')).toEqual({ slot: 1, fresh: true });
    a.beginFrame();
    expect(a.slotFor('a')).toEqual({ slot: 0, fresh: false });
    expect(a.size).toBe(2);
  });

  it('takes over the slot unused the longest when full, never one used this frame', () => {
    const a = new SignAtlas(2);
    a.beginFrame();
    a.slotFor('a');
    a.slotFor('b');
    a.beginFrame();
    a.slotFor('b'); // 'a' was not used this frame
    expect(a.slotFor('c')).toEqual({ slot: 0, fresh: true });
    // 'b' and 'c' are both used this frame: nothing can be evicted
    expect(a.slotFor('d')).toBeNull();
    expect(a.slotFor('b')).toEqual({ slot: 1, fresh: false });
    // 'a' lost its slot: asking again evicts the one used the longest ago
    a.beginFrame();
    a.slotFor('c');
    expect(a.slotFor('a')).toEqual({ slot: 1, fresh: true });
  });
});

describe('plaque placement', () => {
  it('picks the middle of a free wall, then the nearest free spot', () => {
    expect(pickSpan(0, 10, [], 2)).toBeCloseTo(4);
    const a = pickSpan(0, 10, [[3.5, 6.5]], 2)!;
    expect(a).not.toBeNull();
    expect(a + 2 <= 3.4 || a >= 6.6).toBe(true);
    // the nearest to the middle, not the far end
    expect(Math.abs(a + 1 - 5)).toBeLessThan(3.5);
  });

  it('gives up when nothing fits', () => {
    expect(pickSpan(0, 2, [], 2)).toBeNull();
    expect(pickSpan(0, 10, [[0, 10]], 2)).toBeNull();
  });

  it('puts a door plaque right of the opening, else left, else nowhere', () => {
    const door = { x0: 7, x1: 8 };
    expect(besideDoor(door, { a0: 0, a1: 20 }, [], 1)).toBeCloseTo(8.18);
    expect(besideDoor(door, { a0: 0, a1: 9 }, [], 1)).toBeCloseTo(7 - 0.18 - 1);
    expect(besideDoor(door, { a0: 0, a1: 20 }, [[8, 12]], 1)).toBeCloseTo(7 - 0.18 - 1);
    expect(besideDoor(door, { a0: 6.9, a1: 9 }, [], 1)).toBeNull();
  });
});
