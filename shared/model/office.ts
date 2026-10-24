// Ported from habblaud server/model/office.ts (MIT, © 2026 Márcio Junior)
// The office model, rewritten as a reducer over AgentEvent (ADR 0002): one status machine for every provider.
// Adapters call apply(); the SSE hub calls commit() (throttled) to get the new snapshot, feed and notices; a timer
// calls tick() to expire grace periods and refresh filler bubbles. Pure (no Node or DOM APIs): the server runs it, and so
// does the browser in mock mode (?mock=1) with the demo simulator. Habblaud's rules are kept: grace periods,
// synthesized "Done"/"Needs you" bubbles, shell-wait bubbles, notice dedupe and quiet boots.
import { JOB_WAIT_TOOL, SPECIAL, describeJob, describePrompt, maskSecrets, truncate } from '../activity';
import { hash32 } from '../hash';
import { t } from '../i18n';
import { nameKey, type NameSource } from '../names';
import {
  mainIdOf,
  type AccountInfo,
  type Activity,
  type AgentDetail,
  type AgentEvent,
  type AgentInfo,
  type AgentStats,
  type AgentStatus,
  type FeedItem,
  type Notice,
  type NoticeLevel,
  type OfficeSnapshot,
  type ProviderId,
  type ProviderMeta,
  type RoomEffect,
  type RoomInfo,
  type ShellJob,
  type SourceInfo,
} from '../protocol';
import { ALARM_MS, PARTY_MS, roomSignalCandidate, settleSignal, signalText, type RoomSignalCandidate } from '../room-effects';
import { describeToolFor } from '../tools';
import { SlotAllocator, normalizeCwd, roomDisplayNames } from './rooms';

export const OFFLINE_GRACE_MS = 20_000;
export const DONE_GRACE_MS = 25_000;
export const SLOT_COOLDOWN_MS = 30_000;
export const NOTICE_DEDUPE_MS = 10_000;
/** "Waiting for the shell" notice: at most one every 10 min per agent. */
export const SHELL_NOTICE_DEDUPE_MS = 600_000;
/** Activities per agent in the snapshot; the long history comes from GET /api/agents/:id. */
export const SNAPSHOT_RECENT = 8;
const RECENT_LIMIT = 30;
const HISTORY_LIMIT = 200;
const FEED_LIMIT = 200;
const PROMPT_MAX = 2_000;
/** Room for agents whose events carry no cwd (custom agents may not report one). */
export const UNKNOWN_ROOM = '(no project)';

export interface OfficeDeps {
  /** Character names (server: persisted in names.json; browser mock mode: in memory). */
  names: NameSource;
  /** Name the user chose for a folder's room (server/model/room-aliases.ts), if any. */
  roomAlias?: (path: string) => string | undefined;
  version: string;
  /** Build of the client being served (OfficeSnapshot.meta.build); absent in dev and tests. */
  build?: () => string | undefined;
  startedAt: number;
  /** Accounts, given the number of open sessions per `${provider}|${account}`. */
  accounts?: (sessions: ReadonlyMap<string, number>) => AccountInfo[];
  sources?: () => SourceInfo[];
  providers?: () => ProviderMeta[];
  /** Friendly account name for notices ("Account D"). */
  accountName?: (provider: ProviderId, account: string) => string | undefined;
  /** Simulated agents are in the office (OfficeSnapshot.meta.demo). */
  demo?: boolean;
  /** The default theme pack id (OfficeSnapshot.meta.theme, from AGENT_OFFICE_THEME). */
  theme?: string;
  now?: () => number;
}

export interface CommitResult {
  snapshot: OfficeSnapshot;
  changed: boolean;
  feed: FeedItem[];
  notices: Notice[];
}

/** An agent the liveness checker should look at (P1-07). */
export interface LivenessTarget {
  id: string;
  provider: ProviderId;
  pid?: number;
  procStart?: string;
  lastEventAt: number;
}

interface AgentRecord {
  info: AgentInfo;
  history: Activity[];
  removeAt?: number;
  pid?: number;
  procStart?: string;
  /** Start of the current turn (for "Done in X"). */
  turnStart?: number;
  /** "Done" synthesized by the status change (replaced by a real one if it arrives). */
  synthDone?: { id: string; at: number };
  /** "Needs you" synthesized; leaving the wait brings the previous activity back. */
  synthWait?: { id: string; prev?: Activity };
  /** "Waiting for the shell" bubble of this 'shell' episode (and the activity it covered). */
  shellWait?: { id: string; prev?: Activity };
  /** Open tool calls (id or name → start time), for durations. */
  openTools: Map<string, number>;
  /** Open tool calls that may become a room effect (id or name → candidate), settled at tool.end. */
  roomFx?: Map<string, RoomSignalCandidate>;
}

