// Ported from habblaud server/sources/source.test.ts (MIT, © 2026 Márcio Junior)
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, ProviderId } from '../../shared/protocol';
import { describeToolFor } from '../../shared/tools';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { AdapterSet, HEARTBEAT_TIMEOUT_MS, pidAlive, type ProviderAdapter } from './adapter';

setQuiet(true);

const caps = { transcript: false, approve: false, message: false, usage: false, subagents: false };

function fake(id: ProviderId, opts: Partial<ProviderAdapter> & { log?: string[] } = {}): ProviderAdapter {
  const events = opts.log ?? [];
  return {
    id,
    label: id,
    color: '#888888',
    capabilities: caps,
    start: opts.start ?? (() => void events.push(`start:${id}`)),
    stop: opts.stop ?? (() => void events.push(`stop:${id}`)),
    sources: opts.sources ?? (() => [{ provider: id, label: 'default', path: `/x/${id}`, sessions: 1, ok: true }]),
    describeTool: (name, input) => describeToolFor(id, name, input),
    ...(opts.onHook ? { onHook: opts.onHook } : {}),
    ...(opts.alive ? { alive: opts.alive } : {}),
  };
}

function office(now = () => Date.now()) {
  return new Office({ names: new NameStore(null), version: 't', startedAt: 0, now });
}

const ev = (provider: ProviderId, session: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({ v: 1, provider, account: 'default', session, cwd: '/p/a', at: 1, type: 'session.start', ...extra });

describe('AdapterSet', () => {
  it('sources, provider metadata and hook routing', () => {
    const set = new AdapterSet([fake('claude-code')]);
    set.add(fake('gemini-cli', { onHook: () => [] }));
    expect(() => set.add(fake('gemini-cli'))).toThrow();
    expect(set.all().map((a) => a.id)).toEqual(['claude-code', 'gemini-cli']);
    expect(set.of('gemini-cli')?.id).toBe('gemini-cli');
    expect(set.sources().map((s) => s.provider)).toEqual(['claude-code', 'gemini-cli']);
    expect(set.providers()).toEqual([
      { id: 'claude-code', label: 'claude-code', color: '#888888', capabilities: caps },
      { id: 'gemini-cli', label: 'gemini-cli', color: '#888888', capabilities: caps },
    ]);
    expect(set.hooks('gemini-cli')).toBeDefined();
    expect(set.hooks('claude-code')).toBeUndefined();
    expect(set.hooks('nope')).toBeUndefined();
  });

  it('starts in order (sync ones finish there); one failing adapter does not stop the others', async () => {
    const log: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((ok) => (release = ok));
    const set = new AdapterSet([
      fake('claude-code', { log }),
      fake('gemini-cli', { log, start: () => (log.push('start:gemini-cli'), slow.then(() => void log.push('ready:gemini-cli'))) }),
      fake('codex', { start: () => { throw new Error('broke'); }, stop: () => { throw new Error('broke again'); } }),
      fake('custom:x', { start: () => Promise.reject(new Error('async broke')) }),
    ]);
    const done = set.start(office());
    expect(log).toEqual(['start:claude-code', 'start:gemini-cli']);
    release();
    await done;
    expect(log).toEqual(['start:claude-code', 'start:gemini-cli', 'ready:gemini-cli']);
    expect(() => set.stop()).not.toThrow();
    expect(log.slice(-2)).toEqual(['stop:claude-code', 'stop:gemini-cli']);
  });

  it('counted boot: the office is ready only when the async adapter finishes', async () => {
    const o = office();
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const sync = fake('claude-code', { start: (ctx) => (ctx.beginBoot(), ctx.endBoot()) });
    const async = fake('gemini-cli', {
      start: async (ctx) => {
        ctx.beginBoot();
        try {
          await gate;
        } finally {
          ctx.endBoot();
        }
      },
    });
    const done = new AdapterSet([async, sync]).start(o);
    expect(o.isBooting()).toBe(true);
    release();
    await done;
    expect(o.isBooting()).toBe(false);
  });

  it('emit validates and masks before the office sees the event', () => {
    const o = office();
    const ctx = new AdapterSet().context(o);
    ctx.emit({ ...ev('gemini-cli', 's1'), type: 'turn.start', prompt: 'token=abc123secret' });
    ctx.emit({ ...ev('gemini-cli', 's2'), type: 'not-a-type' } as unknown as AgentEvent);
    expect(o.list().map((a) => a.id)).toEqual(['gemini-cli:default:s1']);
    expect(o.get('gemini-cli:default:s1')!.activity!.detail).toBe('token=***');
  });
});

describe('liveness', () => {
  it('the adapter decides when it knows; otherwise the PID probe; otherwise a heartbeat timeout', () => {
    let now = 1_000;
    const o = office(() => now);
    const set = new AdapterSet([fake('claude-code', { alive: (t) => (t.id.endsWith(':gone') ? false : undefined) }), fake('gemini-cli')]);
    o.apply(ev('claude-code', 'gone'));
    o.apply(ev('claude-code', 'kept', { pid: 111 }));
    o.apply(ev('gemini-cli', 'dead', { pid: 222 }));
    o.apply(ev('gemini-cli', 'nopid', { at: now }));
    const probe = (pid: number) => pid === 111;
    set.checkLiveness(o, now, probe);
    const status = (id: string) => o.get(id)?.status;
    expect(status('claude-code:default:gone')).toBe('offline');
    expect(status('claude-code:default:kept')).toBe('idle');
    expect(status('gemini-cli:default:dead')).toBe('offline');
    expect(status('gemini-cli:default:nopid')).toBe('idle');
    now += HEARTBEAT_TIMEOUT_MS + 1;
    set.checkLiveness(o, now, probe);
    expect(status('gemini-cli:default:nopid')).toBe('offline');
    expect(status('claude-code:default:kept')).toBe('idle');
  });

  it('pidAlive: this process yes, a finished one no', () => {
    expect(pidAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(child.pid).toBeGreaterThan(0);
    expect(pidAlive(child.pid!)).toBe(false);
  });
});
