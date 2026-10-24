// Ported from habblaud server/sources/watcher.ts (MIT, © 2026 Márcio Junior)
// Claude Code adapter. Watches the OPEN Claude Code sessions of every account and turns them into AgentEvents:
// the session registry (status, authoritative), the session transcript (prompts, tools, tasks, tokens, title) and the
// subagents (files in <session>/subagents/, workflows included).
//
// Habblaud's watcher drives its office directly; this one only emits events, and keeps just enough of what it sent
// (status, jobs, tokens, tasks, title) to emit differences.
//
// Performance: the ~1 s poll touches only the session registries, the open sessions' transcripts and those
// sessions' subagents/ folders (never the archive of old transcripts). fs.watch is only an accelerator.
import type { ProviderAccount } from '../../accounts/service';
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { JobOutcome } from '../../../shared/activity';
import { t as tr } from '../../../shared/i18n';
import type { AgentEvent, AgentEventType, AgentInfo, EventTask, ProviderCapabilities, SourceInfo } from '../../../shared/protocol';
import { describeClaudeTool } from '../../../shared/tools/claude-code';
import { errMsg, log } from '../../log';
import { discoverClaudeAccounts, type ClaudeAccount } from '../accounts';
import { pidAlive, type AdapterContext, type ProviderAdapter, type SessionFile } from '../adapter';
import { cwdFromHead, dirsIn, filesIn, folderName, readHeadLines, stem } from '../../conversation/files';
import { parseClaudeConversation } from './conversation';
import type { LivenessTarget } from '../../../shared/model/office';
import { FileTail } from '../tail';
import { compareVersions, ProcStartChecker, registryStatus, RegistryReader, SHELL_STATUS_VERSION, type RegistryEntry, type RegistryStatus } from './registry';
import { SHELL_FALLBACK_MAX_AGE_MS, ShellTracker } from './shells';
import {
  BOOT_RECENT_MS,
  concludedByIdle,
  listSubagentFiles,
  parseJournal,
  PENDING_TOOL_TIMEOUT_MS,
  readSubagentMeta,
  sessionDirOf,
  subagentRole,
  type JournalAgent,
  type SubagentFile,
  type SubagentMeta,
} from './subagents';
import {
  createTranscriptState,
  mergePrefix,
  parseLine,
  scanPrefix,
  titleOf,
  type LineResult,
  type ShellEvent,
  type SpawnInfo,
  type TokenCount,
  type TranscriptSignal,
  type TranscriptState,
} from './transcript';

export interface ClaudeAdapterOptions {
  /** Accounts to watch (default: discovered from $HOME and CLAUDE_CONFIG_DIR, re-checked every minute). */
  accounts?: () => ClaudeAccount[];
  /** In Docker the registry's PIDs are the host's: they can't be probed. */
  inDocker?: boolean;
  now?: () => number;
  pollMs?: number;
  /** How much of each transcript's end is read when a session opens (default 1 MB). */
  tailBytes?: number;
  /** Is a registry entry's process alive? (default: PID probe + procStart check on Windows) */
  isAlive?: (e: RegistryEntry) => boolean;
  /** Turns fs.watch off (tests). */
  watch?: boolean;
}

/** Owner key of the main agent in the shell tracker (subagents use their agent id). */
const MAIN = '';
const MAX_SET = 2_000;
/** How long a session must be missing from the registry to count as ended. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/**
 * Registry "idle" (from a version that writes "shell") for this long = no background shell running; the slack
 * covers an end notification still on its way to the transcript.
 */
const IDLE_CLEARS_SHELLS_MS = 30_000;
/** A finished subagent is forgotten (its file counts as seen) after the office's grace period. */
const SUB_FORGET_MS = 30_000;
/** Accounts are looked up again this often (a new CLAUDE_CONFIG_DIR folder appears). */
const ACCOUNTS_REFRESH_MS = 60_000;
/** Id of the job that stands in for background shells the registry reports but the transcript doesn't show. */
const REGISTRY_SHELL_JOB = 'registry-shell';

/** cwd -> folder name in projects/ (every non-alphanumeric character becomes "-"). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** No status in the registry (old versions): guess from the transcript. */
function statusFromTranscript(state: TranscriptState, now: number): RegistryStatus {
  if (state.ended) return 'idle';
  return state.lastAt !== undefined && now - state.lastAt < 90_000 ? 'working' : 'idle';
}

function addBounded(set: Set<string>, v: string): void {
  set.add(v);
  if (set.size > MAX_SET) set.delete(set.values().next().value as string);
}

/** What was last sent for an agent, so only differences go out. */
interface Emitted {
  tokens: TokenCount;
  tasks: string;
  title?: string;
}

interface SubTracker {
  agentId: string;
  file: SubagentFile;
  meta?: SubagentMeta;
  tail: FileTail;
  state: TranscriptState;
  emitted: Emitted;
  done: boolean;
  doneAt?: number;
}

