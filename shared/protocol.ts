// Ported from habblaud shared/types.ts (MIT, © 2026 Márcio Junior)
// Re-shaped for Agent Office: provider-neutral (`provider` is required everywhere), English, plus the ingest
// protocol (`AgentEvent`, ADR 0002). Pure code: no Node or DOM APIs.
//
// Evolution rule: changes here are ADDITIVE (new optional fields, new union members). Renaming or removing a field
// breaks the server, the client and every adapter at once.

// ------------------------------------------------------------------ providers

/** Built-in providers, plus `custom:<slug>` for anything that reports through the SDK. */
export type BuiltinProviderId = 'claude-code' | 'gemini-cli' | 'codex';
export type ProviderId = BuiltinProviderId | `custom:${string}`;

export const BUILTIN_PROVIDERS: readonly BuiltinProviderId[] = ['claude-code', 'gemini-cli', 'codex'];

/** What the office can do with agents of a provider (the UI turns features on per provider). */
export interface ProviderCapabilities {
  /** A conversation transcript can be shown (read-only). */
  transcript: boolean;
  /** Permission requests can be approved from the office. */
  approve: boolean;
  /** Messages can be sent into a session. */
  message: boolean;
  /** Plan usage (rate limits) is known. */
  usage: boolean;
  /** Subagents are reported. */
  subagents: boolean;
}

export interface ProviderMeta {
  id: ProviderId;
  /** Human label, e.g. "Gemini CLI". */
  label: string;
  /** Badge color (hex). */
  color: string;
  capabilities: ProviderCapabilities;
}

// ------------------------------------------------------------------ ingest: AgentEvent (ADR 0002)

export const EVENT_TYPES = [
  'session.start',
  'session.end',
  'turn.start',
  'turn.end',
  'tool.start',
  'tool.end',
  'waiting',
  'subagent.start',
  'subagent.end',
  'job.start',
  'job.end',
  'tasks',
  'usage',
  'compact',
  'heartbeat',
] as const;
export type AgentEventType = (typeof EVENT_TYPES)[number];

export const WAITING_REASONS = ['permission', 'question', 'input'] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface EventTool {
  /** Provider tool-call id, when the source has one (Gemini hooks don't: tools pair by name, in order). */
  id?: string;
  /** Native tool name ("Bash", "run_shell_command", "mcp__github__create_issue"). */
  name: string;
  /** Native tool input; masked and truncated on ingest. */
  input?: unknown;
  /** tool.end: false when the tool failed, was denied or was cancelled. */
  ok?: boolean;
  /** tool.end with ok=false: a short error kind ("denied", "cancelled", "file_not_found", "exit_3"). Never output. */
  error?: string;
  /** The call started a background job (see job.*). */
  background?: boolean;
}

export interface EventJob {
  /** Stable id of the background job (Claude backgroundTaskId, Gemini PID, ...). */
  id: string;
  /** Short label (the command's description or a summary), masked on ingest. */
  label?: string;
  /** The full command, masked and truncated on ingest. */
  command?: string;
  /** job.end: false when the job failed or was killed. */
  ok?: boolean;
}

export interface EventSubagent {
  /** Subagent type ("Explore", "generalist", "fork", ...). */
  role?: string;
  /** What it was asked to do (short). */
  title?: string;
  /** Runs in the background (the parent keeps working). */
  background?: boolean;
  /** subagent.end: false when it failed. */
  ok?: boolean;
}

export interface EventTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** Present-progressive form ("Writing tests"), when the source has one. */
  activeForm?: string;
}

export interface AgentEvent {
  v: 1;
  provider: ProviderId;
  /** Account slug: 'default', or 8 hex chars of SHA-256 of the config-dir path. Never a path. */
  account: string;
  /** Provider session id. Main agent id = `${provider}:${account}:${session}`. */
  session: string;
  /** Subagent id inside the session; absent = the main agent. */
  agent?: string;
  /** For subagents started by another subagent: its id inside the session. Absent = the main agent. */
  parentAgent?: string;
  /** Project directory → room. */
  cwd?: string;
  /** Epoch ms at the source. */
  at: number;
  /** PID of the agent process (resolved through shell wrappers), for liveness checks. */
  pid?: number;
  /** Process start time as reported by the source (e.g. Claude's `procStart`), to detect PID reuse. */
  procStart?: string;
  type: AgentEventType;
  tool?: EventTool;
  waiting?: { reason: WaitingReason; text?: string };
  job?: EventJob;
  subagent?: EventSubagent;
  /** session.start: the session id this one replaces in the same process (`/clear`). */
  continues?: string;
  /** turn.start: the user's prompt (masked and truncated before it is broadcast). */
  prompt?: string;
  /** Session title (main) or task description (subagent), when the source knows it. */
  title?: string;
  model?: string;
  tokens?: { in?: number; out?: number; cached?: number };
  tasks?: EventTask[];
  gitBranch?: string;
}

