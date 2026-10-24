// Ported from habblaud server/sources/transcript.ts (MIT, © 2026 Márcio Junior)
// Reading Claude Code's JSONL transcripts (main session and subagents). Each line updates a TranscriptState (titles,
// tasks, tokens...) and can produce events (prompt, tool start/end, end of turn, compaction) and signals (subagent
// and shell lifecycles, which the adapter resolves across files). Unknown line types are ignored; a bad line never
// stops the reading.
//
// Re-shaped for Agent Office: the output is AgentEvent fragments, not activities (the office describes tools itself).
// P0-05 rules: `api-request*` records and `credential_org` attachments are skipped before parsing; `PowerShell` is a
// shell like `Bash`; `permissionDecision: reject` marks a denial; `toolEndsTurn` ends a turn (SubagentHandback).
import { createReadStream } from 'node:fs';
import { claudeJob } from '../../../shared/tools/claude-code';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { EventTask, EventTool, TaskStatus } from '../../../shared/protocol';
import { LineBuffer, warnOversizedLine } from '../tail';
import type { ShellStart } from './shells';

// ------------------------------------------------------------------ tasks

export type TaskOp =
  | { op: 'replace'; tasks: EventTask[] }
  | { op: 'create'; id: string; title: string; activeForm?: string }
  | { op: 'update'; id: string; status?: TaskStatus | 'deleted'; title?: string; activeForm?: string }
  | { op: 'rename'; from: string; to: string };

const TASK_STATUSES = new Set<string>(['pending', 'in_progress', 'completed']);

export function applyTaskOp(tasks: EventTask[], op: TaskOp): EventTask[] {
  switch (op.op) {
    case 'replace':
      return op.tasks.map((t) => ({ ...t }));
    case 'create': {
      const t: EventTask = { id: op.id, title: op.title, status: 'pending' };
      if (op.activeForm) t.activeForm = op.activeForm;
      return [...tasks.filter((x) => x.id !== op.id), t];
    }
    case 'update': {
      const status = op.status;
      if (status === 'deleted') return tasks.filter((t) => t.id !== op.id);
      if (!tasks.some((t) => t.id === op.id)) return tasks;
      return tasks.map((t) => {
        if (t.id !== op.id) return t;
        const next: EventTask = { ...t };
        if (status) next.status = status;
        if (op.title) next.title = op.title;
        if (op.activeForm) next.activeForm = op.activeForm;
        return next;
      });
    }
    case 'rename':
      return tasks.map((t) => (t.id === op.from ? { ...t, id: op.to } : t));
  }
}

function todosToTasks(raw: unknown): EventTask[] {
  if (!Array.isArray(raw)) return [];
  const out: EventTask[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const t = item as Record<string, unknown>;
    const title = str(t.content) ?? str(t.subject) ?? str(t.title);
    if (!title) return;
    const status = typeof t.status === 'string' && TASK_STATUSES.has(t.status) ? (t.status as TaskStatus) : 'pending';
    const task: EventTask = { id: str(t.id) ?? String(i + 1), title: truncate(title, 120), status };
    const af = str(t.activeForm);
    if (af) task.activeForm = truncate(af, 120);
    out.push(task);
  });
  return out;
}

// ------------------------------------------------------------------ state

export interface SpawnInfo {
  toolUseId: string;
  /** 'Agent' | 'Task' | 'Workflow'. */
  tool: string;
  description?: string;
  subagentType?: string;
  name?: string;
  background: boolean;
  at: number;
}

/**
 * Signals for the subagents' lifecycle (taken from the transcript of whoever started them) and for the shells the
 * agent waits for (Bash/PowerShell/Monitor; see shells.ts).
 */
