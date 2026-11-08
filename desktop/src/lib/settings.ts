// The app's own settings (window mode, pinning, tray behavior, remembered bounds), kept in one small JSON file in the
// app's data folder. Whatever is in the file is validated: a hand-edited or old file never breaks startup.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Bounds, Mode } from './windowState';

export interface DesktopSettings {
  mode: Mode;
  /** Widget stays above other windows. */
  pinned: boolean;
  /** 0.3 .. 1 */
  opacity: number;
  /** The close button hides the window to the tray instead of quitting. */
  closeToTray: boolean;
  startAtLogin: boolean;
  /** Native notifications when an agent starts waiting for you. */
  notifications: boolean;
  /** The port used last time, tried first. */
  port?: number;
  bounds: Partial<Record<Mode, Bounds>>;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  mode: 'window',
  pinned: true,
  opacity: 1,
  closeToTray: true,
  startAtLogin: false,
  notifications: true,
  bounds: {},
};

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

function bounds(v: unknown): Bounds | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  const nums = [b.x, b.y, b.width, b.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const [x, y, width, height] = nums as number[];
  if (width! < 1 || height! < 1 || width! > 20_000 || height! > 20_000) return undefined;
  return { x: Math.round(x!), y: Math.round(y!), width: Math.round(width!), height: Math.round(height!) };
}

export function sanitizeSettings(raw: unknown): DesktopSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1024 && r.port <= 65535 ? r.port : undefined;
  const opacity = typeof r.opacity === 'number' && Number.isFinite(r.opacity) ? Math.min(1, Math.max(0.3, r.opacity)) : DEFAULT_SETTINGS.opacity;
  const rb = r.bounds && typeof r.bounds === 'object' ? (r.bounds as Record<string, unknown>) : {};
  const window = bounds(rb.window);
  const widget = bounds(rb.widget);
  return {
    mode: r.mode === 'widget' ? 'widget' : 'window',
    pinned: bool(r.pinned, DEFAULT_SETTINGS.pinned),
    opacity,
    closeToTray: bool(r.closeToTray, DEFAULT_SETTINGS.closeToTray),
    startAtLogin: bool(r.startAtLogin, DEFAULT_SETTINGS.startAtLogin),
    notifications: bool(r.notifications, DEFAULT_SETTINGS.notifications),
    ...(port ? { port } : {}),
    bounds: { ...(window ? { window } : {}), ...(widget ? { widget } : {}) },
  };
}

export function loadSettings(file: string): DesktopSettings {
  try {
    return sanitizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return sanitizeSettings(undefined);
  }
}

/** Writes through a temp file so a crash never leaves half a settings file. Failures are ignored on purpose. */
export function saveSettings(file: string, settings: DesktopSettings): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // settings are a convenience: never stop the app over them
  }
}
