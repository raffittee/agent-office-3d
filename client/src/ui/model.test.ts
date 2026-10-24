import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../shared/protocol';
import { ago, compact, countByStatus, sidebarTree } from './model';

const T0 = Date.parse('2026-10-25T09:00:00Z');

function room(id: string, slot: number, name = id): RoomInfo {
  return { id, name, path: `/home/dev/${name}`, slot, seed: slot, createdAt: T0 };
}

function agent(id: string, roomId: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: extra.parentId ? 'sub' : 'main',
    provider: 'claude-code',
    roomId,
    name: id,
    look: 'f',
    role: 'Main agent',
    sessionId: id,
    account: 'default',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...extra,
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[]): OfficeSnapshot {
  return { rev: 1, serverTime: T0, rooms, agents, accounts: [], meta: { demo: false, sources: [], providers: [], startedAt: T0, version: 't' } };
}

const S = snap(
  [room('/b', 1, 'api'), room('/a', 0, 'web')],
  [
    agent('Zoe', '/a'),
    agent('Ana', '/a', { status: 'waiting' }),
    agent('Kid', '/a', { parentId: 'Zoe', title: 'Map the routes' }),
    agent('Gem', '/b', { provider: 'gemini-cli', activity: { id: 'x', kind: 'edit', icon: '✏️', text: 'Editing billing.ts', at: T0 } }),
    agent('Old', '/b', { status: 'offline' }),
  ],
);
const all = { query: '', providers: new Set<never>() };

describe('sidebar tree', () => {
  it('rooms in slot order; main agents by name, subagents under their parent; offline left out', () => {
    const tree = sidebarTree(S, all);
    expect(tree.map((r) => r.room.name)).toEqual(['web', 'api']);
    expect(tree[0]!.agents.map((a) => `${a.agent.name}:${a.depth}`)).toEqual(['Ana:0', 'Zoe:0', 'Kid:1']);
    expect(tree[0]!.waiting).toBe(1);
    expect(tree[1]!.agents.map((a) => a.agent.name)).toEqual(['Gem']);
  });

  it('search matches agents (name, title, activity) and rooms (name, path); a matching subagent keeps its parent', () => {
    expect(sidebarTree(S, { ...all, query: 'billing' }).map((r) => r.agents.map((a) => a.agent.name))).toEqual([['Gem']]);
    expect(sidebarTree(S, { ...all, query: 'routes' })[0]!.agents.map((a) => a.agent.name)).toEqual(['Zoe', 'Kid']);
    expect(sidebarTree(S, { ...all, query: 'API' })[0]!.agents.map((a) => a.agent.name)).toEqual(['Gem']);
    expect(sidebarTree(S, { ...all, query: 'nothing here' })).toEqual([]);
  });

  it('the provider filter keeps only the chosen providers', () => {
    const tree = sidebarTree(S, { query: '', providers: new Set(['gemini-cli'] as const) });
    expect(tree.flatMap((r) => r.agents.map((a) => a.agent.name))).toEqual(['Gem']);
  });
});

describe('formatting', () => {
  it('counts statuses', () => {
    expect(countByStatus(S.agents)).toMatchObject({ working: 3, waiting: 1, offline: 1 });
  });

  it('relative times and compact numbers', () => {
    expect(ago(1000)).toBe('just now');
    expect(ago(45_000)).toBe('45 s ago');
    expect(ago(12 * 60_000)).toBe('12 min ago');
    expect(ago(3 * 3_600_000)).toBe('3 h ago');
    expect(ago(72 * 3_600_000)).toBe('3 d ago');
    expect(compact(950)).toBe('950');
    expect(compact(1234)).toBe('1.2k');
    expect(compact(45_600)).toBe('46k');
    expect(compact(2_500_000)).toBe('2.5M');
  });
});
