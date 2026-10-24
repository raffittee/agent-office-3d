// Ported from habblaud server/permissions/registry.ts (MIT, © 2026 Márcio Junior)
// Answering from the office (P7-01, P7-02): the registry of pending permission requests.
//
// A CLI's permission hook (hooks/claude-permission.mjs for Claude Code's PermissionRequest) posts each request to
// POST /api/permissions and waits for the decision on GET /api/permissions/:id/wait (long-poll). The page answers on
// POST /api/permissions/:id/decision. The registry:
// - takes a request only when the interactive features are on (server side), a page is open and the session is known
//   (otherwise the hook leaves at once and the terminal carries on as usual);
// - publishes it on the agent (AgentInfo.permission, through the Office) and raises a "needs you" notice;
// - hands the decision to the hook (allow or deny, the answers of a question) or releases it without one ("answer in
//   the terminal");
// - drops orphans: the hook's timeout, a hook that died (nobody waiting), an agent that left, and a request answered
//   in the terminal (the tool call ended: Office's onToolEnd, provider-neutral, instead of Habblaud's transcript scan).
// Habblaud's Codex branch, demo requests and phone access were left out.
import { randomBytes } from 'node:crypto';
import { maskSecrets, truncate } from '../../shared/activity';
import { answerSummary, ANSWER_OTHER_MAX, ASK_TOOL, checkAnswers } from '../../shared/answers';
import { t } from '../../shared/i18n';
import type { Activity, AgentInfo, PermissionAnswer, PermissionDecision, PermissionRequestInfo, PermissionSuggestionInfo, ProviderId } from '../../shared/protocol';
import { permissionView } from '../../shared/permission-view';
import { describeToolFor } from '../../shared/tools';

/** The hook's default wait (it sends its own in `timeout_ms`). */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
/** Slack after the hook's timeout before the request goes away by itself. */
export const EXPIRY_GRACE_MS = 5_000;
/** Longest answer to one long-poll (the hook asks again right after). */
export const WAIT_MAX_MS = 25_000;
/** No hook waiting for this long = the hook died (cancelled, timed out, session interrupted). */
export const ORPHAN_MS = 8_000;
/** A decision kept for a hook that was between two waits. */
export const RESOLVED_KEEP_MS = 30_000;
export const MAX_PENDING = 32;
/** A long wait with no page open for this long goes back to the terminal (nobody would see it). */
export const UNWATCHED_MS = 5 * 60_000;

const DESTINATIONS = new Set(['session', 'localSettings', 'projectSettings', 'userSettings']);
const MAX_SUGGESTIONS = 4;
const MAX_MESSAGE = 1_000;
const RULE_MAX = 160;
/** Answers in an `answer` decision (ask-the-user tools ask up to 4 questions). */
const MAX_ANSWERS = 4;
/** Providers whose hooks can register requests (Gemini's is a P7-03 spike; Codex's could follow). */
const PROVIDERS: ReadonlySet<string> = new Set(['claude-code']);

/** What the registry needs from the Office (small, for tests). */
export interface OfficeLike {
  list(): AgentInfo[];
  get(id: string): AgentInfo | undefined;
  markDirty(): void;
  noteActivity(id: string, activity: Activity): void;
  noticeNeedsYou(id: string, text: string): void;
}

export interface RegistryOptions {
  office: OfficeLike;
  /** Pages connected (Hub.size): with none, the request isn't taken from the terminal. */
  viewers: () => number;
  now?: () => number;
  tickMs?: number;
  orphanMs?: number;
  resolvedKeepMs?: number;
  maxPending?: number;
}

export type SkipReason = 'no-viewers' | 'unknown-session' | 'unsupported-tool' | 'unsupported-provider' | 'too-many';
export type RegisterResult = { id: string; expiresAt: number } | { skip: SkipReason };
export type ReleaseReason = 'terminal' | 'answered' | 'expired' | 'orphan' | 'gone' | 'unwatched' | 'shutdown';

/** One wait's answer. `answer`: the answers by position (the hook swaps them for the original texts). */
export type WaitResult =
  | { status: 'pending' }
  | { status: 'decided'; behavior: 'allow' | 'deny'; message?: string; interrupt?: boolean; suggestion?: number }
  | { status: 'decided'; behavior: 'answer'; answers: PermissionAnswer[] }
  | { status: 'released'; reason: ReleaseReason };

/** invalid = an unknown rule suggestion; invalid-answer = a decision that doesn't fit the kind of request. */
export type DecideResult = 'ok' | 'not-found' | 'conflict' | 'invalid' | 'invalid-answer';