interface SessionTracker {
  key: string;
  account: string;
  dir: string;
  entry: RegistryEntry;
  sessionId: string;
  transcriptPath?: string;
  nextResolveAt: number;
  tail?: FileTail;
  state: TranscriptState;
  customTitleFile?: string;
  subs: Map<string, SubTracker>;
  /** Subagent files already seen and out of the office: known size. */
  known: Map<string, number>;
  spawns: Map<string, SpawnInfo & { owner: string }>;
  launched: Map<string, { agentId?: string; runId?: string }>;
  taskToTool: Map<string, string>;
  runToTool: Map<string, string>;
  finishedTools: Set<string>;
  finishedAgents: Set<string>;
  finishedRuns: Set<string>;
  failedTools: Set<string>;
  journals: Map<string, { size: number; agents: Map<string, JournalAgent> }>;
  /** Shells (Bash/PowerShell/Monitor) that the main agent and the subagents of this session are waiting for. */
  shells: ShellTracker;
  /** Background jobs announced with job.start: tool_use id -> owner. */
  jobs: Map<string, string>;
  /** How finished jobs ended, until their job.end goes out. */
  outcomes: Map<string, JobOutcome>;
  /** A stand-in job for a registry "shell" status without known shells is open. */
  registryShell: boolean;
  /** The status the office has for the main agent, as far as this adapter's events go. */
  status: RegistryStatus;
  waitingText?: string;
  emitted: Emitted;
  lastSubScanAt: number;
  scanned: boolean;
  watchers: FSWatcher[];
  watchingSubs: boolean;
  missingSince?: number;
  /** Since when the registry (of a version that writes "shell") says "idle". */
  idleSince?: number;
}

