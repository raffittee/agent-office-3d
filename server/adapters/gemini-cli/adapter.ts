// Gemini CLI adapter. Two sources, combined (docs/providers/gemini-cli.md, P0-04):
//
// - Hooks (hooks/gemini-cli.mjs → POST /api/hooks/gemini-cli): the session's lifecycle and status. SessionStart /
//   SessionEnd, BeforeAgent / AfterAgent (turns), Notification (permission prompts) and, with the `full` profile,
//   BeforeTool / AfterTool. Tool hooks carry no call id: starts and ends pair by name, in order.
// - The chat file (`transcript_path`), always tailed: the only signal after a denied or cancelled permission (the
//   call turns `cancelled`, then "Request cancelled."), model and tokens, tool calls with the `light` profile (and in
//   ACP mode, which fires almost no hooks), and subagents (chats/<sessionId>/<subagentId>.jsonl). A subagent's own
//   tool hooks carry the parent's session id, so they're ignored: its chat file reports them.
//
// Background commands report a PID and no hook fires when they end: the PID is probed instead.
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { t } from '../../../shared/i18n';
import type { AgentEvent, AgentEventType, EventTool, ProviderCapabilities, SourceInfo } from '../../../shared/protocol';
import { describeGeminiTool } from '../../../shared/tools/gemini-cli';
import { errMsg, log } from '../../log';
import { accountSlug } from '../accounts';
import { pidAlive, type AdapterContext, type ProviderAdapter } from '../adapter';
import { FileTail } from '../tail';
import { createChatState, endedTool, parseChatLine, type ChatItem, type ChatState, type ChatToolCall } from './chat';
import { geminiHomeOf, HOOK_EVENTS, parseHookBody, type GeminiHook } from './hook';

export interface GeminiAdapterOptions {
  now?: () => number;
  pollMs?: number;
  /** Is a background command's process alive? (default: PID probe) */
  isAlive?: (pid: number) => boolean;
  /** The user's home (the default account's Gemini home). */
  home?: string;
}

/** A `/clear` pairs SessionEnd(clear) with the SessionStart(clear) that follows within this time. */
const CLEAR_PAIR_MS = 10_000;
/** A subagent whose chat file stays quiet this long is considered finished. */
const SUB_IDLE_MS = 120_000;
/** Ended sessions and subagents are forgotten after this long. */
const FORGET_MS = 60_000;
/** The first read of a chat file opened mid-session: only its end. */
const TAIL_BYTES = 512 * 1024;

interface SubChat {
  id: string;
  tail: FileTail;
  chat: ChatState;
  started: boolean;
  done: boolean;
  doneAt?: number;
}

interface Session {
  sessionId: string;
  account: string;
  cwd?: string;
  pid?: number;
  transcriptPath?: string;
  tail?: FileTail;
  chat: ChatState;
  started: boolean;
  /** BeforeTool hooks arrive (profile `full`): tool activity comes from hooks, not the chat file. */
  hookTools: boolean;
  /** Hook tools started and not ended yet: name → ids, oldest first. */
  open: Map<string, string[]>;
  seq: number;
  /** invoke_agent calls in progress (their inner tool hooks belong to the subagent). */
  invokeDepth: number;
  /** agent_name of invoke_agent calls whose subagent hasn't shown up yet. */
  pendingRoles: string[];
  inTurn: boolean;
  /** Background commands: PID → job id. */
  jobs: Map<number, string>;
  subs: Map<string, SubChat>;
  ended: boolean;
  endedAt?: number;
}

export class GeminiCliAdapter implements ProviderAdapter {
  readonly id = 'gemini-cli' as const;
  readonly label = 'Gemini CLI';
  readonly color = '#4285f4';
  readonly capabilities: ProviderCapabilities = { transcript: false, approve: false, message: false, usage: false, subagents: true };

  describeTool = describeGeminiTool;