/** Id of the agent an event belongs to. */
export function agentIdOf(e: Pick<AgentEvent, 'provider' | 'account' | 'session' | 'agent'>): string {
  const main = `${e.provider}:${e.account}:${e.session}`;
  return e.agent ? `${main}:${e.agent}` : main;
}

/** Id of the main agent of an event's session. */
export function mainIdOf(e: Pick<AgentEvent, 'provider' | 'account' | 'session'>): string {
  return `${e.provider}:${e.account}:${e.session}`;
}

// ------------------------------------------------------------------ broadcast: OfficeSnapshot

export type AgentKind = 'main' | 'sub';

/**
 * High-level state of an agent. It drives the character's behavior, the same way for every provider.
 * - working: processing a turn. Sits at the desk typing.
 * - waiting: needs the user (permission, question, input). Sits with a raised hand.
 * - idle: finished the turn and waits for the next instruction. Wanders (coffee, water cooler, ...).
 * - shell: finished the turn but background jobs are still running (see `jobs`). Watches the terminal.
 * - done: a subagent finished. Walks its result to the parent, then leaves.
 * - offline: the session ended (or its process died). Leaves; the last one out turns off the lights.
 */
export const AGENT_STATUSES = ['working', 'waiting', 'idle', 'shell', 'done', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** A background (or still-running foreground) command the agent is waiting for. */
export interface ShellJob {
  id: string;
  /** Short label: the command's description or a summary (masked). */
  label: string;
  /** The full command (masked, up to ~300 characters), when known. */
  command?: string;
  /** Epoch ms when it started. */
  startedAt: number;
  /** true = background job (the turn ended while it runs); false = a foreground command without a result yet. */
  background: boolean;
  /** 'monitor' = a process monitor; 'shell' = a shell command. */
  kind: 'shell' | 'monitor';
}

export const ACTIVITY_KINDS = [
  'prompt', // got a new instruction from the user
  'think', // thinking
  'respond', // writing a text reply
  'read',
  'search',
  'edit',
  'write',
  'run', // a terminal command
  'test',
  'git',
  'web',
  'browser',
  'plan', // tasks / planning
  'delegate', // started subagent(s)
  'communicate', // message to another agent
  'ask', // question to the user
  'mcp',
  'skill',
  'wait',
  'error',
  'compact', // context compaction
  'done', // finished the turn
  'other',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Activity {
  /** Unique per activity. */
  id: string;
  kind: ActivityKind;
  /** Emoji for the activity. */
  icon: string;
  /** Short text (up to ~46 characters), e.g. "Editing App.tsx". */
  text: string;
  /** Optional detail (full command, path, query, ...), up to ~300 characters. */
  detail?: string;
  /** Raw tool name, when there is one. */
  tool?: string;
  /** Epoch ms. */
  at: number;
  durationMs?: number;
  error?: boolean;
  /** Full questions of an ask-the-user tool (kind 'ask'), so the office can show the options. */
  questions?: AskQuestion[];
}

/** One question of an ask-the-user tool, masked and truncated. */
export interface AskQuestion {
  /** Position in the tool input (invalid entries are skipped, so there may be gaps). */
  index: number;
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** `index` = position of the option in the original input. */
  options: Array<{ index: number; label: string; description?: string }>;
}

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  activeForm?: string;
}

export interface AgentStats {
  toolCalls: number;
  /** Input tokens, including cached ones. */
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** Subagents started by this agent. */
  subagents: number;
}

export interface AgentInfo {
  /** Stable while the agent exists: `agentIdOf(event)`. */
  id: string;
  kind: AgentKind;
  provider: ProviderId;
  /** Subagents: the id of the agent that started it. */
  parentId?: string;
  roomId: string;
  /** Unique human name in the office, e.g. "Marina". */
  name: string;
  /** Name presentation hint (art may use it to vary the look). */
  look: 'f' | 'm';
  /** Role. Main: "Main agent". Sub: the subagent type ("Explore", "generalist", ...). */
  role: string;
  /** Session title (main) or task description (sub). */
  title?: string;
  sessionId: string;
  /** Account slug (= AccountInfo.id). */
  account: string;
  status: AgentStatus;
  /** Why, when status === 'waiting', e.g. "approve a permission". */
  waitingFor?: string;
  /** Current (or latest) activity. */
  activity?: Activity;
  /** Latest activities, oldest first (up to 8 in the snapshot). */
  recent: Activity[];
  tasks: TaskItem[];
  /** Jobs the agent is waiting for. */
  jobs?: ShellJob[];
  model?: string;
  gitBranch?: string;
  startedAt: number;
  lastEventAt: number;
  /** When the status last changed (epoch ms). */
  statusSince: number;
  stats: AgentStats;
  /** 32-bit seed for the character's deterministic appearance. */
  seed: number;
  /** Subagent running in the background. */
  background?: boolean;
}

/**
 * A temporary effect in a project room (e.g. a CI or PR event seen in a transcript):
 * - party: celebration, ~12 s;
 * - alarm: something failed; lasts until resolved or ~10 min.
 */
export interface RoomEffect {
  kind: 'party' | 'alarm';
  /** Short banner text. */
  text: string;
  /** Start (epoch ms, server clock). A new effect has a new `at`. */
  at: number;
  /** Expected end (epoch ms, server clock). */
  until: number;
  agentId?: string;
}

export interface RoomInfo {
  /** Stable key: the normalized project path. */
  id: string;
  /** Display name (the folder name, disambiguated when repeated, or an alias). */
  name: string;
  /** Full project path. */
  path: string;
  /**
   * Arrival order, assigned by the server and stable while the room exists (a freed slot is reused only after a
   * cooldown). The client uses it only as an order for placing rooms.
   */
  slot: number;
  /** Seed for deterministic colors and decoration. */
  seed: number;
  createdAt: number;
  effect?: RoomEffect;
}

/** One data source of an adapter (a config dir, a hook endpoint, ...), for the health view. */
export interface SourceInfo {
  provider: ProviderId;
  label: string;
  /** Path or endpoint (shown to the local user only). */
  path: string;
  /** Open sessions seen in this source. */
  sessions: number;
  ok: boolean;
  error?: string;
}

/** A plan usage window (e.g. a 5-hour session, a week). */
export interface UsageWindow {
  /** Percent used, 0–100. */
  utilization: number;
  /** When the window resets (epoch ms). */
  resetsAt?: number;
}

export interface AccountUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Where the numbers come from (always local files written by the tool itself). */
  source: string;
  /** No quota or credits right now (not the same as 0% used). */
  noQuota?: boolean;
  /** When the numbers were obtained at the source (epoch ms). */
  fetchedAt: number;
}

