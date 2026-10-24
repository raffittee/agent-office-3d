// Agent Office SDK for TypeScript / JavaScript (P5-02). One file, no dependencies: copy it into your project.
// Works in Node ≥ 18, Bun and Deno (anything with `fetch`).
//
//   const office = new AgentOffice({ name: 'my-agent', cwd: process.cwd() });
//   await office.sessionStart({ title: 'Refactor the parser' });
//   office.turnStart('Fix the failing test');
//   await office.tool('read_file', { path: 'src/parser.ts' }, () => readFile('src/parser.ts'));
//   office.turnEnd();
//   await office.close();
//
// Events go to http://127.0.0.1:<port>/api/events (AGENT_OFFICE_PORT, default 4848), batched. Reporting never
// throws and never slows the agent down: if the office isn't running, events are dropped. A heartbeat every 30 s
// keeps the session visible while the agent is quiet. The protocol is `AgentEvent` (shared/agent-event.schema.json).

export type ToolInput = Record<string, unknown>;

export interface AgentOfficeOptions {
  /** Your agent's name, as a slug (lowercase letters, digits, `.`, `_`, `-`): the provider becomes `custom:<name>`. */
  name: string;
  /** The project folder: it picks the room. Default: process.cwd() when available. */
  cwd?: string;
  /** A stable id for this run. Default: random. */
  session?: string;
  /** An account slug, if your agent has several ('default'). Never a path or an email. */
  account?: string;
  /** The office's base URL. Default: http://127.0.0.1:$AGENT_OFFICE_PORT (4848). */
  url?: string;
  /** Heartbeat period (ms); 0 = off. Default 30 000. */
  heartbeatMs?: number;
  /** Report the process id (lets the office notice a crash). Default: true when `process.pid` exists. */
  pid?: number | false;
  /** Called when posting fails (default: silent). */
  onError?: (err: unknown) => void;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
}

export type EventType =
  | 'session.start'
  | 'session.end'
  | 'turn.start'
  | 'turn.end'
  | 'tool.start'
  | 'tool.end'
  | 'waiting'
  | 'subagent.start'
  | 'subagent.end'
  | 'job.start'
  | 'job.end'
  | 'tasks'
  | 'usage'
  | 'compact'
  | 'heartbeat';

export interface OfficeEvent {
  v: 1;
  provider: `custom:${string}`;
  account: string;
  session: string;
  agent?: string;
  parentAgent?: string;
  cwd?: string;
  at: number;
  pid?: number;
  type: EventType;
  tool?: { id?: string; name: string; input?: unknown; ok?: boolean; error?: string; background?: boolean };
  waiting?: { reason: 'permission' | 'question' | 'input'; text?: string };
  job?: { id: string; label?: string; command?: string; ok?: boolean };
  subagent?: { role?: string; title?: string; background?: boolean; ok?: boolean };
  prompt?: string;
  title?: string;
  model?: string;
  tokens?: { in?: number; out?: number; cached?: number };
  tasks?: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }[];
  gitBranch?: string;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_BATCH = 100;

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}

/** Reports what one agent (and its subagents) is doing. */
export class AgentOffice {
  readonly provider: `custom:${string}`;
  readonly session: string;
  private readonly account: string;
  private readonly cwd: string | undefined;
  private readonly url: string;
  private readonly pid: number | undefined;
  private readonly onError: (err: unknown) => void;
  private readonly fetchFn: typeof fetch | undefined;
  private queue: OfficeEvent[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private model: string | undefined;

  constructor(opts: AgentOfficeOptions) {
    if (!SLUG.test(opts.name)) throw new Error(`AgentOffice: name must be a slug (lowercase letters, digits, ".", "_", "-"), got "${opts.name}"`);
    this.provider = `custom:${opts.name}`;
    this.session = opts.session ?? randomId();
    this.account = opts.account && SLUG.test(opts.account) ? opts.account : 'default';
    const proc = (globalThis as { process?: { cwd?: () => string; pid?: number } }).process;
    this.cwd = opts.cwd ?? proc?.cwd?.();
    this.url = (opts.url ?? `http://127.0.0.1:${env('AGENT_OFFICE_PORT') ?? 4848}`).replace(/\/+$/, '');
    this.pid = opts.pid === false ? undefined : (opts.pid ?? proc?.pid);
    this.onError = opts.onError ?? (() => {});
    this.fetchFn = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    const hb = opts.heartbeatMs ?? 30_000;
    if (hb > 0) {
      this.heartbeat = setInterval(() => this.emit({ type: 'heartbeat' }), hb);
      (this.heartbeat as { unref?: () => void }).unref?.();
    }
  }

  // ---------------------------------------------------------------- the session

  /** The agent started. Resolves once the event was posted (or dropped). */
  sessionStart(o: { title?: string; model?: string; gitBranch?: string } = {}): Promise<void> {
    if (o.model) this.model = o.model;
    this.emit({ type: 'session.start', ...(o.title ? { title: o.title } : {}), ...(o.gitBranch ? { gitBranch: o.gitBranch } : {}) });
    return this.flush();
  }

  /** The agent is done: flushes, stops the heartbeat. */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.emit({ type: 'session.end' });
    await this.flush();
  }

