// Ported from habblaud server/sources/codex/rollout.ts (MIT, © 2026 Márcio Junior)
// Codex rollouts (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl), checked against Codex 0.164.0
// (test/fixtures/codex/, docs/providers/codex.md). Each line becomes zero or more items the adapter turns into
// AgentEvents. Pure: no file access here.
//
// - session_meta (first line): the thread, its cwd, its parent when it's a subagent (`source.subagent.thread_spawn`).
// - event_msg task_started / task_complete / turn_aborted: turns, by turn_id (the same id the hooks carry).
// - event_msg item_completed UserMessage: the prompt (the turn starts with it, so the prompt reaches turn.start).
// - response_item function_call / custom_tool_call (+ _output): tools, by call_id (= the hooks' tool_use_id).
//   "Process running with session ID N" in an exec_command output = a background job; it ends when a later output
//   for that exec session says "Process exited", or when its CommandExecution item completes.
// - event_msg token_count: tokens (`last_token_usage`; cached tokens are inside input_tokens) and plan rate limits.
// Unknown lines are ignored; a broken line never stops the reading. Prompts and outputs are never logged.

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(v: unknown): v is string {
  return typeof v === 'string' && THREAD_ID.test(v);
}

export interface RolloutMeta {
  threadId: string;
  cwd?: string;
  cliVersion?: string;
  gitBranch?: string;
  /** A subagent: the thread that spawned it. */
  parentThreadId?: string;
  nickname?: string;
  role?: string;
  /** A Codex-internal thread (review, compaction, memory, guardian): not shown in the office. */
  internal: boolean;
}

/** Keys compared case-insensitively and without `_` (Codex has written `subagent`, `subAgent`, `thread_spawn`…). */
function looseGet(o: Rec, name: string): unknown {
  const want = name.toLowerCase().replace(/_/g, '');
  for (const [k, v] of Object.entries(o)) if (k.toLowerCase().replace(/_/g, '') === want) return v;
  return undefined;
}

const INTERNAL_THREAD_SOURCES = new Set(['guardian_review', 'memory_consolidation']);

export function parseSessionMeta(p: Rec): RolloutMeta | undefined {
  const threadId = str(p.id);
  if (!isThreadId(threadId)) return undefined;
  const src = rec(p.source);
  let internal = INTERNAL_THREAD_SOURCES.has(String(p.thread_source ?? ''));
  let spawn: Rec | undefined;
  if (src) {
    if (looseGet(src, 'internal') !== undefined) internal = true;
    const sub = looseGet(src, 'subagent');
    if (sub !== undefined) {
      spawn = rec(sub) ? rec(looseGet(rec(sub)!, 'thread_spawn')) : undefined;
      // review, compact, memory_consolidation…: internal threads without a known parent
      if (!spawn) internal = true;
    }
  }
  const meta: RolloutMeta = { threadId, internal };
  const cwd = str(p.cwd);
  if (cwd) meta.cwd = cwd;
  const version = str(p.cli_version);
  if (version) meta.cliVersion = version;
  const branch = str(rec(p.git)?.branch);
  if (branch && branch !== 'HEAD') meta.gitBranch = branch;
  const parent = str(spawn ? looseGet(spawn, 'parent_thread_id') : undefined) ?? str(p.parent_thread_id);
  if (isThreadId(parent) && parent !== threadId) meta.parentThreadId = parent;
  const nickname = str(spawn ? looseGet(spawn, 'agent_nickname') : undefined) ?? str(p.agent_nickname);
  if (nickname) meta.nickname = nickname.slice(0, 40);
  const role = str(spawn ? (looseGet(spawn, 'agent_role') ?? looseGet(spawn, 'agent_type')) : undefined) ?? str(p.agent_role);
  if (role) meta.role = role.slice(0, 40);
  return meta;
}

