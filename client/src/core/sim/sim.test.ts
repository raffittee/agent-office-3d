// Ported from habblaud client/src/world/sim/sim.test.ts (MIT, © 2026 Márcio Junior)
// The simulation, integrated, without a DOM: snapshots → characters walking, sitting, switching the light off and
// leaving. Not ported: the appearance tests (no 2D art module; Phase 3).
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo, ShellJob } from '../../../../shared/protocol';
import { DEFAULT_WORLD_OPTIONS } from '../options';
import type { RoomTheme } from '../vocab';
import type { Character } from './character';
import { SHELL_DONE_TOOL, Sim } from './sim';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const T0 = 1_700_000_000_000;

function room(id: string, slot: number): RoomInfo {
  return { id, name: id.replace('/', ''), path: id, slot, seed: slot * 99 + 7, createdAt: T0 };
}

function agent(id: string, roomId: string, status: AgentInfo['status'], extra: Partial<AgentInfo> = {}): AgentInfo {
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
    seed: id.length * 1234567,
    ...extra,
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[], rev = 1): OfficeSnapshot {
  return {
    rev,
    serverTime: T0,
    rooms,
    agents,
    accounts: [{ id: 'default', provider: 'claude-code', short: 'C', name: 'Account C', color: '#f08a3c', sessions: 1, usageStatus: 'ok' }],
    meta: { demo: true, sources: [], providers: [], startedAt: T0, version: 't' },
  };
}

/** Advances the simulation in 1/30 s steps. */
function run(sim: Sim, clock: { now: number }, seconds: number, until?: () => boolean): void {
  const steps = Math.round(seconds * 30);
  for (let i = 0; i < steps; i++) {
    clock.now += 1000 / 30;
    sim.update(1 / 30, clock.now);
    if (until?.()) return;
  }
}

function newSim(): Sim {
  return new Sim({ options: () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }), roomTheme: () => theme });
}

