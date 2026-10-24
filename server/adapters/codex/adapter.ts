// Codex adapter (P5-01), checked against Codex 0.164.0 (docs/providers/codex.md, test/fixtures/codex/). Three
// sources, combined; each fact is reported once, whichever source sees it first (turns by turn_id, tools by call_id
// = the hooks' tool_use_id, subagents by thread id, jobs by exec session):
//
// - Locks: <CODEX_HOME>/thread-writer-locks/<thread>.lock exists while a thread is loaded. Checked by existence only
//   (opening one with flock would hold Codex's lock). They find open sessions at boot and tell when one closes.
// - Rollouts: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, tailed: everything works without hooks
//   (turns, tools, background exec sessions, tokens, plan usage, subagents through their own rollouts).
// - Hooks (hooks/codex.mjs → POST /api/hooks/codex): lower latency, the agent's PID, and permission prompts, which
//   rollouts don't show.
//
// Never read: auth.json, config.toml.
import { existsSync, readdirSync, readSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { t } from '../../../shared/i18n';
import type { LivenessTarget } from '../../../shared/model/office';
import type { AgentEvent, AgentEventType, EventTool, ProviderCapabilities, SourceInfo } from '../../../shared/protocol';
import { codexToolName, describeCodexTool } from '../../../shared/tools/codex';
import { errMsg, log } from '../../log';
import { usageFromCodex, type ProviderAccount } from '../../accounts/service';
import { accountSlug, discoverCodexHomes, samePath, type CodexHome } from '../accounts';
import type { AdapterContext, ProviderAdapter } from '../adapter';
import { FileTail } from '../tail';
import { codexHomeOf, HOOK_EVENTS, parseHookBody, type CodexHook } from './hook';
import { createRolloutState, isThreadId, parseRolloutLine, type RateLimits, type RolloutItem, type RolloutMeta, type RolloutState } from './rollout';

export interface CodexAdapterOptions {
  now?: () => number;
  pollMs?: number;
  /** The Codex homes to watch (default: discovered). */
  homes?: CodexHome[];
  /** The user's home (the default account is ~/.codex). */
  home?: string;
}

export const LOCKS_DIR = 'thread-writer-locks';
const LOCK_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
/** A rollout opened mid-session: only its end is replayed. */
const TAIL_BYTES = 512 * 1024;
/** The session_meta line holds the base instructions: read up to this much of the file's start for it. */
const META_BYTES = 512 * 1024;
/** How many day folders back to look for a thread's rollout. */
const SEARCH_DAYS = 45;
/** A thread seen only through hooks, with no lock yet: alive for this long after its last hook. */
const LOCK_GRACE_MS = 10_000;
const FORGET_MS = 60_000;
const LOCK_SCAN_MS = 2_000;

interface Thread {
  id: string;
  /** The main thread of the session (itself, for the main agent). */
  sessionId: string;
  account: string;
  home?: string;
  parentId?: string;
  cwd?: string;
  model?: string;
  pid?: number;
  path?: string;
  tail?: FileTail;
  state: RolloutState;
  started: boolean;
  ended: boolean;
  endedAt?: number;
  internal: boolean;
  role?: string;
  title?: string;
  turnsStarted: Set<string>;
  turnsEnded: Set<string>;
  openTurn?: string;
  toolsStarted: Set<string>;
  toolsEnded: Set<string>;
  jobs: Set<string>;
  /** The thread's lock was seen (so its disappearance ends it). */
  locked: boolean;
  lastHookAt?: number;
}

/** Plan usage per account, from the latest token_count (P5-04). */
export interface CodexAccountUsage {
  account: string;
  at: number;
  limits: RateLimits;
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly color = '#10a37f';
  readonly capabilities: ProviderCapabilities = { transcript: false, approve: false, message: false, usage: true, subagents: true };

  describeTool = describeCodexTool;

  private ctx: AdapterContext | null = null;
  private threads = new Map<string, Thread>();
  /** Spawned agents not seen yet: agent id → what the parent said about them. */
  private spawned = new Map<string, { nickname?: string; task?: string; parentId: string }>();
  /** Tool inputs from PreToolUse, for the matching PostToolUse (spawn_agent's task, write_stdin's session). */
  private hookInputs = new Map<string, { name: string; input: Record<string, unknown> }>();
  private usage = new Map<string, CodexAccountUsage>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLockScan = 0;
  private readonly now: () => number;
  private readonly homeDir: string;
  private readonly homes: CodexHome[];
  private readonly defaultHome: string;

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.homeDir = opts.home ?? homedir();
    this.defaultHome = resolve(this.homeDir, '.codex');
    this.homes = opts.homes ?? discoverCodexHomes(process.env, this.homeDir);
  }

  start(ctx: AdapterContext): void {
    this.ctx = ctx;
    ctx.beginBoot();
    try {
      for (const e of this.scanLocks()) ctx.emit(e);
    } finally {
      ctx.endBoot();
    }
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    const open = (slug: string) => [...this.threads.values()].filter((th) => th.account === slug && th.id === th.sessionId && !th.ended).length;
    const list: SourceInfo[] = this.homes.map((h) => ({ provider: this.id, label: h.slug, path: h.dir, sessions: open(h.slug), ok: true }));
    list.push({ provider: this.id, label: t('hooks'), path: '/api/hooks/codex', sessions: [...this.threads.values()].filter((th) => th.lastHookAt !== undefined && !th.ended && th.id === th.sessionId).length, ok: true });
    return list;
  }

  /** The latest plan usage per account (P5-04). */
  accountUsage(): CodexAccountUsage[] {
    return [...this.usage.values()];
  }

  /** Watched homes, with the plan usage the latest token_count reported. */
  accounts(): ProviderAccount[] {
    const list: ProviderAccount[] = this.homes.map((h) => ({ id: h.slug, dir: h.dir }));
    for (const u of this.usage.values()) if (!list.some((a) => a.id === u.account)) list.push({ id: u.account });
    for (const a of list) {
      const u = this.usage.get(a.id);
      if (!u) continue;
      a.usage = usageFromCodex(u.limits, u.at);
      if (u.limits.planType) a.plan = u.limits.planType;
    }
    return list;
  }

  /** Main agents: alive while their lock exists (when the home has locks). Subagents follow their session. */
  alive(target: LivenessTarget): boolean | undefined {
    const session = target.id.split(':').pop() ?? '';
    const th = this.threads.get(session);
    if (!th || !th.home || !existsSync(join(th.home, LOCKS_DIR))) return undefined;
    if (existsSync(join(th.home, LOCKS_DIR, `${session}.lock`))) return true;
    if (!th.locked && th.lastHookAt !== undefined && this.now() - th.lastHookAt < LOCK_GRACE_MS) return true;
    return false;
  }

  // ---------------------------------------------------------------- hooks

  onHook(payload: unknown): AgentEvent[] {
    const now = this.now();
    const h = parseHookBody(payload, now);
    if (!h) {
      const name = (payload as { hook_event_name?: unknown } | null)?.hook_event_name;
      if (typeof name === 'string' && /^[A-Z][A-Za-z]{2,40}$/.test(name) && !(HOOK_EVENTS as readonly string[]).includes(name)) return [];
      throw new Error('not a Codex hook payload');
    }
    const main = this.threadFor(h.sessionId, h.sessionId, { home: h.codexHome ?? (h.transcriptPath ? codexHomeOf(h.transcriptPath) : undefined), cwd: h.cwd });
    main.lastHookAt = now;
    if (h.pid !== undefined) main.pid = h.pid;
    if (h.model) main.model = h.model;
    if (h.transcriptPath && !main.path && !h.agentId) this.follow(main, h.transcriptPath);
    const out: AgentEvent[] = [];
    // what the rollout says first (tokens, jobs), then the hook
    out.push(...this.pump(main));
    const th = h.agentId ? this.threadFor(h.agentId, h.sessionId, { parentId: h.sessionId, cwd: h.cwd }) : main;
    if (h.agentId) {
      th.lastHookAt = now;
      if (h.agentType && h.agentType !== 'default') th.role ??= h.agentType;
      if (h.agentTranscriptPath && !th.path) this.follow(th, h.agentTranscriptPath);
      out.push(...this.pump(th));
    }
    switch (h.event) {
      case 'SessionStart':
        if (main.ended) this.reopen(main);
        out.push(...this.ensureStarted(main, h.at));
        break;
      case 'SessionEnd':
        out.push(...this.endThread(main, h.at));
        break;
      case 'UserPromptSubmit':
        if (h.turnId) out.push(...this.turnStart(th, h.turnId, h.at, h.prompt));
        break;
      case 'Stop':
        out.push(...this.turnEnd(th, h.turnId, h.at));
        break;
      case 'SubagentStart':
        if (h.agentId) out.push(...this.ensureStarted(th, h.at));
        break;
      case 'SubagentStop':
        if (h.agentId) out.push(...this.subEnd(th, h.at, true));
        break;
      case 'PreToolUse': {
        if (!h.toolUseId || !h.toolName) break;
        const name = codexToolName(h.toolName);
        const input = h.toolInput ?? {};
        this.hookInputs.set(h.toolUseId, { name, input });
        out.push(...this.toolStart(th, h.toolUseId, name, input, h.at));
        if (name === 'request_user_input') out.push(this.ev(th, 'waiting', h.at, { waiting: { reason: 'question' } }));
        break;
      }
      case 'PostToolUse': {
        if (!h.toolUseId || !h.toolName) break;
        const name = codexToolName(h.toolName);
        const pre = this.hookInputs.get(h.toolUseId);
        this.hookInputs.delete(h.toolUseId);
        const r = h.toolResult ?? {};
        let ok: boolean | undefined;
        let error: string | undefined;
        if (r.exitCode !== undefined) {
          ok = r.exitCode === 0;
          if (!ok) error = `exit_${r.exitCode}`;
        }
        if (r.rejected) {
          ok = false;
          error = 'rejected';
        }
        out.push(...this.toolEnd(th, h.toolUseId, name, h.at, ok, error));
        if (name === 'spawn_agent' && r.agentId) this.noteSpawn(th, r.agentId, r.nickname, typeof pre?.input.message === 'string' ? pre.input.message : undefined);
        if (r.execSession !== undefined) out.push(...this.jobStart(th, `exec:${r.execSession}`, String(pre?.input.command ?? pre?.input.cmd ?? h.toolInput?.command ?? ''), h.at));
        if (name === 'write_stdin' && r.exitCode !== undefined) {
          const sid = pre?.input.session_id ?? h.toolInput?.session_id;
          if (typeof sid === 'number' || typeof sid === 'string') out.push(...this.jobEnd(th, `exec:${sid}`, h.at, r.exitCode === 0));
        }
        break;
      }
      case 'PermissionRequest': {
        const command = typeof h.toolInput?.command === 'string' ? h.toolInput.command : undefined;
        const text = h.reason ?? command;
        out.push(...this.ensureStarted(th, h.at));
        out.push(this.ev(th, 'waiting', h.at, { waiting: text ? { reason: 'permission', text: text.slice(0, 300) } : { reason: 'permission' } }));
        break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- rollouts

  /**
   * Starts tailing a thread's rollout from its last TAIL_BYTES (a thread found mid-session is rebuilt from them; what
   * hooks already reported is skipped by id). The session_meta line is read on its own first.
   */
  private follow(th: Thread, path: string): void {
    th.path = path;
    const meta = readMetaLine(path);
    if (meta) this.applyItems(th, parseRolloutLine(th.state, meta, this.now()));
    const tail = new FileTail(path);
    tail.seekTail(TAIL_BYTES);
    th.tail = tail;
  }

  /** New rollout lines of a thread, as events. */
  private pump(th: Thread): AgentEvent[] {
    if (!th.tail || th.ended) return [];
    const out: AgentEvent[] = [];
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = th.tail.read();
      } catch (err) {
        log.warnOnce(`codex-rollout:${th.id}`, `Codex: could not read a rollout (${errMsg(err)}).`);
        break;
      }
      if (r.reset) th.state = createRolloutState();
      for (const line of r.lines) out.push(...this.applyItems(th, parseRolloutLine(th.state, line, this.now())));
      if (!r.more) break;
    }
    return out;
  }

  private applyItems(th: Thread, items: RolloutItem[]): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const item of items) {
      switch (item.type) {
        case 'meta':
          this.applyMeta(th, item.meta);
          break;
        case 'model':
          th.model = item.model;
          break;
        case 'spawned':
          this.noteSpawn(th, item.agentId, item.nickname, item.task);
          break;
        case 'turn.start':
          // a subagent given more work after it finished comes back
          if (th.id !== th.sessionId && th.ended) this.reopen(th);
          out.push(...this.turnStart(th, item.turnId, item.at, item.prompt));
          break;
        case 'turn.end':
          out.push(...this.turnEnd(th, item.turnId, item.at, item.aborted));
          // a subagent's turn ending is its result: it walks to its parent
          if (th.id !== th.sessionId && th.lastHookAt === undefined) out.push(...this.subEnd(th, item.at, !item.aborted));
          break;
        case 'tool.start':
          out.push(...this.toolStart(th, item.callId, codexToolName(item.name), item.input, item.at));
          break;
        case 'tool.end':
          out.push(...this.toolEnd(th, item.callId, codexToolName(item.name), item.at, item.ok, item.error));
          break;
        case 'job.start':
          out.push(...this.jobStart(th, item.jobId, item.command, item.at));
          break;
        case 'job.end':
          out.push(...this.jobEnd(th, item.jobId, item.at, item.ok));
          break;
        case 'waiting':
          if (!th.internal) out.push(...this.ensureStarted(th, item.at), this.ev(th, 'waiting', item.at, { waiting: item.text ? { reason: 'question', text: item.text } : { reason: 'question' } }));
          break;
        case 'usage':
          if (th.internal) break;
          out.push(...this.ensureStarted(th, item.at), this.ev(th, 'usage', item.at, { tokens: item.tokens }));
          if (item.rateLimits) this.usage.set(th.account, { account: th.account, at: item.at, limits: item.rateLimits });
          break;
      }
    }
    return out;
  }

  private applyMeta(th: Thread, meta: RolloutMeta): void {
    if (meta.cwd) th.cwd ??= meta.cwd;
    th.internal = meta.internal;
    if (meta.parentThreadId && th.id !== th.sessionId) th.parentId = meta.parentThreadId;
    if (meta.parentThreadId && th.id === th.sessionId && !th.started) {
      // found by its own lock before its parent: re-file it under the parent's session
      const parent = this.threads.get(meta.parentThreadId);
      th.sessionId = parent?.sessionId ?? meta.parentThreadId;
      th.parentId = meta.parentThreadId;
    }
    if (meta.role) th.role ??= meta.role;
    if (meta.nickname) th.title ??= meta.nickname;
  }

  // ---------------------------------------------------------------- locks

  private safePoll(): void {
    try {
      for (const e of this.poll()) this.ctx?.emit(e);
    } catch (err) {
      log.warnOnce(`codex-poll:${errMsg(err)}`, `Codex: a polling round failed (${errMsg(err)}).`);
    }
  }

  /** One round: locks (every 2 s), rollouts, forgetting. Returns the events (also for tests). */
  poll(): AgentEvent[] {
    const now = this.now();
    const out: AgentEvent[] = [];
    if (now - this.lastLockScan >= LOCK_SCAN_MS) out.push(...this.scanLocks());
    for (const th of [...this.threads.values()]) {
      if (th.ended) {
        if (now - (th.endedAt ?? now) > FORGET_MS) this.threads.delete(th.id);
        continue;
      }
      out.push(...this.pump(th));
    }
    return out;
  }

  /** New locks → threads (their rollout's end rebuilds them); vanished locks → the thread ended. */
  private scanLocks(): AgentEvent[] {
    this.lastLockScan = this.now();
    const out: AgentEvent[] = [];
    for (const home of this.homes) {
      let names: string[];
      try {
        names = readdirSync(join(home.dir, LOCKS_DIR));
      } catch {
        continue; // no locks folder: an older Codex, or not mounted (Docker)
      }
      const present = new Set<string>();
      for (const name of names) {
        const id = LOCK_FILE.exec(name)?.[1]?.toLowerCase();
        if (!id) continue;
        present.add(id);
        let th = this.threads.get(id);
        if (th && !th.ended) {
          th.locked = true;
          continue;
        }
        const path = findRollout(home.dir, id);
        th = this.threadFor(id, id, { home: home.dir });
        th.locked = true;
        if (path) this.follow(th, path);
        if (th.internal) continue;
        out.push(...this.ensureStarted(th, th.state.lastAt ?? this.now()));
        out.push(...this.pump(th));
      }
      for (const th of this.threads.values()) {
        if (th.ended || !th.locked || !th.home || !samePath(th.home, home.dir) || present.has(th.id)) continue;
        out.push(...(th.id === th.sessionId ? this.endThread(th, this.now()) : this.subEnd(th, this.now(), true)));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- events, once each

  private threadFor(id: string, sessionId: string, o: { home?: string; cwd?: string; parentId?: string }): Thread {
    let th = this.threads.get(id);
    if (!th) {
      const home = o.home ?? (sessionId !== id ? this.threads.get(sessionId)?.home : undefined);
      th = {
        id,
        sessionId,
        account: home ? accountSlug(home, this.defaultHome) : 'default',
        state: createRolloutState(),
        started: false,
        ended: false,
        internal: false,
        turnsStarted: new Set(),
        turnsEnded: new Set(),
        toolsStarted: new Set(),
        toolsEnded: new Set(),
        jobs: new Set(),
        locked: false,
      };
      if (home) th.home = home;
      if (o.parentId) th.parentId = o.parentId;
      const sp = this.spawned.get(id);
      if (sp) {
        th.parentId ??= sp.parentId;
        if (sp.task) th.title = sp.task;
        else if (sp.nickname) th.title = sp.nickname;
      }
      this.threads.set(id, th);
    }
    if (o.cwd) th.cwd ??= o.cwd;
    if (o.home && !th.home) {
      th.home = o.home;
      th.account = accountSlug(o.home, this.defaultHome);
    }
    return th;
  }

  private reopen(th: Thread): void {
    th.ended = false;
    delete th.endedAt;
    th.started = false;
  }

  private noteSpawn(parent: Thread, agentId: string, nickname?: string, task?: string): void {
    const info: { nickname?: string; task?: string; parentId: string } = { parentId: parent.id };
    if (nickname) info.nickname = nickname;
    if (task) info.task = task;
    this.spawned.set(agentId, info);
    const th = this.threads.get(agentId);
    if (th && !th.started) {
      th.parentId ??= parent.id;
      th.title ??= task ?? nickname;
    }
  }

  private ensureStarted(th: Thread, at: number): AgentEvent[] {
    if (th.started || th.internal) return [];
    const out: AgentEvent[] = [];
    if (th.id === th.sessionId) {
      th.started = true;
      out.push(this.ev(th, 'session.start', at));
      return out;
    }
    const main = this.threads.get(th.sessionId);
    if (main) out.push(...this.ensureStarted(main, at));
    th.started = true;
    th.ended = false;
    const sp = this.spawned.get(th.id);
    const subagent: { role: string; title?: string } = { role: th.role ?? sp?.nickname ?? t('Subagent') };
    const title = sp?.task ?? th.title;
    if (title && title !== subagent.role) subagent.title = title.split('\n')[0]!.slice(0, 120);
    out.push(this.ev(th, 'subagent.start', at, { subagent }));
    return out;
  }

  private turnStart(th: Thread, turnId: string, at: number, prompt?: string): AgentEvent[] {
    if (th.internal || th.turnsStarted.has(turnId)) return [];
    th.turnsStarted.add(turnId);
    th.openTurn = turnId;
    const out = this.ensureStarted(th, at);
    // a subagent's turn is its task: the main agent's prompt is what reaches turn.start
    out.push(this.ev(th, 'turn.start', at, prompt && th.id === th.sessionId ? { prompt } : {}));
    return out;
  }

  private turnEnd(th: Thread, turnId: string | undefined, at: number, aborted = false): AgentEvent[] {
    const id = turnId ?? th.openTurn;
    if (th.internal || !th.started || (id && th.turnsEnded.has(id))) return [];
    if (id) th.turnsEnded.add(id);
    if (!id || id === th.openTurn) delete th.openTurn;
    const out: AgentEvent[] = [];
    // tools left open by an aborted turn end with it
    for (const tool of th.toolsStarted) {
      if (th.toolsEnded.has(tool)) continue;
      th.toolsEnded.add(tool);
      out.push(this.ev(th, 'tool.end', at, { tool: { id: tool, name: 'tool', ok: !aborted, ...(aborted ? { error: 'interrupted' } : {}) } }));
    }
    out.push(this.ev(th, 'turn.end', at));
    return out;
  }

  private toolStart(th: Thread, id: string, name: string, input: Record<string, unknown>, at: number): AgentEvent[] {
    if (th.internal || th.toolsStarted.has(id)) return [];
    th.toolsStarted.add(id);
    const out = this.ensureStarted(th, at);
    const tool: EventTool = { id, name, input: slimInput(name, input) };
    out.push(this.ev(th, 'tool.start', at, { tool }));
    return out;
  }

  private toolEnd(th: Thread, id: string, name: string, at: number, ok?: boolean, error?: string): AgentEvent[] {
    if (th.internal || !th.toolsStarted.has(id) || th.toolsEnded.has(id)) return [];
    th.toolsEnded.add(id);
    const tool: EventTool = { id, name };
    if (ok !== undefined) tool.ok = ok;
    if (error) tool.error = error;
    return [this.ev(th, 'tool.end', at, { tool })];
  }

  private jobStart(th: Thread, id: string, command: string, at: number): AgentEvent[] {
    if (th.internal || th.jobs.has(id)) return [];
    th.jobs.add(id);
    const job: { id: string; command?: string } = { id };
    if (command) job.command = command.slice(0, 1_000);
    return [...this.ensureStarted(th, at), this.ev(th, 'job.start', at, { job })];
  }

  private jobEnd(th: Thread, id: string, at: number, ok?: boolean): AgentEvent[] {
    if (!th.jobs.delete(id)) return [];
    return [this.ev(th, 'job.end', at, { job: ok === undefined ? { id } : { id, ok } })];
  }

  private subEnd(th: Thread, at: number, ok: boolean): AgentEvent[] {
    if (th.id === th.sessionId || !th.started || th.ended) return [];
    th.ended = true;
    th.endedAt = this.now();
    return [this.ev(th, 'subagent.end', at, ok ? {} : { subagent: { ok: false } })];
  }

  private endThread(th: Thread, at: number): AgentEvent[] {
    if (th.ended) return [];
    th.ended = true;
    th.endedAt = this.now();
    for (const sub of this.threads.values()) {
      if (sub.sessionId === th.id && sub !== th && !sub.ended) {
        sub.ended = true;
        sub.endedAt = th.endedAt;
      }
    }
    return th.started ? [this.ev(th, 'session.end', at)] : [];
  }

  private ev(th: Thread, type: AgentEventType, at: number, extra: Partial<AgentEvent> = {}): AgentEvent {
    const main = this.threads.get(th.sessionId);
    const e: AgentEvent = { v: 1, provider: this.id, account: main?.account ?? th.account, session: th.sessionId, at, type, ...extra };
    if (th.id !== th.sessionId) {
      e.agent = th.id;
      if (th.parentId && th.parentId !== th.sessionId) e.parentAgent = th.parentId;
    }
    const cwd = th.cwd ?? main?.cwd;
    if (cwd) e.cwd = cwd;
    const pid = main?.pid ?? th.pid;
    if (pid !== undefined) e.pid = pid;
    const model = th.model ?? th.state.model;
    if (model && e.model === undefined) e.model = model;
    return e;
  }
}

/** A tool input for the office: an apply_patch's patch text becomes its file list (contents never leave). */
function slimInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name !== 'apply_patch') return input;
  if (Array.isArray(input.files)) return { files: input.files };
  const patch = typeof input.input === 'string' ? input.input : typeof input.command === 'string' ? input.command : '';
  return { files: [...patch.slice(0, 200_000).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim()).slice(0, 50) };
}

