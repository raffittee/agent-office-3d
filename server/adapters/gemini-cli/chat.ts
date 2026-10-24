// Reading Gemini CLI's chat files (<home>/.gemini/tmp/<slug>/chats/session-*.jsonl, and a subagent's
// chats/<parentSessionId>/<subagentSessionId>.jsonl). Format, verified in P0-04 (docs/providers/gemini-cli.md):
// append-only JSONL read as last-write-wins: line 1 is metadata (`kind: main | subagent`); a message is appended
// again under the same `id` every time it changes; `$set`, `$patch` and `$rewindTo` are control lines. Tool calls are
// written when they finish. Model and tokens appear only here (no hook carries them).
import type { EventTool } from '../../../shared/protocol';

export interface ChatState {
  sessionId?: string;
  kind?: 'main' | 'subagent';
  model?: string;
  /** Tokens counted per message id (a message is re-appended with its usage). */
  usage: Map<string, { in: number; out: number; cached: number }>;
  /** Tool calls already reported, by id. */
  calls: Set<string>;
  /** The first user message is a <session_context> blob, never a prompt. */
  sawContext: boolean;
  /** First real user message (a subagent's task). */
  firstPrompt?: string;
  lastAt?: number;
}

export function createChatState(): ChatState {
  return { usage: new Map(), calls: new Set(), sawContext: false };
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'success' | 'error' | 'cancelled';
  /** When the model asked for it (the message's time) and when it finished. */
  startAt: number;
  endAt: number;
  /** "Command moved to background (PID: n)". */
  backgroundPid?: number;
  /** invoke_agent: the subagent's session id (its chat file's name). */
  agentId?: string;
  /** invoke_agent: "Termination Reason: GOAL" (or an error). */
  goal?: boolean;
}

export type ChatItem =
  | { type: 'usage'; at: number; model?: string; tokens: { in: number; out: number; cached: number } }
  | { type: 'tool'; call: ChatToolCall }
  | { type: 'cancelled'; at: number }
  | { type: 'prompt'; at: number; text: string };

/** Tool-input keys that carry file contents or edits: never forwarded. */
const CONTENT_KEYS = new Set(['content', 'old_string', 'new_string', 'newContent', 'originalContent', 'fileDiff', 'edits']);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toMs(v: unknown, fallback: number): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

/** A tool input without file contents, with strings cut. */
export function slimArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObject(args)) return out;
  for (const [k, v] of Object.entries(args)) {
    if (CONTENT_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v.length > 500 ? `${v.slice(0, 499)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** The text of a user message (`content` is a JSON string of parts, or the parts themselves). */
function userText(content: unknown): string {
  let parts: unknown = content;
  if (typeof content === 'string') {
    try {
      parts = JSON.parse(content);
    } catch {
      return content;
    }
  }
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (isObject(p) && typeof p.text === 'string' ? p.text : '')).join('\n');
}

function resultText(call: Record<string, unknown>): string {
  const display = call.resultDisplay;
  let s = typeof display === 'string' ? display : '';
  try {
    s += `\n${JSON.stringify(call.result ?? '').slice(0, 4_000)}`;
  } catch {
    // unserializable: the display is enough
  }
  return s;
}

/** Reads one chat line. Bad, unknown and control lines produce nothing. */
export function parseChatLine(state: ChatState, raw: string, now: number): ChatItem[] {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObject(j)) return [];
  if ('$set' in j || '$patch' in j || '$rewindTo' in j) return [];
  // Metadata line.
  if (typeof j.sessionId === 'string' && (j.kind === 'main' || j.kind === 'subagent') && j.type === undefined) {
    state.sessionId = j.sessionId;
    state.kind = j.kind;
    return [];
  }
  const id = typeof j.id === 'string' ? j.id : undefined;
  const at = toMs(j.timestamp, now);
  if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  const out: ChatItem[] = [];
  switch (j.type) {
    case 'user': {
      if (!id) return [];
      // Tool results come back as user messages made of functionResponse parts (no text).
      const text = userText(j.content).trim();
      if (!text) return [];
      if (!state.sawContext && text.startsWith('<session_context>')) {
        state.sawContext = true;
        return [];
      }
      state.firstPrompt ??= text.slice(0, 300);
      out.push({ type: 'prompt', at, text: text.slice(0, 1_000) });
      return out;
    }
    case 'gemini': {
      if (!id) return [];
      const model = typeof j.model === 'string' && j.model.trim() ? j.model.trim() : undefined;
      if (model) state.model = model;
      if (isObject(j.tokens)) {
        const t = j.tokens;
        // `input` includes the cached part; thinking tokens are billed as output.
        const cached = num(t.cached);
        const now3 = { in: Math.max(0, num(t.input) - cached), cached, out: num(t.output) + num(t.thoughts) };
        const prev = state.usage.get(id) ?? { in: 0, out: 0, cached: 0 };
        const d = { in: Math.max(0, now3.in - prev.in), out: Math.max(0, now3.out - prev.out), cached: Math.max(0, now3.cached - prev.cached) };
        state.usage.set(id, { in: Math.max(now3.in, prev.in), out: Math.max(now3.out, prev.out), cached: Math.max(now3.cached, prev.cached) });
        if (state.usage.size > 512) state.usage.delete(state.usage.keys().next().value as string);
        if (d.in || d.out || d.cached) out.push({ type: 'usage', at, ...(model ? { model } : {}), tokens: d });
      }
      if (Array.isArray(j.toolCalls)) {
        for (const c of j.toolCalls) {
          if (!isObject(c) || typeof c.id !== 'string' || typeof c.name !== 'string') continue;
          const status = c.status === 'success' || c.status === 'error' || c.status === 'cancelled' ? c.status : undefined;
          if (!status || state.calls.has(c.id)) continue;
          state.calls.add(c.id);
          if (state.calls.size > 2_000) state.calls.delete(state.calls.values().next().value as string);
          const text = resultText(c);
          const call: ChatToolCall = { id: c.id, name: c.name, input: slimArgs(c.args), status, startAt: at, endAt: Math.max(at, toMs(c.timestamp, at)) };
          const bg = /moved to background \(PID:\s*(\d+)\)/i.exec(text)?.[1];
          if (bg) call.backgroundPid = Number(bg);
          if (typeof c.agentId === 'string' && /^[\w-]+$/.test(c.agentId)) call.agentId = c.agentId;
          if (c.name === 'invoke_agent') call.goal = /Termination Reason:\s*GOAL/i.test(text);
          out.push({ type: 'tool', call });
        }
      }
      return out;
    }
    case 'info':
      if (typeof j.content === 'string' && /^Request cancelled\.?$/i.test(j.content.trim())) out.push({ type: 'cancelled', at });
      return out;
    default:
      return [];
  }
}

/** A finished chat tool call as tool.end's `tool`. */
export function endedTool(call: ChatToolCall): EventTool {
  const tool: EventTool = { id: call.id, name: call.name, ok: call.status === 'success' };
  if (call.status === 'cancelled') tool.error = 'cancelled';
  else if (call.status === 'error') tool.error = 'error';
  return tool;
}
