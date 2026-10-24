// Accessibility helpers shared by the 3D view and the panels (P8-03).
// - Motion: the "Motion" setting (follow the system, reduce, full) on top of prefers-reduced-motion. Reduced motion
//   means: no camera glides, no confetti rain or spinning beacons, no pulsing or sliding panels.
// - Provider shapes: each provider has a shape as well as a color (●, ◆, ■, ▲…), so badges stay apart without
//   color vision.
import type { ProviderId } from '../../shared/protocol';

export type MotionSetting = 'auto' | 'reduce' | 'full';

let setting: MotionSetting = 'auto';
let mq: MediaQueryList | null | undefined;

function systemReduced(): boolean {
  if (mq === undefined) {
    mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    mq?.addEventListener?.('change', applyClass);
  }
  return !!mq?.matches;
}

function applyClass(): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('ao-reduced-motion', reducedMotion());
}

/** Should motion be reduced now (the setting, else the system's preference)? */
export function reducedMotion(): boolean {
  return setting === 'reduce' ? true : setting === 'full' ? false : systemReduced();
}

export function setMotion(s: MotionSetting): void {
  setting = s;
  applyClass();
}

export type Shape = 'circle' | 'diamond' | 'square' | 'triangle' | 'hexagon' | 'star';

const SHAPES: Record<string, Shape> = { 'claude-code': 'circle', 'gemini-cli': 'diamond', codex: 'square' };
const CUSTOM: Shape[] = ['triangle', 'hexagon', 'star'];
const GLYPH: Record<Shape, string> = { circle: '●', diamond: '◆', square: '■', triangle: '▲', hexagon: '⬢', star: '★' };

/** A provider's shape: fixed for the built-ins; custom agents get one of the rest, stable by name. */
export function providerShape(id: ProviderId | string): Shape {
  const fixed = SHAPES[id];
  if (fixed) return fixed;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CUSTOM[h % CUSTOM.length]!;
}

export function shapeGlyph(id: ProviderId | string): string {
  return GLYPH[providerShape(id)];
}