describe('office simulation', () => {
  it('initial load: whoever works is already seated typing, the room lit', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('bia', '/a', 'waiting', { waitingFor: 'approve' })]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    const bia = sim.chars.get('bia')!;
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.pose).toBe('type');
    expect(bia.pose).toBe('raise_hand');
    expect(bia.mode).toBe('wait');
    const r = sim.rooms.get('/a')!;
    expect(r.phase).toBe('ready');
    expect(r.lightOn).toBe(true);
  });

  it('arrival: a new room is built dark; the first one switches the light on and sits', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.phase).toBe('building');
    expect(b.lightOn).toBe(false);
    const caio = sim.chars.get('caio')!;
    expect(caio.step?.t ?? caio.queue[0]?.t).toBe('elevOut');
    run(sim, clock, 60, () => !!caio.homeSpot && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.phase).toBe('ready');
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
    run(sim, clock, 0.1);
    expect(caio.pose).toBe('type');
  });

  it('arrival: someone still waiting to step out of the elevator who goes offline never appears and is removed', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    // a burst of arrivals: the last ones wait several seconds for their turn in the elevators
    const late = Array.from({ length: 12 }, (_, i) => agent(`n${i}`, '/a', 'working'));
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), ...late], 2), clock.now);
    run(sim, clock, 0.3);
    const last = sim.chars.get('n11')!;
    expect(clock.now).toBeLessThan(last.hiddenUntil);
    // they all leave before their turn comes
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), ...late.map((a) => ({ ...a, status: 'offline' as const }))], 3), clock.now);
    run(sim, clock, 0.5);
    expect(sim.chars.has('n11')).toBe(false);
    expect(last.alpha).toBe(0);
    run(sim, clock, 30);
    expect([...sim.chars.keys()]).toEqual(['ana']);
  });

  it('arrival: a status change on the way to the switch does not leave the room dark', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 3);
    expect(b.lightOn).toBe(false);
    expect(b.switchClaim).toBe('caio');
    // still walking to the switch: the status changes twice (the plan is redone)
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'waiting', { waitingFor: 'approve' })], 3), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 4), clock.now);
    run(sim, clock, 60, () => b.lightOn && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
  });

  it('leaving: someone who just switched the light on and must already leave switches it off again', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 60, () => caio.step?.t === 'switch');
    expect(caio.step?.t).toBe('switch');
    // the session ends right in the middle of the switch click
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 3), clock.now);
    run(sim, clock, 20, () => caio.leaving && !b.lightOn);
    expect(b.lightOn).toBe(false);
    // still on the way to the elevator when the light goes off
    expect(sim.chars.has('caio')).toBe(true);
    run(sim, clock, 90, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
  });

  it('leaving: the last one switches the light off, takes the elevator, vanishes, and the room is dismantled', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working'), agent('davi', '/b', 'idle')]), clock.now);
    run(sim, clock, 0.5);
    // room /b's sessions end: caio goes offline, davi disappears from the snapshot
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.listed).toBe(false);
    expect(sim.chars.get('caio')!.mode).toBe('leave');
    // davi only leaves after the 3 s debounce
    run(sim, clock, 1);
    expect(sim.chars.get('davi')!.leaving).toBe(false);
    run(sim, clock, 3);
    expect(sim.chars.get('davi')!.leaving).toBe(true);
    // exactly one of them takes care of the switch
    expect(b.switchClaim).not.toBeNull();
    run(sim, clock, 90, () => !b.lightOn);
    expect(b.lightOn).toBe(false);
    run(sim, clock, 90, () => !sim.chars.has('caio') && !sim.chars.has('davi'));
    expect(sim.chars.has('caio')).toBe(false);
    expect(sim.chars.has('davi')).toBe(false);
    run(sim, clock, 10, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
    // the other room stays lit
    expect(sim.rooms.get('/a')!.lightOn).toBe(true);
  });

  it('a subagent delivers its result to its parent and leaves', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const main = agent('ana', '/a', 'working');
    sim.applySnapshot(snap(rooms, [main]), clock.now);
    run(sim, clock, 0.2);
    const sub = agent('ana:s1', '/a', 'working', { kind: 'sub', parentId: 'ana', name: 'Beto', title: 'Map the files' });
    sim.applySnapshot(snap(rooms, [main, sub], 2), clock.now);
    const beto = sim.chars.get('ana:s1')!;
    run(sim, clock, 60, () => beto.atSpot !== null && beto.atSpot === beto.homeSpot && !beto.step && !beto.queue.length);
    expect(beto.homeSpot).not.toBeNull();
    sim.applySnapshot(snap(rooms, [main, { ...sub, status: 'done' }], 3), clock.now);
    expect(beto.mode).toBe('deliver');
    let delivered = false;
    run(sim, clock, 40, () => {
      if (beto.bubbleText?.startsWith('Delivering')) delivered = true;
      return delivered;
    });
    expect(delivered).toBe(true);
    const ana = sim.chars.get('ana')!;
    expect(['check', 'heart']).toContain(ana.icon);
    run(sim, clock, 60, () => !sim.chars.has('ana:s1'));
    expect(sim.chars.has('ana:s1')).toBe(false);
  });

  it('an idle agent wanders and comes back to the desk', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { statusSince: T0 })]), clock.now);
    const ana = sim.chars.get('ana')!;
    ana.nextOutingAt = 1;
    let left = false;
    run(sim, clock, 60, () => {
      if (ana.atSpot !== ana.homeSpot) left = true;
      return left && ana.atSpot === ana.homeSpot;
    });
    expect(left).toBe(true);
    // back to work at once when the status changes
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')], 2), clock.now);
    run(sim, clock, 60, () => !!ana.homeSpot && ana.atSpot === ana.homeSpot && !ana.step && !ana.queue.length);
    run(sim, clock, 0.1);
    expect(ana.pose).toBe('type');
  });

  it("someone dozing at the desk (idle for long) wakes up when getting up: the \"zzz\" doesn't come along", () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { statusSince: T0 - 3_600_000 })]), clock.now);
    const ana = sim.chars.get('ana')!;
    run(sim, clock, 60, () => ana.atSpot === ana.homeSpot && ana.icon === 'zzz');
    expect(ana.pose).toBe('sleep');
    expect(ana.icon).toBe('zzz');
    // Any plan takes it away from its place without changing the mode: still "idle for long".
    ana.queue.push({ t: 'exit' }, { t: 'act', pose: 'stand', ms: 4000 });
    run(sim, clock, 1.5);
    expect(ana.pose).toBe('stand');
    expect(ana.icon).toBeNull();
    // The once-a-second check doesn't give the "zzz" back to someone standing.
    run(sim, clock, 1.5);
    expect(ana.icon).toBeNull();
  });

  it('fast forward (hidden tab) teleports to the destinations', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    clock.now += 20_000;
    sim.fastForward(clock.now);
    const caio = sim.chars.get('caio')!;
    expect(caio.atSpot).toBe(caio.homeSpot);
    expect(caio.alpha).toBe(1);
    expect(sim.rooms.get('/b')!.phase).toBe('ready');
    expect(sim.rooms.get('/b')!.lightOn).toBe(true);
  });

  it("faulty snapshots don't break the world", () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/inexistente', 'working'), agent('bia', '/a', 'working', { parentId: 'ninguem', kind: 'sub' })]), clock.now);
    run(sim, clock, 5);
    expect(sim.chars.size).toBe(2);
    // a room disappears and comes back while being dismantled: rebuilds
    sim.applySnapshot(snap([], [], 2), clock.now);
    run(sim, clock, 20);
    sim.applySnapshot(snap([room('/a', 0)], [agent('caio', '/a', 'working')], 3), clock.now);
    run(sim, clock, 5);
    const a = sim.rooms.get('/a');
    expect(a).toBeDefined();
    expect(['building', 'ready']).toContain(a!.phase);
  });

  it('initial load: nobody starts on a corridor or restroom bench, and no room is left empty', () => {
    for (const since of [T0, T0 - 5 * 60_000]) {
      const sim = newSim();
      const clock = { now: T0 };
      const agents: AgentInfo[] = [];
      for (let i = 0; i < 12; i++) agents.push(agent(`idle-${String.fromCharCode(97 + i)}${'x'.repeat(i)}`, i % 2 ? '/b' : '/a', 'idle', { statusSince: since }));
      sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], agents), clock.now);
      for (const ch of sim.chars.values()) {
        const at = ch.atSpot ? sim.spots.get(ch.atSpot) : undefined;
        expect(at, `${ch.id} without a place`).toBeDefined();
        expect(at!.kind).not.toBe('bench');
        // someone who just became idle starts at their own desk
        if (since === T0) expect(ch.atSpot).toBe(ch.homeSpot);
      }
      for (const id of ['/a', '/b']) expect([...sim.chars.values()].some((c) => c.roomId === id && c.atSpot === c.homeSpot)).toBe(true);
      // and nobody goes for an outing in the first seconds
      run(sim, clock, 3);
      if (since === T0) for (const ch of sim.chars.values()) expect(ch.atSpot, ch.id).toBe(ch.homeSpot);
    }
  });

  it("a full room: the extra ones work standing INSIDE the room (they don't loiter in the reception)", () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents: AgentInfo[] = [];
    for (let i = 0; i < 26; i++) agents.push(agent(`ag-${i}-${'y'.repeat(i)}`, '/a', 'working'));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    run(sim, clock, 25);
    const r = sim.rooms.get('/a')!.layout.rect;
    const inside = (x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    const homeless = [...sim.chars.values()].filter((c) => !c.homeSpot);
    expect(homeless.length).toBeGreaterThan(0);
    const tiles = new Set<string>();
    for (const c of homeless) {
      expect(c.standTile, c.id).not.toBeNull();
      expect(inside(c.standTile!.x, c.standTile!.y)).toBe(true);
      expect(inside(c.tx, c.ty), `${c.id} outside the room at ${c.tx},${c.ty}`).toBe(true);
      const key = `${c.standTile!.x},${c.standTile!.y}`;
      expect(tiles.has(key), `dois no mesmo tile ${key}`).toBe(false);
      tiles.add(key);
    }
    // standing still (not walking in circles) and working on the laptop
    const before = homeless.map((c) => `${c.tx},${c.ty}`);
    run(sim, clock, 15);
    expect(homeless.map((c) => `${c.tx},${c.ty}`)).toEqual(before);
    expect(homeless.every((c) => c.pose === 'read' && c.held === 'laptop')).toBe(true);
    // a place freed up: someone standing sits
    const seated = [...sim.chars.values()].find((c) => c.homeSpot && c.atSpot === c.homeSpot)!;
    sim.applySnapshot(snap([room('/a', 0)], agents.filter((a) => a.id !== seated.id), 2), clock.now);
    run(sim, clock, 40, () => homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot));
    expect(homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot)).toBe(true);
  });

  it('delegating: talks facing the door with 💬 (the raised hand is only for "needs you")', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const main = agent('ana', '/a', 'working', { activity: { id: 'a1', kind: 'edit', icon: '✏️', text: 'Editando', at: T0 } });
    sim.applySnapshot(snap([room('/a', 0)], [main]), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap([room('/a', 0)], [{ ...main, activity: { id: 'a2', kind: 'delegate', icon: '👥', text: 'Delegando', at: T0 } }], 2), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.icon).toBe('chat');
    const poses = new Set<string>();
    run(sim, clock, 3, () => {
      poses.add(ana.pose);
      return false;
    });
    expect(poses.has('talk')).toBe(true);
    expect(poses.has('raise_hand')).toBe(false);
  });

  it("each character has its own pace and lane (people leaving together don't overlap)", () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map((id) => agent(id, '/a', 'working', { seed: id.charCodeAt(0) * 7919 + id.length }));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    const chars = [...sim.chars.values()];
    for (const c of chars) {
      expect(c.speedK).toBeGreaterThanOrEqual(0.92);
      expect(c.speedK).toBeLessThanOrEqual(1.08);
      expect(Math.abs(c.lane)).toBeLessThanOrEqual(4);
    }
    expect(new Set(chars.map((c) => c.speedK.toFixed(3))).size).toBeGreaterThan(1);
    expect(new Set(chars.map((c) => c.lane)).size).toBeGreaterThan(1);
  });
});

