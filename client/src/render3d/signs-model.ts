// Room signs (P10-06), the pure part: the label an area carries, how a label is fitted into its atlas slot, which
// atlas slot a label gets (with eviction), and where a plaque sits on a wall. No three, no DOM: signs.ts draws it.
import { t } from '../../../shared/i18n';
import { CAFE_ID, LOUNGE_ID, RECEPTION_ID, RESTROOM_ID } from '../core/layout/core';

/** One atlas slot in pixels, the texture's size, and the plaque's aspect (width over height). */
export const SLOT_W = 256;
export const SLOT_H = 64;
export const ATLAS_W = 1024;
export const ATLAS_H = 1024;
export const ATLAS_COLS = ATLAS_W / SLOT_W;
export const ATLAS_ROWS = ATLAS_H / SLOT_H;
export const SIGN_ASPECT = SLOT_W / SLOT_H;

/** The text an area's sign shows: fixed names for the core areas, the project's name for a room; null = no sign. */
export function signLabel(areaId: string, roomName?: string): string | null {
  switch (areaId) {
    case RECEPTION_ID:
      return t('Reception');
    case CAFE_ID:
      return t('Kitchen');
    case LOUNGE_ID:
      return t('Lounge');
    case RESTROOM_ID:
      return t('Restrooms');
    default: {
      const name = (roomName ?? '').replace(/\s+/g, ' ').trim();
      return name || null;
    }
  }
}

/** Measures a string's width in pixels at a font size. */
export type Measure = (text: string, fontPx: number) => number;

/**
 * Fits a label into `maxWidth` pixels: the biggest font from `maxFont` down to `minFont` (steps of 2) that holds the
 * whole text, else the text cut with an ellipsis at `minFont`.
 */
export function fitLabel(text: string, maxWidth: number, measure: Measure, maxFont = 40, minFont = 22): { text: string; font: number } {
  const clean = text.replace(/\s+/g, ' ').trim();
  for (let f = maxFont; f >= minFont; f -= 2) if (measure(clean, f) <= maxWidth) return { text: clean, font: f };
  // too long even at the smallest font: drop characters (never a lone ellipsis) until it fits
  let cut = clean;
  while (cut.length > 1 && measure(`${cut}…`, minFont) > maxWidth) cut = cut.slice(0, -1);
  return { text: `${cut.trimEnd()}…`, font: minFont };
}

/** Slot index → pixel rectangle in the canvas (origin top-left). */
export function slotRect(slot: number): { x: number; y: number; w: number; h: number } {
  return { x: (slot % ATLAS_COLS) * SLOT_W, y: Math.floor(slot / ATLAS_COLS) * SLOT_H, w: SLOT_W, h: SLOT_H };
}

/** The UV offset (bottom-left origin) of a slot, and the UV size of the slot's inside (a margin keeps neighbours out). */
export function slotUv(slot: number, margin = 2): { u: number; v: number; du: number; dv: number } {
  const r = slotRect(slot);
  return {
    u: (r.x + margin) / ATLAS_W,
    v: 1 - (r.y + r.h - margin) / ATLAS_H,
    du: (r.w - 2 * margin) / ATLAS_W,
    dv: (r.h - 2 * margin) / ATLAS_H,
  };
}

/**
 * Which atlas slot each label (key) lives in. A key keeps its slot while it is used; when the atlas is full, the slot
 * not used for the longest time is taken over — never one used in the current frame.
 */
export class SignAtlas {
  private slots = new Map<string, { slot: number; last: number }>();
  private frame = 0;

  constructor(readonly capacity = ATLAS_COLS * ATLAS_ROWS) {}

  /** Call once per frame before `slotFor`. */
  beginFrame(): void {
    this.frame++;
  }

  /** The slot of a key, and whether it must be (re)drawn; null when every slot is in use this frame. */
  slotFor(key: string): { slot: number; fresh: boolean } | null {
    const hit = this.slots.get(key);
    if (hit) {
      hit.last = this.frame;
      return { slot: hit.slot, fresh: false };
    }
    if (this.slots.size < this.capacity) {
      const slot = this.slots.size;
      this.slots.set(key, { slot, last: this.frame });
      return { slot, fresh: true };
    }
    let oldest: string | null = null;
    let at = this.frame;
    for (const [k, v] of this.slots) {
      if (v.last < at) {
        at = v.last;
        oldest = k;
      }
    }
    if (oldest === null) return null;
    const taken = this.slots.get(oldest)!;
    this.slots.delete(oldest);
    this.slots.set(key, { slot: taken.slot, last: this.frame });
    return { slot: taken.slot, fresh: true };
  }

  get size(): number {
    return this.slots.size;
  }
}

/** A plaque to draw: its centre (m), the way it faces (a unit step on x or z) and its size (m). */
export interface SignSpec {
  /** 'wall' = on the far wall; 'door' = by (or over) a doorway. */
  kind: 'wall' | 'door';
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  w: number;
  h: number;
}

/** The text quad's size for a plaque height: the atlas aspect, so the lettering is never stretched. */
export function signSize(h: number): { w: number; h: number } {
  return { w: h * SIGN_ASPECT, h };
}

/** Rotation about y (radians) of a quad that faces +z so that it faces (nx, nz). */
export function signYaw(nx: number, nz: number): number {
  return Math.atan2(nx, nz);
}

/**
 * The left edge (along the wall) of a plaque `width` wide near the wall's middle that touches none of `busy` (with a
 * `gap` of clearance) and stays `margin` inside [a0, a1]; null if it fits nowhere.
 */
export function pickSpan(a0: number, a1: number, busy: readonly [number, number][], width: number, gap = 0.1, margin = 0.15): number | null {
  const lo = a0 + margin;
  const hi = a1 - margin - width;
  if (hi < lo) return null;
  const fits = (a: number) => a >= lo - 1e-9 && a <= hi + 1e-9 && !busy.some(([b0, b1]) => a + width > b0 - gap && a < b1 + gap);
  const mid = (lo + hi) / 2;
  if (fits(mid)) return mid;
  // search outwards from the middle in small steps
  for (let d = 0.1; d <= (hi - lo) / 2 + 0.1; d += 0.1) {
    if (fits(mid - d)) return mid - d;
    if (fits(mid + d)) return mid + d;
  }
  return null;
}

/**
 * Beside a doorway: the left edge of a plaque `width` wide just right of the opening, else just left of it, inside the
 * wall run [a0, a1] and clear of `busy`; null if neither side has room.
 */
export function besideDoor(door: { x0: number; x1: number }, run: { a0: number; a1: number }, busy: readonly [number, number][], width: number, gap = 0.18): number | null {
  const clear = (a: number) => a >= run.a0 + 0.05 && a + width <= run.a1 - 0.05 && !busy.some(([b0, b1]) => a + width > b0 - 0.05 && a < b1 + 0.05);
  const right = door.x1 + gap;
  if (clear(right)) return right;
  const left = door.x0 - gap - width;
  if (clear(left)) return left;
  return null;
}