  private ctx: AdapterContext | null = null;
  private sessions = new Map<string, Session>();
  private clears: Array<{ session: Session; at: number }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly home: string;

  constructor(private readonly opts: GeminiAdapterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.isAlive = opts.isAlive ?? pidAlive;
    this.home = opts.home ?? homedir();
  }

  start(ctx: AdapterContext): void {
    this.ctx = ctx;
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    const open = [...this.sessions.values()].filter((s) => !s.ended).length;
    return [{ provider: this.id, label: t('hooks'), path: '/api/hooks/gemini-cli', sessions: open, ok: true }];
  }

  // ---------------------------------------------------------------- hooks

  onHook(payload: unknown): AgentEvent[] {
    const now = this.now();
    const h = parseHookBody(payload, now);
    if (!h) {
      // Events we don't register (PreCompress, BeforeModel…) from an older or hand-made install: ignored, not errors.
      const name = (payload as { hook_event_name?: unknown } | null)?.hook_event_name;
      if (typeof name === 'string' && /^[A-Z][A-Za-z]{2,40}$/.test(name) && !(HOOK_EVENTS as readonly string[]).includes(name)) return [];
      throw new Error('not a Gemini CLI hook payload');
    }
    let s = this.sessions.get(h.sessionId);
    if (!s) {
      s = this.newSession(h);
      this.sessions.set(h.sessionId, s);
    }
    if (h.cwd) s.cwd = h.cwd;
    if (h.pid !== undefined) s.pid = h.pid;
    // Resume: SessionStart names a file that's never created; later hooks name the real one.
    if (h.transcriptPath && h.transcriptPath !== s.transcriptPath) this.follow(s, h.transcriptPath);
    const out: AgentEvent[] = [];
    if (!s.started && h.event !== 'SessionStart') {
      // A session already running when the office started (or ACP mode, which fires no SessionStart).
      s.started = true;
      out.push(this.ev(s, undefined, 'session.start', h.at));
    }
    // What the chat file says comes first (a cancelled call before the next prompt, tokens before the turn ends).
    out.push(...this.pumpChat(s));
    switch (h.event) {
      case 'SessionStart':
        out.push(...this.sessionStart(s, h));
        break;
      case 'SessionEnd':
        if (h.reason === 'clear') {
          // The same process continues under a new id: wait for SessionStart(clear).
          if (!s.ended) this.clears.push({ session: s, at: now });
          this.end(s, now);
        } else if (!s.ended) {
          // /quit fires SessionEnd twice: only the first counts.
          this.end(s, now);
          out.push(this.ev(s, undefined, 'session.end', h.at));
        }
        break;
      case 'BeforeAgent':
        s.inTurn = true;
        out.push(this.ev(s, undefined, 'turn.start', h.at, h.prompt ? { prompt: h.prompt } : {}));
        break;
      case 'AfterAgent':
        s.inTurn = false;
        s.open.clear();
        s.invokeDepth = 0;
        out.push(this.ev(s, undefined, 'turn.end', h.at));
        break;
      case 'BeforeTool':
        out.push(...this.beforeTool(s, h));
        break;
      case 'AfterTool':
        out.push(...this.afterTool(s, h));
        break;
      case 'Notification':
        if (h.notificationType === 'ToolPermission') {
          const text = h.details?.title ?? h.message;
          out.push(this.ev(s, undefined, 'waiting', h.at, { waiting: text ? { reason: 'permission', text } : { reason: 'permission' } }));
        }
        break;
    }
    return out;
  }

  private sessionStart(s: Session, h: GeminiHook): AgentEvent[] {
    const extra: Partial<AgentEvent> = {};
    if (h.source === 'clear') {
      const now = this.now();
      const i = this.clears.findIndex((c) => now - c.at <= CLEAR_PAIR_MS && ((s.pid !== undefined && c.session.pid === s.pid) || (s.pid === undefined && c.session.cwd === s.cwd)));
      if (i >= 0) {
        const prev = this.clears.splice(i, 1)[0]!.session;
        extra.continues = prev.sessionId;
        s.pid ??= prev.pid;
      }
    }
    s.started = true;
    s.ended = false;
    delete s.endedAt;
    return [this.ev(s, undefined, 'session.start', h.at, extra)];
  }

