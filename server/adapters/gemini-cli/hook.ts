// The body hooks/gemini-cli.mjs posts to /api/hooks/gemini-cli, validated. It arrives over HTTP (local-only, but any
// local process can post), so every field is checked and anything unexpected is dropped.
import { isAbsolute, sep } from 'node:path';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'Notification'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface GeminiToolResult {
  ok: boolean;
  errorType?: string;
  exitCode?: number;
  backgroundPid?: number;
}

export interface GeminiHook {
  event: HookEvent;
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  /** Epoch ms (the payload's timestamp, or now). */
  at: number;
  source?: string;
  reason?: string;
  prompt?: string;
  pid?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: GeminiToolResult;
  notificationType?: string;
  message?: string;
  details?: { type?: string; title?: string; fileName?: string; command?: string };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max = 4_000): string | undefined {
  return typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/**
 * Is this a Gemini chat file the adapter may tail? `<home>/.gemini/tmp/<slug>/chats/session-*.jsonl`, or a subagent's
 * `chats/<parent>/<id>.jsonl`. The path comes from a hook payload: anything else is refused, so a local process
 * can't make the server read arbitrary files.
 */
export function isGeminiChatPath(p: string): boolean {
  if (!isAbsolute(p) || !p.endsWith('.jsonl')) return false;
  const parts = p.split(/[\\/]+/);
  const i = parts.lastIndexOf('.gemini');
  if (i < 0 || parts[i + 1] !== 'tmp' || !parts[i + 2] || parts[i + 3] !== 'chats') return false;
  const rest = parts.slice(i + 4);
  if (rest.some((x) => x === '..' || x === '.')) return false;
  if (rest.length === 1) return /^session-[\w.:-]+\.jsonl$/.test(rest[0]!);
  return rest.length === 2 && /^[\w-]+$/.test(rest[0]!) && /^[\w-]+\.jsonl$/.test(rest[1]!);
}

/** The Gemini home a chat path belongs to (the folder holding `.gemini`). */
export function geminiHomeOf(chatPath: string): string | undefined {
  const parts = chatPath.split(/[\\/]+/);
  const i = parts.lastIndexOf('.gemini');
  if (i <= 0) return undefined;
  const home = parts.slice(0, i).join(sep);
  return home || sep;
}

/** Validates a shim body. undefined = not understood. */
export function parseHookBody(raw: unknown, now: number): GeminiHook | undefined {
  if (!isObject(raw)) return undefined;
  const event = raw.hook_event_name;
  if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) return undefined;
  const sessionId = str(raw.session_id, 200);
  if (!sessionId || !/^[\w.:-]+$/.test(sessionId)) return undefined;
  const ts = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
  const h: GeminiHook = { event: event as HookEvent, sessionId, at: Number.isFinite(ts) ? ts : now };
  const transcript = str(raw.transcript_path);
  if (transcript && isGeminiChatPath(transcript)) h.transcriptPath = transcript;
  const cwd = str(raw.cwd);
  if (cwd && isAbsolute(cwd)) h.cwd = cwd;
  const source = str(raw.source, 40);
  if (source) h.source = source;
  const reason = str(raw.reason, 40);
  if (reason) h.reason = reason;
  const prompt = str(raw.prompt, 8_000);
  if (prompt) h.prompt = prompt;
  const pid = int(raw.pid);
  if (pid !== undefined && pid > 0) h.pid = pid;
  const toolName = str(raw.tool_name, 200);
  if (toolName) h.toolName = toolName;
  if (isObject(raw.tool_input)) h.toolInput = raw.tool_input;
  if (isObject(raw.tool_result)) {
    const r = raw.tool_result;
    const res: GeminiToolResult = { ok: r.ok !== false };
    const errorType = str(r.error_type, 60);
    if (errorType) res.errorType = errorType;
    const exit = int(r.exit_code);
    if (exit !== undefined) res.exitCode = exit;
    const bg = int(r.background_pid);
    if (bg !== undefined && bg > 0) res.backgroundPid = bg;
    h.toolResult = res;
  }
  const nt = str(raw.notification_type, 60);
  if (nt) h.notificationType = nt;
  const message = str(raw.message, 300);
  if (message) h.message = message;
  if (isObject(raw.details)) {
    const d: GeminiHook['details'] = {};
    for (const k of ['type', 'title', 'fileName', 'command'] as const) {
      const v = str(raw.details[k], 300);
      if (v) d[k] = v;
    }
    h.details = d;
  }
  return h;
}
