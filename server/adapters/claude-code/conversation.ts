// The read-only conversation view (P7-05) for Claude Code: transcript lines → ConversationEntry. Pure. A condensed
// take on habblaud server/sources/terminal.ts (MIT, © 2026 Márcio Junior): prompts, slash commands, answers,
// thinking, tool calls and results, compaction and interruptions. `api-request*` records and `credential_org`
// attachments are dropped before parsing (CLAUDE.md, P0-05); meta lines, reminders and command caveats never show.
import { t } from '../../../shared/i18n';
import { cleanText, oneLine, rec, RESULT_MAX, str, toMs, toolEntry, type Rec } from '../../../shared/conversation';
import type { ConversationEntry } from '../../../shared/protocol';
import { skipRaw } from './transcript';

const INTERRUPTED = /^\[Request interrupted by user/;
const REJECTED = /doesn't want to proceed|tool use was rejected|user rejected/i;

function inner(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m?.[1];
}

/** A tool_result's content as text (strings, or text blocks; images become a marker). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const r = rec(b);
      if (r?.type === 'text' && typeof r.text === 'string') return r.text;
      if (r?.type === 'image') return t('[image]');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function parseClaudeConversation(lines: Iterable<string>): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  const seen = new Set<string>();
  let lastAt = 0;
  let seq = 0;
  const emit = (e: ConversationEntry) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    out.push(e);
  };
  for (const raw of lines) {
    if (raw.length < 2 || skipRaw(raw)) continue;
    let j: Rec | undefined;
    try {
      j = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!j) continue;
    const at = toMs(j.timestamp) ?? lastAt;
    if (at) lastAt = at;
    const uuid = str(j.uuid) ?? `x${++seq}`;
    const msg = rec(j.message);
    if (j.type === 'user') {
      if (j.isMeta === true) continue;
      const content = msg?.content;
      if (j.isCompactSummary === true) {
        emit({ kind: 'system', id: `${uuid}:s`, at, text: t('Conversation compacted') });
        continue;
      }
      const texts: string[] = [];
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content)) {
        for (const b of content) {
          const r = rec(b);
          if (r?.type === 'tool_result') {
            const id = str(r.tool_use_id) ?? `${uuid}:r`;
            const text = cleanText(resultText(r.content), RESULT_MAX);
            const rejected = REJECTED.test(text);
            emit({ kind: 'result', id: `${id}:result`, at, toolId: id, text: rejected ? t('Denied') : text, ...(r.is_error === true || rejected ? { error: true } : {}) });
          } else if (r?.type === 'text' && typeof r.text === 'string') texts.push(r.text);
        }
      }
      const text = texts.join('\n').trim();
      if (!text) continue;
      if (INTERRUPTED.test(text)) emit({ kind: 'system', id: `${uuid}:s`, at, text: t('Interrupted by the user'), level: 'warn' });
      else if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
        const name = inner(text, 'command-name')?.trim() ?? `/${inner(text, 'command-message')?.trim() ?? ''}`;
        const args = inner(text, 'command-args')?.trim() ?? '';
        emit({ kind: 'user', id: `${uuid}:u`, at, text: cleanText(`${name} ${args}`.trim(), 500) });
      } else if (text.startsWith('<local-command-stdout>') || text.startsWith('<local-command-stderr>')) {
        const body = (inner(text, 'local-command-stdout') ?? inner(text, 'local-command-stderr') ?? '').trim();
        if (body) emit({ kind: 'system', id: `${uuid}:s`, at, text: oneLine(body) });
      } else if (text.startsWith('<bash-input>')) {
        emit({ kind: 'user', id: `${uuid}:u`, at, text: cleanText(`! ${inner(text, 'bash-input') ?? ''}`, 2_000) });
      } else if (text.startsWith('<task-notification>') || text.startsWith('Caveat:')) {
        const summary = inner(text, 'summary');
        if (summary) emit({ kind: 'system', id: `${uuid}:s`, at, text: oneLine(summary) });
      } else {
        const clean = cleanText(text);
        if (clean) emit({ kind: 'user', id: `${uuid}:u`, at, text: clean });
      }
    } else if (j.type === 'assistant') {
      const content = msg?.content;
      if (!Array.isArray(content)) continue;
      const mid = str(msg?.id) ?? uuid;
      content.forEach((b, i) => {
        const r = rec(b);
        if (!r) return;
        if (r.type === 'text' && typeof r.text === 'string') {
          const text = cleanText(r.text);
          if (text && text !== 'No response requested.') emit({ kind: 'assistant', id: `${mid}:t${i}:${uuid}`, at, text });
        } else if (r.type === 'thinking') {
          const text = typeof r.thinking === 'string' ? cleanText(r.thinking, 2_000) : '';
          emit({ kind: 'thinking', id: `${mid}:k${i}:${uuid}`, at, ...(text ? { text } : {}) });
        } else if (r.type === 'tool_use') {
          emit(toolEntry(str(r.id) ?? `${uuid}:tool${i}`, at, str(r.name) ?? 'tool', r.input, str(j!.cwd)));
        }
      });
    } else if (j.type === 'system') {
      const sub = str(j.subtype);
      if (sub === 'compact_boundary') emit({ kind: 'system', id: `${uuid}:s`, at, text: t('Conversation compacted') });
      else if (sub === 'api_error' || j.level === 'error') emit({ kind: 'system', id: `${uuid}:s`, at, text: oneLine(str(j.content) ?? t('API error')), level: 'error' });
    }
  }
  return out;
}