describe('rooms without gaps', () => {
  const inside = (r: { layout: { rect: { x: number; y: number; w: number; h: number } } }, c: { tx: number; ty: number }) =>
    c.tx >= r.layout.rect.x && c.tx < r.layout.rect.x + r.layout.rect.w && c.ty >= r.layout.rect.y && c.ty < r.layout.rect.y + r.layout.rect.h;

  it("initial load: rooms take slots 0, 1, 2… in the server's order, even with gaps in its slots", () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/c', 8), room('/a', 0), room('/b', 3)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working')]), clock.now);
    expect(['/a', '/b', '/c'].map((id) => sim.rooms.get(id)!.slot)).toEqual([0, 1, 2]);
    expect(sim.building.cols).toBe(4);
  });

  it('a terminal closed: the farthest room moves into the slot, people walk over and the building shrinks', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1), room('/c', 2)];
    const agents = [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working'), agent('davi', '/c', 'idle')];
    sim.applySnapshot(snap(rooms, agents), clock.now);
    run(sim, clock, 0.5);
    const c = sim.rooms.get('/c')!;
    const caio = sim.chars.get('caio')!;
    const homeBefore = caio.homeSpot;
    expect(c.slot).toBe(2);
    expect(sim.building.cols).toBe(4);

    // room /b's session closes: bia leaves and the room is dismantled
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2)], [agents[0]!, agent('bia', '/b', 'offline'), agents[2]!, agents[3]!], 2), clock.now);
    run(sim, clock, 200, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
    expect(c.slot).toBe(2);

    // the slot waits a little, then room /c moves into it (rebuilt, dark)
    run(sim, clock, 3, () => c.slot === 1);
    expect(c.slot).toBe(1);
    expect(c.phase).toBe('building');
    const ghost = [...sim.rooms.values()].find((r) => r.ghost);
    expect(ghost?.slot).toBe(2);
    expect(ghost?.listed).toBe(false);
    // everyone keeps their desk (now in the new room) and walks to it, without teleporting
    expect(caio.homeSpot).toBe(homeBefore);
    let maxStep = 0;
    let px = caio.x;
    let py = caio.y;
    run(sim, clock, 60, () => {
      maxStep = Math.max(maxStep, Math.hypot(caio.x - px, caio.y - py));
      px = caio.x;
      py = caio.y;
      return !sim.rooms.has(ghost!.id) && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length;
    });
    expect(maxStep).toBeLessThan(12);
    expect(caio.atSpot).toBe(caio.homeSpot);
    expect(inside(c, caio)).toBe(true);
    expect(c.phase).toBe('ready');
    expect(c.lightOn).toBe(true);
    // the old address emptied, went dark and was dismantled; the building is back to one column of rooms
    expect(sim.rooms.has(ghost!.id)).toBe(false);
    run(sim, clock, 10, () => sim.building.cols === 3);
    expect(sim.building.cols).toBe(3);
    // davi (idle, maybe on an outing) also has a place in the new room
    expect(c.layout.spots.some((p) => p.id === sim.chars.get('davi')!.homeSpot)).toBe(true);
  });

  it("someone leaving doesn't move: the slot stays until their room is gone", () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1), room('/c', 2)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working')]), clock.now);
    run(sim, clock, 0.5);
    const c = sim.rooms.get('/c')!;
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'offline'), agent('caio', '/c', 'offline')], 2), clock.now);
    let moved = false;
    run(sim, clock, 240, () => {
      if (c.slot !== 2 || [...sim.rooms.values()].some((r) => r.ghost)) moved = true;
      return !sim.rooms.has('/b') && !sim.rooms.has('/c');
    });
    expect(moved).toBe(false);
    expect(sim.rooms.has('/c')).toBe(false);
    run(sim, clock, 5, () => sim.building.cols === 3);
    expect(sim.building.cols).toBe(3);
  });

  it('random opens and closes (even mid-move): nobody teleports and no gap is left at the end', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const sim = newSim();
    const clock = { now: T0 };
    const ids = ['/a', '/b', '/c', '/d', '/e', '/f', '/g'];
    const open = new Map<string, number>();
    ids.slice(0, 5).forEach((id, i) => open.set(id, i));
    let nextSlot = 5;
    let rev = 1;
    const agentsOf = (id: string, status: AgentInfo['status']) => [agent(`${id}-1`, id, status), agent(`${id}-2`, id, status === 'offline' ? 'offline' : 'idle')];
    const closed = new Set<string>();
    const push = () => {
      const rs = [...open].map(([id, slot]) => room(id, slot));
      const as = [...open.keys()].flatMap((id) => agentsOf(id, 'working')).concat([...closed].flatMap((id) => agentsOf(id, 'offline')));
      sim.applySnapshot(snap(rs, as, ++rev), clock.now);
    };
    push();
    let maxStep = 0;
    // per character (someone coming back with the same id is another character, out of the elevator)
    const last = new WeakMap<object, { x: number; y: number }>();
    const track = () => {
      for (const ch of sim.chars.values()) {
        const p = last.get(ch);
        if (p && ch.visible && !ch.inside && clock.now >= ch.hiddenUntil) maxStep = Math.max(maxStep, Math.hypot(ch.x - p.x, ch.y - p.y));
        last.set(ch, { x: ch.x, y: ch.y });
      }
      return false;
    };
    for (let round = 0; round < 14; round++) {
      const roll = rnd();
      if (roll < 0.55 && open.size > 1) {
        const id = [...open.keys()][Math.floor(rnd() * open.size)]!;
        open.delete(id);
        closed.add(id);
      } else {
        const id = ids.find((x) => !open.has(x));
        if (id) {
          open.set(id, nextSlot++);
          closed.delete(id);
        }
      }
      push();
      run(sim, clock, 4 + rnd() * 40, track);
    }
    run(sim, clock, 400, () => {
      track();
      const rs = [...sim.rooms.values()];
      const compact = rs.every((r) => r.slot < rs.length);
      return compact && rs.every((r) => r.listed && r.phase === 'ready' && !r.ghost) && [...sim.chars.values()].every((c) => !c.leaving);
    });
    const slots = [...sim.rooms.values()].map((r) => r.slot).sort((a, b) => a - b);
    expect([...sim.rooms.keys()].sort()).toEqual([...open.keys()].sort());
    expect(slots).toEqual(slots.map((_, i) => i));
    expect([...sim.rooms.values()].some((r) => r.ghost)).toBe(false);
    run(sim, clock, 20, () => sim.building.cols === 2 + Math.ceil(open.size / 2));
    expect(sim.building.cols).toBe(2 + Math.ceil(open.size / 2));
    expect(maxStep).toBeLessThan(12);
  });

  it('a room that opens later takes the first free slot', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2)], [agent('ana', '/a', 'working'), agent('caio', '/c', 'working')]), clock.now);
    expect(sim.rooms.get('/c')!.slot).toBe(1);
    run(sim, clock, 0.5);
    // the server sends the new room in a high slot; in the building it goes to slot 2
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2), room('/d', 7)], [agent('ana', '/a', 'working'), agent('caio', '/c', 'working'), agent('duda', '/d', 'working')], 2), clock.now);
    expect(sim.rooms.get('/d')!.slot).toBe(2);
    expect(sim.rooms.get('/d')!.phase).toBe('building');
  });
});

