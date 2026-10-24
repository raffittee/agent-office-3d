// Ported from habblaud server/messages/registry.ts (MIT, © 2026 Márcio Junior), reshaped to be provider-neutral.
// Messages from the office (P7-04): the queue of what the page sends to agents.
//
// The page sends with POST /api/messages. Delivery depends on the provider:
// - an inbox, for Claude Code (the agent-office-messages plugin, a round every 2 s in each open session) and custom
//   agents (the SDKs' `inbox()`): the session fetches its own messages with POST /api/inbox, delivers each one as if
//   the user typed it, and confirms with POST /api/inbox/ack. Polling marks the session PRESENT (AgentInfo.canMessage);
// - `codex queue` for Codex (messages/codex.ts), run by the server with the account's CODEX_HOME.
// The registry keeps each agent's messages in order and tracks them (queued → sent → delivered | failed); it fails the
// ones nobody fetched, the ones the session didn't confirm, and the ones of an agent that left. It adds the "Message
// from the office" activity when a delivery is confirmed. The text goes to the session exactly as typed (it's the
// user's own) and never comes back in a page response or the log; only the activity carries its start, masked and cut.
import { randomBytes } from 'node:crypto';
import { truncate } from '../../shared/activity';
import { describeMessage, MESSAGE_MAX } from '../../shared/messages';
import type { Activity, AgentInfo, InboxMessage, OutboxMessage, ProviderId } from '../../shared/protocol';
import type { CodexQueueRunner } from './codex';

/** A session that polled its inbox this recently can receive messages (canMessage). */
export const PRESENCE_MS = 10_000;
/** A queued message nobody fetched in this time fails. */
export const QUEUED_TIMEOUT_MS = 60_000;
/** A fetched message the session didn't confirm in this time fails. */
export const SENT_TIMEOUT_MS = 30_000;
/** A resolved message stays this long for GET /api/messages/:id. */
export const KEEP_MS = 10 * 60_000;
/** Open (unresolved) messages per agent; the next one gets 429. */
export const MAX_OPEN = 5;
/** Messages handed to an inbox per round. */
export const INBOX_BATCH = 5;

export const ERR_NOT_FETCHED = 'the session did not fetch the message: is the agent-office-messages plugin (or the SDK inbox) running?';
export const ERR_NOT_CONFIRMED = 'the session did not confirm the delivery';
export const ERR_GONE = 'the agent left the office';
export const ERR_REFUSED = 'the session did not accept the message';

const ERROR_MAX = 300;
const ID_MAX = 300;
const ACK_MAX = 50;

/** What the registry needs from the Office (small, for tests). */
export interface OfficeLike {
  get(id: string): AgentInfo | undefined;
  list(): AgentInfo[];
  markDirty(): void;
  noteActivity(id: string, activity: Activity): void;
}

export interface MessageRegistryOptions {
  office: OfficeLike;
  /** Codex delivery; absent = Codex agents can't receive messages. */
  codex?: { run: CodexQueueRunner; homeOf: (account: string) => string | undefined };
  now?: () => number;
  tickMs?: number;
}

export type SendResult = { message: OutboxMessage } | { error: 'not-found' | 'too-many' | 'invalid' } | { error: 'unavailable'; reason: string };

/** A body error (→ 400). */
export class InvalidRequest extends Error {}

interface Entry {
  msg: OutboxMessage;
  text: string;
  /** The inbox key (`provider|session`), or undefined for Codex. */
  inbox?: string;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const shortStr = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
const present = (a: AgentInfo | undefined): a is AgentInfo => !!a && a.status !== 'offline' && a.status !== 'done';
const inboxKey = (provider: string, session: string) => `${provider}|${session}`;
/** Providers that deliver through an inbox. */
const usesInbox = (p: ProviderId) => p === 'claude-code' || p.startsWith('custom:');

export class MessageRegistry {
  private entries = new Map<string, Entry>();
  /** Inbox key → last poll. */
  private seen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly opts: MessageRegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Can this agent receive a message now? (main agents only) */
  canMessage(a: AgentInfo): boolean {
    if (a.kind !== 'main' || !present(a)) return false;
    if (a.provider === 'codex') return !!this.opts.codex?.homeOf(a.account);
    if (!usesInbox(a.provider)) return false;
    const at = this.seen.get(inboxKey(a.provider, a.sessionId));
    return at !== undefined && this.now() - at <= PRESENCE_MS;
  }

