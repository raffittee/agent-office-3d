// Ported from habblaud shared/i18n.ts (MIT, © 2026 Márcio Junior)
// UI text helper. English is the source language (D10): every string is written in English and goes through t(),
// which returns the active dictionary's translation or the English text itself. v1 ships English only; a dictionary
// can be registered later without touching call sites.

/** Active translations, keyed by the English source text. Empty = English. */
let dict: Readonly<Record<string, string>> = {};

/** Installs a dictionary (keys are English source strings). Pass {} to go back to English. */
export function registerDictionary(d: Readonly<Record<string, string>>): void {
  dict = d;
}

/**
 * Translates an English source string. Numbered slots ({0}, {1}, ...) take `args` in order; a translation may
 * reorder them. Missing translation = the English text.
 */
export function t(src: string, args?: readonly unknown[]): string {
  const s = dict[src] || src;
  if (!args || args.length === 0) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}