/** Arguments of a function call: a JSON string (the usual) or an object. */
export function parseArguments(raw: unknown): Rec {
  if (rec(raw)) return rec(raw)!;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return rec(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

/** A plan window: `window_minutes` 300 = the 5-hour session, 10080 = the week. */
export interface RateWindow {
  minutes: number;
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
}

export interface RateLimits {
  windows: RateWindow[];
  /** No quota left and no credits (`rate_limit_reached_type` without a primary window). */
  reached?: string;
  planType?: string;
}

/** `token_count.rate_limits` → plan usage; only the default `codex` limit (models with their own limit would flip-flop). */
export function parseRateLimits(raw: unknown): RateLimits | undefined {
  const rl = rec(raw);
  if (!rl) return undefined;
  const limit = str(rl.limit_id);
  if (limit && limit !== 'codex') return undefined;
  const windows: RateWindow[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    const o = rec(w);
    const minutes = num(o?.window_minutes);
    const used = num(o?.used_percent);
    if (!o || minutes === undefined || used === undefined) continue;
    const win: RateWindow = { minutes, usedPercent: Math.min(100, Math.max(0, used)) };
    const resets = num(o.resets_at);
    if (resets !== undefined) win.resetsAt = resets < 1e12 ? Math.round(resets * 1000) : Math.round(resets);
    windows.push(win);
  }
  const out: RateLimits = { windows };
  const reached = str(rl.rate_limit_reached_type);
  if (reached && !rec(rl.primary)) out.reached = reached;
  const plan = str(rl.plan_type);
  if (plan) out.planType = plan;
  return windows.length || out.reached ? out : undefined;
}

export type RolloutItem =
  | { type: 'meta'; meta: RolloutMeta; at: number }
  | { type: 'turn.start'; turnId: string; at: number; prompt?: string }
  | { type: 'turn.end'; turnId?: string; at: number; aborted?: boolean }
  | { type: 'tool.start'; callId: string; name: string; input: Rec; at: number }
  | { type: 'tool.end'; callId: string; name: string; at: number; ok?: boolean; error?: string }
  | { type: 'job.start'; jobId: string; command: string; at: number }
  | { type: 'job.end'; jobId: string; at: number; ok?: boolean }
  | { type: 'waiting'; reason: 'question'; at: number; text?: string }
  | { type: 'spawned'; agentId: string; nickname?: string; task?: string; at: number }
  | { type: 'usage'; at: number; tokens: { in: number; out: number; cached: number }; rateLimits?: RateLimits }
  | { type: 'model'; model: string };

export interface RolloutState {
  meta?: RolloutMeta;
  model?: string;
  /** task_started seen, its user message not yet (the turn starts with the prompt). */
  pendingTurn?: { turnId: string; at: number };
  /** Calls without an output yet: call_id → name and input. */
  calls: Map<string, { name: string; input: Rec }>;
  /** Background exec sessions still running: exec session id → job id. */
  jobs: Map<string, string>;
  lastAt?: number;
}

export function createRolloutState(): RolloutState {
  return { calls: new Map(), jobs: new Map() };
}

/** "Process exited with code N" (exec_command) / "Exit code: N" (apply_patch). */
export function exitCodeOf(output: string): number | undefined {
  const m = /Process exited with code (-?\d+)/.exec(output) ?? /^Exit code: (-?\d+)/m.exec(output);
  return m ? Number(m[1]) : undefined;
}

/** "Process running with session ID N": the command keeps running in the background. */
export function runningSessionOf(output: string): string | undefined {
  return /Process running with session ID (\d+)/.exec(output)?.[1];
}

function outputText(raw: unknown): string {
  if (typeof raw === 'string') return raw.slice(0, 20_000);
  const o = rec(raw);
  if (o && typeof o.content === 'string') return o.content.slice(0, 20_000);
  if (Array.isArray(raw)) return raw.map((x) => (typeof rec(x)?.text === 'string' ? (rec(x)!.text as string) : '')).join('\n').slice(0, 20_000);
  return '';
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof rec(c)?.text === 'string' ? (rec(c)!.text as string) : '')).join('\n');
}

/** The tool name as hooks would report it: a namespace (`multi_agent_v1`) is kept apart from the name. */
function callName(p: Rec): string {
  return str(p.name) ?? (p.type === 'local_shell_call' ? 'local_shell' : p.type === 'web_search_call' ? 'web_search' : 'tool');
}

