// Tiny DOM helpers for the panels.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, title: string, onClick: () => void, cls = 'ui-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

export function badge(text: string, color: string): HTMLSpanElement {
  const b = el('span', 'ui-badge', text);
  b.style.background = color;
  return b;
}

/** localStorage that never throws (private windows, blocked storage). */
export const prefs = {
  get<T extends object>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`agent-office:${key}`);
      return raw === null ? fallback : ({ ...fallback, ...(JSON.parse(raw) as object) } as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`agent-office:${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable: the setting lasts for this page only
    }
  },
};