type NoticeKind = 'arrive' | 'room' | 'wait' | 'deliver' | 'done' | 'leave' | 'shell' | 'jobDone' | 'effect';

function zeroStats(): AgentStats {
  return { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };
}

function cloneAgent(a: AgentInfo): AgentInfo {
  const c: AgentInfo = { ...a, recent: a.recent.slice(), tasks: a.tasks.map((x) => ({ ...x })), stats: { ...a.stats } };
  if (a.jobs) c.jobs = a.jobs.map((j) => ({ ...j }));
  return c;
}

/** Names compared without case or Unicode-form differences. */
class NameSet extends Set<string> {
  private folded = new Set<string>();
  override add(name: string): this {
    // Set's constructor calls add before fields exist: only use `new NameSet()` without arguments.
    this.folded?.add(nameKey(name));
    return super.add(name);
  }
  override has(name: string): boolean {
    return this.folded.has(nameKey(name));
  }
}

const byStart = (a: ShellJob, b: ShellJob) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

function waitingText(e: AgentEvent): string {
  const text = e.waiting?.text?.trim();
  if (text) return truncate(maskSecrets(text), 60);
  switch (e.waiting?.reason) {
    case 'permission':
      return t('approve a permission');
    case 'question':
      return t('answer a question');
    default:
      return t('answer in the terminal');
  }
}

export class Office {
  private agents = new Map<string, AgentRecord>();
  /** Main-agent id of a session that continues another (`/clear`) → the id of the agent it continues. */
  private aliases = new Map<string, string>();
  private rooms = new Map<string, { path: string; createdAt: number; effect?: RoomEffect }>();
  private slots = new SlotAllocator(SLOT_COOLDOWN_MS);
  private roomNames = new Map<string, string>();
  private feed: FeedItem[] = [];
  private pendingFeed: FeedItem[] = [];
  private pendingNotices: Notice[] = [];
  private noticeAt = new Map<string, number>();
  private listeners = new Set<() => void>();
  private rev = 0;
  private dirty = true;
  private last: OfficeSnapshot | null = null;
  private booting = false;
  private bootDepth = 0;
  private bootFeed: FeedItem[] = [];
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly deps: OfficeDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Called (synchronously) on every change; the hub decides when to commit(). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  markDirty(): void {
    this.dirty = true;
    this.listeners.forEach((cb) => cb());
  }

  // ---------------------------------------------------------------- boot

  /**
   * While booting: no notices; the feed is put in chronological order at the end. Counted: each adapter calls
   * beginBoot when it starts rebuilding open sessions and endBoot when it's done (in a `finally`); the office is
   * ready (sorted feed, wait bubbles, no late notices) when the last one finishes.
   */
  beginBoot(): void {
    if (this.bootDepth++ > 0) return;
    this.booting = true;
    this.bootFeed = [];
  }

  endBoot(): void {
    if (this.bootDepth === 0) return;
    if (--this.bootDepth > 0) return;
    this.booting = false;
    const sorted = this.bootFeed.sort((a, b) => a.activity.at - b.activity.at).slice(-FEED_LIMIT);
    this.bootFeed = [];
    this.feed = [...this.feed, ...sorted].slice(-FEED_LIMIT);
    // Whoever was already waiting for you when the server started gets the "Needs you" bubble (nothing is
    // synthesized during the boot; no notice, it isn't news).
    for (const rec of this.agents.values()) {
      const info = rec.info;
      if (info.status !== 'waiting' || rec.synthWait || info.activity?.kind === 'ask') continue;
      const prev = info.activity;
      const act: Activity = { id: `${info.id}#wait:${++this.seq}`, at: info.statusSince, ...SPECIAL.waiting(info.waitingFor) };
      this.addActivity(rec, act, { feed: false });
      rec.synthWait = prev ? { id: act.id, prev } : { id: act.id };
    }
    this.markDirty();
  }

  isBooting(): boolean {
    return this.booting;
  }

  // ---------------------------------------------------------------- queries

