// Pure helpers for the panels: counters, the sidebar's rooms → agents tree with search and provider filter, time
// formatting and status labels. Tested without a DOM.
import { t } from '../../../shared/i18n';
import type { AgentInfo, AgentStatus, OfficeSnapshot, ProviderId, ProviderMeta, RoomInfo } from '../../../shared/protocol';

export const STATUS_ORDER: readonly AgentStatus[] = ['waiting', 'working', 'shell', 'idle', 'done', 'offline'];

export const STATUS_COLORS: Record<AgentStatus, string> = {
  working: '#2e9d4f',
  waiting: '#e0861f',
  idle: '#5b7fa6',
  shell: '#8a63c9',
  done: '#3aa6a0',
  offline: '#8a8a8a',
};

export function statusLabel(s: AgentStatus): string {
  switch (s) {
    case 'working':
      return t('working');
    case 'waiting':
      return t('needs you');
    case 'idle':
      return t('idle');
    case 'shell':
      return t('waiting for a job');
    case 'done':
      return t('done');
    case 'offline':
      return t('offline');
  }
}

/** Agents per status (offline ones aren't counted). */
export function countByStatus(agents: readonly AgentInfo[]): Record<AgentStatus, number> {
  const out: Record<AgentStatus, number> = { working: 0, waiting: 0, idle: 0, shell: 0, done: 0, offline: 0 };
  for (const a of agents) out[a.status]++;
  return out;
}

export interface SidebarFilter {
  /** Free text matched against agent name, title, role, activity, room name and path (case-insensitive). */
  query: string;
  /** Providers to show; empty = all. */
  providers: ReadonlySet<ProviderId>;
}

export interface TreeAgent {
  agent: AgentInfo;
  depth: number;
}

export interface TreeRoom {
  room: RoomInfo;
  agents: TreeAgent[];
  /** Agents needing the user in this room. */
  waiting: number;
}

function matches(text: string | undefined, q: string): boolean {
  return !!text && text.toLowerCase().includes(q);
}

/**
 * Rooms in slot order with their agents (main agents by name, each followed by its subagents). A room matches the
 * search through its name or path (then all its agents show) or through any agent; offline agents are left out.
 */
export function sidebarTree(snap: OfficeSnapshot, f: SidebarFilter): TreeRoom[] {
  const q = f.query.trim().toLowerCase();
  const byProvider = (a: AgentInfo) => !f.providers.size || f.providers.has(a.provider);
  const live = snap.agents.filter((a) => a.status !== 'offline' && byProvider(a));
  const ids = new Set(live.map((a) => a.id));
  const kids = new Map<string, AgentInfo[]>();
  for (const a of live) {
    if (!a.parentId || !ids.has(a.parentId)) continue;
    const list = kids.get(a.parentId) ?? [];
    list.push(a);
    kids.set(a.parentId, list);
  }
  const byName = (x: AgentInfo, y: AgentInfo) => x.name.localeCompare(y.name);
  const out: TreeRoom[] = [];
  for (const room of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
    const roomHit = !q || matches(room.name, q) || matches(room.path, q);
    const agentHit = (a: AgentInfo) => !q || roomHit || matches(a.name, q) || matches(a.title, q) || matches(a.role, q) || matches(a.activity?.text, q);
    const agents: TreeAgent[] = [];
    const walk = (a: AgentInfo, depth: number) => {
      const sub = (kids.get(a.id) ?? []).sort(byName);
      const visibleKids: TreeAgent[] = [];
      for (const k of sub) {
        const before = agents.length;
        walk(k, depth + 1);
        visibleKids.push(...agents.splice(before));
      }
      if (agentHit(a) || visibleKids.length) agents.push({ agent: a, depth }, ...visibleKids);
    };
    for (const a of live.filter((x) => x.roomId === room.id && (!x.parentId || !ids.has(x.parentId))).sort(byName)) walk(a, 0);
    if (!agents.length && !(roomHit && q)) continue;
    out.push({ room, agents, waiting: agents.filter((x) => x.agent.status === 'waiting').length });
  }
  return out;
}

/** "just now", "45 s", "12 min", "3 h", "2 d" ago. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return t('just now');
  if (s < 60) return t('{0} s ago', [s]);
  const m = Math.floor(s / 60);
  if (m < 60) return t('{0} min ago', [m]);
  const h = Math.floor(m / 60);
  if (h < 48) return t('{0} h ago', [h]);
  return t('{0} d ago', [Math.floor(h / 24)]);
}

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function providerMeta(snap: OfficeSnapshot | null, id: ProviderId): ProviderMeta {
  return snap?.meta.providers.find((p) => p.id === id) ?? { id, label: id, color: '#888888', capabilities: { transcript: false, approve: false, message: false, usage: false, subagents: false } };
}
