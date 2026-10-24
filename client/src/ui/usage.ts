// Plan usage in the top bar (P5-04): one chip per account with open sessions or known usage, with the 5-hour and
// weekly windows as small bars. The numbers come only from local files the tools write (see
// server/accounts/service.ts); "stale" when they're over 30 minutes old, nothing when the tool doesn't record them.
import { t } from '../../../shared/i18n';
import type { AccountInfo, OfficeSnapshot } from '../../../shared/protocol';
import type { OfficeStore } from '../net/store';
import { el } from './dom';

export interface UsageBar {
  label: string;
  pct: number;
  level: 'ok' | 'warn' | 'high';
  /** "resets in 2 h 30 min" */
  resets?: string;
}

export interface UsageChip {
  key: string;
  short: string;
  color: string;
  name: string;
  bars: UsageBar[];
  stale: boolean;
  noQuota: boolean;
  /** The tooltip. */
  title: string;
}

/** "in 2 h 30 min", "in 3 d", "in 12 min". */
export function inTime(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return t('in {0} min', [min]);
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? t('in {0} h {1} min', [h, min % 60]) : t('in {0} h', [h]);
  return t('in {0} d', [Math.round(h / 24)]);
}

function level(pct: number): UsageBar['level'] {
  return pct >= 90 ? 'high' : pct >= 70 ? 'warn' : 'ok';
}

/** The chips for a snapshot's accounts (pure). */
export function usageChips(accounts: readonly AccountInfo[], now: number): UsageChip[] {
  return accounts
    .filter((a) => a.usage || a.sessions > 0)
    .map((a) => {
      const bars: UsageBar[] = [];
      const u = a.usage;
      for (const [label, w] of [
        [t('5h'), u?.fiveHour],
        [t('week'), u?.sevenDay],
      ] as const) {
        if (!w) continue;
        const pct = Math.round(w.utilization);
        const bar: UsageBar = { label, pct, level: level(pct) };
        if (w.resetsAt !== undefined && w.resetsAt > now) bar.resets = t('resets {0}', [inTime(w.resetsAt - now)]);
        bars.push(bar);
      }
      const stale = a.usageStatus === 'stale';
      const lines = [a.name, ...(a.organization ? [a.organization] : []), t('{0} open sessions', [a.sessions])];
      for (const b of bars) lines.push(`${b.label}: ${b.pct}%${b.resets ? ` · ${b.resets}` : ''}`);
      if (u?.noQuota) lines.push(t('No quota left'));
      if (u) lines.push(u.source === 'demo' ? t('Made-up numbers (demo)') : stale ? t('Last updated {0} ago', [Math.round((now - u.fetchedAt) / 60_000) + ' min']) : t('From {0}', [u.source]));
      else lines.push(t('Plan usage not available for this account'));
      return { key: `${a.provider}|${a.id}`, short: a.short, color: a.color, name: a.name, bars, stale, noQuota: !!u?.noQuota, title: lines.join('\n') };
    });
}

/** The usage strip for the top bar. */
export function createUsage(store: OfficeStore): HTMLElement {
  const root = el('div', 'ui-usage');
  root.setAttribute('aria-label', t('Plan usage'));
  let last = '';
  const render = (snap: OfficeSnapshot | null) => {
    const chips = usageChips(snap?.accounts ?? [], Date.now());
    const key = JSON.stringify(chips);
    if (key === last) return;
    last = key;
    root.replaceChildren(
      ...chips.map((c) => {
        const chip = el('span', `ui-acct${c.stale ? ' stale' : ''}${c.noQuota ? ' none' : ''}`);
        chip.title = c.title;
        chip.style.setProperty('--c', c.color);
        chip.append(el('b', '', c.short));
        for (const b of c.bars) {
          const bar = el('span', `ui-bar ${b.level}`);
          bar.setAttribute('role', 'meter');
          bar.setAttribute('aria-valuenow', String(b.pct));
          bar.setAttribute('aria-valuemin', '0');
          bar.setAttribute('aria-valuemax', '100');
          bar.setAttribute('aria-label', `${c.name} ${b.label}`);
          const fill = el('i');
          fill.style.width = `${b.pct}%`;
          bar.append(fill);
          chip.append(bar, el('small', '', `${b.pct}%`));
        }
        return chip;
      }),
    );
  };
  store.on('snapshot', () => render(store.snapshot));
  render(store.snapshot);
  // reset times count down even without new snapshots
  setInterval(() => {
    last = '';
    render(store.snapshot);
  }, 60_000);
  return root;
}
