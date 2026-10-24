// The read-only conversation view (P7-05) for Gemini CLI: chat-file lines → ConversationEntry. Pure. The chat file is
// append-only, but a message changes by being written again under the same id (the last write wins, in its first
// place), `$rewindTo` drops what came after a message, and `$patch` updates messages in place; the parser replays
// all of it, then renders. The session context message never shows.
import { t } from '../../../shared/i18n';
import { cleanText, oneLine, rec, RESULT_MAX, str, toMs, toolEntry, type Rec } from '../../../shared/conversation';
import type { ConversationEntry } from '../../../shared/protocol';

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const r = rec(b);
      return r && typeof r.text === 'string' ? r.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function resultOf(call: Rec): { text: string; error: boolean } {
  const parts = Array.isArray(call.result) ? call.result : [];
  const resp = rec(rec(rec(parts[0])?.functionResponse)?.response);
  const error = str(resp?.error);
  const output = error ?? str(resp?.output) ?? str(call.resultDisplay) ?? '';
  return { text: output, error: !!error || (call.status !== undefined && call.status !== 'success') };
}

export function parseGeminiConversation(lines: Iterable<string>): ConversationEntry[] {
  const order: string[] = [];
  const messages = new Map<string, Rec>();
  for (const raw of lines) {
    if (raw.length < 2) continue;
    let j: Rec | undefined;
    try {
      j = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!j) continue;
    const rewind = str(j.$rewindTo);
    if (rewind !== undefined) {
      const i = order.indexOf(rewind);
      if (i >= 0) for (const id of order.splice(i)) messages.delete(id);
      continue;
    }
    const patch = rec(j.$patch);
    if (patch && Array.isArray(patch.updates)) {
      for (const u of patch.updates) {
        const r = rec(u);
        const id = str(r?.id);
        if (id && messages.has(id)) messages.set(id, { ...messages.get(id)!, ...r });
      }
      continue;
    }
    const id = str(j.id);
    if (!id || typeof j.type !== 'string') continue;
    if (!messages.has(id)) order.push(id);
    messages.set(id, j);
  }
  const out: ConversationEntry[] = [];
  for (const id of order) {
    const m = messages.get(id)!;
    const at = toMs(m.timestamp) ?? 0;
    const text = partsText(m.content).trim();
    switch (m.type) {
      case 'user':
        if (text && !text.startsWith('<session_context>')) out.push({ kind: 'user', id, at, text: cleanText(text) });
        break;
      case 'gemini': {
        const thoughts = Array.isArray(m.thoughts) ? m.thoughts.map(rec).filter((x): x is Rec => !!x) : [];
        thoughts.forEach((th, i) => {
          const tt = [str(th.subject), str(th.description)].filter(Boolean).join(': ');
          out.push({ kind: 'thinking', id: `${id}:k${i}`, at, ...(tt ? { text: cleanText(tt, 2_000) } : {}) });
        });
        if (text) out.push({ kind: 'assistant', id, at, text: cleanText(text) });
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls.map(rec).filter((x): x is Rec => !!x) : [];
        calls.forEach((c, i) => {
          const callId = str(c.id) ?? `${id}:c${i}`;
          const callAt = toMs(c.timestamp) ?? at;
          out.push(toolEntry(callId, callAt, str(c.name) ?? 'tool', c.args));
          if (c.status === undefined && c.result === undefined) return;
          const r = resultOf(c);
          const cancelled = c.status === 'cancelled';
          out.push({ kind: 'result', id: `${callId}:result`, at: callAt, toolId: callId, text: cancelled ? t('Cancelled') : cleanText(r.text, RESULT_MAX), ...(r.error ? { error: true } : {}) });
        });
        break;
      }
      case 'info':
      case 'warning':
      case 'error':
        if (text) out.push({ kind: 'system', id, at, text: oneLine(text), level: m.type === 'info' ? 'info' : m.type === 'warning' ? 'warn' : 'error' });
        break;
      default:
        break;
    }
  }
  return out;
}
