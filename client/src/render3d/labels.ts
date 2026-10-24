// What each character's label shows (P2-08), decided purely from sim state and options so it can be tested:
// the name tag, the bubble (activity, "needs you", job timer, delivery) and an icon. overlay.ts draws the result.
import { t } from '../../../shared/i18n';
import type { Character } from '../core/sim/character';
import { formatShellAge, hourglassIcon, shellBubbleAlpha } from '../core/sim/shell';
import type { WorldOptions } from '../core/options';
import type { IconName } from '../core/vocab';

export const ICON_EMOJI: Record<IconName, string> = {
  alert: '❗',
  question: '❓',
  zzz: '💤',
  check: '✅',
  heart: '💛',
  coffee: '☕',
  music: '🎵',
  idea: '💡',
  sweat: '😓',
  star: '⭐',
  lightning: '⚡',
  chat: '💬',
  box: '📦',
  wave: '👋',
  hourglass: '⏳',
  hourglass_flip: '⌛',
  cobweb: '🕸️',
  storm: '🌧️',
  coin: '🪙',
  sparkle: '✨',
  trophy: '🏆',
  hand_rock: '✊',
  hand_paper: '✋',
  hand_scissors: '✌️',
};

/** A recent activity change stays visible this long in "important" mode. */
export const RECENT_MS = 6_000;

export type BubbleKind = 'activity' | 'alert' | 'shell' | 'deliver';

export interface LabelView {
  name: string | null;
  bubble: { kind: BubbleKind; icon: string; text: string; opacity: number } | null;
  icon: string | null;
  /** Higher wins when labels overlap. */
  priority: number;
}

/**
 * The label of one character. `zoomPx` is pixels per metre: zoomed far out only alerts and the selection stay.
 */
export function labelFor(ch: Character, now: number, opts: WorldOptions, selected: boolean, zoomPx: number): LabelView {
  const a = ch.info;
  const waiting = ch.mode === 'wait';
  const far = zoomPx < 9;
  const mid = zoomPx < 16;
  let bubble: LabelView['bubble'] = null;
  if (ch.bubbleText && now < ch.bubbleUntil) bubble = { kind: 'deliver', icon: ch.bubbleIcon, text: ch.bubbleText, opacity: 1 };
  else if (waiting) bubble = { kind: 'alert', icon: '✋', text: a.waitingFor ?? t('needs you'), opacity: 1 };
  else if (ch.mode === 'shell' && ch.shellSince) {
    const age = now - ch.shellSince;
    const imp = opts.bubbles === 'all' || selected ? 1 : shellBubbleAlpha(now - ch.shellEnteredAt, a.seed % 30_000);
    const count = ch.shellCount > 1 ? ` ×${ch.shellCount}` : '';
    bubble = { kind: 'shell', icon: ICON_EMOJI[hourglassIcon(now)], text: `${ch.shellLabel}${count} · ${formatShellAge(age)}`, opacity: imp };
  } else if (a.activity && ch.mode === 'work') {
    const recent = now - ch.activityChangedAt < RECENT_MS;
    const show = opts.bubbles === 'all' || selected || (opts.bubbles === 'important' && recent);
    if (show) bubble = { kind: 'activity', icon: a.activity.icon, text: a.activity.text, opacity: 1 };
  }
  if (opts.bubbles === 'none' && bubble && bubble.kind !== 'alert') bubble = null;
  if (bubble && bubble.opacity <= 0.01) bubble = null;
  if (bubble && far && bubble.kind !== 'alert' && !selected) bubble = null;
  if (bubble && mid && bubble.kind === 'activity' && !selected) bubble = null;
  const showName = selected || (opts.showNames && !far);
  const icon = ch.icon && now < ch.iconUntil ? ICON_EMOJI[ch.icon] : ch.chatEmoji && now < ch.chatUntil ? ch.chatEmoji : null;
  const priority = (selected ? 100 : 0) + (waiting ? 50 : 0) + (bubble?.kind === 'deliver' ? 30 : 0) + (bubble ? 10 : 0) + (a.kind === 'main' ? 2 : 0);
  return { name: showName ? a.name : null, bubble, icon: far && !selected ? null : icon, priority };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Greedy decluttering: in priority order, keeps a label if it doesn't overlap one already kept. Returns kept ids. */
export function declutter(items: { id: string; rect: Rect; priority: number }[]): Set<string> {
  const kept: Rect[] = [];
  const out = new Set<string>();
  for (const it of [...items].sort((a, b) => b.priority - a.priority)) {
    const r = it.rect;
    if (kept.some((k) => r.x < k.x + k.w && r.x + r.w > k.x && r.y < k.y + k.h && r.y + r.h > k.y)) continue;
    kept.push(r);
    out.add(it.id);
  }
  return out;
}
