// Ported from habblaud server/model/rooms.ts (MIT, © 2026 Márcio Junior)
// Office rooms: identity (normalized cwd), display name and position (slot) in the building.

/** A Windows path: drive letter (`C:\`, `c:/`) or UNC (`\\server\share`). */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Room key of a working directory. POSIX paths: no repeated or trailing slashes. Windows paths are
 * case-insensitive and come with either separator (VS Code writes `c:\`, the desktop app `C:\`, P0-05): forward
 * slashes and lower case, so both land in the same room.
 */
export function normalizeCwd(cwd: string): string {
  const raw = cwd.trim();
  if (WINDOWS_PATH.test(raw)) {
    const unc = raw.startsWith('\\\\');
    let p = raw.replace(/[\\/]+/g, '/').toLowerCase();
    if (unc) p = `/${p}`;
    return /^[a-z]:\/$/.test(p) ? p : p.replace(/\/+$/, '');
  }
  const p = raw.replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * Each room's name: the folder name; rooms with the same folder name get parent folders added until they are
 * distinct (e.g. "applications/app" and "other/app").
 */
export function roomDisplayNames(rooms: ReadonlyMap<string, string>): Map<string, string> {
  const segs = new Map([...rooms].map(([id, path]) => [id, segments(path)]));
  const depth = new Map([...rooms.keys()].map((id) => [id, 1]));
  const nameOf = (id: string) => {
    const s = segs.get(id)!;
    return s.length ? s.slice(-depth.get(id)!).join('/') : rooms.get(id) || '/';
  };
  for (let guard = 0; guard < 16; guard++) {
    const groups = new Map<string, string[]>();
    for (const id of rooms.keys()) {
      const n = nameOf(id).toLowerCase();
      groups.set(n, [...(groups.get(n) ?? []), id]);
    }
    let grew = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        if (depth.get(id)! < segs.get(id)!.length) {
          depth.set(id, depth.get(id)! + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map([...rooms.keys()].map((id) => [id, nameOf(id)]));
}

/**
 * Hands out slots: a new room takes the lowest free slot that isn't cooling down. A freed slot is reused only after
 * `cooldownMs` (the length of the leaving animation).
 */
export class SlotAllocator {
  private slots = new Map<string, number>();
  private freedAt = new Map<number, number>();

  constructor(private readonly cooldownMs = 30_000) {}

  /** Adjusts the allocation to the current set of rooms. Returns true when something changed. */
  sync(ids: Iterable<string>, now: number): boolean {
    const live = new Set(ids);
    let changed = false;
    for (const [id, slot] of [...this.slots]) {
      if (live.has(id)) continue;
      this.slots.delete(id);
      this.freedAt.set(slot, now);
      changed = true;
    }
    for (const id of live) {
      if (this.slots.has(id)) continue;
      this.slots.set(id, this.firstFree(now));
      changed = true;
    }
    return changed;
  }

  slotOf(id: string): number | undefined {
    return this.slots.get(id);
  }

  private firstFree(now: number): number {
    const used = new Set(this.slots.values());
    for (let slot = 0; ; slot++) {
      if (used.has(slot)) continue;
      const freed = this.freedAt.get(slot);
      if (freed !== undefined && now - freed < this.cooldownMs) continue;
      this.freedAt.delete(slot);
      return slot;
    }
  }
}
