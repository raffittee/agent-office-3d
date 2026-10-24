// The theme packs bundled with the client (P4-02): every themes/<id>/theme.json, validated, plus URLs for the files
// they reference. Invalid packs are skipped with a console warning (`npm run theme:check` explains why). In dev,
// editing a theme.json hot-reloads it: listeners get the new list and the world restyles without losing state.
import { validateTheme, type ThemePack } from '../../../shared/theme';
import { FURNITURE_KINDS } from '../core/vocab';
import { resolveLook, type Look } from './look';

export const DEFAULT_THEME = 'modern';

const packFiles = import.meta.glob('../../../themes/*/theme.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const assetFiles = import.meta.glob('../../../themes/*/**/*.{glb,png,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export interface ThemeEntry {
  look: Look;
  /** URL of the pack's thumbnail, if it has one. */
  thumbnail: string | null;
  /** URL of a file inside the pack (models), or null. */
  url(file: string): string | null;
}

function folderOf(key: string): string {
  return key.split('/').slice(-2, -1)[0]!;
}

function load(): ThemeEntry[] {
  const kinds = new Set<string>(FURNITURE_KINDS);
  const out: ThemeEntry[] = [];
  for (const [key, raw] of Object.entries(packFiles)) {
    const folder = folderOf(key);
    const issues = validateTheme(raw, kinds);
    const pack = raw as ThemePack;
    if (issues.length || pack.id !== folder) {
      console.warn(`[themes] skipping themes/${folder}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ') || 'id must match the folder'}`);
      continue;
    }
    const prefix = key.slice(0, -'theme.json'.length);
    const url = (file: string) => assetFiles[prefix + file] ?? null;
    out.push({ look: resolveLook(pack), thumbnail: pack.thumbnail ? url(pack.thumbnail) : null, url });
  }
  // the default first, then by name
  return out.sort((a, b) => (a.look.id === DEFAULT_THEME ? -1 : b.look.id === DEFAULT_THEME ? 1 : a.look.name.localeCompare(b.look.name)));
}

let entries = load();
const listeners = new Set<(list: ThemeEntry[]) => void>();

export function themes(): ThemeEntry[] {
  return entries;
}

/** A theme by id, falling back to the default (or the first valid pack). */
export function themeById(id: string | null | undefined): ThemeEntry {
  return entries.find((e) => e.look.id === id) ?? entries.find((e) => e.look.id === DEFAULT_THEME) ?? entries[0]!;
}

/** Called when packs change (dev hot reload). */
export function onThemesChanged(fn: (list: ThemeEntry[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    const next = (mod as { themes?: () => ThemeEntry[] } | undefined)?.themes?.();
    if (!next) return;
    entries = next;
    for (const fn of listeners) fn(next);
  });
}