  private beforeTool(s: Session, h: GeminiHook): AgentEvent[] {
    const name = h.toolName;
    if (!name) return [];
    s.hookTools = true;
    if (name === 'invoke_agent') {
      s.invokeDepth++;
      const role = typeof h.toolInput?.agent_name === 'string' ? h.toolInput.agent_name : undefined;
      if (role) s.pendingRoles.push(role.slice(0, 40));
    } else if (s.invokeDepth > 0) {
      return []; // a subagent's tool: its chat file reports it
    }
    const id = `${name}#${++s.seq}`;
    const queue = s.open.get(name) ?? [];
    queue.push(id);
    s.open.set(name, queue);
    const tool: EventTool = { id, name };
    if (h.toolInput) tool.input = h.toolInput;
    if (h.toolInput?.is_background === true) tool.background = true;
    return [this.ev(s, undefined, 'tool.start', h.at, { tool })];
  }

  private afterTool(s: Session, h: GeminiHook): AgentEvent[] {
    const name = h.toolName;
    if (!name) return [];
    if (name === 'invoke_agent') s.invokeDepth = Math.max(0, s.invokeDepth - 1);
    else if (s.invokeDepth > 0) return [];
    const id = s.open.get(name)?.shift();
    if (!id) return [];
    const r = h.toolResult ?? { ok: true };
    const tool: EventTool = { id, name, ok: r.ok };
    if (!r.ok) tool.error = r.errorType ?? (r.exitCode !== undefined ? `exit_${r.exitCode}` : 'error');
    const out = [this.ev(s, undefined, 'tool.end', h.at, { tool })];
    if (r.backgroundPid !== undefined) out.push(...this.jobStart(s, r.backgroundPid, h.toolInput ?? {}, h.at));
    return out;
  }

  private jobStart(s: Session, pid: number, input: Record<string, unknown>, at: number): AgentEvent[] {
    if (s.jobs.has(pid)) return [];
    const id = `pid:${pid}`;
    s.jobs.set(pid, id);
    const job: { id: string; label?: string; command?: string } = { id };
    if (typeof input.description === 'string') job.label = input.description;
    if (typeof input.command === 'string') job.command = input.command;
    return [this.ev(s, undefined, 'job.start', at, { job })];
  }

  // ---------------------------------------------------------------- chat files

  private follow(s: Session, path: string): void {
    s.transcriptPath = path;
    const tail = new FileTail(path);
    // A file already written (the office started mid-session, or a resume): only its end, and no replay of tools
    // the hooks may have reported already.
    tail.seekTail(TAIL_BYTES);
    s.tail = tail;
  }