export type TranscriptSignal =
  | { type: 'spawn'; spawn: SpawnInfo }
  | { type: 'launched'; toolUseId: string; agentId?: string; runId?: string; taskId?: string }
  | { type: 'finished'; toolUseId: string; agentId?: string; runId?: string; error: boolean }
  | { type: 'notification'; toolUseId?: string; taskId?: string; status?: string; summary?: string }
  | { type: 'stopped'; taskId: string }
  /** A shell (foreground or background) or Monitor was called. */
  | { type: 'shellStart'; shell: ShellStart }
  /** A shell/Monitor tool_result: `taskId` = the background task id, when there is one. */
  | { type: 'shellResult'; toolUseId: string; taskId?: string; error: boolean }
  /** End of turn or interruption: no foreground command keeps running. */
  | { type: 'turnEnd' };

/** Signals the shell tracker cares about (also in the file's start, read in the background). */
const SHELL_SIGNALS = new Set<TranscriptSignal['type']>(['shellStart', 'shellResult', 'notification', 'stopped', 'turnEnd']);

/** What a line says happened, as AgentEvent fragments (the adapter adds the envelope). */
export type TranscriptEvent =
  | { type: 'turn.start'; at: number; prompt: string }
  | { type: 'turn.end'; at: number; interrupted?: boolean }
  | { type: 'tool.start'; at: number; tool: EventTool }
  | { type: 'tool.end'; at: number; tool: EventTool }
  | { type: 'compact'; at: number };

export interface TokenCount {
  in: number;
  out: number;
  cached: number;
}

export interface TranscriptState {
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  lastPrompt?: string;
  tasks: EventTask[];
  /** TaskCreate waiting for the real id (tool_use id -> provisional id). */
  pendingTaskCreates: Map<string, string>;
  /** Task operations since the start of the window read (until the file's start is merged). */
  taskOpsLog: TaskOp[] | null;
  sawTaskReplace: boolean;
  /** Tokens counted so far (the adapter emits the difference as `usage`). */
  tokens: TokenCount;
  model?: string;
  gitBranch?: string;
  permissionMode?: string;
  firstAt?: number;
  lastAt?: number;
  /** The turn ended (end of turn, end_turn, a turn-ending tool or an interruption) and nothing new started. */
  ended: boolean;
  /** Tools called that have no result yet. */
  pendingTools: Map<string, string>;
  /** Tool names by tool_use id (for results). */
  toolNames: Map<string, string>;
  /** TaskStop/KillShell: tool_use id -> id of the task stopped. */
  stopRequests: Map<string, string>;
  /** Tokens already counted per message (a message's lines repeat its usage, sometimes partially). */
  usageByMsg: Map<string, TokenCount>;
  /** Ids of the first messages of the window read (so merging the file's start doesn't count them twice). */
  firstMsgIds: Set<string> | null;
  /** Messages whose usage mustn't be counted (they belong to the window already read). */
  skipUsage?: ReadonlySet<string>;
  seq: number;
  /**
   * Transcript of a fork (a subagent that inherits its parent's context). It starts with a 'fork-context-ref' line and
   * a COPY of the parent's Agent call followed by its result ("Fork started…") with the fork's directive.
   * 'expect-spawn' = the next assistant line is that copy.
   */
  fork?: 'expect-spawn' | 'expect-result';
  /** tool_use id of the inherited call (the same as in the fork's meta.json): not one of the fork's tools. */
  inheritedSpawn?: string;
}

export function createTranscriptState(opts: { trackPrefix?: boolean } = {}): TranscriptState {
  return {
    tasks: [],
    pendingTaskCreates: new Map(),
    taskOpsLog: opts.trackPrefix ? [] : null,
    sawTaskReplace: false,
    tokens: { in: 0, out: 0, cached: 0 },
    ended: false,
    pendingTools: new Map(),
    toolNames: new Map(),
    stopRequests: new Map(),
    usageByMsg: new Map(),
    firstMsgIds: opts.trackPrefix ? new Set() : null,
    seq: 0,
  };
}

export interface LineResult {
  events: TranscriptEvent[];
  signals: TranscriptSignal[];
  /** Title, tasks, tokens or metadata changed. */
  changed: boolean;
  /** Epoch ms of the line (its `timestamp`, or the `now` given). */
  at: number;
}

// ------------------------------------------------------------------ helpers