/** Parses one rollout line. */
export function parseRolloutLine(s: RolloutState, line: string, now: number): RolloutItem[] {
  let j: Rec | undefined;
  try {
    j = rec(JSON.parse(line));
  } catch {
    return [];
  }
  if (!j) return [];
  const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
  const at = Number.isFinite(ts) ? ts : now;
  s.lastAt = at;
  const p = rec(j.payload);
  if (!p) return [];
  const out: RolloutItem[] = [];
  const startTurn = (prompt?: string) => {
    if (!s.pendingTurn) return;
    const item: RolloutItem = { type: 'turn.start', turnId: s.pendingTurn.turnId, at: s.pendingTurn.at };
    if (prompt) item.prompt = prompt.slice(0, 8_000);
    out.push(item);
    delete s.pendingTurn;
  };
  switch (j.type) {
    case 'session_meta': {
      const meta = parseSessionMeta(p);
      if (meta) {
        s.meta = meta;
        out.push({ type: 'meta', meta, at });
      }
      break;
    }
    case 'turn_context': {
      const model = str(p.model);
      if (model && model !== s.model) {
        s.model = model;
        out.push({ type: 'model', model });
      }
      break;
    }
    case 'event_msg':
      switch (p.type) {
        case 'task_started':
        case 'turn_started': {
          startTurn();
          const turnId = str(p.turn_id) ?? `turn@${at}`;
          s.pendingTurn = { turnId, at };
          break;
        }
        case 'item_completed': {
          const item = rec(p.item);
          if (item?.type === 'UserMessage') startTurn(contentText(item.content));
          else if (item?.type === 'CommandExecution') {
            // a background command finished
            const pid = str(item.process_id) ?? (num(item.process_id) !== undefined ? String(item.process_id) : undefined);
            const job = pid ? s.jobs.get(pid) : undefined;
            if (pid && job) {
              s.jobs.delete(pid);
              const code = num(item.exit_code);
              out.push({ type: 'job.end', jobId: job, at, ...(code !== undefined ? { ok: code === 0 } : {}) });
            }
          }
          break;
        }
        case 'user_message':
          // legacy rollouts (no item_completed)
          startTurn(str(p.message));
          break;
        case 'task_complete':
        case 'turn_complete':
        case 'turn_aborted': {
          startTurn();
          const turnId = str(p.turn_id);
          out.push({ type: 'turn.end', at, ...(turnId ? { turnId } : {}), ...(p.type === 'turn_aborted' ? { aborted: true } : {}) });
          s.calls.clear();
          break;
        }
        case 'token_count': {
          const info = rec(p.info);
          const last = rec(info?.last_token_usage);
          const input = num(last?.input_tokens) ?? 0;
          const cached = num(last?.cached_input_tokens) ?? 0;
          const output = num(last?.output_tokens) ?? 0;
          const rateLimits = parseRateLimits(p.rate_limits);
          if (last || rateLimits) out.push({ type: 'usage', at, tokens: { in: Math.max(0, input - cached), out: output, cached }, ...(rateLimits ? { rateLimits } : {}) });
          break;
        }
        default:
          break;
      }
      break;
    case 'response_item':
      switch (p.type) {
        case 'function_call':
        case 'custom_tool_call':
        case 'local_shell_call': {
          startTurn();
          const callId = str(p.call_id) ?? str(p.id);
          if (!callId) break;
          const name = callName(p);
          const input = p.type === 'custom_tool_call' ? { input: typeof p.input === 'string' ? p.input.slice(0, 200_000) : '' } : p.type === 'local_shell_call' ? { command: rec(p.action)?.command } : parseArguments(p.arguments);
          s.calls.set(callId, { name, input });
          out.push({ type: 'tool.start', callId, name, input, at });
          if (name === 'request_user_input') out.push({ type: 'waiting', reason: 'question', at, ...(str(input.question) ? { text: str(input.question)!.slice(0, 300) } : {}) });
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const callId = str(p.call_id);
          if (!callId) break;
          const call = s.calls.get(callId);
          s.calls.delete(callId);
          const name = call?.name ?? 'tool';
          const text = outputText(p.output);
          const end: RolloutItem = { type: 'tool.end', callId, name, at };
          const code = exitCodeOf(text);
          if (code !== undefined) {
            end.ok = code === 0;
            if (code !== 0) end.error = `exit_${code}`;
          } else if (/^approval policy is \w+; reject command|rejected by user|declined/i.test(text)) {
            end.ok = false;
            end.error = 'rejected';
          }
          out.push(end);
          if (name === 'spawn_agent') {
            const spawned = parseArguments(text);
            if (isThreadId(spawned.agent_id)) {
              const item: RolloutItem = { type: 'spawned', agentId: spawned.agent_id, at };
              if (str(spawned.nickname)) item.nickname = str(spawned.nickname)!.slice(0, 40);
              const task = str(call?.input.message) ?? str(call?.input.prompt);
              if (task) item.task = task.slice(0, 1_000);
              out.push(item);
            }
          }
          const running = runningSessionOf(text);
          if (running && (name === 'exec_command' || name === 'shell' || name === 'write_stdin') && !s.jobs.has(running)) {
            const jobId = `exec:${running}`;
            s.jobs.set(running, jobId);
            const command = String(call?.input.cmd ?? call?.input.command ?? '');
            out.push({ type: 'job.start', jobId, command, at });
          } else if (name === 'write_stdin' && code !== undefined) {
            const sid = call?.input.session_id;
            const key = typeof sid === 'number' || typeof sid === 'string' ? String(sid) : undefined;
            const job = key ? s.jobs.get(key) : undefined;
            if (key && job) {
              s.jobs.delete(key);
              out.push({ type: 'job.end', jobId: job, at, ok: code === 0 });
            }
          }
          break;
        }
        default:
          break;
      }
      break;
    default:
      break;
  }
  return out;
}
