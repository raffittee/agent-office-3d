// Social life (P6-01): personalities, gathering rules, and the director inside a running sim.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../../shared/protocol';
import { DEFAULT_WORLD_OPTIONS } from '../options';
import { Sim } from '../sim/sim';
import { GATHER_KINDS, kindWeights, pickKind, rpsResult, winChance } from './gathering';
import { bondBetween, personaFor, soloWeights, traitsClash } from './persona';

describe('personas', () => {
  it('are deterministic, with 2–3 traits that never clash', () => {
    for (let seed = 1; seed < 400; seed++) {
      const p = personaFor(seed * 7919);
      expect(personaFor(seed * 7919)).toEqual(p);
      expect(p.traits.length).toBeGreaterThanOrEqual(2);
      expect(p.traits.length).toBeLessThanOrEqual(3);
      for (const a of p.traits) for (const b of p.traits) expect(traitsClash(a, b)).toBe(false);
      expect(p.sociability).toBeGreaterThan(0);
      expect(p.sociability).toBeLessThan(1);
    }
  });

  it('bonds are symmetric: some friends, fewer rivals, mostly colleagues', () => {
    let friends = 0;
    let rivals = 0;
    const n = 3000;
    for (let i = 0; i < n; i++) {
      const a = i * 104729 + 3;
      const b = i * 15485863 + 11;
      const bond = bondBetween(a, b);
      expect(bondBetween(b, a)).toBe(bond);
      if (bond === 'friends') friends++;
      if (bond === 'rivals') rivals++;
    }
    expect(friends / n).toBeGreaterThan(0.15);
    expect(friends / n).toBeLessThan(0.4);
    expect(rivals / n).toBeGreaterThan(0.05);
    expect(rivals / n).toBeLessThan(friends / n);
  });

  it('traits tilt solo outings and gatherings', () => {
    const coffee = { traits: ['coffee' as const], sociability: 0.5, skill: 0.5, catchphrase: '' };
    expect(soloWeights(coffee).coffee).toBeGreaterThan(soloWeights({ ...coffee, traits: [] }).coffee);
    const sporty = { ...coffee, traits: ['sporty' as const] };
    expect(kindWeights(sporty).pingpong).toBeGreaterThan(kindWeights(coffee).pingpong);
    expect(pickKind(sporty, new Set(['talk']), () => 0.99)).toBe('talk');
    expect(pickKind(sporty, new Set(), () => 0.5)).toBeNull();
    expect(GATHER_KINDS).toContain('tv');
  });

  it('games: rock-paper-scissors and the odds stay sane', () => {
    expect(rpsResult('rock', 'scissors')).toBe(1);
    expect(rpsResult('rock', 'paper')).toBe(-1);
    expect(rpsResult('paper', 'paper')).toBe(0);
    const pro = { traits: [], sociability: 0.5, skill: 0.95, catchphrase: '' };
    const noob = { ...pro, skill: 0.05 };
    expect(winChance(pro, noob)).toBeLessThanOrEqual(0.85);
    expect(winChance(noob, pro)).toBeGreaterThanOrEqual(0.15);
  });
});

// ---------------------------------------------------------------- in the sim

const T0 = 1_700_000_000_000;
const room = (id: string, slot: number): RoomInfo => ({ id, name: id, path: id, slot, seed: slot * 99 + 7, createdAt: T0 });
function agent(id: string, roomId: string, status: AgentInfo['status'], seed: number): AgentInfo {
  return {
    id,
    kind: 'main',
    provider: 'claude-code',
    roomId,
    name: id,
    look: 'f',
    role: 'Main agent',
    sessionId: `s-${id}`,
    account: 'default',
    status,
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed,
  };
}
const snap = (agents: AgentInfo[], rev = 1): OfficeSnapshot => ({
  rev,
  serverTime: T0,
  rooms: [room('/a', 0), room('/b', 1)],
  agents,
  accounts: [],
  meta: { demo: true, sources: [], providers: [], startedAt: T0, version: 't' },
});

describe('gatherings in the sim', () => {
  // sociable people (chatty, joker…) so gatherings happen quickly
  const seeds = [11, 23, 37, 41, 53, 67].map((s) => s * 1_000_003);
  const people = seeds.map((s, i) => agent(`p${i}`, i % 2 ? '/b' : '/a', 'idle', s));

  function run(sim: Sim, clock: { now: number }, seconds: number, each?: () => void): void {
    for (let i = 0; i < seconds * 20; i++) {
      clock.now += 50;
      sim.update(0.05, clock.now);
      each?.();
    }
  }

  it('idle agents gather, play or chat, and go back to their desks', () => {
    const sim = new Sim({ options: () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'lively' }) });
    const clock = { now: T0 };
    sim.applySnapshot(snap(people), clock.now);
    const kinds = new Set<string>();
    let maxMembers = 0;
    let trophies = 0;
    run(sim, clock, 600, () => {
      for (const g of sim.social.gatherings.values()) {
        kinds.add(g.kind);
        maxMembers = Math.max(maxMembers, g.members.length);
      }
      for (const c of sim.chars.values()) if (c.icon === 'trophy') trophies++;
    });
    expect(kinds.size).toBeGreaterThan(0);
    expect(maxMembers).toBeGreaterThanOrEqual(2);
    // everyone keeps a valid home; reservations don't leak
    for (const c of sim.chars.values()) {
      expect(c.homeSpot).not.toBeNull();
      for (const id of sim.spots.reservedBy(c.id)) expect(id === c.homeSpot || c.tempSpots.includes(id)).toBe(true);
    }
    void trophies;
  });

  it('work calls a member away at once; the others carry on or break up', () => {
    const sim = new Sim({ options: () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'lively' }) });
    const clock = { now: T0 };
    sim.applySnapshot(snap(people), clock.now);
    let g = undefined as ReturnType<typeof sim.social.of>;
    for (let i = 0; i < 12_000 && !g; i++) {
      clock.now += 50;
      sim.update(0.05, clock.now);
      g = [...sim.social.gatherings.values()].find((x) => x.phase === 'run');
    }
    expect(g, 'a gathering got going').toBeDefined();
    const busy = g!.members[0]!.id;
    sim.applySnapshot(snap(people.map((p) => (p.id === busy ? { ...p, status: 'working', statusSince: clock.now } : p)), 2), clock.now);
    expect(sim.social.of(busy)).toBeUndefined();
    run(sim, clock, 25);
    const c = sim.chars.get(busy)!;
    expect(c.atSpot).toBe(c.homeSpot);
    expect(c.pose).toBe('type');
  });

  it('a hidden tab fast-forward ends every gathering', () => {
    const sim = new Sim({ options: () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'lively' }) });
    const clock = { now: T0 };
    sim.applySnapshot(snap(people), clock.now);
    for (let i = 0; i < 12_000 && !sim.social.gatherings.size; i++) {
      clock.now += 50;
      sim.update(0.05, clock.now);
    }
    expect(sim.social.gatherings.size).toBeGreaterThan(0);
    sim.fastForward(clock.now + 60_000);
    expect(sim.social.gatherings.size).toBe(0);
  });
});