const MAX_TRACKED = 512;
const FIRST_MSG_IDS = 48;
/** Longest string kept from a tool input (the office needs paths, commands and short descriptions). */
const INPUT_STRING_MAX = 500;
/** Tool-input keys that carry file contents or edits: never forwarded. */
const CONTENT_KEYS = new Set(['content', 'old_string', 'new_string', 'oldString', 'newString', 'edits', 'new_source', 'contents']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function truthy(v: unknown): boolean {
  return v === true || (typeof v === 'string' && /^(true|1|yes)$/i.test(v.trim()));
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max = MAX_TRACKED): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

/** A tool input without file contents, with long strings cut (it's masked again on emit). */
export function slimInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (CONTENT_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v.length > INPUT_STRING_MAX ? `${v.slice(0, INPUT_STRING_MAX - 1)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v && typeof v === 'object') out[k] = v; // questions, todos: masked and capped on emit
  }
  return out;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Extracts the fields of a `<task-notification>` (result of a background task). */
export function parseTaskNotification(text: string): { taskId?: string; toolUseId?: string; status?: string; summary?: string } {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() || undefined;
  const out: { taskId?: string; toolUseId?: string; status?: string; summary?: string } = {};
  const taskId = tag('task-id');
  const toolUseId = tag('tool-use-id');
  const status = tag('status');
  const summary = tag('summary');
  if (taskId) out.taskId = taskId;
  if (toolUseId) out.toolUseId = toolUseId;
  if (status) out.status = status;
  if (summary) out.summary = summary;
  return out;
}

/**
 * Background task id in a shell/Monitor tool_result: `toolUseResult.backgroundTaskId` ("Command running in
 * background with ID: bo0ov3q3l..." in the text) or equivalent fields.
 */
export function backgroundIdOf(tur: Record<string, unknown>, content: unknown, tool?: string): string | undefined {
  for (const k of ['backgroundTaskId', 'backgroundId', 'shellId', 'bash_id', 'monitorId']) {
    const v = str(tur[k]);
    if (v) return v.trim();
  }
  if (tool === 'Monitor') {
    const v = str(tur.taskId) ?? str(tur.task_id);
    if (v) return v.trim();
  }
  if (!SHELL_TOOLS.has(tool ?? '') && tool !== 'Monitor') return undefined;
  // Only the start of the text, in Claude Code's own wording ("Command running in background with ID: x"): a
  // foreground command's output can contain anything (that sentence included).
  const head = (textOf(content).trimStart().split('\n', 1)[0] ?? '').slice(0, 300);
  const re =
    tool === 'Monitor'
      ? /^(?:Monitor|Started|Watching|Task)\b[^"]{0,80}?\b(?:task|monitor)?\s*id\b[':\s]*([A-Za-z0-9_-]{4,})/i
      : /^Command\b[^"]{0,60}?\bbackground\w*\b[^"]{0,60}?\bID:\s*([A-Za-z0-9_-]{4,})/i;
  return re.exec(head)?.[1];
}

const INTERRUPTED = /^\[Request interrupted by user/;
const REJECTED = /doesn't want to proceed|tool use was rejected|user rejected/i;
// "System" messages written as user (local commands, reminders, bash output, peer messages...).
const SYSTEM_TAG = /^<(local-command-[\w-]+|command-stdout|command-stderr|system-reminder|bash-[\w-]+|user-memory-input|user-prompt-submit-hook|persisted-output|agent-message)\b/;
// Slash commands that aren't work instructions.
const LOCAL_COMMANDS = new Set([
  '/clear', '/compact', '/model', '/cost', '/usage', '/status', '/config', '/login', '/logout', '/exit', '/quit', '/resume',
  '/context', '/mcp', '/help', '/permissions', '/memory', '/doctor', '/theme', '/vim', '/terminal-setup', '/rename', '/agents',
  '/hooks', '/ide', '/statusline', '/output-style', '/add-dir', '/plugin', '/rewind', '/export', '/release-notes', '/upgrade',
]);

/** Records that are skipped before parsing: full API requests (P0-05) and the credential_org attachment. */
const API_REQUEST = /^\s*\{\s*"type"\s*:\s*"api-request/;
const CREDENTIAL_ORG = /"attachment"\s*:\s*\{\s*"type"\s*:\s*"credential_org"/;

/** Should this raw line be dropped without parsing? */
export function skipRaw(raw: string): boolean {
  return API_REQUEST.test(raw) || CREDENTIAL_ORG.test(raw);
}

// ------------------------------------------------------------------ parser

class LineParser {
  readonly out: LineResult;

  constructor(
    private readonly s: TranscriptState,
    private readonly j: Record<string, unknown>,
    private readonly at: number,
  ) {
    this.out = { events: [], signals: [], changed: false, at };
  }

  private changed(): void {
    this.out.changed = true;
  }

  private taskOp(op: TaskOp): void {
    const s = this.s;
    if (op.op === 'replace') s.sawTaskReplace = true;
    s.tasks = applyTaskOp(s.tasks, op);
    s.taskOpsLog?.push(op);
    this.changed();
  }

  run(): void {
    const j = this.j;
    const branch = str(j.gitBranch);
    if (branch && branch !== 'HEAD' && branch !== this.s.gitBranch) {
      this.s.gitBranch = branch;
      this.changed();
    }
    switch (j.type) {
      case 'assistant':
        return this.assistant();
      case 'user':
        return this.user();
      case 'system':
        return this.system();
      case 'custom-title':
        return this.meta('customTitle', j.customTitle);
      case 'agent-name':
        return this.meta('agentName', j.agentName);
      case 'ai-title':
        return this.meta('aiTitle', j.aiTitle);
      case 'last-prompt': {
        const p = str(j.lastPrompt);
        if (p && !p.trimStart().startsWith('<')) this.meta('lastPrompt', truncate(maskSecrets(p.slice(0, 1_000)), 200));
        return;
      }
      case 'permission-mode':
        return this.meta('permissionMode', j.permissionMode);
      case 'mode':
        return this.meta('permissionMode', j.mode);
      case 'fork-context-ref':
        this.s.fork = 'expect-spawn';
        return;
      case 'queue-operation': {
        const content = str(j.content);
        if (j.operation === 'enqueue' && content?.trimStart().startsWith('<task-notification>')) this.notification(content);
        return;
      }
      case 'attachment': {
        const att = j.attachment as Record<string, unknown> | undefined;
        const prompt = str(att?.prompt);
        if (att?.type === 'queued_command' && prompt?.trimStart().startsWith('<task-notification>')) this.notification(prompt);
        return;
      }
      default:
        return;
    }
  }

  private meta(key: 'customTitle' | 'agentName' | 'aiTitle' | 'lastPrompt' | 'permissionMode', v: unknown): void {
    const value = str(v)?.trim();
    if (!value || this.s[key] === value) return;
    this.s[key] = value;
    this.changed();
  }

  private usage(msgId: string, u: unknown): void {
    if (!u || typeof u !== 'object') return;
    const r = u as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const now: TokenCount = { in: n(r.input_tokens) + n(r.cache_creation_input_tokens), cached: n(r.cache_read_input_tokens), out: n(r.output_tokens) };
    const s = this.s;
    if (s.skipUsage?.has(msgId)) return;
    if (s.firstMsgIds && s.firstMsgIds.size < FIRST_MSG_IDS && !s.usageByMsg.has(msgId)) s.firstMsgIds.add(msgId);
    // Lines of the same message repeat its usage (sometimes partial): count only the increase.
    const prev = s.usageByMsg.get(msgId) ?? { in: 0, out: 0, cached: 0 };
    const d = { in: Math.max(0, now.in - prev.in), out: Math.max(0, now.out - prev.out), cached: Math.max(0, now.cached - prev.cached) };
    remember(s.usageByMsg, msgId, { in: Math.max(now.in, prev.in), out: Math.max(now.out, prev.out), cached: Math.max(now.cached, prev.cached) }, 256);
    if (d.in || d.out || d.cached) {
      s.tokens.in += d.in;
      s.tokens.out += d.out;
      s.tokens.cached += d.cached;
      this.changed();
    }
  }

  private assistant(): void {
    const j = this.j;
    const m = j.message as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') return;
    const s = this.s;
    if (s.fork === 'expect-spawn') {
      // The copy of the call that created the fork (from the parent's transcript): not an activity, tool, token use
      // or subagent spawn of the fork itself.
      const spawn = Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>).find((b) => b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'))
        : undefined;
      const id = spawn ? str(spawn.id) : undefined;
      if (id) {
        s.fork = 'expect-result';
        s.inheritedSpawn = id;
        return;
      }
      delete s.fork;
    }
    const model = str(m.model);
    if (model && model !== '<synthetic>' && model !== s.model) {
      s.model = model;
      this.changed();
    }
    const msgId = str(m.id) ?? str(j.requestId) ?? str(j.uuid) ?? `x${++s.seq}`;
    this.usage(msgId, m.usage);
    s.ended = m.stop_reason === 'end_turn' && s.pendingTools.size === 0;
    const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
    blocks.forEach((b, i) => {
      if (b && typeof b === 'object' && b.type === 'tool_use') this.toolUse(b, `${msgId}:${i}`);
    });
  }

  private toolUse(b: Record<string, unknown>, fallbackId: string): void {
    const s = this.s;
    const name = str(b.name) ?? 'tool';
    const id = str(b.id) ?? fallbackId;
    const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
    s.ended = false;
    remember(s.toolNames, id, name);
    remember(s.pendingTools, id, name, 128);
    this.changed();
    const tool: EventTool = { id, name, input: slimInput(input) };
    if ((SHELL_TOOLS.has(name) && truthy(input.run_in_background)) || name === 'Monitor') tool.background = true;
    this.out.events.push({ type: 'tool.start', at: this.at, tool });

    switch (name) {
      case 'Agent':
      case 'Task':
      case 'Workflow': {
        const spawn: SpawnInfo = { toolUseId: id, tool: name, background: truthy(input.run_in_background), at: this.at };
        const description = str(input.description);
        const subagentType = str(input.subagent_type);
        const agentName = str(input.name);
        if (description) spawn.description = description;
        if (subagentType) spawn.subagentType = subagentType;
        if (agentName) spawn.name = agentName;
        this.out.signals.push({ type: 'spawn', spawn });
        break;
      }
      case 'TodoWrite':
        this.taskOp({ op: 'replace', tasks: todosToTasks(input.todos) });
        break;
      case 'TaskCreate': {
        const title = str(input.subject) ?? str(input.description);
        if (!title) break;
        const tid = `pending:${id}`;
        remember(s.pendingTaskCreates, id, tid, 64);
        const af = str(input.activeForm);
        this.taskOp(af ? { op: 'create', id: tid, title: truncate(title, 120), activeForm: truncate(af, 120) } : { op: 'create', id: tid, title: truncate(title, 120) });
        break;
      }
      case 'TaskUpdate': {
        const tid = str(input.taskId) ?? (typeof input.taskId === 'number' ? String(input.taskId) : undefined);
        if (!tid) break;
        const status = typeof input.status === 'string' && (TASK_STATUSES.has(input.status) || input.status === 'deleted') ? (input.status as TaskStatus | 'deleted') : undefined;
        const op: TaskOp = { op: 'update', id: tid };
        if (status) op.status = status;
        const title = str(input.subject);
        if (title) op.title = truncate(title, 120);
        const af = str(input.activeForm);
        if (af) op.activeForm = truncate(af, 120);
        this.taskOp(op);
        break;
      }
      case 'TaskStop':
      case 'KillShell':
      case 'KillBash': {
        const tid = str(input.task_id) ?? str(input.taskId) ?? str(input.shell_id) ?? str(input.bash_id) ?? str(input.id);
        if (tid) remember(s.stopRequests, id, tid, 64);
        break;
      }
      case 'Bash':
      case 'PowerShell':
      case 'Monitor': {
        const job = claudeJob(name, input);
        const shell: ShellStart = {
          toolUseId: id,
          label: job.label,
          background: name === 'Monitor' || truthy(input.run_in_background),
          kind: job.kind,
          at: this.at,
        };
        if (job.command) shell.command = job.command;
        if (name === 'Monitor' && typeof input.timeout_ms === 'number' && Number.isFinite(input.timeout_ms)) shell.timeoutMs = input.timeout_ms;
        this.out.signals.push({ type: 'shellStart', shell });
        break;
      }
      default:
        break;
    }
  }

  private user(): void {
    const j = this.j;
    if (j.isMeta === true || j.isCompactSummary === true) return;
    const m = j.message as Record<string, unknown> | undefined;
    const content = m?.content;
    if (typeof content === 'string') return this.userText(content);
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') results.push(b);
      else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    if (this.s.fork === 'expect-result' && results.some((r) => str(r.tool_use_id) === this.s.inheritedSpawn)) {
      // The inherited call's result ("Fork started…"): the end of nothing. The fork's directive comes in the text,
      // after the <fork-boilerplate> block: that's its "prompt".
      delete this.s.fork;
      const directive = forkDirective(texts.join('\n'));
      if (directive) this.userText(directive);
      return;
    }
    const interrupted = texts.some((t) => INTERRUPTED.test(t.trimStart()));
    for (const r of results) this.toolResult(r, interrupted);
    if (interrupted) this.interrupted();
    else if (!results.length && texts.length) this.userText(texts.join('\n'));
    // A tool that ends the turn (a subagent's SubagentHandback): nothing follows.
    if (j.toolEndsTurn === true && this.s.pendingTools.size === 0) this.s.ended = true;
  }

  private interrupted(): void {
    this.s.ended = true;
    this.s.pendingTools.clear();
    this.out.signals.push({ type: 'turnEnd' });
    this.out.events.push({ type: 'turn.end', at: this.at, interrupted: true });
  }

  private userText(raw: string): void {
    const text = raw.trimStart();
    if (!text) return;
    if (text.startsWith('<task-notification>')) return this.notification(text);
    if (INTERRUPTED.test(text)) return this.interrupted();
    if (SYSTEM_TAG.test(text) || text.startsWith('Caveat:')) return;
    let prompt = text;
    if (/^<command-(name|message|args)>/.test(text)) {
      const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
      if (!cmd || LOCAL_COMMANDS.has(cmd)) return;
      prompt = `${cmd} ${args}`.trim();
    }
    this.s.ended = false;
    const short = truncate(maskSecrets(prompt.slice(0, 1_000)), 200);
    this.meta('lastPrompt', short);
    this.out.events.push({ type: 'turn.start', at: this.at, prompt: short });
  }

  private notification(text: string): void {
    this.out.signals.push({ type: 'notification', ...parseTaskNotification(text) });
  }

  private toolResult(b: Record<string, unknown>, interrupted: boolean): void {
    const s = this.s;
    const id = str(b.tool_use_id);
    if (!id) return;
    const name = s.toolNames.get(id);
    s.pendingTools.delete(id);
    const isError = b.is_error === true;
    const tur = (this.j.toolUseResult && typeof this.j.toolUseResult === 'object' ? this.j.toolUseResult : {}) as Record<string, unknown>;
    const decision = (this.j.permissionDecision && typeof this.j.permissionDecision === 'object' ? this.j.permissionDecision : {}) as Record<string, unknown>;

    const tool: EventTool = { id, name: name ?? 'tool', ok: !isError && decision.decision !== 'reject' };
    if (!tool.ok) {
      const content = textOf(b.content);
      if (decision.decision === 'reject' || REJECTED.test(content)) tool.error = 'denied';
      else if (interrupted) tool.error = 'cancelled';
      else {
        const exit = name && SHELL_TOOLS.has(name) ? /exit code[:\s]+(-?\d+)/i.exec(content)?.[1] : undefined;
        tool.error = exit !== undefined ? `exit_${exit}` : 'error';
      }
    }
    this.out.events.push({ type: 'tool.end', at: this.at, tool });

    const isSpawn = name === 'Agent' || name === 'Task' || name === 'Workflow' || typeof tur.agentId === 'string' || typeof tur.runId === 'string';
    if (isSpawn) {
      const agentId = str(tur.agentId);
      const runId = str(tur.runId);
      if (tur.status === 'async_launched' || tur.isAsync === true) {
        const sig: TranscriptSignal = { type: 'launched', toolUseId: id };
        if (agentId) sig.agentId = agentId;
        if (runId) sig.runId = runId;
        const taskId = str(tur.taskId);
        if (taskId) sig.taskId = taskId;
        this.out.signals.push(sig);
      } else {
        const sig: TranscriptSignal = { type: 'finished', toolUseId: id, error: isError };
        if (agentId) sig.agentId = agentId;
        if (runId) sig.runId = runId;
        this.out.signals.push(sig);
      }
    }

    const provisional = s.pendingTaskCreates.get(id);
    if (provisional !== undefined) {
      s.pendingTaskCreates.delete(id);
      const task = tur.task && typeof tur.task === 'object' ? (tur.task as Record<string, unknown>) : undefined;
      const rawId = task?.id ?? tur.taskId ?? tur.id;
      const real = (typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : undefined) ?? /#(\w+)/.exec(textOf(b.content))?.[1];
      if (real && real !== provisional) this.taskOp({ op: 'rename', from: provisional, to: real });
    }

    const stopped = s.stopRequests.get(id);
    if (stopped !== undefined) {
      s.stopRequests.delete(id);
      if (!isError) this.out.signals.push({ type: 'stopped', taskId: stopped });
    }

    // Shells/Monitor: in the background the result carries the task id; in the foreground it's the command's end.
    const bgId = backgroundIdOf(tur, b.content, name);
    if ((name && (SHELL_TOOLS.has(name) || name === 'Monitor')) || (name === undefined && bgId)) {
      const sig: TranscriptSignal = { type: 'shellResult', toolUseId: id, error: isError };
      if (bgId && !isError) sig.taskId = bgId;
      this.out.signals.push(sig);
    }
  }

  private system(): void {
    switch (this.j.subtype) {
      case 'turn_duration':
        this.s.ended = true;
        this.out.signals.push({ type: 'turnEnd' });
        this.out.events.push({ type: 'turn.end', at: this.at });
        return;
      case 'compact_boundary':
        this.out.events.push({ type: 'compact', at: this.at });
        return;
      default:
        return;
    }
  }
}

/** A fork's directive: the text after the <fork-boilerplate> block, without the "Your directive:" label. */
export function forkDirective(text: string): string {
  const end = text.lastIndexOf('</fork-boilerplate>');
  const rest = end >= 0 ? text.slice(end + '</fork-boilerplate>'.length) : text;
  return rest.trim().replace(/^your directive:\s*/i, '').trim();
}

const EMPTY = (at: number): LineResult => ({ events: [], signals: [], changed: false, at });

/** Reads one JSONL line. Bad, unknown and skipped lines produce nothing. */
export function parseLine(state: TranscriptState, raw: string, now: number): LineResult {
  if (skipRaw(raw)) return EMPTY(now);
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return EMPTY(now);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return EMPTY(now);
  const rec = j as Record<string, unknown>;
  if (typeof rec.type === 'string' && rec.type.startsWith('api-request')) return EMPTY(now);
  const att = rec.attachment as { type?: unknown } | undefined;
  if (att && att.type === 'credential_org') return EMPTY(now);
  const at = toMs(rec.timestamp);
  if (at !== undefined) {
    if (state.firstAt === undefined || at < state.firstAt) state.firstAt = at;
    if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  }
  const p = new LineParser(state, rec, at ?? now);
  p.run();
  return p.out;
}

/** Title shown: custom-title > agent-name > ai-title > last prompt (cut). */
export function titleOf(state: TranscriptState): string | undefined {
  const t = state.customTitle ?? state.agentName ?? state.aiTitle ?? state.lastPrompt;
  return t ? truncate(t, 90) : undefined;
}

// ------------------------------------------------------------------ the file's start

// Lines that matter for titles/tasks/tokens before the window read at boot.
const PREFIX_MARKERS = [
  '"type":"assistant"',
  '"type":"custom-title"',
  '"type":"agent-name"',
  '"type":"ai-title"',
  '"type":"last-prompt"',
  '"type":"permission-mode"',
  // A fork's start: the copy of the parent's Agent call right after it isn't the fork's.
  '"type":"fork-context-ref"',
  // Background launches (to match an end notification with its subagent/workflow).
  '"async_launched"',
  // Background shells: launch and end (to know which are still running).
  '"backgroundTaskId"',
  '<task-notification>',
];

function prefixRelevant(state: TranscriptState, line: string): boolean {
  if (PREFIX_MARKERS.some((m) => line.includes(m))) return true;
  if ((state.pendingTaskCreates.size || state.stopRequests.size) && line.includes('"tool_result"')) {
    for (const id of state.pendingTaskCreates.keys()) if (line.includes(id)) return true;
    for (const id of state.stopRequests.keys()) if (line.includes(id)) return true;
  }
  return false;
}

/** A shell signal with the time of the line that produced it. */
export interface ShellEvent {
  signal: TranscriptSignal;
  at: number;
}

/**
 * Streams (without blocking the event loop) bytes [0, end) of a transcript, only to recover titles, tasks and tokens
 * from before the window read at boot, the background launches ('launched', which match future notifications with
 * subagents), and the shell signals (`shellEvents`), to find background shells still open.
 */
export async function scanPrefix(
  path: string,
  end: number,
  skipUsage: ReadonlySet<string>,
): Promise<{ state: TranscriptState; signals: TranscriptSignal[]; shellEvents: ShellEvent[] }> {
  const state = createTranscriptState();
  const signals: TranscriptSignal[] = [];
  const shellEvents: ShellEvent[] = [];
  state.skipUsage = skipUsage;
  if (end <= 0) return { state, signals, shellEvents };
  const now = Date.now();
  const take = (line: string) => {
    if (!prefixRelevant(state, line)) return;
    const r = parseLine(state, line, now);
    for (const sig of r.signals) {
      if (sig.type === 'launched') signals.push(sig);
      if (SHELL_SIGNALS.has(sig.type)) shellEvents.push({ signal: sig, at: r.at });
    }
  };
  const pending = new LineBuffer();
  let discarded = 0;
  const stream = createReadStream(path, { start: 0, end: end - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const fed = pending.push(chunk);
    discarded += fed.discarded;
    for (const buf of fed.lines) {
      const line = buf.toString('utf8');
      if (line) take(line);
    }
  }
  const rest = pending.flush();
  if (rest?.length) {
    const line = rest.toString('utf8');
    if (line) take(line);
  }
  if (discarded) warnOversizedLine(path);
  delete state.skipUsage;
  return { state, signals, shellEvents };
}

/** Merges what came from the file's start into the state built from the end window. */
export function mergePrefix(state: TranscriptState, prefix: TranscriptState): void {
  state.customTitle ??= prefix.customTitle;
  state.agentName ??= prefix.agentName;
  state.aiTitle ??= prefix.aiTitle;
  state.lastPrompt ??= prefix.lastPrompt;
  state.model ??= prefix.model;
  state.gitBranch ??= prefix.gitBranch;
  state.permissionMode ??= prefix.permissionMode;
  if (prefix.firstAt !== undefined && (state.firstAt === undefined || prefix.firstAt < state.firstAt)) state.firstAt = prefix.firstAt;
  if (!state.sawTaskReplace && state.taskOpsLog) state.tasks = state.taskOpsLog.reduce(applyTaskOp, prefix.tasks);
  state.taskOpsLog = null;
  state.tokens.in += prefix.tokens.in;
  state.tokens.out += prefix.tokens.out;
  state.tokens.cached += prefix.tokens.cached;
  state.firstMsgIds = null;
}