/** The first line of a rollout (session_meta), read without the rest of the file. */
export function readMetaLine(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(META_BYTES);
    const n = readSync(fd, buf, 0, META_BYTES, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    return nl > 0 ? buf.subarray(0, nl).toString('utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A thread's rollout: sessions/YYYY/MM/DD/rollout-*-<id>.jsonl, newest days first, within SEARCH_DAYS day folders. */
export function findRollout(home: string, id: string): string | undefined {
  if (!isThreadId(id)) return undefined;
  const suffix = `-${id}.jsonl`;
  const list = (dir: string, re: RegExp) => {
    try {
      return readdirSync(dir).filter((n) => re.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  const root = join(home, 'sessions');
  for (const y of list(root, /^\d{4}$/)) {
    for (const m of list(join(root, y), /^\d{2}$/)) {
      for (const d of list(join(root, y, m), /^\d{2}$/)) {
        const dir = join(root, y, m, d);
        const hit = list(dir, /^rollout-.*\.jsonl$/).find((n) => n.endsWith(suffix));
        if (hit) return join(dir, hit);
        if (++days >= SEARCH_DAYS) return undefined;
      }
    }
  }
  const archived = list(join(home, 'archived_sessions'), /^rollout-.*\.jsonl$/).find((n) => n.endsWith(suffix));
  return archived ? join(home, 'archived_sessions', archived) : undefined;
}

