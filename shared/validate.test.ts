import { describe, expect, it } from 'vitest';
import schema from './agent-event.schema.json';
import { EVENT_TYPES, TASK_STATUSES, WAITING_REASONS, agentIdOf, mainIdOf, type AgentEvent } from './protocol';
import { isProviderId, validateAgentEvent } from './validate';

const base = { v: 1, provider: 'gemini-cli', account: 'default', session: 'af30d16c-f9dd-4442-be5c-1bbf8eca4430', at: 1792780165923 } as const;

function ok(e: unknown): AgentEvent {
  const r = validateAgentEvent(e);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.event;
}

function errors(e: unknown): string[] {
  const r = validateAgentEvent(e);
  return r.ok ? [] : r.errors;
}

describe('validateAgentEvent: valid events', () => {
  it('accepts every event type with its required fields', () => {
    const extra: Partial<Record<(typeof EVENT_TYPES)[number], Record<string, unknown>>> = {
      'tool.start': { tool: { name: 'read_file', input: { file_path: 'a.ts' } } },
      'tool.end': { tool: { name: 'run_shell_command', ok: false, error: 'exit_3' } },
      waiting: { waiting: { reason: 'permission', text: 'Confirm Write: a.txt' } },
      'subagent.start': { agent: 'sub-1', subagent: { role: 'generalist', title: 'List files', background: false } },
      'subagent.end': { agent: 'sub-1', subagent: { ok: true } },
      'job.start': { job: { id: '62152', label: 'Wait a bit', command: 'ping -n 4 127.0.0.1' } },
      'job.end': { job: { id: '62152', ok: true } },
      tasks: { tasks: [{ id: '1', title: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }] },
      usage: { model: 'gemini-3.8-flash', tokens: { in: 1200, out: 34, cached: 800 } },
    };
    for (const type of EVENT_TYPES) expect(ok({ ...base, type, ...extra[type] }).type).toBe(type);
  });

  it('keeps known optional fields and drops unknown ones', () => {
    const e = ok({
      ...base,
      type: 'session.start',
      cwd: 'C:\\Users\\dev\\code\\project',
      pid: 14152,
      procStart: '134372522336881641',
      continues: 'old-session',
      title: 'Fix the login bug',
      gitBranch: 'main',
      futureField: { anything: true },
    });
    expect(e).toEqual({
      ...base,
      type: 'session.start',
      cwd: 'C:\\Users\\dev\\code\\project',
      pid: 14152,
      procStart: '134372522336881641',
      continues: 'old-session',
      title: 'Fix the login bug',
      gitBranch: 'main',
    });
    expect('futureField' in e).toBe(false);
  });

  it('accepts custom providers with a slug', () => {
    expect(ok({ ...base, provider: 'custom:my-agent.v2', type: 'heartbeat' }).provider).toBe('custom:my-agent.v2');
    expect(isProviderId('custom:x')).toBe(true);
  });
});

