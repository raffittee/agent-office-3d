// Hand-written, dependency-free validator for AgentEvent (mirrors shared/agent-event.schema.json).
// Unknown fields are accepted and dropped: the protocol only grows by additive changes, so a newer emitter must not
// be rejected by an older server. Text is not masked here; ingest masks and truncates after validation.
import {
  BUILTIN_PROVIDERS,
  EVENT_TYPES,
  TASK_STATUSES,
  WAITING_REASONS,
  type AgentEvent,
  type AgentEventType,
  type EventJob,
  type EventSubagent,
  type EventTask,
  type EventTool,
  type ProviderId,
} from './protocol';

export type Validation = { ok: true; event: AgentEvent } | { ok: false; errors: string[] };

/** Longest text field accepted (ingest truncates further). */
export const MAX_TEXT = 65536;
const MAX_ID = 200;
const MAX_TASKS = 500;

const CUSTOM_PROVIDER = /^custom:[a-z0-9][a-z0-9._-]{0,39}$/;
const ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const NEEDS: Partial<Record<AgentEventType, keyof AgentEvent>> = {
  'tool.start': 'tool',
  'tool.end': 'tool',
  waiting: 'waiting',
  'job.start': 'job',
  'job.end': 'job',
  'subagent.start': 'agent',
  'subagent.end': 'agent',
  tasks: 'tasks',
};

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && ((BUILTIN_PROVIDERS as readonly string[]).includes(v) || CUSTOM_PROVIDER.test(v));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateAgentEvent(input: unknown): Validation {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['event must be an object'] };
  const o = input;

  const id = (key: string, v: unknown, required: boolean): string | undefined => {
    if (v === undefined) {
      if (required) errors.push(`${key} is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ID || CONTROL.test(v)) {
      errors.push(`${key} must be a non-empty string of at most ${MAX_ID} printable characters`);
      return undefined;
    }
    return v;
  };
  const text = (key: string, v: unknown, max = MAX_TEXT): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > max) {
      errors.push(`${key} must be a string of at most ${max} characters`);
      return undefined;
    }
    return v;
  };
  const bool = (key: string, v: unknown): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') {
      errors.push(`${key} must be a boolean`);
      return undefined;
    }
    return v;
  };
  const count = (key: string, v: unknown): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`${key} must be a non-negative number`);
      return undefined;
    }
    return v;
  };

  if (o.v !== 1) errors.push('v must be 1');
  if (!isProviderId(o.provider)) errors.push('provider must be claude-code, gemini-cli, codex or custom:<slug>');
  if (typeof o.account !== 'string' || !ACCOUNT.test(o.account)) errors.push('account must be a slug ([a-z0-9._-], at most 64)');
  const session = id('session', o.session, true);
  const agent = id('agent', o.agent, false);
  const parentAgent = id('parentAgent', o.parentAgent, false);
  const continues = id('continues', o.continues, false);
  let cwd: string | undefined;
  if (o.cwd !== undefined) {
    if (typeof o.cwd !== 'string' || o.cwd.length === 0 || o.cwd.length > 4096 || CONTROL.test(o.cwd)) errors.push('cwd must be a path string');
    else cwd = o.cwd;
  }
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at <= 0 || o.at > 1e14) errors.push('at must be epoch milliseconds');
  let pid: number | undefined;
  if (o.pid !== undefined) {
    if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid < 1 || o.pid > 0x7fffffff) errors.push('pid must be a positive integer');
    else pid = o.pid;
  }
  const procStart = text('procStart', o.procStart, 64);
  const type = (EVENT_TYPES as readonly unknown[]).includes(o.type) ? (o.type as AgentEventType) : undefined;
  if (!type) errors.push(`type must be one of ${EVENT_TYPES.join(', ')}`);

  let tool: EventTool | undefined;
  if (o.tool !== undefined) {
    if (!isObject(o.tool)) errors.push('tool must be an object');
    else {
      const name = id('tool.name', o.tool.name, true);
      const t: EventTool = { name: name ?? '' };
      const tid = id('tool.id', o.tool.id, false);
      if (tid !== undefined) t.id = tid;
      if (o.tool.input !== undefined) t.input = o.tool.input;
      const ok = bool('tool.ok', o.tool.ok);
      if (ok !== undefined) t.ok = ok;
      const err = text('tool.error', o.tool.error, 64);
      if (err !== undefined) t.error = err;
      const bg = bool('tool.background', o.tool.background);
      if (bg !== undefined) t.background = bg;
      tool = t;
    }
  }

  let waiting: AgentEvent['waiting'];
  if (o.waiting !== undefined) {
    if (!isObject(o.waiting) || !(WAITING_REASONS as readonly unknown[]).includes(o.waiting.reason)) {
      errors.push(`waiting.reason must be one of ${WAITING_REASONS.join(', ')}`);
    } else {
      waiting = { reason: o.waiting.reason as (typeof WAITING_REASONS)[number] };
      const t = text('waiting.text', o.waiting.text);
      if (t !== undefined) waiting.text = t;
    }
  }

  let job: EventJob | undefined;
  if (o.job !== undefined) {
    if (!isObject(o.job)) errors.push('job must be an object');
    else {
      const jid = id('job.id', o.job.id, true);
      job = { id: jid ?? '' };
      const label = text('job.label', o.job.label);
      if (label !== undefined) job.label = label;
      const command = text('job.command', o.job.command);
      if (command !== undefined) job.command = command;
      const ok = bool('job.ok', o.job.ok);
      if (ok !== undefined) job.ok = ok;
    }
  }

  let subagent: EventSubagent | undefined;
  if (o.subagent !== undefined) {
    if (!isObject(o.subagent)) errors.push('subagent must be an object');
    else {
      subagent = {};
      const role = text('subagent.role', o.subagent.role, MAX_ID);
      if (role !== undefined) subagent.role = role;
      const title = text('subagent.title', o.subagent.title);
      if (title !== undefined) subagent.title = title;
      const bg = bool('subagent.background', o.subagent.background);
      if (bg !== undefined) subagent.background = bg;
      const ok = bool('subagent.ok', o.subagent.ok);
      if (ok !== undefined) subagent.ok = ok;
    }
  }

  let tokens: AgentEvent['tokens'];
  if (o.tokens !== undefined) {
    if (!isObject(o.tokens)) errors.push('tokens must be an object');
    else {
      tokens = {};
      const tin = count('tokens.in', o.tokens.in);
      if (tin !== undefined) tokens.in = tin;
      const tout = count('tokens.out', o.tokens.out);
      if (tout !== undefined) tokens.out = tout;
      const cached = count('tokens.cached', o.tokens.cached);
      if (cached !== undefined) tokens.cached = cached;
    }
  }

  let tasks: EventTask[] | undefined;
  if (o.tasks !== undefined) {
    if (!Array.isArray(o.tasks) || o.tasks.length > MAX_TASKS) errors.push(`tasks must be an array of at most ${MAX_TASKS}`);
    else {
      tasks = [];
      o.tasks.forEach((raw, i) => {
        if (!isObject(raw) || !(TASK_STATUSES as readonly unknown[]).includes(raw.status)) {
          errors.push(`tasks[${i}] must have an id, a title and a status (${TASK_STATUSES.join(', ')})`);
          return;
        }
        const tid = id(`tasks[${i}].id`, raw.id, true);
        const title = text(`tasks[${i}].title`, raw.title);
        if (title === undefined) errors.push(`tasks[${i}].title is required`);
        const task: EventTask = { id: tid ?? '', title: title ?? '', status: raw.status as EventTask['status'] };
        const af = text(`tasks[${i}].activeForm`, raw.activeForm);
        if (af !== undefined) task.activeForm = af;
        tasks!.push(task);
      });
    }
  }

  const prompt = text('prompt', o.prompt);
  const title = text('title', o.title);
  const model = text('model', o.model, MAX_ID);
  const gitBranch = text('gitBranch', o.gitBranch, 400);

  if (type) {
    const need = NEEDS[type];
    const present: Record<string, unknown> = { tool, waiting, job, agent, tasks };
    if (need && present[need] === undefined && !errors.some((e) => e.startsWith(need))) errors.push(`${type} needs ${need}`);
    if (type === 'usage' && !tokens && model === undefined) errors.push('usage needs tokens or model');
  }

  if (errors.length) return { ok: false, errors };
  const event: AgentEvent = {
    v: 1,
    provider: o.provider as ProviderId,
    account: o.account as string,
    session: session!,
    at: o.at as number,
    type: type!,
  };
  const optional: Partial<AgentEvent> = { agent, parentAgent, cwd, pid, procStart, tool, waiting, job, subagent, continues, prompt, title, model, tokens, tasks, gitBranch };
  for (const [k, val] of Object.entries(optional)) if (val !== undefined) (event as unknown as Record<string, unknown>)[k] = val;
  return { ok: true, event };
}
