// The body hooks/codex.mjs posts to /api/hooks/codex, validated. It arrives over HTTP (local-only, but any local
// process can post), so every field is checked and anything unexpected is dropped. Paths the adapter may read
// (rollouts) must look like Codex rollouts.
import { isAbsolute, sep } from 'node:path';
import { isThreadId } from './rollout';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PermissionRequest'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface CodexToolResult {
  exitCode?: number;
  /** A command left running: its exec session. */
  execSession?: number;
  rejected?: boolean;
  /** spawn_agent: the new agent. */
  agentId?: string;
  nickname?: string;
}

export interface CodexHook {
  event: HookEvent;
  sessionId: string;
  turnId?: string;
  /** The rollout of the session (or, for a subagent's SubagentStop, of the subagent). */
  transcriptPath?: string;
  agentTranscriptPath?: string;
  cwd?: string;
  /** A subagent's event: its thread id. */
  agentId?: string;
  agentType?: string;
  model?: string;
  codexHome?: string;
  source?: string;
  reason?: string;
  prompt?: string;
  pid?: number;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: CodexToolResult;
  at: number;
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
 * Is this a Codex rollout the adapter may read? `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` (or under
 * `archived_sessions/`). The path comes from a hook payload: anything else is refused.
 */
export function isRolloutPath(p: string): boolean {
  if (!isAbsolute(p) || !p.endsWith('.jsonl')) return false;
  const parts = p.split(/[\\/]+/);
  if (parts.some((x) => x === '..' || x === '.')) return false;
  const file = parts[parts.length - 1]!;
  if (!/^rollout-[\w.:-]+\.jsonl$/.test(file)) return false;
  const i = parts.lastIndexOf('sessions');
  if (i > 0 && parts.length === i + 5 && /^\d{4}$/.test(parts[i + 1]!) && /^\d{2}$/.test(parts[i + 2]!) && /^\d{2}$/.test(parts[i + 3]!)) return true;
  const a = parts.lastIndexOf('archived_sessions');
  return a > 0 && parts.length === a + 2;
}

/** The Codex home a rollout belongs to (the folder holding `sessions/`). */
export function codexHomeOf(rolloutPath: string): string | undefined {
  const parts = rolloutPath.split(/[\\/]+/);
  const i = Math.max(parts.lastIndexOf('sessions'), parts.lastIndexOf('archived_sessions'));
  if (i <= 0) return undefined;
  return parts.slice(0, i).join(sep) || sep;
}

/** Validates a shim body. undefined = not understood. */
export function parseHookBody(raw: unknown, now: number): CodexHook | undefined {
  if (!isObject(raw)) return undefined;
  const event = raw.hook_event_name;
  if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) return undefined;
  const sessionId = str(raw.session_id, 64);
  if (!isThreadId(sessionId)) return undefined;
  const h: CodexHook = { event: event as HookEvent, sessionId, at: now };
  const turnId = str(raw.turn_id, 64);
  if (turnId && /^[\w-]+$/.test(turnId)) h.turnId = turnId;
  const transcript = str(raw.transcript_path);
  if (transcript && isRolloutPath(transcript)) h.transcriptPath = transcript;
  const agentTranscript = str(raw.agent_transcript_path);
  if (agentTranscript && isRolloutPath(agentTranscript)) h.agentTranscriptPath = agentTranscript;
  const cwd = str(raw.cwd);
  if (cwd && isAbsolute(cwd)) h.cwd = cwd;
  const agentId = str(raw.agent_id, 64);
  if (isThreadId(agentId) && agentId !== sessionId) h.agentId = agentId;
  const agentType = str(raw.agent_type, 40);
  if (agentType) h.agentType = agentType;
  const model = str(raw.model, 100);
  if (model) h.model = model;
  const home = str(raw.codex_home);
  if (home && isAbsolute(home)) h.codexHome = home;
  const source = str(raw.source, 40);
  if (source) h.source = source;
  const reason = str(raw.reason, 300);
  if (reason) h.reason = reason;
  const prompt = str(raw.prompt, 8_000);
  if (prompt) h.prompt = prompt;
  const pid = int(raw.pid);
  if (pid !== undefined && pid > 0) h.pid = pid;
  const toolName = str(raw.tool_name, 200);
  if (toolName) h.toolName = toolName;
  const toolUseId = str(raw.tool_use_id, 200);
  if (toolUseId && /^[\w.:-]+$/.test(toolUseId)) h.toolUseId = toolUseId;
  if (isObject(raw.tool_input)) h.toolInput = raw.tool_input;
  if (isObject(raw.tool_result)) {
    const r = raw.tool_result;
    const res: CodexToolResult = {};
    const exit = int(r.exit_code);
    if (exit !== undefined) res.exitCode = exit;
    const exec = int(r.exec_session);
    if (exec !== undefined && exec > 0) res.execSession = exec;
    if (r.rejected === true) res.rejected = true;
    const agent = str(r.agent_id, 64);
    if (isThreadId(agent)) res.agentId = agent;
    const nickname = str(r.nickname, 40);
    if (nickname) res.nickname = nickname;
    h.toolResult = res;
  }
  return h;
}