describe('validateAgentEvent: invalid events', () => {
  it('rejects non-objects', () => {
    for (const bad of [null, 'x', 42, [], undefined]) expect(errors(bad)).toEqual(['event must be an object']);
  });

  it('rejects a wrong version, provider, account or type', () => {
    expect(errors({ ...base, v: 2, type: 'heartbeat' })).toContain('v must be 1');
    expect(errors({ ...base, provider: 'claude', type: 'heartbeat' })[0]).toMatch(/^provider/);
    expect(errors({ ...base, provider: 'custom:', type: 'heartbeat' })[0]).toMatch(/^provider/);
    expect(errors({ ...base, provider: 'custom:Bad Name', type: 'heartbeat' })[0]).toMatch(/^provider/);
    expect(errors({ ...base, account: 'C:\\Users\\dev\\.claude', type: 'heartbeat' })[0]).toMatch(/^account/);
    expect(errors({ ...base, type: 'tool.middle' })[0]).toMatch(/^type/);
    expect(errors({ ...base })[0]).toMatch(/^type/);
  });

  it('rejects bad ids, timestamps and pids', () => {
    expect(errors({ ...base, session: '', type: 'heartbeat' })[0]).toMatch(/^session/);
    expect(errors({ ...base, session: 'a\nb', type: 'heartbeat' })[0]).toMatch(/^session/);
    expect(errors({ ...base, session: 'x'.repeat(201), type: 'heartbeat' })[0]).toMatch(/^session/);
    const { session: _s, ...noSession } = base;
    expect(errors({ ...noSession, type: 'heartbeat' })).toContain('session is required');
    expect(errors({ ...base, at: -1, type: 'heartbeat' })[0]).toMatch(/^at/);
    expect(errors({ ...base, at: '2026-10-24', type: 'heartbeat' })[0]).toMatch(/^at/);
    expect(errors({ ...base, pid: 1.5, type: 'heartbeat' })[0]).toMatch(/^pid/);
    expect(errors({ ...base, pid: 0, type: 'heartbeat' })[0]).toMatch(/^pid/);
  });

  it('requires the payload each type needs', () => {
    expect(errors({ ...base, type: 'tool.start' })).toEqual(['tool.start needs tool']);
    expect(errors({ ...base, type: 'waiting' })).toEqual(['waiting needs waiting']);
    expect(errors({ ...base, type: 'job.end' })).toEqual(['job.end needs job']);
    expect(errors({ ...base, type: 'subagent.start' })).toEqual(['subagent.start needs agent']);
    expect(errors({ ...base, type: 'tasks' })).toEqual(['tasks needs tasks']);
    expect(errors({ ...base, type: 'usage' })).toEqual(['usage needs tokens or model']);
  });

  it('checks nested payloads', () => {
    expect(errors({ ...base, type: 'tool.start', tool: { input: {} } })).toContain('tool.name is required');
    expect(errors({ ...base, type: 'tool.end', tool: { name: 'x', ok: 'yes' } })).toContain('tool.ok must be a boolean');
    expect(errors({ ...base, type: 'waiting', waiting: { reason: 'coffee' } })[0]).toMatch(/^waiting.reason/);
    expect(errors({ ...base, type: 'job.start', job: {} })).toContain('job.id is required');
    expect(errors({ ...base, type: 'usage', tokens: { in: -5 } })).toContain('tokens.in must be a non-negative number');
    expect(errors({ ...base, type: 'tasks', tasks: [{ id: '1', title: 't', status: 'blocked' }] })[0]).toMatch(/^tasks\[0\]/);
    expect(errors({ ...base, type: 'tasks', tasks: 'many' })[0]).toMatch(/^tasks must be/);
    expect(errors({ ...base, type: 'turn.start', prompt: 'x'.repeat(65537) })[0]).toMatch(/^prompt/);
  });
});

describe('ids', () => {
  it('derives main and subagent ids', () => {
    expect(agentIdOf({ provider: 'claude-code', account: 'default', session: 's1' })).toBe('claude-code:default:s1');
    expect(agentIdOf({ provider: 'claude-code', account: 'default', session: 's1', agent: 'a7' })).toBe('claude-code:default:s1:a7');
    expect(mainIdOf({ provider: 'claude-code', account: 'default', session: 's1' })).toBe('claude-code:default:s1');
  });
});

describe('JSON Schema stays in sync with the protocol', () => {
  it('lists the same event types, reasons and task statuses', () => {
    expect(schema.properties.type.enum).toEqual([...EVENT_TYPES]);
    expect(schema.properties.waiting.properties.reason.enum).toEqual([...WAITING_REASONS]);
    expect(schema.properties.tasks.items.properties.status.enum).toEqual([...TASK_STATUSES]);
    expect(schema.required).toEqual(['v', 'provider', 'account', 'session', 'at', 'type']);
  });
});
