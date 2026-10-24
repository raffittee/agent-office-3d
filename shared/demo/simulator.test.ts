// Ported from habblaud shared/demo/simulator.test.ts (MIT, © 2026 Márcio Junior), re-shaped for events.
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentStatus } from '../protocol';
import { validateAgentEvent } from '../validate';
import { createMockOffice } from './mock';
import { DemoSimulator } from './simulator';

const T0 = Date.parse('2026-10-25T09:00:00Z');
const STEP = 250;

function run(seed: number, minutes: number): AgentEvent[] {
  const sim = new DemoSimulator({ seed }, T0);
  const out: AgentEvent[] = [];
  for (let now = T0; now <= T0 + minutes * 60_000; now += STEP) out.push(...sim.tick(now));
  return out;
}

describe('DemoSimulator', () => {
  it('the same seed always produces the same office', () => {
    expect(run(42, 5)).toEqual(run(42, 5));
    expect(run(42, 5)).not.toEqual(run(43, 5));
  });

  it('every event is a valid AgentEvent, on the demo account', () => {
    const events = run(7, 10);
    expect(events.length).toBeGreaterThan(200);
    for (const e of events) {
      const r = validateAgentEvent(e);
      expect(r.ok, JSON.stringify(e)).toBe(true);
      expect(e.account).toBe('demo');
      expect(e.session).toMatch(/^demo-/);
    }
  });

  it('mixes providers, each with its own tool names', () => {
    const events = run(1, 10);
    const providers = new Set(events.map((e) => e.provider));
    expect([...providers].sort()).toEqual(['claude-code', 'codex', 'custom:demo', 'gemini-cli']);
    const tools = (p: string) => new Set(events.filter((e) => e.provider === p && e.type === 'tool.start').map((e) => e.tool!.name));
    expect([...tools('claude-code')].some((n) => ['Read', 'Edit', 'Bash', 'Grep'].includes(n))).toBe(true);
    expect([...tools('gemini-cli')].some((n) => ['read_file', 'replace', 'run_shell_command', 'grep_search'].includes(n))).toBe(true);
    // Two providers share a room from the start.
    const firstRooms = events.filter((e) => e.type === 'session.start').slice(0, 2).map((e) => e.cwd);
    expect(firstRooms[0]).toBe(firstRooms[1]);
  });

  it('tool starts and ends pair up, and jobs end', () => {
    const events = run(3, 15);
    const open = new Set<string>();
    for (const e of events) {
      const key = `${e.session}:${e.agent ?? ''}:${e.tool?.id}`;
      if (e.type === 'tool.start') open.add(key);
      if (e.type === 'tool.end') expect(open.delete(key), key).toBe(true);
    }
    const jobs = events.filter((e) => e.type === 'job.start').length;
    expect(jobs).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'job.end').length).toBeGreaterThan(0);
  });
});

describe('the mock office (simulator + the real reducer)', () => {
  it('plays the whole lifecycle: every status shows up, and agents without a PID stay present through heartbeats', () => {
    const mock = createMockOffice({ seed: 11 }, T0);
    const seen = new Set<AgentStatus>();
    const providers = new Set<string>();
    let notices = 0;
    for (let now = T0; now <= T0 + 20 * 60_000; now += STEP) {
      const r = mock.step(now);
      notices += r.notices.length;
      for (const a of r.snapshot.agents) {
        seen.add(a.status);
        providers.add(a.provider);
      }
      // The liveness rule for agents without a PID: offline after 2 min without events.
      for (const a of r.snapshot.agents) if (a.kind === 'main' && a.status !== 'offline') expect(now - a.lastEventAt).toBeLessThan(120_000);
    }
    expect([...seen].sort()).toEqual(['done', 'idle', 'offline', 'shell', 'waiting', 'working']);
    expect(providers.size).toBe(4);
    expect(notices).toBeGreaterThan(0);
    const snap = mock.step(T0 + 20 * 60_000 + STEP).snapshot;
    expect(snap.meta.demo).toBe(true);
    expect(snap.meta.providers.map((p) => p.id)).toEqual(['claude-code', 'gemini-cli', 'codex', 'custom:demo']);
  });

  it('the opening burst makes no notices', () => {
    const mock = createMockOffice({ seed: 5 }, T0);
    expect(mock.office.commit().notices).toEqual([]);
    expect(mock.office.list().length).toBeGreaterThanOrEqual(4);
  });
});