/** A validation error in the hook's body (→ 400). */
export class InvalidRequest extends Error {}

interface Waiter {
  done: (r: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The ORIGINAL shape of a question, to check the answers that come back by position. */
interface AskFormat {
  multiSelect: boolean;
  options: number;
}

interface Pending {
  /** The full version (with `input`): GET /api/permissions/:id. */
  info: PermissionRequestInfo;
  askFormat?: Array<AskFormat | undefined>;
  agentId: string;
  waiters: Set<Waiter>;
  /** Since when no hook waits. */
  idleSince: number;
  outcome?: Exclude<WaitResult, { status: 'pending' }>;
  resolvedAt?: number;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

const isQuestion = (info: { tool: string }) => info.tool === ASK_TOOL;

/** `answer` is for questions only, and a question isn't approved without its answers. */
function wrongKind(info: PermissionRequestInfo, d: PermissionDecision): boolean {
  return d.behavior === 'answer' ? !isQuestion(info) || !info.questions?.length : d.behavior === 'allow' && isQuestion(info);
}

function askFormat(raw: unknown): Array<AskFormat | undefined> {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const r = rec(q);
    return r ? { multiSelect: r.multiSelect === true, options: Array.isArray(r.options) ? r.options.length : 0 } : undefined;
  });
}

/** Real questions (with text) in the original: all must show in the office to answer from there. */
function askCount(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter((q) => {
    const text = rec(q)?.question;
    return typeof text === 'string' && !!text.trim();
  }).length;
}

function fitsFormat(f: AskFormat | undefined, a: PermissionAnswer): boolean {
  if (!f) return false;
  const options = a.options ?? [];
  if (options.some((i) => i >= f.options)) return false;
  return f.multiSelect || options.length + (a.other ? 1 : 0) === 1;
}

/** An agent that can still get a request (hasn't left or finished). */
function present(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.status !== 'offline' && a.status !== 'done';
}

/** "Bash(npm test:*)" from {toolName, ruleContent}. */
function ruleText(raw: unknown): string | undefined {
  const r = rec(raw);
  const tool = shortStr(r?.toolName, 200);
  if (!tool) return undefined;
  const content = typeof r?.ruleContent === 'string' && r.ruleContent.trim() ? r.ruleContent : undefined;
  return truncate(maskSecrets(content ? `${tool}(${content})` : tool), RULE_MAX);
}

/**
 * The "always allow" suggestions the office offers: only `addRules` with `behavior: "allow"` to a known destination.
 * The page picks one by position and the hook applies the ORIGINAL suggestion (the server never invents rules).
 */
export function pickSuggestions(raw: unknown): PermissionSuggestionInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionSuggestionInfo[] = [];
  raw.forEach((s, index) => {
    const r = rec(s);
    if (!r || r.type !== 'addRules' || r.behavior !== 'allow' || typeof r.destination !== 'string' || !DESTINATIONS.has(r.destination)) return;
    const rules = Array.isArray(r.rules) ? r.rules.map(ruleText).filter((x): x is string => !!x) : [];
    if (!rules.length || out.length >= MAX_SUGGESTIONS) return;
    out.push({ index, rules: rules.slice(0, 4), destination: r.destination });
  });
  return out;
}

/** Validates the hook's JSON (what the CLI gives on stdin, plus the hook's `timeout_ms` and `provider`). */
export function parseHookInput(raw: unknown): { provider: ProviderId; sessionId: string; agentId?: string; agentType?: string; cwd?: string; tool: string; input: Rec; suggestions: unknown; timeoutMs: number } {
  const r = rec(raw);
  const sessionId = shortStr(r?.session_id, 200);
  const tool = shortStr(r?.tool_name, 200);
  if (!r || !sessionId || !tool) throw new InvalidRequest('expected the PermissionRequest hook JSON (session_id and tool_name)');
  const timeout = typeof r.timeout_ms === 'number' && Number.isFinite(r.timeout_ms) ? r.timeout_ms : DEFAULT_TIMEOUT_MS;
  const provider = (shortStr(r.provider, 60) ?? 'claude-code') as ProviderId;
  const out: ReturnType<typeof parseHookInput> = {
    provider,
    sessionId,
    tool,
    input: rec(r.tool_input) ?? {},
    suggestions: r.permission_suggestions,
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeout)),
  };
  const agentId = shortStr(r.agent_id, 200);
  const agentType = shortStr(r.agent_type, 120);
  const cwd = shortStr(r.cwd, 4_096);
  if (agentId) out.agentId = agentId;
  if (agentType) out.agentType = agentType;
  if (cwd) out.cwd = cwd;
  return out;
}

