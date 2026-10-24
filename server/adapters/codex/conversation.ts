// The read-only conversation view (P7-05) for Codex: rollout lines → ConversationEntry. Pure. Developer messages, the
// environment context and the world state never show; subagent notifications become system lines.
import { t } from '../../../shared/i18n';
import { cleanText, oneLine, rec, RESULT_MAX, str, toMs, toolEntry, type Rec } from '../../../shared/conversation';
import type { ConversationEntry } from '../../../shared/protocol';
import { commandText } from '../../../shared/tools/codex';

function texts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const r = rec(b);
      return r && typeof r.text === 'string' ? r.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A function call's arguments (JSON text) as an object, with `cmd` turned into readable text. */
function args(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    const a = JSON.parse(raw) as unknown;
    const r = rec(a);
    if (r && r.cmd !== undefined) return { ...r, command: commandText(r.cmd) };
    return a;
  } catch {
    return { input: raw };
  }
}

export function parseCodexConversation(lines: Iterable<string>): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  let lastAt = 0;
  let seq = 0;
  let cwd: string | undefined;
  for (const raw of lines) {
    if (raw.length < 2) continue;
    let j: Rec | undefined;
    try {
      j = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    const p = rec(j?.payload);
    if (!j || !p) continue;
    const at = toMs(j.timestamp) ?? lastAt;
    if (at) lastAt = at;
    if (j.type === 'session_meta' || j.type === 'turn_context') cwd = str(p.cwd) ?? cwd;
    if (j.type !== 'response_item') continue;
    const id = str(p.id) ?? str(p.call_id) ?? `c${++seq}`;
    switch (p.type) {
      case 'message': {
        const text = texts(p.content).trim();
        if (!text || p.role === 'developer' || p.role === 'system') break;
        if (p.role === 'user') {
          if (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) break;
          if (text.startsWith('<subagent_notification>')) out.push({ kind: 'system', id: `${id}:s`, at, text: t('A subagent reported back') });
          else out.push({ kind: 'user', id, at, text: cleanText(text) });
        } else if (p.role === 'assistant') out.push({ kind: 'assistant', id, at, text: cleanText(text) });
        break;
      }
      case 'reasoning': {
        const summary = Array.isArray(p.summary) ? texts(p.summary) : '';
        out.push({ kind: 'thinking', id, at, ...(summary ? { text: cleanText(summary, 2_000) } : {}) });
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const name = str(p.name) ?? (p.type === 'local_shell_call' ? 'shell' : 'tool');
        const input = p.type === 'custom_tool_call' ? { command: str(p.input) ?? '' } : p.type === 'local_shell_call' ? { command: commandText(rec(p.action)?.command) } : args(p.arguments);
        out.push(toolEntry(str(p.call_id) ?? id, at, name, input, cwd));
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = str(p.call_id) ?? id;
        const output = typeof p.output === 'string' ? p.output : texts(rec(p.output)?.content) || JSON.stringify(p.output ?? '');
        const failed = /Process exited with code [1-9]|^Exit code: [1-9]|reject command/m.test(output);
        out.push({ kind: 'result', id: `${callId}:result`, at, toolId: callId, text: cleanText(output, RESULT_MAX), ...(failed ? { error: true } : {}) });
        break;
      }
      default:
        break;
    }
  }
  return out.map((e) => (e.kind === 'system' ? { ...e, text: oneLine(e.text) } : e));
}
