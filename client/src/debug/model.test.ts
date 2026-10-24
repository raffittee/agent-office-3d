import { describe, expect, it } from 'vitest';
import { createMockOffice } from '../../../shared/demo/mock';
import type { OfficeSnapshot } from '../../../shared/protocol';
import { debugRooms } from './model';

const T0 = Date.parse('2026-10-25T09:00:00Z');

function snapshotWithSubagents(): OfficeSnapshot {
  const mock = createMockOffice({ seed: 11 }, T0);
  for (let now = T0; now <= T0 + 20 * 60_000; now += 250) {
    const snap = mock.step(now).snapshot;
    if (snap.agents.some((a) => a.kind === 'sub')) return snap;
  }
  throw new Error('the demo never started a subagent');
}

describe('debugRooms', () => {
  it('lists every agent once, in its room, rooms in slot order', () => {
    const snap = snapshotWithSubagents();
    const rooms = debugRooms(snap);
    expect(rooms.map((r) => r.id)).toEqual([...snap.rooms].sort((a, b) => a.slot - b.slot).map((r) => r.id));
    const listed = rooms.flatMap((r) => r.agents.map((a) => a.id));
    expect([...listed].sort()).toEqual(snap.agents.map((a) => a.id).sort());
    for (const r of rooms) for (const a of r.agents) expect(snap.agents.find((x) => x.id === a.id)!.roomId).toBe(r.id);
  });

  it('puts subagents right under their parent, with the provider badge from meta', () => {
    const snap = snapshotWithSubagents();
    const sub = snap.agents.find((a) => a.kind === 'sub')!;
    const room = debugRooms(snap).find((r) => r.id === sub.roomId)!;
    const i = room.agents.findIndex((a) => a.id === sub.id);
    expect(room.agents[i]!.depth).toBe(1);
    const parent = room.agents.slice(0, i).reverse().find((a) => a.depth === 0)!;
    expect(parent.id).toBe(sub.parentId);
    const meta = snap.meta.providers.find((p) => p.id === sub.provider)!;
    expect(room.agents[i]).toMatchObject({ providerLabel: meta.label, providerColor: meta.color });
  });

  it('shows why an agent waits, and keeps orphaned subagents', () => {
    const snap = snapshotWithSubagents();
    const main = snap.agents.find((a) => a.kind === 'main')!;
    const waiting = { ...main, status: 'waiting' as const, waitingFor: 'approve a permission' };
    const orphan = { ...main, id: 'x:orphan', kind: 'sub' as const, parentId: 'gone', name: 'Zed' };
    const rooms = debugRooms({ ...snap, agents: [waiting, orphan] });
    const agents = rooms.flatMap((r) => r.agents);
    expect(agents.find((a) => a.id === main.id)!.activity).toBe('✋ approve a permission');
    expect(agents.find((a) => a.id === 'x:orphan')!.depth).toBe(0);
  });
});