function parseAnswers(raw: unknown): PermissionAnswer[] | undefined {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ANSWERS) return undefined;
  const out: PermissionAnswer[] = [];
  for (const item of raw) {
    const r = rec(item);
    if (!r || !isIndex(r.question)) return undefined;
    const a: PermissionAnswer = { question: r.question };
    if (r.options !== undefined) {
      if (!Array.isArray(r.options) || !r.options.every(isIndex) || new Set(r.options).size !== r.options.length) return undefined;
      if (r.options.length) a.options = (r.options as number[]).slice().sort((x, y) => x - y);
    }
    if (r.other !== undefined) {
      if (typeof r.other !== 'string') return undefined;
      const other = r.other.trim();
      if (other.length > ANSWER_OTHER_MAX) return undefined;
      if (other) a.other = other;
    }
    out.push(a);
  }
  return out;
}

/** A decision from the page. */
export function parseDecision(raw: unknown): PermissionDecision | undefined {
  const r = rec(raw);
  if (r?.behavior === 'answer') {
    const answers = parseAnswers(r.answers);
    return answers ? { behavior: 'answer', answers } : undefined;
  }
  if (r?.behavior === 'terminal') return { behavior: 'terminal' };
  if (r?.behavior === 'deny') {
    const d: PermissionDecision = { behavior: 'deny' };
    if (typeof r.message === 'string' && r.message.trim()) d.message = r.message.trim().slice(0, MAX_MESSAGE);
    if (r.interrupt === true) d.interrupt = true;
    return d;
  }
  if (r?.behavior === 'allow') {
    if (r.suggestion === undefined) return { behavior: 'allow' };
    return isIndex(r.suggestion) ? { behavior: 'allow', suggestion: r.suggestion } : undefined;
  }
  return undefined;
}

export class PermissionRegistry {
  private pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly orphanMs: number;
  private readonly resolvedKeepMs: number;
  private readonly maxPending: number;
  private unwatchedSince: number | null = null;