  has(id: string): boolean {
    return this.agents.has(id);
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id)?.info;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map((r) => r.info);
  }

  /** The agent id an event resolves to (aliases from `/clear` applied). */
  resolve(e: Pick<AgentEvent, 'provider' | 'account' | 'session' | 'agent'>): string {
    const main = this.aliases.get(mainIdOf(e)) ?? mainIdOf(e);
    return e.agent ? `${main}:${e.agent}` : main;
  }

  roomName(roomId: string): string {
    return this.roomNames.get(roomId) ?? roomId.split('/').filter(Boolean).pop() ?? roomId;
  }

  detail(id: string): AgentDetail | undefined {
    const rec = this.agents.get(id);
    return rec ? { agent: cloneAgent(rec.info), history: rec.history.slice() } : undefined;
  }

  recentFeed(n: number): FeedItem[] {
    return this.feed.slice(-n);
  }

  /** Present agents with what the liveness checker needs. */
  livenessTargets(): LivenessTarget[] {
    const out: LivenessTarget[] = [];
    for (const rec of this.agents.values()) {
      if (rec.info.kind !== 'main' || rec.info.status === 'offline') continue;
      const tgt: LivenessTarget = { id: rec.info.id, provider: rec.info.provider, lastEventAt: rec.info.lastEventAt };
      if (rec.pid !== undefined) tgt.pid = rec.pid;
      if (rec.procStart !== undefined) tgt.procStart = rec.procStart;
      out.push(tgt);
    }
    return out;
  }

  // ---------------------------------------------------------------- the reducer

  /** Applies one (validated, masked) event. */
  apply(e: AgentEvent): void {
    if (e.type === 'session.start' && e.continues) this.continueSession(e);
    const mainId = this.resolve({ ...e, agent: undefined });
    let main = this.agents.get(mainId);
    if (e.type === 'session.end' && !e.agent) {
      if (main) this.closeMain(main);
      return;
    }
    if (!main) main = this.addMain(mainId, e);
    else if (main.info.status === 'offline' && e.type !== 'session.end') this.revive(main);
    if (e.pid !== undefined) main.pid = e.pid;
    if (e.procStart !== undefined) main.procStart = e.procStart;

    let rec = main;
    if (e.agent) {
      const subId = `${mainId}:${e.agent}`;
      const sub = this.agents.get(subId) ?? (e.type === 'subagent.end' ? undefined : this.addSub(subId, main, e));
      if (!sub) return;
      rec = sub;
    }
    this.touch(rec, e);

    switch (e.type) {
      case 'session.start':
        // New agents start idle; a returning one was revived above.
        break;
      case 'session.end':
        // A subagent's session ended: it is done.
        this.completeSub(rec);
        break;
      case 'turn.start':
        if (e.prompt?.trim()) this.addActivity(rec, { id: `${rec.info.id}#prompt:${e.at}`, at: e.at, ...describePrompt(e.prompt.slice(0, PROMPT_MAX)) });
        rec.turnStart = e.at;
        this.setStatus(rec, 'working');
        break;
      case 'turn.end':
        rec.openTools.clear();
        rec.roomFx?.clear();
        this.setStatus(rec, rec.info.jobs?.some((j) => j.background) ? 'shell' : 'idle');
        break;
      case 'tool.start':
        this.toolStart(rec, e);
        break;
      case 'tool.end':
        this.toolEnd(rec, e);
        break;
      case 'waiting':
        this.setStatus(rec, 'waiting', waitingText(e));
        break;
      case 'subagent.start':
        // addSub above created it; a repeated start reactivates a finished one.
        if (rec.info.status === 'done') this.reactivateSub(rec);
        break;
      case 'subagent.end':
        this.completeSub(rec, e.subagent?.ok);
        break;
      case 'job.start':
        this.jobStart(rec, e);
        break;
      case 'job.end':
        this.jobEnd(rec, e);
        break;
      case 'tasks':
        rec.info.tasks = (e.tasks ?? []).map((x) => ({ id: x.id, title: truncate(maskSecrets(x.title), 120), status: x.status, ...(x.activeForm ? { activeForm: truncate(maskSecrets(x.activeForm), 120) } : {}) }));
        break;
      case 'usage':
        if (e.tokens) {
          rec.info.stats.tokensIn += (e.tokens.in ?? 0) + (e.tokens.cached ?? 0);
          rec.info.stats.tokensOut += e.tokens.out ?? 0;
        }
        break;
      case 'compact':
        this.addActivity(rec, { id: `${rec.info.id}#compact:${e.at}`, at: e.at, ...SPECIAL.compact() });
        break;
      case 'heartbeat':
        break;
    }
    this.markDirty();
  }

  /** Liveness lost (the process is gone): same as session.end. */
  markOffline(id: string): void {
    const rec = this.agents.get(id);
    if (rec && rec.info.kind === 'main') this.closeMain(rec);
  }

  // ---------------------------------------------------------------- main agents

  private addMain(id: string, e: AgentEvent): AgentRecord {
    const now = this.now();
    const path = e.cwd?.trim() || UNKNOWN_ROOM;
    const roomId = e.cwd?.trim() ? normalizeCwd(path) : UNKNOWN_ROOM;
    this.ensureRoom(roomId, path, now);
    const person = this.deps.names.assign(`${e.provider}:${e.session}`, this.takenNames());
    const info: AgentInfo = {
      id,
      kind: 'main',
      provider: e.provider,
      roomId,
      name: person.name,
      look: person.look,
      role: t('Main agent'),
      sessionId: e.session,
      account: e.account,
      status: 'idle',
      recent: [],
      tasks: [],
      startedAt: e.at,
      lastEventAt: e.at,
      statusSince: now,
      stats: zeroStats(),
      seed: hash32(id),
    };
    const rec: AgentRecord = { info, history: [], openTools: new Map() };
    this.agents.set(id, rec);
    const acc = this.deps.accountName?.(e.provider, e.account);
    this.notice('arrive', id, 'info', t('👋 {0} arrived in {1}{2}', [info.name, this.roomName(roomId), acc ? ` (${acc})` : '']), roomId);
    return rec;
  }

  /** `/clear` (or a resume in the same process): the character stays, tasks and numbers reset. */
  private continueSession(e: AgentEvent): void {
    const oldMain = this.aliases.get(mainIdOf({ ...e, session: e.continues! })) ?? mainIdOf({ ...e, session: e.continues! });
    const newMain = mainIdOf(e);
    const rec = this.agents.get(oldMain);
    if (!rec || newMain === oldMain || this.agents.has(newMain)) return;
    this.aliases.set(newMain, oldMain);
    const info = rec.info;
    this.deps.names.remember(`${e.provider}:${e.session}`, { name: info.name, look: info.look });
    info.sessionId = e.session;
    info.tasks = [];
    info.stats = zeroStats();
    delete info.title;
    if (info.status === 'offline') this.revive(rec);
    this.addActivity(rec, { id: `${oldMain}#clear:${++this.seq}`, at: e.at, ...SPECIAL.cleared() });
  }

  private revive(rec: AgentRecord): void {
    delete rec.removeAt;
    rec.info.status = 'idle';
    rec.info.statusSince = this.now();
    for (const sub of this.descendants(rec.info.id)) if (sub.removeAt !== undefined && sub.info.status !== 'done') delete sub.removeAt;
  }

  private closeMain(rec: AgentRecord): void {
    if (rec.info.status === 'offline') return;
    const now = this.now();
    const info = rec.info;
    info.status = 'offline';
    info.statusSince = now;
    delete info.waitingFor;
    // Jobs die with the session.
    delete info.jobs;
    delete rec.shellWait;
    rec.openTools.clear();
    delete rec.roomFx;
    rec.removeAt = now + OFFLINE_GRACE_MS;
    for (const sub of this.descendants(info.id)) {
      delete sub.info.jobs;
      if (sub.info.status !== 'done') {
        sub.info.status = 'done';
        sub.info.statusSince = now;
      }
      sub.removeAt = Math.min(sub.removeAt ?? Infinity, rec.removeAt);
    }
    this.notice('leave', info.id, 'info', t('🚪 {0} ended the session', [info.name]), info.roomId);
    this.markDirty();
  }

  // ---------------------------------------------------------------- subagents

  private addSub(id: string, main: AgentRecord, e: AgentEvent): AgentRecord {
    const now = this.now();
    const parentId = e.parentAgent ? `${main.info.id}:${e.parentAgent}` : main.info.id;
    const parent = this.agents.get(parentId) ?? main;
    const person = this.deps.names.assign(`${e.provider}:${e.session}:${e.agent}`, this.takenNames());
    const info: AgentInfo = {
      id,
      kind: 'sub',
      provider: main.info.provider,
      parentId: parent.info.id,
      roomId: main.info.roomId,
      name: person.name,
      look: person.look,
      role: e.subagent?.role ? truncate(e.subagent.role, 40) : t('Subagent'),
      sessionId: main.info.sessionId,
      account: main.info.account,
      status: 'working',
      recent: [],
      tasks: [],
      startedAt: e.at,
      lastEventAt: e.at,
      statusSince: now,
      stats: zeroStats(),
      seed: hash32(id),
    };
    const title = e.subagent?.title ?? e.title;
    if (title) info.title = truncate(maskSecrets(title), 120);
    if (e.subagent?.background) info.background = true;
    const rec: AgentRecord = { info, history: [], openTools: new Map(), turnStart: e.at };
    this.agents.set(id, rec);
    parent.info.stats.subagents++;
    return rec;
  }

  private completeSub(rec: AgentRecord, ok?: boolean): void {
    const info = rec.info;
    if (info.kind !== 'sub' || info.status === 'done' || info.status === 'offline') return;
    const now = this.now();
    info.status = 'done';
    info.statusSince = now;
    delete info.jobs;
    delete info.waitingFor;
    rec.removeAt = now + DONE_GRACE_MS;
    if (!this.booting && info.activity?.kind !== 'done') {
      const desc = ok === false ? SPECIAL.error(undefined, info.title) : SPECIAL.turnDone(now - info.startedAt);
      this.addActivity(rec, { id: `${info.id}#done:${++this.seq}`, at: now, ...desc, ...(ok === false ? {} : { durationMs: now - info.startedAt }) });
    }
    const parent = info.parentId ? this.agents.get(info.parentId)?.info : undefined;
    const what = info.title ? `“${truncate(info.title, 40)}”` : t('the work');
    this.notice('deliver', info.id, ok === false ? 'warn' : 'success', t('📦 {0} delivered {1} to {2}', [info.name, what, parent?.name ?? t('the main agent')]), info.roomId);
  }

  private reactivateSub(rec: AgentRecord): void {
    const parent = rec.info.parentId ? this.agents.get(rec.info.parentId) : undefined;
    if (!parent || parent.info.status === 'offline') return;
    rec.info.status = 'working';
    rec.info.statusSince = this.now();
    delete rec.removeAt;
  }

  // ---------------------------------------------------------------- tools and jobs

  private toolStart(rec: AgentRecord, e: AgentEvent): void {
    const tool = e.tool!;
    const desc = describeToolFor(rec.info.provider, tool.name, tool.input);
    const key = tool.id ?? `${tool.name}#${++this.seq}`;
    rec.openTools.set(tool.id ?? tool.name, e.at);
    const fx = roomSignalCandidate(tool.name, tool.input);
    if (fx) (rec.roomFx ??= new Map()).set(tool.id ?? tool.name, fx);
    const act: Activity = { id: `${rec.info.id}#tool:${key}`, at: e.at, tool: tool.name, ...desc };
    rec.info.stats.toolCalls++;
    this.addActivity(rec, act);
    this.setStatus(rec, 'working');
  }

  private toolEnd(rec: AgentRecord, e: AgentEvent): void {
    const tool = e.tool!;
    const started = rec.openTools.get(tool.id ?? tool.name);
    rec.openTools.delete(tool.id ?? tool.name);
    const fx = rec.roomFx?.get(tool.id ?? tool.name);
    if (fx) {
      rec.roomFx!.delete(tool.id ?? tool.name);
      this.roomSignal(rec, settleSignal(fx, tool.ok), e.at);
    }
    if (tool.ok === false) {
      const err = tool.error ?? '';
      const desc = err === 'denied' ? SPECIAL.rejected(tool.name) : err === 'cancelled' ? SPECIAL.cancelled() : SPECIAL.error(tool.name, err || undefined);
      const act: Activity = { id: `${rec.info.id}#tool-end:${tool.id ?? `${tool.name}:${++this.seq}`}`, at: e.at, tool: tool.name, ...desc };
      if (err !== 'denied' && err !== 'cancelled') act.error = true;
      if (started !== undefined) act.durationMs = Math.max(0, e.at - started);
      this.addActivity(rec, act);
    }
    // A finished tool ends a wait (the permission was answered); a denial or cancel usually ends the turn too,
    // and the adapter follows with turn.end.
    if (rec.info.status === 'waiting') this.setStatus(rec, 'working');
  }

  /**
   * A party or an alarm in the agent's room (P6-04). A green CI ends the room's alarm (with a short party); a
   * plain green CI with no alarm is routine and shows nothing. Old events (a boot replaying transcripts) don't fire.
   */
  private roomSignal(rec: AgentRecord, sig: ReturnType<typeof settleSignal>, at: number): void {
    if (!sig) return;
    const room = this.rooms.get(rec.info.roomId);
    if (!room) return;
    const now = this.now();
    const alarm = sig.kind === 'ci_failed';
    if (sig.kind === 'ci_passed' && room.effect?.kind !== 'alarm') return;
    const until = Math.min(at, now) + (alarm ? ALARM_MS : PARTY_MS);
    if (this.booting || until <= now) return;
    const text = signalText(sig);
    room.effect = { kind: alarm ? 'alarm' : 'party', text, at: now, until, agentId: rec.info.id };
    this.dirty = true;
    this.notice('effect', rec.info.id, alarm ? 'alert' : 'success', `${rec.info.name}: ${text}`, rec.info.roomId, { dedupeKey: `${rec.info.roomId}|fx|${text}` });
  }

  private jobStart(rec: AgentRecord, e: AgentEvent): void {
    const job = e.job!;
    const d = describeJob(job.command ?? '', job.label);
    const next: ShellJob = { id: job.id, label: d.label, startedAt: e.at, background: true, kind: 'shell' };
    if (d.command) next.command = d.command;
    rec.info.jobs = [...(rec.info.jobs ?? []).filter((j) => j.id !== job.id), next].sort(byStart);
  }

  private jobEnd(rec: AgentRecord, e: AgentEvent): void {
    const info = rec.info;
    const job = info.jobs?.find((j) => j.id === e.job!.id);
    if (!job) return;
    const rest = (info.jobs ?? []).filter((j) => j.id !== job.id);
    if (rest.length) info.jobs = rest;
    else delete info.jobs;
    const outcome = e.job!.ok === false ? 'failed' : 'ok';
    const ms = Math.max(0, e.at - job.startedAt);
    const act: Activity = { id: `${info.id}#job-done:${job.id}`, at: e.at, ...SPECIAL.jobDone(job.label, outcome, ms, job.command) };
    if (outcome === 'ok') act.durationMs = ms;
    this.addActivity(rec, act);
    const room = this.roomName(info.roomId);
    const text = outcome === 'ok' ? t('✅ {0}: shell finished in {1} — {2}', [info.name, room, job.label]) : t('❌ {0}: shell failed in {1} — {2}', [info.name, room, job.label]);
    this.notice('jobDone', info.id, outcome === 'ok' ? 'success' : 'warn', text, info.roomId, { dedupeKey: `${info.id}|jobDone|${job.id}` });
    if (info.status === 'shell' && !info.jobs?.some((j) => j.background)) this.setStatus(rec, 'idle');
  }

  // ---------------------------------------------------------------- status

  private setStatus(rec: AgentRecord, status: AgentStatus, waitingFor?: string): void {
    const info = rec.info;
    const prev = info.status;
    const reason = status === 'waiting' ? (waitingFor ?? t('answer in the terminal')) : undefined;
    if (prev === status && info.waitingFor === reason) return;
    if (info.kind === 'sub' && prev === 'done' && status !== 'done') return;
    const now = this.now();
    if (prev !== status) {
      info.status = status;
      info.statusSince = now;
    }
    if (reason) info.waitingFor = reason;
    else delete info.waitingFor;
    const room = this.roomName(info.roomId);

    if (status === 'working' && (prev === 'idle' || prev === 'shell' || rec.turnStart === undefined)) rec.turnStart ??= now;
    if (status === 'shell' && prev !== 'shell') {
      const { label } = this.jobSummary(rec);
      this.notice('shell', info.id, 'info', t('⏳ {0} is waiting for the shell in {1}{2}', [info.name, room, label ? `: ${label}` : '']), info.roomId, {
        dedupeMs: SHELL_NOTICE_DEDUPE_MS,
      });
    }
    if (prev === 'shell' && status !== 'shell' && rec.shellWait) {
      if (info.activity?.id === rec.shellWait.id && rec.shellWait.prev) info.activity = rec.shellWait.prev;
      delete rec.shellWait;
    }
    if (status === 'waiting' && prev !== 'waiting') {
      if (!this.booting && info.activity?.kind !== 'ask') {
        const prevActivity = info.activity;
        const act: Activity = { id: `${info.id}#wait:${++this.seq}`, at: now, ...SPECIAL.waiting(reason) };
        this.addActivity(rec, act);
        rec.synthWait = prevActivity ? { id: act.id, prev: prevActivity } : { id: act.id };
      }
      this.notice('wait', info.id, 'alert', t('✋ {0} needs you in {1}: {2}', [info.name, room, reason!]), info.roomId);
    }
    if (prev === 'waiting' && status !== 'waiting' && rec.synthWait) {
      if (info.activity?.id === rec.synthWait.id && rec.synthWait.prev) info.activity = rec.synthWait.prev;
      delete rec.synthWait;
    }
    if ((prev === 'working' || prev === 'waiting') && status === 'idle') {
      const cur = info.activity;
      // No "Done" after a denial, a cancel or an interruption (those are 'wait' activities).
      if (!this.booting && cur?.kind !== 'done' && cur?.kind !== 'wait') {
        const ms = rec.turnStart !== undefined ? now - rec.turnStart : undefined;
        const act: Activity = { id: `${info.id}#done:${++this.seq}`, at: now, ...SPECIAL.turnDone(ms) };
        if (ms !== undefined) act.durationMs = ms;
        this.addActivity(rec, act);
        rec.synthDone = { id: act.id, at: now };
      }
      if (info.kind === 'main') this.notice('done', info.id, 'success', t('✅ {0} finished in {1}', [info.name, room]), info.roomId);
    }
    if (status === 'idle' || status === 'shell') delete rec.turnStart;
  }

  /** Label of the oldest job, how many there are and the detail (command). */
  private jobSummary(rec: AgentRecord): { label?: string; count: number; detail?: string } {
    let jobs = rec.info.jobs ?? [];
    if (!jobs.length) {
      // No own jobs known: a subagent may have started the command.
      jobs = this.descendants(rec.info.id)
        .flatMap((r) => r.info.jobs ?? [])
        .filter((j) => j.background)
        .sort(byStart);
    }
    const main = jobs[0];
    if (!main) return { count: 0 };
    const out: { label?: string; count: number; detail?: string } = { label: main.label, count: jobs.length };
    if (main.command) out.detail = main.command;
    return out;
  }

  // ---------------------------------------------------------------- activities

  private touch(rec: AgentRecord, e: AgentEvent): void {
    const info = rec.info;
    if (e.at > info.lastEventAt) info.lastEventAt = e.at;
    if (e.model) info.model = truncate(e.model, 60);
    if (e.gitBranch) info.gitBranch = truncate(e.gitBranch, 80);
    if (e.title && info.kind === 'main') info.title = truncate(maskSecrets(e.title), 120);
  }

  /**
   * Records an activity. `feed: false` = history only. `filler` (only fills the character's bubble) never reaches the
   * feed.
   */
  private addActivity(rec: AgentRecord, activity: Activity, opts: { feed?: boolean; filler?: boolean } = {}): void {
    const info = rec.info;
    // A real "Done" replaces the one synthesized by the status change.
    if (activity.kind === 'done' && rec.synthDone && activity.at - rec.synthDone.at < 60_000 && !activity.id.includes('#done:')) {
      const synthId = rec.synthDone.id;
      const replaced: Activity = { ...activity, id: synthId };
      const swap = (list: Activity[]) => list.map((a) => (a.id === synthId ? replaced : a));
      info.recent = swap(info.recent);
      rec.history = swap(rec.history);
      if (info.activity?.id === synthId) info.activity = replaced;
      delete rec.synthDone;
      return;
    }
    // Replaying the same event (adapter restart, re-read transcript): no duplicates.
    if (info.recent.some((a) => a.id === activity.id)) return;
    if (activity.kind !== 'done') delete rec.synthDone;
    info.recent = [...info.recent, activity].slice(-RECENT_LIMIT);
    rec.history.push(activity);
    if (rec.history.length > HISTORY_LIMIT) rec.history.splice(0, rec.history.length - HISTORY_LIMIT);
    info.activity = activity;
    if (activity.at > info.lastEventAt) info.lastEventAt = activity.at;
    if (!opts.filler) {
      const item: FeedItem = {
        id: activity.id,
        agentId: info.id,
        roomId: info.roomId,
        agentName: info.name,
        roomName: this.roomName(info.roomId),
        provider: info.provider,
        account: info.account,
        activity,
      };
      if (this.booting) this.bootFeed.push(item);
      else if (opts.feed !== false) this.pushFeed([item]);
    }
  }

  /**
   * Working, but nothing new for a while (the last activity is the previous turn's "Done", e.g. waiting for
   * background subagents): show something consistent with "working".
   */
  private fillWorkingActivity(rec: AgentRecord): void {
    const info = rec.info;
    if (info.status !== 'working') return;
    const cur = info.activity;
    const now = this.now();
    if (cur && (cur.kind !== 'done' || now - cur.at < 15_000)) return;
    const busySubs = [...this.agents.values()].some((r) => r.info.parentId === info.id && r.info.status === 'working');
    const desc = busySubs ? SPECIAL.supervising() : SPECIAL.think();
    this.addActivity(rec, { id: `${info.id}#busy:${++this.seq}`, at: now, ...desc }, { filler: true });
  }

  /**
   * Status 'shell': the bubble shows "Waiting for the shell: <label>", never the turn's "Done". It only covers what
   * is behind (end of turn, activities before the wait, its own bubble with another label); what happens during
   * the wait (e.g. one of the jobs ending) still shows. The first bubble of each wait goes to the feed.
   */
  private fillShellActivity(rec: AgentRecord): void {
    const info = rec.info;
    if (info.status !== 'shell') return;
    const { label, count, detail } = this.jobSummary(rec);
    const desc = SPECIAL.waitingShell(label, count, detail);
    const cur = info.activity;
    const mine = cur?.tool === JOB_WAIT_TOOL;
    if (mine && cur.text === desc.text) return;
    if (cur && !mine && cur.kind !== 'done' && cur.at > info.statusSince) return;
    const now = this.now();
    const act: Activity = { id: `${info.id}#shell-wait:${++this.seq}`, at: Math.max(now, info.statusSince), ...desc };
    const first = !rec.shellWait;
    const prev = mine ? rec.shellWait?.prev : cur;
    this.addActivity(rec, act, { filler: !first || this.booting });
    rec.shellWait = prev ? { id: act.id, prev } : { id: act.id };
  }

  // ---------------------------------------------------------------- clock

  /** Removes whoever served their grace period and refreshes filler bubbles. Call every ~250 ms. */
  tick(): void {
    const now = this.now();
    let removed = false;
    for (const room of this.rooms.values()) {
      if (room.effect && now >= room.effect.until) {
        delete room.effect;
        this.dirty = true;
      }
    }
    for (const [id, rec] of this.agents) {
      if (rec.removeAt !== undefined && now >= rec.removeAt) {
        this.agents.delete(id);
        removed = true;
        continue;
      }
      const before = rec.info.activity?.id;
      this.fillWorkingActivity(rec);
      this.fillShellActivity(rec);
      if (rec.info.activity?.id !== before) this.dirty = true;
    }
    if (removed) {
      for (const [alias, target] of [...this.aliases]) if (!this.agents.has(target)) this.aliases.delete(alias);
      const occupied = new Set([...this.agents.values()].map((r) => r.info.roomId));
      for (const id of [...this.rooms.keys()]) if (!occupied.has(id)) this.rooms.delete(id);
      this.recomputeRoomNames();
      this.dirty = true;
    }
    if (this.dirty) this.markDirty();
  }

  /** Closes a revision: returns the snapshot (new, if something changed), the feed and the pending notices. */
  commit(): CommitResult {
    const feed = this.pendingFeed;
    const notices = this.pendingNotices;
    this.pendingFeed = [];
    this.pendingNotices = [];
    if (!this.dirty && this.last) return { snapshot: this.last, changed: false, feed, notices };
    this.rev++;
    this.dirty = false;
    this.last = this.build();
    return { snapshot: this.last, changed: true, feed, notices };
  }

  // ---------------------------------------------------------------- internals

  private build(): OfficeSnapshot {
    const now = this.now();
    this.slots.sync(this.rooms.keys(), now);
    const rooms: RoomInfo[] = [...this.rooms]
      .map(([id, r]) => {
        const room: RoomInfo = { id, name: this.roomName(id), path: r.path, slot: this.slots.slotOf(id) ?? 0, seed: hash32(id), createdAt: r.createdAt };
        if (r.effect && now < r.effect.until) room.effect = { ...r.effect };
        return room;
      })
      .sort((a, b) => a.slot - b.slot);
    const agents = [...this.agents.values()].map((r) => {
      const a = cloneAgent(r.info);
      if (a.recent.length > SNAPSHOT_RECENT) a.recent = a.recent.slice(-SNAPSHOT_RECENT);
      return a;
    });
    const sessions = new Map<string, number>();
    for (const a of agents) if (a.kind === 'main' && a.status !== 'offline') sessions.set(`${a.provider}|${a.account}`, (sessions.get(`${a.provider}|${a.account}`) ?? 0) + 1);
    const build = this.deps.build?.();
    return {
      rev: this.rev,
      serverTime: now,
      rooms,
      agents,
      accounts: this.deps.accounts?.(sessions) ?? [],
      meta: {
        demo: !!this.deps.demo,
        sources: this.deps.sources?.() ?? [],
        providers: this.deps.providers?.() ?? [],
        startedAt: this.deps.startedAt,
        version: this.deps.version,
        ...(build ? { build } : {}),
        ...(this.deps.theme ? { theme: this.deps.theme } : {}),
      },
    };
  }

  /** Names the draw can't give: those of everyone in the office. */
  private takenNames(): Set<string> {
    const used = new NameSet();
    for (const r of this.agents.values()) used.add(r.info.name);
    return used;
  }

  private descendants(id: string): AgentRecord[] {
    const out: AgentRecord[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const rec of this.agents.values()) {
        if (rec.info.parentId === cur) {
          out.push(rec);
          queue.push(rec.info.id);
        }
      }
    }
    return out;
  }

  private ensureRoom(roomId: string, path: string, now: number): void {
    if (this.rooms.has(roomId)) return;
    this.rooms.set(roomId, { path, createdAt: now });
    this.recomputeRoomNames();
    this.notice('room', roomId, 'info', t('🏗️ New room: {0}', [this.roomName(roomId)]), roomId);
  }

  private recomputeRoomNames(): void {
    const paths = new Map([...this.rooms].map(([id, r]) => [id, r.path]));
    this.roomNames = roomDisplayNames(paths);
    for (const [id, path] of paths) {
      const alias = this.deps.roomAlias?.(path);
      if (alias) this.roomNames.set(id, alias);
    }
  }

  /** A room name changed (rename): recompute and broadcast. */
  refreshRoomNames(): void {
    this.recomputeRoomNames();
    this.markDirty();
  }

  private pushFeed(items: FeedItem[]): void {
    this.pendingFeed.push(...items);
    this.feed.push(...items);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
  }

  private notice(kind: NoticeKind, key: string, level: NoticeLevel, text: string, roomId?: string, opts: { dedupeKey?: string; dedupeMs?: number } = {}): void {
    if (this.booting) return;
    const now = this.now();
    const k = opts.dedupeKey ?? `${key}|${kind}`;
    const window = opts.dedupeMs ?? NOTICE_DEDUPE_MS;
    const last = this.noticeAt.get(k);
    if (last !== undefined && now - last < window) return;
    this.noticeAt.set(k, now);
    if (this.noticeAt.size > 2_000) {
      for (const [nk, at] of this.noticeAt) if (now - at > Math.max(NOTICE_DEDUPE_MS, SHELL_NOTICE_DEDUPE_MS)) this.noticeAt.delete(nk);
    }
    const n: Notice = { id: `n-${now.toString(36)}-${++this.seq}`, level, text, at: now };
    if (kind !== 'room') n.agentId = key;
    if (roomId) n.roomId = roomId;
    this.pendingNotices.push(n);
  }
}