const emptyEmitted = (): Emitted => ({ tokens: { in: 0, out: 0, cached: 0 }, tasks: '[]' });

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = 'claude-code' as const;
  readonly label = 'Claude Code';
  readonly color = '#d97757';
  readonly capabilities: ProviderCapabilities = { transcript: true, approve: true, message: true, usage: false, subagents: true };

  private ctx: AdapterContext | null = null;
  private accountList: ClaudeAccount[] = [];
  private accountsAt = -Infinity;
  private readers = new Map<string, RegistryReader>();
  private sessions = new Map<string, SessionTracker>();
  private sourceInfo = new Map<string, SourceInfo>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private readonly isAlive: (e: RegistryEntry) => boolean;
  private stopped = false;
  /** Lowest Claude Code version seen writing "shell" to the registry (starts at the known one). */
  private shellStatusVersion = SHELL_STATUS_VERSION;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
    if (opts.isAlive) this.isAlive = opts.isAlive;
    else {
      const procStart = new ProcStartChecker();
      this.isAlive = (e) => pidAlive(e.pid) && procStart.matches(e.pid, e.procStart);
    }
  }

  describeTool = describeClaudeTool;
  parseConversation = parseClaudeConversation;

  /** The transcript of a main agent or of a subagent (subagents/agent-<id>.jsonl). */
  transcriptOf(agent: AgentInfo): string | undefined {
    for (const t of this.sessions.values()) {
      if (t.sessionId !== agent.sessionId || t.account !== agent.account) continue;
      if (agent.kind === 'main') return t.transcriptPath;
      return t.subs.get(agent.id.slice(`${this.id}:${t.account}:${t.sessionId}:`.length))?.file.path;
    }
    return undefined;
  }

  /** The newest transcripts of every account: <config>/projects/<encoded cwd>/<sessionId>.jsonl. */
  recentSessions(limit: number): SessionFile[] {
    const found: { account: string; file: string; mtime: number }[] = [];
    for (const a of this.currentAccounts()) {
      const projects = join(a.dir, 'projects');
      for (const d of dirsIn(projects)) for (const f of filesIn(join(projects, d), /^[\w-]+\.jsonl$/)) found.push({ account: a.slug, ...f });
    }
    found.sort((x, y) => y.mtime - x.mtime);
    return found.slice(0, limit).map((f) => {
      const project = folderName(cwdFromHead(readHeadLines(f.file)));
      return { provider: this.id, account: f.account, sessionId: stem(f.file), file: f.file, lastAt: f.mtime, ...(project ? { project } : {}) };
    });
  }

  /** Boot (synchronous, between beginBoot/endBoot) + periodic polling. */
  start(ctx: AdapterContext): void {
    this.ctx = ctx;
    ctx.beginBoot();
    try {
      this.poll(true);
    } finally {
      ctx.endBoot();
    }
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const t of this.sessions.values()) this.closeWatchers(t);
  }

  sources(): SourceInfo[] {
    return this.accountList.map((a) => this.sourceInfo.get(a.dir) ?? { provider: this.id, label: a.slug, path: a.dir, sessions: 0, ok: true });
  }

  /** Watched config folders (usage comes from the statusline tap, read by the accounts service). */
  accounts(): ProviderAccount[] {
    return this.accountList.map((a) => ({ id: a.slug, dir: a.dir }));
  }

  /** A session still in the registry is alive (its PID and process start were checked there). */
  alive(target: LivenessTarget): boolean | undefined {
    for (const t of this.sessions.values()) if (target.id === `${this.id}:${t.account}:${t.sessionId}`) return true;
    return undefined;
  }

  /** Waits for pending reads of transcripts' starts (tests). */
  idle(): Promise<void> {
    return this.prefixChain;
  }

  // ---------------------------------------------------------------- events

  private send(t: SessionTracker, agent: string | undefined, type: AgentEventType, at: number, extra: Partial<AgentEvent> = {}): void {
    const state = agent ? t.subs.get(agent)?.state : t.state;
    const e: AgentEvent = { v: 1, provider: this.id, account: t.account, session: t.sessionId, cwd: t.entry.cwd, at, pid: t.entry.pid, type, ...extra };
    if (agent) e.agent = agent;
    if (t.entry.procStart) e.procStart = t.entry.procStart;
    if (state?.model && e.model === undefined) e.model = state.model;
    if (state?.gitBranch && e.gitBranch === undefined) e.gitBranch = state.gitBranch;
    this.ctx?.emit(e);
  }

  /** Emits what a parsed line says happened, and resolves its signals. */
  private applyResult(t: SessionTracker, owner: string, r: LineResult): void {
    const agent = owner === MAIN ? undefined : owner;
    for (const ev of r.events) {
      switch (ev.type) {
        case 'turn.start':
          this.send(t, agent, 'turn.start', ev.at, { prompt: ev.prompt });
          if (!agent) t.status = 'working';
          break;
        case 'turn.end':
          // The registry is the authority on the main agent's status; old versions without one rely on this.
          // Subagents end with subagent.end, never turn.end.
          if (!agent && t.entry.status === undefined) {
            this.send(t, undefined, 'turn.end', ev.at);
            t.status = 'idle';
          }
          break;
        case 'tool.start':
          this.send(t, agent, 'tool.start', ev.at, { tool: ev.tool });
          if (!agent) t.status = 'working';
          break;
        case 'tool.end':
          this.send(t, agent, 'tool.end', ev.at, { tool: ev.tool });
          if (!agent && t.status === 'waiting') t.status = 'working';
          break;
        case 'compact':
          this.send(t, agent, 'compact', ev.at);
          break;
      }
    }
    for (const sig of r.signals) this.applySignal(t, owner, sig, r.at);
  }

  /** Tokens, tasks and title that changed since they were last sent. */
  private syncSummary(t: SessionTracker, agent: string | undefined, state: TranscriptState, emitted: Emitted): void {
    const at = state.lastAt ?? this.now();
    const d = { in: state.tokens.in - emitted.tokens.in, out: state.tokens.out - emitted.tokens.out, cached: state.tokens.cached - emitted.tokens.cached };
    if (d.in > 0 || d.out > 0 || d.cached > 0) {
      this.send(t, agent, 'usage', at, { tokens: { in: Math.max(0, d.in), out: Math.max(0, d.out), cached: Math.max(0, d.cached) } });
    }
    emitted.tokens = { ...state.tokens };
    const tasks = JSON.stringify(state.tasks);
    if (tasks !== emitted.tasks) {
      emitted.tasks = tasks;
      this.send(t, agent, 'tasks', at, { tasks: state.tasks.map((x): EventTask => ({ ...x })) });
    }
    if (!agent) {
      const title = titleOf(state);
      if (title && title !== emitted.title) {
        emitted.title = title;
        this.send(t, undefined, 'heartbeat', at, { title });
      }
    }
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`claude-poll:${errMsg(err)}`, `Claude Code: a polling round failed (${errMsg(err)}).`);
    }
  }

  /** Accelerator: an fs.watch event brings the next round forward. */
  private schedule(): void {
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  private currentAccounts(): ClaudeAccount[] {
    const now = this.now();
    if (now - this.accountsAt >= ACCOUNTS_REFRESH_MS) {
      this.accountsAt = now;
      try {
        this.accountList = (this.opts.accounts ?? discoverClaudeAccounts)();
      } catch (err) {
        log.warnOnce(`claude-accounts:${errMsg(err)}`, `Claude Code: could not list accounts (${errMsg(err)}).`);
      }
    }
    return this.accountList;
  }

  poll(boot = false): void {
    this.lastPollAt = this.now();
    const seen = new Set<string>();
    for (const acc of this.currentAccounts()) {
      let reader = this.readers.get(acc.dir);
      if (!reader) {
        reader = new RegistryReader(acc.dir, { checkPid: !this.opts.inDocker, isAlive: this.isAlive });
        this.readers.set(acc.dir, reader);
        this.watchDir(join(acc.dir, 'sessions'));
      }
      const res = reader.poll();
      const info: SourceInfo = { provider: this.id, label: acc.slug, path: acc.dir, sessions: res.entries.length, ok: res.ok };
      if (res.error) info.error = res.error;
      this.sourceInfo.set(acc.dir, info);
      for (const entry of res.entries) {
        const key = `${acc.slug}:${entry.pid}`;
        seen.add(key);
        try {
          this.syncSession(key, acc, entry, boot);
        } catch (err) {
          log.warnOnce(`claude-session:${key}:${errMsg(err)}`, `Claude Code session ${key}: ${errMsg(err)}`);
        }
      }
    }
    const now = this.now();
    for (const [key, t] of [...this.sessions]) {
      if (seen.has(key)) {
        delete t.missingSince;
        continue;
      }
      // Gone from the registry for a moment (file being rewritten)? Close only if it stays gone.
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.closeWatchers(t);
      this.sessions.delete(key);
      this.send(t, undefined, 'session.end', now);
    }
  }

  private syncSession(key: string, acc: ClaudeAccount, entry: RegistryEntry, boot: boolean): void {
    let t = this.sessions.get(key);
    if (!t) {
      t = this.newTracker(key, acc, entry);
      this.sessions.set(key, t);
      this.send(t, undefined, 'session.start', entry.startedAt ?? this.now());
    } else if (t.sessionId !== entry.sessionId) {
      // /clear or /resume in the same process: same character, new transcript.
      const now = this.now();
      for (const sub of t.subs.values()) if (!sub.done) this.send(t, sub.agentId, 'subagent.end', now);
      for (const [id, owner] of t.jobs) this.send(t, owner === MAIN || !t.subs.has(owner) ? undefined : owner, 'job.end', now, { job: { id } });
      this.closeWatchers(t);
      const fresh = this.newTracker(key, acc, entry);
      fresh.status = t.status;
      if (t.waitingText !== undefined) fresh.waitingText = t.waitingText;
      this.sessions.set(key, fresh);
      this.send(fresh, undefined, 'session.start', now, { continues: t.sessionId });
      t = fresh;
    }
    t.entry = entry;
    this.pumpMain(t);
    this.scanSubagents(t, boot);
    this.pumpSubs(t);
    const now = this.now();
    const st = registryStatus(entry);
    // Shells die with the process: what started before it (a resumed session) isn't running.
    t.shells.prune(now, entry.startedAt);
    t.shells.holdForeground(st.status === 'waiting', now);
    let status = st.status ?? statusFromTranscript(t.state, now);
    if (entry.status === 'idle' && this.writesShellStatus(entry)) {
      // This version writes "shell": "idle" guarantees no background shell (what's left missed its end).
      t.idleSince ??= now;
      if (now - t.idleSince >= IDLE_CLEARS_SHELLS_MS) t.shells.dropBackgroundShells(now);
    } else {
      delete t.idleSince;
      // Old CLIs don't write "shell": idle with a background shell and no notification = waiting for the shell.
      if (status === 'idle' && t.shells.hasBackgroundShell(now, SHELL_FALLBACK_MAX_AGE_MS)) status = 'shell';
    }
    this.publishShells(t, status);
    this.applyStatus(t, status, st.waiting);
  }

  /** Does this session's version write "shell" to the registry? (learns from the sessions that already did) */
  private writesShellStatus(entry: RegistryEntry): boolean {
    if (!entry.version) return false;
    if (entry.status === 'shell' && compareVersions(entry.version, this.shellStatusVersion) < 0) this.shellStatusVersion = entry.version;
    return compareVersions(entry.version, this.shellStatusVersion) >= 0;
  }

  private applyStatus(t: SessionTracker, status: RegistryStatus, waiting?: { reason: 'permission' | 'question' | 'input'; text: string }): void {
    if (status === t.status && (status !== 'waiting' || waiting?.text === t.waitingText)) return;
    const now = this.now();
    switch (status) {
      case 'working':
        this.send(t, undefined, 'turn.start', now);
        break;
      case 'idle':
      case 'shell':
        // The office picks 'shell' itself while background jobs are open.
        this.send(t, undefined, 'turn.end', now);
        break;
      case 'waiting':
        this.send(t, undefined, 'waiting', now, waiting ? { waiting } : {});
        break;
    }
    t.status = status;
    if (status === 'waiting' && waiting) t.waitingText = waiting.text;
    else delete t.waitingText;
  }

  /**
   * Announces the session's background shells as jobs (job.start / job.end on changes). A background shell of a
   * subagent that already left keeps running: it moves to the main agent (whose registry counts those shells too).
   * Monitors aren't jobs. A registry "shell" without any known shell gets a stand-in job.
   */
  private publishShells(t: SessionTracker, status: RegistryStatus): void {
    const desired = new Map<string, { owner: string; label: string; command?: string; startedAt: number }>();
    for (const job of t.shells.list()) {
      if (!job.background || job.kind !== 'shell') continue;
      let owner = job.owner;
      if (owner !== MAIN) {
        const sub = t.subs.get(owner);
        if (!sub || sub.done) owner = MAIN;
      }
      const d: { owner: string; label: string; command?: string; startedAt: number } = { owner, label: job.label, startedAt: job.startedAt };
      if (job.command) d.command = job.command;
      desired.set(job.toolUseId, d);
    }
    const now = this.now();
    // Ended (or moved) jobs first.
    for (const [id, owner] of [...t.jobs]) {
      const want = desired.get(id);
      if (want && want.owner === owner) continue;
      if (!want) {
        const outcome = t.outcomes.get(id);
        t.outcomes.delete(id);
        const sub = owner === MAIN ? undefined : t.subs.get(owner);
        this.send(t, sub && !sub.done ? owner : undefined, 'job.end', now, { job: outcome && outcome !== 'ok' ? { id, ok: false } : { id } });
      }
      t.jobs.delete(id);
    }
    for (const [id, d] of desired) {
      if (t.jobs.has(id)) continue;
      t.jobs.set(id, d.owner);
      this.send(t, d.owner === MAIN ? undefined : d.owner, 'job.start', d.startedAt, { job: d.command ? { id, label: d.label, command: d.command } : { id, label: d.label } });
    }
    const needStandIn = status === 'shell' && t.jobs.size === 0;
    if (needStandIn && !t.registryShell) {
      t.registryShell = true;
      this.send(t, undefined, 'job.start', now, { job: { id: REGISTRY_SHELL_JOB, label: tr('Background shell') } });
    } else if (!needStandIn && t.registryShell) {
      t.registryShell = false;
      this.send(t, undefined, 'job.end', now, { job: { id: REGISTRY_SHELL_JOB } });
    }
  }

  private newTracker(key: string, acc: ClaudeAccount, entry: RegistryEntry): SessionTracker {
    return {
      key,
      account: acc.slug,
      dir: acc.dir,
      entry,
      sessionId: entry.sessionId,
      nextResolveAt: 0,
      state: createTranscriptState(),
      subs: new Map(),
      known: new Map(),
      spawns: new Map(),
      launched: new Map(),
      taskToTool: new Map(),
      runToTool: new Map(),
      finishedTools: new Set(),
      finishedAgents: new Set(),
      finishedRuns: new Set(),
      failedTools: new Set(),
      journals: new Map(),
      shells: new ShellTracker(),
      jobs: new Map(),
      outcomes: new Map(),
      registryShell: false,
      status: 'idle',
      emitted: emptyEmitted(),
      lastSubScanAt: 0,
      scanned: false,
      watchers: [],
      watchingSubs: false,
    };
  }

  // ---------------------------------------------------------------- main transcript

  private resolveTranscript(t: SessionTracker): string | undefined {
    const now = this.now();
    if (now < t.nextResolveAt) return undefined;
    t.nextResolveAt = now + 3_000;
    const name = `${t.sessionId}.jsonl`;
    const projects = join(t.dir, 'projects');
    const expected = join(projects, encodeCwd(t.entry.cwd), name);
    if (existsSync(expected)) return expected;
    // Long paths may be shortened by Claude Code, and the folder keeps the cwd's drive-letter case (c--… from VS
    // Code, C--… from the desktop app): look for the session id in every project folder.
    try {
      for (const d of readdirSync(projects)) {
        const p = join(projects, d, name);
        if (existsSync(p)) return p;
      }
    } catch {
      // projects/ doesn't exist yet
    }
    return undefined;
  }

  private pumpMain(t: SessionTracker): void {
    if (!t.tail) {
      const path = this.resolveTranscript(t);
      if (!path) return;
      t.transcriptPath = path;
      this.loadMain(t, path, false);
      this.watchSession(t);
      return;
    }
    for (let i = 0; i < 4; i++) {
      const r = t.tail.read();
      if (r.reset) {
        log.warn(`Claude Code: the transcript of session ${t.key} was truncated or replaced; reading it again.`);
        this.loadMain(t, t.tail.path, true);
        return;
      }
      for (const line of r.lines) this.applyResult(t, MAIN, this.parse(t.state, line, t.key));
      if (r.lines.length) this.syncSummary(t, undefined, t.state, t.emitted);
      if (!r.more) break;
    }
  }

  private parse(state: TranscriptState, line: string, who: string): LineResult {
    try {
      return parseLine(state, line, this.now());
    } catch (err) {
      log.warnOnce(`claude-line:${who}:${errMsg(err)}`, `Claude Code: skipped a transcript line of ${who} (${errMsg(err)}).`);
      return { events: [], signals: [], changed: false, at: this.now() };
    }
  }

  /** Reads the transcript's end (≈1 MB) and queues the reading of its start in the background. */
  private loadMain(t: SessionTracker, path: string, reload: boolean): void {
    const tail = new FileTail(path);
    const start = tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.state = createTranscriptState({ trackPrefix: start > 0 });
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) this.applyResult(t, MAIN, this.parse(t.state, line, t.key));
      if (!r.more) break;
    }
    t.customTitleFile = readCustomTitleFile(sessionDirOf(path));
    if (t.customTitleFile) t.state.customTitle ??= t.customTitleFile;
    // A replaced file was counted before: its tokens aren't new.
    if (reload) t.emitted.tokens = { ...t.state.tokens };
    this.syncSummary(t, undefined, t.state, t.emitted);
    const state = t.state;
    if (start > 0) {
      this.queuePrefix(path, start, state, (signals, shellEvents) => {
        if (this.sessions.get(t.key) !== t || t.state !== state) return;
        for (const sig of signals) this.applySignal(t, MAIN, sig, this.now());
        this.mergeOlderShells(t, MAIN, shellEvents);
        if (t.customTitleFile) state.customTitle ??= t.customTitleFile;
        this.syncSummary(t, undefined, state, t.emitted);
      });
    }
  }

  private queuePrefix(path: string, end: number, state: TranscriptState, done: (signals: TranscriptSignal[], shellEvents: ShellEvent[]) => void): void {
    const skip = new Set(state.firstMsgIds ?? []);
    this.prefixChain = this.prefixChain
      .then(async () => {
        if (this.stopped) return;
        const prefix = await scanPrefix(path, end, skip);
        mergePrefix(state, prefix.state);
        done(prefix.signals, prefix.shellEvents);
      })
      .catch((err) => log.warnOnce(`claude-prefix:${path}`, `Claude Code: could not read the start of a transcript (${errMsg(err)}).`));
  }

  /**
   * Background shells left open in the file's start (read after the end window): they join the tracker, unless the
   * window already showed their end.
   */
  private mergeOlderShells(t: SessionTracker, owner: string, events: readonly ShellEvent[]): void {
    if (!events.length) return;
    const older = new ShellTracker();
    for (const e of events) applyShellSignal(older, owner, e.signal, e.at);
    if (t.shells.merge(older.openBackground())) t.shells.prune(this.now(), t.entry.startedAt);
  }

  private applySignal(t: SessionTracker, owner: string, sig: TranscriptSignal, at: number): void {
    const fin = applyShellSignal(t.shells, owner, sig, at);
    if (fin) t.outcomes.set(fin.job.toolUseId, fin.outcome);
    switch (sig.type) {
      case 'spawn':
        t.spawns.set(sig.spawn.toolUseId, { ...sig.spawn, owner });
        if (t.spawns.size > MAX_SET) t.spawns.delete(t.spawns.keys().next().value as string);
        return;
      case 'launched':
        t.launched.set(sig.toolUseId, { ...(sig.agentId ? { agentId: sig.agentId } : {}), ...(sig.runId ? { runId: sig.runId } : {}) });
        if (sig.taskId) t.taskToTool.set(sig.taskId, sig.toolUseId);
        if (sig.agentId) t.taskToTool.set(sig.agentId, sig.toolUseId);
        if (sig.runId) t.runToTool.set(sig.runId, sig.toolUseId);
        return;
      case 'finished':
        this.finishTool(t, sig.toolUseId, sig.error);
        if (sig.agentId) addBounded(t.finishedAgents, sig.agentId);
        if (sig.runId) addBounded(t.finishedRuns, sig.runId);
        return;
      case 'notification': {
        const tool = sig.toolUseId ?? (sig.taskId ? t.taskToTool.get(sig.taskId) : undefined);
        if (tool) this.finishTool(t, tool, !!sig.status && /fail|error/i.test(sig.status));
        return;
      }
      case 'stopped': {
        const tool = t.taskToTool.get(sig.taskId);
        if (tool) this.finishTool(t, tool, false);
        return;
      }
      default:
        return;
    }
  }

  private finishTool(t: SessionTracker, toolUseId: string, error: boolean): void {
    addBounded(t.finishedTools, toolUseId);
    if (error) addBounded(t.failedTools, toolUseId);
    const l = t.launched.get(toolUseId);
    if (l?.agentId) addBounded(t.finishedAgents, l.agentId);
    if (l?.runId) addBounded(t.finishedRuns, l.runId);
  }

  // ---------------------------------------------------------------- subagents

  private isFinished(t: SessionTracker, file: SubagentFile, meta: SubagentMeta | undefined): boolean {
    if (meta?.toolUseId && t.finishedTools.has(meta.toolUseId)) return true;
    if (t.finishedAgents.has(file.agentId)) return true;
    if (file.runId) {
      if (t.finishedRuns.has(file.runId)) return true;
      const tool = t.runToTool.get(file.runId);
      if (tool && t.finishedTools.has(tool)) return true;
      if (this.journal(t, file.runId).get(file.agentId)?.done) return true;
    }
    return false;
  }

  private journal(t: SessionTracker, runId: string): Map<string, JournalAgent> {
    if (!t.transcriptPath) return new Map();
    const path = join(sessionDirOf(t.transcriptPath), 'subagents', 'workflows', runId, 'journal.jsonl');
    let size = -1;
    try {
      size = statSync(path).size;
    } catch {
      // a workflow without a journal
    }
    const cached = t.journals.get(runId);
    if (cached && cached.size === size) return cached.agents;
    let agents = new Map<string, JournalAgent>();
    if (size >= 0) {
      try {
        agents = parseJournal(readFileSync(path, 'utf8'));
      } catch {
        // unreadable now: try again next round
      }
    }
    t.journals.set(runId, { size, agents });
    return agents;
  }

  private scanSubagents(t: SessionTracker, boot: boolean): void {
    if (!t.transcriptPath) return;
    const now = this.now();
    const busy = (t.entry.status !== 'idle' && t.entry.status !== 'shell') || t.subs.size > 0;
    if (!boot && !busy && now - t.lastSubScanAt < 5_000) return;
    t.lastSubScanAt = now;
    this.watchSubagents(t);
    const files = listSubagentFiles(sessionDirOf(t.transcriptPath));
    // First scan of the session (boot or resumed session): only recently written ones come in, or ones still in the
    // middle of a tool (a long command, writing nothing for minutes).
    const firstScan = !t.scanned;
    for (const file of files) {
      if (t.subs.has(file.agentId)) continue;
      let size: number;
      let mtimeMs: number;
      try {
        const st = statSync(file.path);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      const known = t.known.get(file.path);
      if (known === undefined) {
        if (firstScan && now - mtimeMs > BOOT_RECENT_MS && !this.maybeStillRunning(t, file, now - mtimeMs)) {
          t.known.set(file.path, size);
          continue;
        }
        this.openSub(t, file, firstScan ? 'replay' : 'new');
      } else if (size > known) {
        this.openSub(t, file, 'regrown');
      }
    }
    t.scanned = true;
  }

  /**
   * A subagent quiet for longer than BOOT_RECENT_MS at the first scan that may still be working: its last message
   * called a tool without a result yet (a long command), or the workflow's journal says it started and didn't finish.
   */
  private maybeStillRunning(t: SessionTracker, file: SubagentFile, quietMs: number): boolean {
    if (quietMs >= PENDING_TOOL_TIMEOUT_MS) return false;
    if (file.runId && !t.finishedRuns.has(file.runId)) {
      const j = this.journal(t, file.runId).get(file.agentId);
      if (j && !j.done) return true;
    }
    return pendingToolAtEnd(file.path);
  }

  /**
   * Puts a subagent in the office. 'new' = the file just appeared; 'replay' = it existed when the session was opened;
   * 'regrown' = written again after it left.
   */
  private openSub(t: SessionTracker, file: SubagentFile, mode: 'new' | 'replay' | 'regrown'): void {
    try {
      this.openSubUnsafe(t, file, mode);
    } catch (err) {
      // A troublesome file: ignored until its size changes again.
      try {
        t.known.set(file.path, statSync(file.path).size);
      } catch {
        t.known.set(file.path, 0);
      }
      log.warnOnce(`claude-sub-open:${file.path}`, `Claude Code: subagent ${file.agentId} skipped (${errMsg(err)}).`);
    }
  }

  private openSubUnsafe(t: SessionTracker, file: SubagentFile, mode: 'new' | 'replay' | 'regrown'): void {
    const now = this.now();
    const meta = readSubagentMeta(file.metaPath);
    const tail = new FileTail(file.path);
    // A new, small file: seekTail returns 0 and reads it all; a large one: only its end.
    const start = tail.seekTail(this.tailBytes);
    const state = createTranscriptState({ trackPrefix: start > 0 });
    const results: LineResult[] = [];
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) results.push(this.parse(state, line, `${t.key}:${file.agentId}`));
      if (!r.more) break;
    }
    const finished =
      this.isFinished(t, file, meta) ||
      (mode !== 'new' && (meta?.finished === true || concludedByIdle({ now, lastWriteAt: tail.mtimeMs, ended: state.ended, pendingTool: state.pendingTools.size > 0 })));
    if (finished) {
      t.known.set(file.path, tail.size);
      return;
    }
    const spawn = meta?.toolUseId ? t.spawns.get(meta.toolUseId) : undefined;
    const parentSub = spawn && spawn.owner !== MAIN ? t.subs.get(spawn.owner) : undefined;
    const journalLabel = file.runId ? this.journal(t, file.runId).get(file.agentId)?.label : undefined;
    const title = meta?.description ?? spawn?.description ?? journalLabel;
    const background = meta?.requestShape ? meta.requestShape !== 'foreground' || !!spawn?.background : !!spawn?.background;
    t.known.delete(file.path);
    const sub: SubTracker = { agentId: file.agentId, file, tail, state, emitted: emptyEmitted(), done: false };
    if (meta) sub.meta = meta;
    t.subs.set(file.agentId, sub);
    const subagent: { role: string; title?: string; background?: boolean } = { role: subagentRole(meta, spawn?.subagentType) };
    if (title) subagent.title = title;
    if (background) subagent.background = true;
    this.send(t, file.agentId, 'subagent.start', state.firstAt ?? now, {
      subagent,
      ...(parentSub && !parentSub.done ? { parentAgent: parentSub.agentId } : {}),
      ...(meta?.model && !state.model ? { model: meta.model } : {}),
    });
    for (const r of results) this.applyResult(t, file.agentId, r);
    this.syncSummary(t, file.agentId, state, sub.emitted);
    if (start > 0) {
      this.queuePrefix(file.path, start, state, (_signals, shellEvents) => {
        if (t.subs.get(file.agentId) !== sub) return;
        this.mergeOlderShells(t, file.agentId, shellEvents);
        this.syncSummary(t, file.agentId, state, sub.emitted);
      });
    }
  }

  private pumpSubs(t: SessionTracker): void {
    const now = this.now();
    for (const sub of [...t.subs.values()]) {
      if (sub.done && now - (sub.doneAt ?? now) > SUB_FORGET_MS) {
        // Left the office (its grace period is over).
        t.subs.delete(sub.agentId);
        t.known.set(sub.file.path, sub.tail.size);
        continue;
      }
      if (!sub.done) {
        const meta = readSubagentMeta(sub.file.metaPath);
        if (meta) sub.meta = meta;
      }
      let fresh = 0;
      for (let i = 0; i < 4; i++) {
        let r;
        try {
          r = sub.tail.read();
        } catch (err) {
          log.warnOnce(`claude-sub:${sub.file.path}`, `Claude Code: subagent ${sub.agentId}: ${errMsg(err)}`);
          break;
        }
        for (const line of r.lines) {
          const res = this.parse(sub.state, line, `${t.key}:${sub.agentId}`);
          fresh += res.events.length;
          this.applyResult(t, sub.agentId, res);
        }
        if (r.lines.length) this.syncSummary(t, sub.agentId, sub.state, sub.emitted);
        if (!r.more) break;
      }
      if (sub.done) {
        if (fresh > 0 && !this.isFinished(t, sub.file, sub.meta) && now - (sub.doneAt ?? now) > 3_000) {
          // Written again after it finished: it's back at work.
          sub.done = false;
          delete sub.doneAt;
          this.send(t, sub.agentId, 'subagent.start', now, { subagent: { role: subagentRole(sub.meta) } });
        }
        continue;
      }
      const done =
        this.isFinished(t, sub.file, sub.meta) ||
        sub.meta?.finished === true ||
        concludedByIdle({ now, lastWriteAt: sub.tail.mtimeMs, ended: sub.state.ended, pendingTool: sub.state.pendingTools.size > 0 });
      if (done) {
        const failed = !!sub.meta?.toolUseId && t.failedTools.has(sub.meta.toolUseId);
        this.send(t, sub.agentId, 'subagent.end', now, failed ? { subagent: { ok: false } } : {});
        sub.done = true;
        sub.doneAt = now;
        // Finished: nothing of it runs in the foreground (what's in the background moves to the main agent).
        t.shells.endForeground(sub.agentId, now);
      }
    }
  }

  // ---------------------------------------------------------------- fs.watch (accelerator)

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // no support / missing folder: polling covers it
    }
  }

  private addWatch(t: SessionTracker, path: string, recursive: boolean): boolean {
    try {
      const w = watch(path, { persistent: false, recursive }, () => this.schedule());
      w.on('error', () => w.close());
      t.watchers.push(w);
      return true;
    } catch {
      return false; // no support: polling covers it
    }
  }

  private watchSession(t: SessionTracker): void {
    if (!this.useWatch || !t.transcriptPath) return;
    this.addWatch(t, t.transcriptPath, false);
    this.watchSubagents(t);
  }

  private watchSubagents(t: SessionTracker): void {
    if (!this.useWatch || t.watchingSubs || !t.transcriptPath) return;
    const subDir = join(sessionDirOf(t.transcriptPath), 'subagents');
    if (existsSync(subDir)) t.watchingSubs = this.addWatch(t, subDir, true);
  }

  private closeWatchers(t: SessionTracker): void {
    for (const w of t.watchers) w.close();
    t.watchers = [];
    t.watchingSubs = false;
  }
}