/** One account of a provider (a config dir, a CLI home). */
export interface AccountInfo {
  /** Account slug (= AgentInfo.account); unique together with the provider. */
  id: string;
  provider: ProviderId;
  /** Very short label (1–3 characters). */
  short: string;
  /** Friendly name. */
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  /** Account color (hex). */
  color: string;
  /** Open sessions in this account now. */
  sessions: number;
  usage?: AccountUsage;
  usageStatus: 'ok' | 'stale' | 'disabled';
}

export interface OfficeSnapshot {
  /** Increments on every change. */
  rev: number;
  serverTime: number;
  rooms: RoomInfo[];
  agents: AgentInfo[];
  accounts: AccountInfo[];
  meta: {
    demo: boolean;
    sources: SourceInfo[];
    providers: ProviderMeta[];
    startedAt: number;
    version: string;
    /** Build id of the client the server serves; a page with another build reloads. Absent in dev. */
    build?: string;
  };
}

export interface FeedItem {
  id: string;
  agentId: string;
  roomId: string;
  agentName: string;
  roomName: string;
  provider: ProviderId;
  account?: string;
  activity: Activity;
}

export type NoticeLevel = 'info' | 'success' | 'warn' | 'alert';

export interface Notice {
  id: string;
  level: NoticeLevel;
  text: string;
  agentId?: string;
  roomId?: string;
  at: number;
}

/**
 * Server messages over SSE at GET /api/stream. Each arrives as a named SSE event (`event: snapshot|feed|notice`)
 * whose `data` is the JSON of `data`. On connect the server sends a full `snapshot` and a `feed` of recent items.
 */
export type ServerMessage =
  | { type: 'snapshot'; data: OfficeSnapshot }
  | { type: 'feed'; data: FeedItem[] }
  | { type: 'notice'; data: Notice };

/** Response of GET /api/agents/:id. */
export interface AgentDetail {
  agent: AgentInfo;
  /** Longer history (up to 200), oldest first. */
  history: Activity[];
}