  /** A turn: the agent received work (`prompt` is masked and truncated by the office). */
  turnStart(prompt?: string, agent?: string): void {
    this.emit({ type: 'turn.start', ...(prompt ? { prompt } : {}) }, agent);
  }

  /** The turn ended: the agent is idle. */
  turnEnd(agent?: string): void {
    this.emit({ type: 'turn.end' }, agent);
  }

  // ---------------------------------------------------------------- tools

  /** A tool call started; returns its id for toolEnd. */
  toolStart(name: string, input?: ToolInput, agent?: string): string {
    const id = `t${++this.seq}`;
    this.emit({ type: 'tool.start', tool: { id, name, ...(input ? { input } : {}) } }, agent);
    return id;
  }

  toolEnd(id: string, o: { ok?: boolean; error?: string; name?: string } = {}, agent?: string): void {
    this.emit({ type: 'tool.end', tool: { id, name: o.name ?? 'tool', ...(o.ok !== undefined ? { ok: o.ok } : {}), ...(o.error ? { error: o.error.slice(0, 200) } : {}) } }, agent);
  }

  /** Runs `fn` as a tool call: start, then end (ok or the error's message). Rethrows the error. */
  async tool<T>(name: string, input: ToolInput | undefined, fn: () => T | Promise<T>, agent?: string): Promise<T> {
    const id = this.toolStart(name, input, agent);
    try {
      const out = await fn();
      this.toolEnd(id, { ok: true, name }, agent);
      return out;
    } catch (err) {
      this.toolEnd(id, { ok: false, name, error: err instanceof Error ? err.name : 'error' }, agent);
      throw err;
    }
  }

  // ---------------------------------------------------------------- states

  /** The agent needs the user: a permission, a question, or any input. Cleared by the next tool or turn event. */
  waiting(reason: 'permission' | 'question' | 'input', text?: string, agent?: string): void {
    this.emit({ type: 'waiting', waiting: { reason, ...(text ? { text } : {}) } }, agent);
  }

  /** Tokens used since the last report (deltas, not totals). */
  usage(tokens: { in?: number; out?: number; cached?: number }, model?: string, agent?: string): void {
    if (model) this.model = model;
    this.emit({ type: 'usage', tokens }, agent);
  }

  /** The agent's task list (replaces the previous one). */
  tasks(list: NonNullable<OfficeEvent['tasks']>, agent?: string): void {
    this.emit({ type: 'tasks', tasks: list }, agent);
  }

  /** A background job (a dev server, a long build) started; the agent shows it until jobEnd. */
  jobStart(o: { label?: string; command?: string } = {}, agent?: string): string {
    const id = `j${++this.seq}`;
    this.emit({ type: 'job.start', job: { id, ...o } }, agent);
    return id;
  }

  jobEnd(id: string, ok?: boolean, agent?: string): void {
    this.emit({ type: 'job.end', job: { id, ...(ok !== undefined ? { ok } : {}) } }, agent);
  }

  // ---------------------------------------------------------------- subagents