describe('waiting for a job', () => {
  const MIN = 60_000;
  const shell = (ageMs: number, extra: Partial<ShellJob> = {}): ShellJob => ({
    id: `b-${ageMs}`,
    label: 'Run the full suite',
    startedAt: T0 - ageMs,
    background: true,
    kind: 'shell',
    ...extra,
  });
  const done = (id: string, error = false): AgentInfo['activity'] => ({ id, kind: 'run', icon: error ? '❌' : '✅', text: 'Shell finished', tool: SHELL_DONE_TOOL, error, at: T0 });

  it("shell status: stays at the desk with the popcorn and doesn't go for outings", () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'shell', { jobs: [shell(20_000)] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.mode).toBe('shell');
    expect(ana.shellCount).toBe(1);
    expect(ana.shellLabel).toBe('Run the full suite');
    ana.nextOutingAt = 1;
    run(sim, clock, 60, () => ana.atSpot !== ana.homeSpot);
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.pose).toBe('wait');
    expect(ana.held).toBe('popcorn');
    expect(ana.shellStage).toBe('popcorn');
  });

  it("the escalation follows the oldest job's age: spins, cobweb/yawn and nap", () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { jobs: [shell(4 * MIN), shell(30_000)] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.shellCount).toBe(2);
    run(sim, clock, 0.2);
    expect(ana.shellStage).toBe('restless');
    expect(ana.held).toBe('none');
    const home = sim.spots.get(ana.homeSpot)!;
    const dirs = new Set<string>();
    run(sim, clock, 30, () => {
      dirs.add(ana.dir);
      return false;
    });
    // at least one full spin in the chair
    expect(dirs.size).toBe(4);
    expect(ana.dir).toBe(home.dir);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { jobs: [shell(12 * MIN + (clock.now - T0))] })], 2), clock.now);
    run(sim, clock, 0.1);
    expect(ana.shellStage).toBe('cobweb');
    let yawned = false;
    run(sim, clock, 40, () => {
      if (ana.chatEmoji === '🥱' && ana.pose === 'sleep') yawned = true;
      return yawned;
    });
    expect(yawned).toBe(true);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { jobs: [shell(26 * MIN + (clock.now - T0))] })], 3), clock.now);
    run(sim, clock, 0.1);
    expect(ana.shellStage).toBe('nap');
    expect(ana.pose).toBe('sleep');
  });

  it('on an outing when the job starts: back to the desk (leaving the stall normally)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'idle')]), clock.now);
    const ana = sim.chars.get('ana')!;
    ana.nextOutingAt = 1;
    run(sim, clock, 60, () => ana.atSpot !== ana.homeSpot && !!ana.step && ana.step.t !== 'exit');
    expect(ana.atSpot === ana.homeSpot).toBe(false);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { jobs: [shell(1000)] })], 2), clock.now);
    expect(ana.mode).toBe('shell');
    let ran = false;
    run(sim, clock, 60, () => {
      if (ana.pose === 'run') ran = true;
      return ana.atSpot === ana.homeSpot && !ana.step && !ana.queue.length;
    });
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ran).toBe(false);
    run(sim, clock, 0.1);
    expect(ana.pose).toBe('wait');
  });

  it('a long foreground command: typing for the first 10 s, then the same wait', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const fg = shell(0, { id: 'toolu_1', background: false });
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working', { jobs: [fg] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    run(sim, clock, 5);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
    run(sim, clock, 7);
    expect(ana.mode).toBe('shell');
    expect(ana.pose).toBe('wait');
    expect(ana.atSpot).toBe(ana.homeSpot);
    // the command finished (tool result): back to typing
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working', { jobs: [] })], 2), clock.now);
    run(sim, clock, 0.2);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
  });

  it('job finished: stands up, cheers with ⭐ and confetti, and goes back to work', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const base = agent('ana', '/a', 'shell', { jobs: [shell(2 * MIN)], activity: { id: 'a0', kind: 'run', icon: '💻', text: 'Running', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    // the notification arrives and the agent is already back at work in the same snapshot
    sim.applySnapshot(snap(rooms, [{ ...base, status: 'working', jobs: [], activity: done('a1') }], 2), clock.now);
    expect(ana.icon).toBe('star');
    expect(sim.effects.some((e) => e.kind === 'confetti' && e.charId === 'ana')).toBe(true);
    const poses = new Set<string>();
    run(sim, clock, 3, () => {
      poses.add(ana.pose);
      return false;
    });
    expect(poses.has('stretch')).toBe(true);
    run(sim, clock, 5, () => ana.atSpot === ana.homeSpot && ana.pose === 'type');
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
  });

  it("an old job's end doesn't celebrate at load; a new one behind another activity does", () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const old = done('old')!;
    const base = agent('ana', '/a', 'working', { recent: [old], activity: { id: 'a0', kind: 'edit', icon: '✏️', text: 'Editando', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    expect(ana.icon).toBeNull();
    expect(sim.effects.length).toBe(0);
    const fresh = { ...done('new')!, at: T0 + 400 };
    const later = { id: 'a2', kind: 'read' as const, icon: '📖', text: 'Reading the output', at: T0 + 450 };
    sim.applySnapshot(snap(rooms, [{ ...base, recent: [old, fresh, later], activity: later }], 2), clock.now);
    expect(ana.icon).toBe('star');
    expect(sim.effects.length).toBe(1);
    // the same snapshot again doesn't celebrate twice
    sim.applySnapshot(snap(rooms, [{ ...base, recent: [old, fresh, later], activity: later }], 3), clock.now);
    expect(sim.effects.length).toBe(1);
  });

  it('job failed: little rain cloud, head down for ~4 s, no confetti', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const base = agent('ana', '/a', 'shell', { jobs: [shell(2 * MIN), shell(MIN)], activity: { id: 'a0', kind: 'run', icon: '💻', text: 'Running', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    sim.effects.length = 0;
    // one of the two failed; the other keeps running
    sim.applySnapshot(snap(rooms, [{ ...base, jobs: [shell(MIN)], activity: done('a1', true) }], 2), clock.now);
    expect(ana.icon).toBe('storm');
    expect(sim.effects.length).toBe(0);
    run(sim, clock, 1);
    expect(ana.pose).toBe('sleep');
    expect(ana.atSpot).toBe(ana.homeSpot);
    run(sim, clock, 4);
    expect(ana.icon).toBeNull();
    expect(ana.mode).toBe('shell');
    expect(ana.shellCount).toBe(1);
    expect(ana.pose).toBe('wait');
  });
});
