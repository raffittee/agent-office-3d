// Debug page (P1-12, temporary: deleted in P2-10). Pure: a snapshot → rooms with their agents, ready to print.
import type { AgentInfo, AgentStatus, OfficeSnapshot, ProviderId } from '../../../shared/protocol';

export interface DebugAgent {
  id: string;
  name: string;
  /** Subagents are indented under their parent. */
  depth: number;
  role: string;
  provider: ProviderId;
  providerLabel: string;
  providerColor: string;
  status: AgentStatus;
  /** Icon + text of the current activity, or why it waits. */
  activity: string;
  jobs: number;
}

export interface DebugRoom {
  id: string;
  name: string;
  path: string;
  agents: DebugAgent[];
}

const FALLBACK_COLOR = '#888888';

/** Rooms in slot order; in each room, main agents by name, each followed by its subagents. */
export function debugRooms(snap: OfficeSnapshot): DebugRoom[] {
  const providers = new Map(snap.meta.providers.map((p) => [p.id, p]));
  const row = (a: AgentInfo, depth: number): DebugAgent => {
    const p = providers.get(a.provider);
    const activity = a.status === 'waiting' && a.waitingFor ? `✋ ${a.waitingFor}` : a.activity ? `${a.activity.icon} ${a.activity.text}` : '';
    return {
      id: a.id,
      name: a.name,
      depth,
      role: a.role,
      provider: a.provider,
      providerLabel: p?.label ?? a.provider,
      providerColor: p?.color ?? FALLBACK_COLOR,
      status: a.status,
      activity,
      jobs: a.jobs?.length ?? 0,
    };
  };
  const byName = (x: AgentInfo, y: AgentInfo) => x.name.localeCompare(y.name);
  const children = new Map<string, AgentInfo[]>();
  for (const a of snap.agents) {
    if (a.parentId === undefined) continue;
    const list = children.get(a.parentId) ?? [];
    list.push(a);
    children.set(a.parentId, list);
  }
  const ids = new Set(snap.agents.map((a) => a.id));
  const walk = (a: AgentInfo, depth: number, out: DebugAgent[]) => {
    out.push(row(a, depth));
    for (const c of (children.get(a.id) ?? []).sort(byName)) walk(c, depth + 1, out);
  };
  return [...snap.rooms]
    .sort((x, y) => x.slot - y.slot)
    .map((room) => {
      const agents: DebugAgent[] = [];
      // Roots: main agents, and subagents whose parent is gone (so nothing disappears from the list).
      const roots = snap.agents.filter((a) => a.roomId === room.id && (a.parentId === undefined || !ids.has(a.parentId))).sort(byName);
      for (const a of roots) walk(a, 0, agents);
      return { id: room.id, name: room.name, path: room.path, agents };
    });
}
