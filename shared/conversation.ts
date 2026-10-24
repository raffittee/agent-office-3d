// The read-only conversation view (P7-05), pure helpers shared by every provider's parser: cleaning and cutting
// texts (system reminders, ANSI codes and control characters out, secrets masked, line breaks kept), and the
// tool entry's title and arguments (shared/permission-view.ts). Ideas from habblaud server/sources/terminal.ts
// (MIT, © 2026 Márcio Junior).
import { maskSecrets } from './activity';
import { cutBlock, permissionView } from './permission-view';
import type { ConversationEntry } from './protocol';

/** Longest text of an entry. */
export const TEXT_MAX = 8_000;
/** Longest tool result. */
export const RESULT_MAX = 3_000;
/** Most entries in one page. */
export const PAGE_MAX = 400;

const REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Cleans a text for the view: no reminders, ANSI or control characters; secrets masked; cut, keeping line breaks. */
export function cleanText(raw: string, max = TEXT_MAX): string {
  const text = raw.slice(0, max * 3).replace(REMINDER, '').replace(ANSI, '').replace(CONTROL, '').trim();
  return text ? cutBlock(text, max) : '';
}

/** A one-line text (system entries). */
export function oneLine(raw: string, max = 200): string {
  const line = maskSecrets(raw.replace(ANSI, '').replace(/\s+/g, ' ').trim());
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A tool entry with a CLI-style title and the masked arguments. */
export function toolEntry(id: string, at: number, tool: string, input: unknown, cwd?: string): ConversationEntry {
  const v = permissionView(tool, input, cwd);
  return { kind: 'tool', id, at, tool, title: v.title, ...(v.input ? { input: v.input } : {}) };
}

/** Timestamps: ISO strings or epoch numbers. */
export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Keeps the last `max` entries (and whether some were dropped). */
export function lastPage(entries: ConversationEntry[], max = PAGE_MAX): { entries: ConversationEntry[]; dropped: boolean } {
  return entries.length > max ? { entries: entries.slice(-max), dropped: true } : { entries, dropped: false };
}