  constructor(private readonly opts: RegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.orphanMs = opts.orphanMs ?? ORPHAN_MS;
    this.resolvedKeepMs = opts.resolvedKeepMs ?? RESOLVED_KEEP_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 500);
    this.timer.unref?.();
  }

  /** Stops the clock and releases everyone waiting (the hooks leave without a decision). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.pending.values()) if (!p.outcome) this.release(p, 'shutdown');
  }

  /** Open requests (no decision yet). */
  get size(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.outcome) n++;
    return n;
  }

  /** Registers a request from a hook. `{skip}` = leave it to the terminal. An invalid body throws InvalidRequest. */
  register(raw: unknown): RegisterResult {
    const req = parseHookInput(raw);
    if (!PROVIDERS.has(req.provider)) return { skip: 'unsupported-provider' };
    const desc = describeToolFor(req.provider, req.tool, req.input);
    const ask = isQuestion(req);
    const questions = desc.questions;
    // A question: every one must show in the office (the hook answers only if each has an answer).
    if (ask && (!questions?.length || questions.length !== askCount(req.input.questions))) return { skip: 'unsupported-tool' };
    if (this.opts.viewers() <= 0) return { skip: 'no-viewers' };
    const target = this.resolveAgent(req.provider, req.sessionId, req.agentId, req.agentType);
    if (!target) return { skip: 'unknown-session' };
    if (this.size >= this.maxPending) return { skip: 'too-many' };

    const now = this.now();
    const id = `p-${now.toString(36)}-${++this.seq}-${randomBytes(9).toString('base64url')}`;
    const view = permissionView(req.tool, req.input, req.cwd);
    const info: PermissionRequestInfo = { id, provider: req.provider, tool: truncate(req.tool, 120), title: view.title, text: desc.text, icon: desc.icon, createdAt: now, expiresAt: now + req.timeoutMs };
    if (view.input && !ask) info.input = view.input;
    if (target.subagent) info.subagent = target.subagent;
    const suggestions = pickSuggestions(req.suggestions);
    if (suggestions.length && !ask) info.suggestions = suggestions;
    if (ask) info.questions = questions;

    const p: Pending = { info, agentId: target.id, waiters: new Set(), idleSince: now };
    if (ask) p.askFormat = askFormat(req.input.questions);
    this.pending.set(id, p);

    const name = this.opts.office.get(target.id)?.name ?? '';
    const by = target.subagent ? t(' (subagent {0})', [target.subagent]) : '';
    const first = info.questions?.[0]?.question;
    if (first) {
      const all = info.questions!.map((q) => q.question).join(' · ');
      this.opts.office.noteActivity(target.id, { id: `${target.id}#perm:${id}`, at: now, kind: 'wait', icon: '❓', text: truncate(t('Question: {0}', [first]), 46), detail: truncate(all, 300), tool: 'PermissionRequest' });
      this.opts.office.noticeNeedsYou(target.id, t('❓ {0} asks: {1}{2}', [name, truncate(first, 120), by]));
    } else {
      this.opts.office.noteActivity(target.id, { id: `${target.id}#perm:${id}`, at: now, kind: 'wait', icon: '🔐', text: truncate(t('Asks permission: {0}', [desc.text]), 46), detail: view.title, tool: 'PermissionRequest' });
      this.opts.office.noticeNeedsYou(target.id, t('🔐 {0} asks permission: {1}{2}', [name, desc.text, by]));
    }
    this.opts.office.markDirty();
    return { id, expiresAt: info.expiresAt + EXPIRY_GRACE_MS };
  }

  /** The full detail of an open request (with the arguments), or undefined. */
  detail(id: string): PermissionRequestInfo | undefined {
    const p = this.pending.get(id);
    return p && !p.outcome ? { ...p.info, ...this.queueOf(p) } : undefined;
  }

  /** The oldest open request of each agent (without `input`), with how many wait after it. The Office's snapshot. */
  snapshot(): Map<string, PermissionRequestInfo> {
    const out = new Map<string, PermissionRequestInfo>();
    const counts = new Map<string, number>();
    for (const p of this.pending.values()) {
      if (p.outcome) continue;
      counts.set(p.agentId, (counts.get(p.agentId) ?? 0) + 1);
      if (out.has(p.agentId)) continue;
      const { input: _input, ...info } = p.info;
      out.set(p.agentId, info);
    }
    for (const [agentId, info] of out) {
      const n = (counts.get(agentId) ?? 1) - 1;
      if (n > 0) info.queued = n;
    }
    return out;
  }

  /** Waits up to `ms` for a decision. undefined = unknown id (the hook gives up). A decision already taken comes back at once. */
  wait(id: string, ms: number): { result: Promise<WaitResult>; cancel: () => void } | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    if (p.outcome) {
      const outcome = p.outcome;
      this.pending.delete(id);
      return { result: Promise.resolve(outcome), cancel: () => {} };
    }
    let waiter: Waiter | undefined;
    const result = new Promise<WaitResult>((done) => {
      const timer = setTimeout(() => this.dropWaiter(p, waiter!, { status: 'pending' }), Math.max(0, Math.min(ms, WAIT_MAX_MS)));
      timer.unref?.();
      waiter = { done, timer };
      p.waiters.add(waiter);
    });
    return { result, cancel: () => waiter && this.dropWaiter(p, waiter) };
  }

  /** The page's decision. */
  decide(id: string, d: PermissionDecision): DecideResult {
    const p = this.pending.get(id);
    if (!p) return 'not-found';
    if (p.outcome) return 'conflict';
    if (d.behavior === 'terminal') {
      this.release(p, 'terminal');
      return 'ok';
    }
    if (wrongKind(p.info, d)) return 'invalid-answer';
    if (d.behavior === 'answer') return this.answer(p, d.answers);
    if (d.behavior === 'allow' && d.suggestion !== undefined && !p.info.suggestions?.some((s) => s.index === d.suggestion)) return 'invalid';
    const outcome: WaitResult = { status: 'decided', behavior: d.behavior };
    if (d.behavior === 'deny' && d.message) outcome.message = d.message;
    if (d.behavior === 'deny' && d.interrupt) outcome.interrupt = true;
    if (d.behavior === 'allow' && d.suggestion !== undefined) outcome.suggestion = d.suggestion;
    this.resolve(p, outcome);
    const now = this.now();
    const act: Activity =
      d.behavior === 'allow'
        ? { id: `${p.agentId}#perm-ok:${id}`, at: now, kind: 'other', icon: '✅', text: d.suggestion !== undefined ? t('Approved in the office (always allow)') : t('Approved in the office'), detail: p.info.title, tool: 'PermissionRequest' }
        : { id: `${p.agentId}#perm-no:${id}`, at: now, kind: 'wait', icon: '🚫', text: t('Denied in the office'), detail: d.message ? `${p.info.title} — ${truncate(maskSecrets(d.message), 200)}` : p.info.title, tool: 'PermissionRequest' };
    this.opts.office.noteActivity(p.agentId, act);
    return 'ok';
  }

  /** The tool call of an agent ended: a request for it was answered in the terminal (first one wins in the CLI). */
  toolEnded(agentId: string, tool: string, at: number): void {
    for (const p of this.pending.values()) {
      if (p.outcome || p.agentId !== agentId || p.info.tool !== tool || at < p.info.createdAt - 1_000) continue;
      this.release(p, 'answered');
      return;
    }
  }

  /** Clock: expiry, orphans, agents that left, nobody watching, and cleanup of delivered decisions. */
  tick(): void {
    const now = this.now();
    this.unwatchedSince = this.opts.viewers() > 0 ? null : (this.unwatchedSince ?? now);
    const unwatched = this.unwatchedSince !== null && now - this.unwatchedSince >= UNWATCHED_MS;
    for (const [id, p] of this.pending) {
      if (p.outcome) {
        if (now - (p.resolvedAt ?? now) >= this.resolvedKeepMs) this.pending.delete(id);
        continue;
      }
      if (now >= p.info.expiresAt + EXPIRY_GRACE_MS) this.release(p, 'expired');
      else if (!p.waiters.size && now - p.idleSince >= this.orphanMs) this.release(p, 'orphan');
      else if (!present(this.opts.office.get(p.agentId))) this.release(p, 'gone');
      else if (unwatched && p.info.expiresAt - p.info.createdAt > DEFAULT_TIMEOUT_MS) this.release(p, 'unwatched');
    }
  }

  // ---------------------------------------------------------------- internals

  /** Each question shown answered exactly once, also checked against the ORIGINAL shape (the hook finds texts by position). */
  private answer(p: Pending, raw: PermissionAnswer[]): DecideResult {
    const questions = p.info.questions ?? [];
    const answers = checkAnswers(questions, raw);
    if (!answers || answers.some((a) => !fitsFormat(p.askFormat?.[a.question], a))) return 'invalid-answer';
    this.resolve(p, { status: 'decided', behavior: 'answer', answers });
    this.opts.office.noteActivity(p.agentId, { id: `${p.agentId}#perm-answer:${p.info.id}`, at: this.now(), kind: 'other', icon: '💬', text: t('Answered in the office'), detail: answerSummary(questions, answers), tool: 'PermissionRequest' });
    return 'ok';
  }

  /** The agent of a request: the subagent when the office shows it, else the main agent (with the subagent's type). */
  private resolveAgent(provider: ProviderId, sessionId: string, agentId?: string, agentType?: string): { id: string; subagent?: string } | undefined {
    const agents = this.opts.office.list().filter((a) => a.provider === provider && a.sessionId === sessionId && present(a));
    const main = agents.find((a) => a.kind === 'main');
    if (agentId) {
      const sub = agents.find((a) => a.kind === 'sub' && a.id.endsWith(`:${agentId}`));
      if (sub) return { id: sub.id };
    }
    if (!main) return undefined;
    return agentId ? { id: main.id, subagent: agentType ?? t('subagent') } : { id: main.id };
  }

  private queueOf(p: Pending): { queued?: number } {
    // by arrival order (the Map's), not createdAt: two requests in the same millisecond would count each other
    let n = 0;
    let after = false;
    for (const o of this.pending.values()) {
      if (o === p) after = true;
      else if (after && !o.outcome && o.agentId === p.agentId) n++;
    }
    return n ? { queued: n } : {};
  }

  private dropWaiter(p: Pending, w: Waiter, result?: WaitResult): void {
    if (!p.waiters.delete(w)) return;
    clearTimeout(w.timer);
    if (!p.waiters.size) p.idleSince = this.now();
    if (result) w.done(result);
  }

  private resolve(p: Pending, outcome: Exclude<WaitResult, { status: 'pending' }>): void {
    p.outcome = outcome;
    p.resolvedAt = this.now();
    const delivered = p.waiters.size > 0;
    for (const w of [...p.waiters]) this.dropWaiter(p, w, outcome);
    // delivered: gone now; otherwise kept until the hook comes back (or RESOLVED_KEEP_MS)
    if (delivered) this.pending.delete(p.info.id);
    this.opts.office.markDirty();
  }

  private release(p: Pending, reason: ReleaseReason): void {
    this.resolve(p, { status: 'released', reason });
  }
}