  /** New lines of the session's chat file and its subagents' files, as events. */
  private pumpChat(s: Session): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (!s.tail) return out;
    let lightTools = 0;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = s.tail.read();
      } catch (err) {
        log.warnOnce(`gemini-chat:${s.sessionId}`, `Gemini CLI: could not read a chat file (${errMsg(err)}).`);
        break;
      }
      if (r.reset) s.chat = createChatState();
      for (const line of r.lines) {
        for (const item of parseChatLine(s.chat, line, this.now())) {
          const before = out.length;
          out.push(...this.mainItem(s, item));
          if (item.type === 'tool' && !s.hookTools && out.length > before) lightTools++;
        }
      }
      if (!r.more) break;
    }
    // Tools read from the chat after the turn already ended (profile `light`): the agent is idle again.
    if (lightTools > 0 && !s.inTurn && s.started) out.push(this.ev(s, undefined, 'turn.end', s.chat.lastAt ?? this.now()));
    out.push(...this.pumpSubs(s));
    return out;
  }

  private mainItem(s: Session, item: ChatItem): AgentEvent[] {
    switch (item.type) {
      case 'usage':
        return [this.ev(s, undefined, 'usage', item.at, { tokens: item.tokens, ...(item.model ? { model: item.model } : {}) })];
      case 'prompt':
        return []; // prompts come from BeforeAgent
      case 'cancelled': {
        // A denied or cancelled permission: no hook fires after it. The open tools and the turn end here.
        const out: AgentEvent[] = [];
        for (const [name, ids] of s.open) for (const id of ids) out.push(this.ev(s, undefined, 'tool.end', item.at, { tool: { id, name, ok: false, error: 'cancelled' } }));
        s.open.clear();
        s.invokeDepth = 0;
        if (s.inTurn) {
          s.inTurn = false;
          out.push(this.ev(s, undefined, 'turn.end', item.at));
        }
        return out;
      }
      case 'tool':
        return this.mainTool(s, item.call);
    }
  }

  private mainTool(s: Session, call: ChatToolCall): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (call.name === 'invoke_agent' && call.agentId) {
      const sub = s.subs.get(call.agentId);
      if (sub?.started && !sub.done) out.push(this.subEnd(s, sub, call.endAt, call.status === 'success' && call.goal !== false));
    }
    if (s.hookTools) {
      // Hooks reported this call; only a cancellation (no AfterTool) needs the chat.
      if (call.status === 'cancelled') {
        const id = s.open.get(call.name)?.shift();
        if (id) out.push(this.ev(s, undefined, 'tool.end', call.endAt, { tool: { id, name: call.name, ok: false, error: 'cancelled' } }));
      }
      return out;
    }
    const tool: EventTool = { id: call.id, name: call.name, input: call.input };
    if (call.input.is_background === true) tool.background = true;
    out.push(this.ev(s, undefined, 'tool.start', call.startAt, { tool }));
    out.push(this.ev(s, undefined, 'tool.end', call.endAt, { tool: endedTool(call) }));
    if (call.backgroundPid !== undefined) out.push(...this.jobStart(s, call.backgroundPid, call.input, call.endAt));
    return out;
  }

  /** Subagent chat files: chats/<sessionId>/<subagentId>.jsonl. */
  private pumpSubs(s: Session): AgentEvent[] {
    if (!s.transcriptPath || s.ended) return [];
    const out: AgentEvent[] = [];
    const dir = join(dirname(s.transcriptPath), s.sessionId);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // no subagents yet
    }
    for (const name of names) {
      const m = /^([\w-]+)\.jsonl$/.exec(name);
      if (!m || s.subs.has(m[1]!)) continue;
      s.subs.set(m[1]!, { id: m[1]!, tail: new FileTail(join(dir, name)), chat: createChatState(), started: false, done: false });
    }
    const now = this.now();
    for (const sub of [...s.subs.values()]) {
      if (sub.done) {
        if (now - (sub.doneAt ?? now) > FORGET_MS) s.subs.delete(sub.id);
        continue;
      }
      const items: ChatItem[] = [];
      for (let i = 0; i < 4; i++) {
        let r;
        try {
          r = sub.tail.read();
        } catch {
          break;
        }
        for (const line of r.lines) items.push(...parseChatLine(sub.chat, line, now));
        if (!r.more) break;
      }
      if (!sub.started) {
        if (sub.chat.kind !== 'subagent' && !items.length) continue;
        sub.started = true;
        const subagent: { role: string; title?: string } = { role: s.pendingRoles.shift() ?? t('Subagent') };
        if (sub.chat.firstPrompt) subagent.title = sub.chat.firstPrompt.split('\n')[0]!.slice(0, 120);
        out.push(this.ev(s, sub.id, 'subagent.start', sub.chat.lastAt ?? now, { subagent }));
      }
      for (const item of items) {
        if (sub.done) break;
        switch (item.type) {
          case 'usage':
            out.push(this.ev(s, sub.id, 'usage', item.at, { tokens: item.tokens, ...(item.model ? { model: item.model } : {}) }));
            break;
          case 'tool': {
            const tool: EventTool = { id: item.call.id, name: item.call.name, input: item.call.input };
            out.push(this.ev(s, sub.id, 'tool.start', item.call.startAt, { tool }));
            out.push(this.ev(s, sub.id, 'tool.end', item.call.endAt, { tool: endedTool(item.call) }));
            if (item.call.name === 'complete_task') out.push(this.subEnd(s, sub, item.call.endAt, item.call.status === 'success'));
            break;
          }
          case 'cancelled':
            out.push(this.subEnd(s, sub, item.at, false));
            break;
          default:
            break;
        }
      }
      if (!sub.done && sub.started && now - sub.tail.mtimeMs > SUB_IDLE_MS) out.push(this.subEnd(s, sub, now, true));
    }
    return out;
  }

  private subEnd(s: Session, sub: SubChat, at: number, ok: boolean): AgentEvent {
    sub.done = true;
    sub.doneAt = this.now();
    return this.ev(s, sub.id, 'subagent.end', at, ok ? {} : { subagent: { ok: false } });
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      for (const e of this.poll()) this.ctx?.emit(e);
    } catch (err) {
      log.warnOnce(`gemini-poll:${errMsg(err)}`, `Gemini CLI: a polling round failed (${errMsg(err)}).`);
    }
  }

  /** One round: chat files, background commands, unpaired /clear, forgetting. Returns the events (also for tests). */
  poll(): AgentEvent[] {
    const now = this.now();
    const out: AgentEvent[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.ended) {
        if (now - (s.endedAt ?? now) > FORGET_MS) this.sessions.delete(s.sessionId);
        continue;
      }
      out.push(...this.pumpChat(s));
      for (const [pid, id] of [...s.jobs]) {
        if (this.isAlive(pid)) continue;
        s.jobs.delete(pid);
        out.push(this.ev(s, undefined, 'job.end', now, { job: { id } }));
      }
    }
    // SessionEnd(clear) without the SessionStart(clear) that should follow: the process really left.
    for (const c of [...this.clears]) {
      if (now - c.at <= CLEAR_PAIR_MS) continue;
      this.clears.splice(this.clears.indexOf(c), 1);
      out.push(this.ev(c.session, undefined, 'session.end', now));
    }
    return out;
  }

  // ---------------------------------------------------------------- helpers

  private newSession(h: GeminiHook): Session {
    const home = h.transcriptPath ? geminiHomeOf(h.transcriptPath) : undefined;
    const s: Session = {
      sessionId: h.sessionId,
      account: home ? accountSlug(home, this.home) : 'default',
      chat: createChatState(),
      started: false,
      hookTools: false,
      open: new Map(),
      seq: 0,
      invokeDepth: 0,
      pendingRoles: [],
      inTurn: false,
      jobs: new Map(),
      subs: new Map(),
      ended: false,
    };
    if (h.cwd) s.cwd = h.cwd;
    return s;
  }

  private end(s: Session, now: number): void {
    s.ended = true;
    s.endedAt = now;
    s.inTurn = false;
    s.open.clear();
  }

  private ev(s: Session, agent: string | undefined, type: AgentEventType, at: number, extra: Partial<AgentEvent> = {}): AgentEvent {
    const e: AgentEvent = { v: 1, provider: this.id, account: s.account, session: s.sessionId, at, type, ...extra };
    if (agent) e.agent = agent;
    if (s.cwd) e.cwd = s.cwd;
    if (s.pid !== undefined) e.pid = s.pid;
    const model = agent ? s.subs.get(agent)?.chat.model : s.chat.model;
    if (model && e.model === undefined) e.model = model;
    return e;
  }
}
