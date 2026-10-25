// P8-01: fuzzing what untrusted input reaches. Random and mutated payloads go through the event validator, masking
// and the Office reducer, and random lines through every transcript parser. Nothing may throw, accepted events must
// keep the protocol's invariants, and `__proto__` tricks must not pollute prototypes. Deterministic (seeded), no
// dependencies.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../shared/hash';
import { Office } from '../../shared/model/office';
import { EVENT_TYPES, type AgentEvent } from '../../shared/protocol';
import { MAX_TEXT, validateAgentEvent } from '../../shared/validate';
import { parseClaudeConversation } from '../adapters/claude-code/conversation';
import { parseCodexConversation } from '../adapters/codex/conversation';
import { parseGeminiConversation } from '../adapters/gemini-cli/conversation';
import { maskEvent } from '../ingest/mask';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { parseDecision, parseHookInput } from '../permissions/registry';

setQuiet(true);

type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;

const STRINGS = ['', ' ', 'a', '__proto__', 'constructor', 'prototype', '\u0000', '\u202e', '😀', 'sk-proj-0123456789abcdefghij', '../../etc/passwd', 'C:\\Windows', '<script>x</script>', 'x'.repeat(70_000), 'custom:x', 'claude-code', '{"a":1}'];

/** A random JSON-ish value, up to `depth` levels deep. */
function value(rng: Rng, depth: number): unknown {
  const r = rng();
  if (depth <= 0 || r < 0.35) {
    return pick<unknown>(rng, [null, true, false, 0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY, Math.floor(rng() * 1e13), ...STRINGS, undefined]);
  }
  if (r < 0.6) return Array.from({ length: Math.floor(rng() * 4) }, () => value(rng, depth - 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(rng() * 5); i > 0; i--) o[pick(rng, [...STRINGS.slice(0, 8), 'tool', 'input', 'name', 'id'])] = value(rng, depth - 1);
  return o;
}

const valid = (rng: Rng): AgentEvent => {
  const type = pick(rng, EVENT_TYPES);
  const e: AgentEvent = { v: 1, provider: pick(rng, ['claude-code', 'codex', 'gemini-cli', 'custom:fuzz'] as const), account: 'default', session: `s${Math.floor(rng() * 4)}`, cwd: '/p/shop', at: 1_000_000 + Math.floor(rng() * 1e6), type };
  if (type.startsWith('tool.')) e.tool = { id: `t${Math.floor(rng() * 5)}`, name: pick(rng, ['Bash', 'Edit', 'Read', 'mcp__github__merge_pull_request']), input: value(rng, 3), ok: rng() < 0.5 };
  if (type === 'waiting') e.waiting = { reason: pick(rng, ['permission', 'question', 'input'] as const), text: String(value(rng, 0)) };
  if (type.startsWith('job.')) e.job = { id: `j${Math.floor(rng() * 3)}` };
  if (type.startsWith('subagent.')) e.agent = `a${Math.floor(rng() * 3)}`;
  if (type === 'tasks') e.tasks = [{ id: '1', title: 'x', status: 'pending' }];
  return e;
};

/** Breaks a valid event in one random way. */
function mutate(rng: Rng, e: AgentEvent): unknown {
  const o: Record<string, unknown> = { ...e };
  const keys = [...Object.keys(o), '__proto__', 'constructor', 'tool', 'tasks', 'agent', 'parentAgent', 'pid', 'tokens'];
  const k = pick(rng, keys);
  if (rng() < 0.3) delete o[k];
  else o[k] = value(rng, 3);
  return rng() < 0.1 ? JSON.parse(JSON.stringify(o).replace('"v":1', '"__proto__":{"polluted":true},"v":1')) : o;
}

function checkInvariants(e: AgentEvent): void {
  expect(e.v).toBe(1);
  expect(EVENT_TYPES).toContain(e.type);
  expect(e.provider).toMatch(/^(claude-code|gemini-cli|codex|custom:[a-z0-9][a-z0-9._-]{0,39})$/);
  expect(e.account).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  expect(typeof e.session).toBe('string');
  expect(Number.isFinite(e.at)).toBe(true);
  for (const s of [e.prompt, e.title, e.cwd, e.model, e.gitBranch]) if (s !== undefined) expect(s.length).toBeLessThanOrEqual(MAX_TEXT);
}

describe('fuzz: events from outside', () => {
  it('the validator never throws; what it accepts keeps the invariants; the reducer survives it all', () => {
    const rng = mulberry32(20261025);
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, now: () => 2_000_000 });
    let accepted = 0;
    for (let i = 0; i < 6_000; i++) {
      const input = i % 3 === 0 ? value(rng, 5) : mutate(rng, valid(rng));
      let r: ReturnType<typeof validateAgentEvent>;
      expect(() => (r = validateAgentEvent(input))).not.toThrow();
      if (!r!.ok) {
        expect(r!.errors.length).toBeGreaterThan(0);
        continue;
      }
      accepted++;
      checkInvariants(r!.event);
      const masked = maskEvent(r!.event);
      expect(() => office.apply(masked)).not.toThrow();
      if (i % 50 === 0) {
        office.tick();
        expect(() => JSON.stringify(office.commit().snapshot)).not.toThrow();
      }
    }
    expect(accepted).toBeGreaterThan(500);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // secrets in tool inputs never survive masking
    const secret = maskEvent({ ...valid(mulberry32(1)), type: 'tool.start', tool: { name: 'Bash', input: { command: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789"' } } });
    expect(JSON.stringify(secret)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('hook bodies and page decisions: invalid input is refused, never thrown past the parser', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 3_000; i++) {
      const v = value(rng, 4);
      try {
        parseHookInput(v);
      } catch (err) {
        expect((err as Error).name).toBe('Error');
      }
      expect(() => parseDecision(v)).not.toThrow();
    }
  });

  it('transcript parsers never throw on garbage, half lines or hostile JSON', () => {
    const rng = mulberry32(99);
    const lines: string[] = [];
    for (let i = 0; i < 4_000; i++) {
      const v = value(rng, 5);
      const s = JSON.stringify(rng() < 0.5 ? { type: pick(rng, ['user', 'assistant', 'system', 'response_item', 'gemini']), message: v, payload: v, content: v, toolCalls: v, id: 'x', $rewindTo: rng() < 0.05 ? 'x' : undefined } : v) ?? 'null';
      lines.push(rng() < 0.1 ? s.slice(0, Math.floor(s.length / 2)) : s);
    }
    for (const parse of [parseClaudeConversation, parseCodexConversation, parseGeminiConversation]) expect(() => parse(lines)).not.toThrow();
  });
});
