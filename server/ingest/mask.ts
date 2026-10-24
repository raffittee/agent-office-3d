// Masks and truncates everything an event carries before it enters the office (CLAUDE.md › Security: secrets are
// masked before anything reaches the browser, the logs or the disk).
import { maskSecrets } from '../../shared/activity';
import type { AgentEvent } from '../../shared/protocol';

/** Longest string kept from an event (the shims already cut at 8 KB). */
export const MAX_STRING = 8 * 1024;
const MAX_KEYS = 200;
const MAX_DEPTH = 6;
const MAX_ITEMS = 200;

export function maskText(s: string, max = MAX_STRING): string {
  // Cut a bit beyond the limit first (masking huge texts is slow), mask, then cut to the limit: a secret is never
  // split before masking.
  const m = maskSecrets(s.length > max * 2 ? s.slice(0, max * 2) : s);
  return m.length > max ? `${m.slice(0, max - 1)}…` : m;
}

/** Masks every string in a JSON-like value, with limits on size and depth. */
export function maskDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return maskText(v);
  if (v === null || typeof v !== 'object') return typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
  if (depth >= MAX_DEPTH) return '…';
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => maskDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (++n > MAX_KEYS) break;
    out[maskText(k, 200)] = maskDeep(x, depth + 1);
  }
  return out;
}

/** A masked copy of a (validated) event. */
export function maskEvent(e: AgentEvent): AgentEvent {
  const m: AgentEvent = { ...e };
  if (m.prompt !== undefined) m.prompt = maskText(m.prompt);
  if (m.title !== undefined) m.title = maskText(m.title, 500);
  if (m.cwd !== undefined) m.cwd = m.cwd.slice(0, 4096);
  if (m.tool) m.tool = { ...m.tool, ...(m.tool.input !== undefined ? { input: maskDeep(m.tool.input) } : {}), ...(m.tool.error ? { error: maskText(m.tool.error, 64) } : {}) };
  if (m.waiting) m.waiting = { ...m.waiting, ...(m.waiting.text !== undefined ? { text: maskText(m.waiting.text, 2_000) } : {}) };
  if (m.job) m.job = { ...m.job, ...(m.job.label !== undefined ? { label: maskText(m.job.label, 500) } : {}), ...(m.job.command !== undefined ? { command: maskText(m.job.command, 2_000) } : {}) };
  if (m.subagent) m.subagent = { ...m.subagent, ...(m.subagent.title !== undefined ? { title: maskText(m.subagent.title, 2_000) } : {}) };
  if (m.tasks) m.tasks = m.tasks.map((x) => ({ ...x, title: maskText(x.title, 500), ...(x.activeForm !== undefined ? { activeForm: maskText(x.activeForm, 500) } : {}) }));
  return m;
}