  /** A subagent: a smaller character that walks its result to its parent when it ends. */
  subagent(o: { role?: string; title?: string; parent?: string } = {}): Subagent {
    const id = `sub-${++this.seq}`;
    this.emit({ type: 'subagent.start', ...(o.parent ? { parentAgent: o.parent } : {}), subagent: { ...(o.role ? { role: o.role } : {}), ...(o.title ? { title: o.title } : {}) } }, id);
    return new Subagent(this, id);
  }

  // ---------------------------------------------------------------- plumbing

  /** Queues an event (posted in a batch on the next tick). */
  emit(e: Partial<OfficeEvent> & { type: EventType }, agent?: string): void {
    const ev: OfficeEvent = { v: 1, provider: this.provider, account: this.account, session: this.session, at: Date.now(), ...e };
    if (agent) ev.agent = agent;
    if (this.cwd) ev.cwd = this.cwd;
    if (this.pid !== undefined) ev.pid = this.pid;
    if (this.model && ev.model === undefined) ev.model = this.model;
    this.queue.push(ev);
    if (this.queue.length >= MAX_BATCH) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 50);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  // ---------------------------------------------------------------- messages from the office (P7-04)

  /**
   * Messages typed for this agent in the office, oldest first. Call it every few seconds while the agent can take
   * input: polling also tells the office this agent can receive messages. Needs the server's interactive features
   * (AGENT_OFFICE_INTERACTIVE=1); otherwise, and on any error, returns []. Confirm each one with `ack()`.
   */
  async inbox(): Promise<{ id: string; text: string }[]> {
    const body = await this.postJson('/api/inbox', { provider: this.provider, session: this.session });
    const list = body && typeof body === 'object' ? (body as { messages?: unknown }).messages : undefined;
    if (!Array.isArray(list)) return [];
    return list.filter((m): m is { id: string; text: string } => !!m && typeof m.id === 'string' && typeof m.text === 'string');
  }

  /** What happened to the messages from `inbox()`: ok, or failed with a reason. Unconfirmed ones fail after 30 s. */
  async ack(results: { id: string; ok: boolean; error?: string }[]): Promise<void> {
    if (results.length) await this.postJson('/api/inbox/ack', { provider: this.provider, session: this.session, results });
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    if (!this.fetchFn) return undefined;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2_000);
      const res = await this.fetchFn(`${this.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return undefined;
      return (await res.json()) as unknown;
    } catch (err) {
      this.onError(err);
      return undefined;
    }
  }

  /** Posts what's queued. Never rejects. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = async (): Promise<void> => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, MAX_BATCH);
        if (!this.fetchFn) return;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 1_500);
          const res = await this.fetchFn(`${this.url}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) this.onError(new Error(`Agent Office answered ${res.status}: ${await res.text().catch(() => '')}`));
        } catch (err) {
          this.onError(err);
        }
      }
    };
    this.flushing = (this.flushing ?? Promise.resolve()).then(run, run);
    return this.flushing;
  }
}

/** A subagent's handle: the same calls, filed under it. */
export class Subagent {
  constructor(
    private readonly office: AgentOffice,
    readonly id: string,
  ) {}

  turnStart(prompt?: string): void {
    this.office.turnStart(prompt, this.id);
  }
  turnEnd(): void {
    this.office.turnEnd(this.id);
  }
  toolStart(name: string, input?: ToolInput): string {
    return this.office.toolStart(name, input, this.id);
  }
  toolEnd(id: string, o: { ok?: boolean; error?: string; name?: string } = {}): void {
    this.office.toolEnd(id, o, this.id);
  }
  tool<T>(name: string, input: ToolInput | undefined, fn: () => T | Promise<T>): Promise<T> {
    return this.office.tool(name, input, fn, this.id);
  }
  waiting(reason: 'permission' | 'question' | 'input', text?: string): void {
    this.office.waiting(reason, text, this.id);
  }
  usage(tokens: { in?: number; out?: number; cached?: number }, model?: string): void {
    this.office.usage(tokens, model, this.id);
  }
  /** Done: the subagent walks its result over to its parent, then leaves. */
  end(ok = true): void {
    this.office.emit({ type: 'subagent.end', ...(ok ? {} : { subagent: { ok: false } }) }, this.id);
  }
}