/** Applies a signal to the shell tracker; returns a job's end, when there is one. */
function applyShellSignal(shells: ShellTracker, owner: string, sig: TranscriptSignal, at: number) {
  switch (sig.type) {
    case 'shellStart':
      shells.start(owner, sig.shell);
      return undefined;
    case 'shellResult':
      shells.result(sig.toolUseId, { ...(sig.taskId ? { taskId: sig.taskId } : {}), error: sig.error, at });
      return undefined;
    case 'turnEnd':
      shells.endForeground(owner, at);
      return undefined;
    case 'notification':
      return shells.notify({ ...sig, at });
    case 'stopped':
      return shells.stop(sig.taskId, at);
    default:
      return undefined;
  }
}

/** How much of a transcript's end is read to tell whether a tool has no result yet. */
const PENDING_PROBE_BYTES = 256 * 1024;

/** Did the transcript's last message call a tool that has no result yet? */
export function pendingToolAtEnd(path: string): boolean {
  try {
    const tail = new FileTail(path);
    tail.seekTail(PENDING_PROBE_BYTES);
    const state = createTranscriptState();
    for (let i = 0; i < 8; i++) {
      const r = tail.read();
      for (const line of r.lines) parseLine(state, line, 0);
      if (!r.more) break;
    }
    return state.pendingTools.size > 0 && !state.ended;
  } catch {
    return false;
  }
}

/** <session>/custom-title.json {"customTitle": "..."} (title given with /rename). */
export function readCustomTitleFile(sessionDir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(sessionDir, 'custom-title.json'), 'utf8')) as { customTitle?: unknown };
    return typeof j.customTitle === 'string' && j.customTitle.trim() ? j.customTitle.trim() : undefined;
  } catch {
    return undefined;
  }
}