  /** The page sends a message ({agentId, text}). */
  send(raw: unknown): SendResult {
    const r = rec(raw);
    const agentId = shortStr(r?.agentId, ID_MAX);
    const text = typeof r?.text === 'string' ? r.text : '';
    if (!agentId || !text.trim() || text.length > MESSAGE_MAX) return { error: 'invalid' };
    const agent = this.opts.office.get(agentId);
    if (!present(agent) || agent.kind !== 'main') return { error: 'not-found' };
    if (!this.canMessage(agent)) {
      const reason =
        agent.provider === 'codex'
          ? 'cannot reach Codex: run Agent Office with `codex` on PATH (or AGENT_OFFICE_CODEX_BIN)'
          : agent.provider === 'claude-code'
            ? 'this session is not listening: install the agent-office-messages plugin (docs/interactive.md) and keep the session open'
            : usesInbox(agent.provider)
              ? 'this agent is not polling its inbox (see sdk/README.md)'
              : 'this provider cannot receive messages from the office';
      return { error: 'unavailable', reason };
    }
    let open = 0;
    for (const e of this.entries.values()) if (e.msg.agentId === agentId && (e.msg.status === 'queued' || e.msg.status === 'sent')) open++;
    if (open >= MAX_OPEN) return { error: 'too-many' };
    const now = this.now();
    const msg: OutboxMessage = { id: `m-${now.toString(36)}-${++this.seq}-${randomBytes(6).toString('base64url')}`, agentId, status: 'queued', createdAt: now, updatedAt: now };
    const entry: Entry = { msg, text };
    if (agent.provider === 'codex') this.runCodex(entry, agent);
    else entry.inbox = inboxKey(agent.provider, agent.sessionId);
    this.entries.set(msg.id, entry);
    return { message: { ...msg } };
  }

  get(id: string): OutboxMessage | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.msg } : undefined;
  }

  /** An inbox poll ({provider, session}): marks the session present and hands over its queued messages, in order. */
  inbox(raw: unknown): InboxMessage[] {
    const r = rec(raw);
    const provider = shortStr(r?.provider, 60) ?? 'claude-code';
    const session = shortStr(r?.session, ID_MAX);
    if (!session || !usesInbox(provider as ProviderId)) throw new InvalidRequest('expected {provider, session}');
    const key = inboxKey(provider, session);
    const first = !this.seen.has(key) || this.now() - this.seen.get(key)! > PRESENCE_MS;
    this.seen.set(key, this.now());
    // the message box appears (or comes back) in the office
    if (first) this.opts.office.markDirty();
    const out: InboxMessage[] = [];
    for (const e of this.entries.values()) {
      if (out.length >= INBOX_BATCH) break;
      if (e.inbox !== key || e.msg.status !== 'queued') continue;
      this.setStatus(e, 'sent');
      out.push({ id: e.msg.id, text: e.text });
    }
    return out;
  }

  /** An inbox's confirmation ({provider, session, results: [{id, ok, error?}]}). */
  ack(raw: unknown): void {
    const r = rec(raw);
    const provider = shortStr(r?.provider, 60) ?? 'claude-code';
    const session = shortStr(r?.session, ID_MAX);
    const results = Array.isArray(r?.results) ? r.results.slice(0, ACK_MAX) : undefined;
    if (!session || !results) throw new InvalidRequest('expected {provider, session, results: [{id, ok, error?}]}');
    const key = inboxKey(provider, session);
    for (const item of results) {
      const x = rec(item);
      const e = x && typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      // only the session the message went to can confirm it
      if (!e || e.inbox !== key || e.msg.status !== 'sent') continue;
      if (x!.ok === true) this.delivered(e);
      else this.fail(e, typeof x!.error === 'string' && x!.error.trim() ? truncate(x!.error, ERROR_MAX) : ERR_REFUSED);
    }
  }

  /** Clock: timeouts, agents that left, cleanup. */
  tick(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const m = e.msg;
      if (m.status === 'delivered' || m.status === 'failed') {
        if (now - m.updatedAt >= KEEP_MS) this.entries.delete(id);
        continue;
      }
      if (!present(this.opts.office.get(m.agentId))) this.fail(e, ERR_GONE);
      else if (e.inbox && m.status === 'queued' && now - m.createdAt >= QUEUED_TIMEOUT_MS) this.fail(e, ERR_NOT_FETCHED);
      else if (e.inbox && m.status === 'sent' && now - m.updatedAt >= SENT_TIMEOUT_MS) this.fail(e, ERR_NOT_CONFIRMED);
    }
    for (const [key, at] of this.seen) {
      if (now - at > PRESENCE_MS * 6) this.seen.delete(key);
      // presence just ran out: the message box goes away in the office
      else if (now - at > PRESENCE_MS && now - at <= PRESENCE_MS + (this.opts.tickMs ?? 1_000)) this.opts.office.markDirty();
    }
  }

  // ---------------------------------------------------------------- internals

  private runCodex(e: Entry, agent: AgentInfo): void {
    const home = this.opts.codex?.homeOf(agent.account);
    if (!home || !this.opts.codex) return this.fail(e, 'the Codex account folder of this agent is unknown');
    this.setStatus(e, 'sent');
    void this.opts.codex.run({ codexHome: home, thread: agent.sessionId, text: e.text }).then((r) => {
      if (e.msg.status !== 'sent') return;
      if (r.ok) this.delivered(e);
      else this.fail(e, truncate(r.error, ERROR_MAX));
    });
  }

  private delivered(e: Entry): void {
    this.setStatus(e, 'delivered');
    const at = this.now();
    this.opts.office.noteActivity(e.msg.agentId, { id: `${e.msg.agentId}#msg:${e.msg.id}`, at, ...describeMessage(e.text) });
  }

  private fail(e: Entry, error: string): void {
    e.msg.error = error;
    this.setStatus(e, 'failed');
  }

  private setStatus(e: Entry, status: OutboxMessage['status']): void {
    e.msg.status = status;
    e.msg.updatedAt = this.now();
  }
}
