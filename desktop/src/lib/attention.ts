// What the tray shows: how many agents wait for you, and who just started waiting (for a notification).
import type { OfficeSnapshot } from '../../../shared/protocol';

export interface WaitingAgent {
  id: string;
  name: string;
  room: string;
}

export interface Attention {
  waiting: WaitingAgent[];
  working: number;
  total: number;
}

type SnapshotLike = Pick<OfficeSnapshot, 'agents' | 'rooms'>;

export function attentionOf(snap: SnapshotLike): Attention {
  const rooms = new Map(snap.rooms.map((r) => [r.id, r.name]));
  const waiting: WaitingAgent[] = [];
  let working = 0;
  let total = 0;
  for (const a of snap.agents) {
    if (a.status === 'offline' || a.status === 'done') continue;
    total++;
    if (a.status === 'working') working++;
    if (a.status === 'waiting') waiting.push({ id: a.id, name: a.name, room: rooms.get(a.roomId) ?? '' });
  }
  return { waiting, working, total };
}

export function trayTooltip(a: Attention): string {
  if (!a.total) return 'Agent Office: no agents';
  const parts: string[] = [];
  if (a.waiting.length) parts.push(a.waiting.length === 1 ? '1 needs you' : `${a.waiting.length} need you`);
  if (a.working) parts.push(`${a.working} working`);
  const rest = a.total - a.waiting.length - a.working;
  if (rest > 0) parts.push(`${rest} idle`);
  return `Agent Office: ${parts.join(' · ')}`;
}

/** The agents that are waiting now but weren't in `before`, and the set to pass next time. */
export function newlyWaiting(before: ReadonlySet<string>, a: Attention): { fresh: WaitingAgent[]; next: Set<string> } {
  return { fresh: a.waiting.filter((w) => !before.has(w.id)), next: new Set(a.waiting.map((w) => w.id)) };
}

/** Text of a notification. Only names the agent and its room: never what it was doing or asked. */
export function notificationText(fresh: readonly WaitingAgent[]): { title: string; body: string } | null {
  const first = fresh[0];
  if (!first) return null;
  if (fresh.length > 1) return { title: 'Agent Office', body: `${fresh.length} agents need you` };
  return { title: 'Agent Office', body: first.room ? `${first.name} (${first.room}) needs you` : `${first.name} needs you` };
}
