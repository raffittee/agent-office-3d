// Ported from habblaud client/src/world/sound-cues.ts (MIT, © 2026 Márcio Junior)
// Ambient sounds the world suggests (P6-05): keystrokes from whoever types on screen, a "ding" when an elevator door
// starts to open, and the games (ping-pong paddle and table, the arcade). Only watches the sim and the view; the UI
// decides whether anything plays (settings, volume, hidden tab). Pure: the camera comes in as `SoundView`.
import type { SoundCue } from '../audio/scheduler';
import type { Character } from './sim/character';
import type { Sim } from './sim/sim';

/** Re-checks who is typing this often (ms). */
const KEYS_TICK_MS = 160;
/** Half a rally: paddle at the ends, bounce in the middle (ms). */
const PINGPONG_HALF_MS = 550;

/** What the camera sees, in sim world units. */
export interface SoundView {
  /** Is this world point on screen (with a margin)? */
  visible(x: number, y: number): boolean;
  /** -0.7 .. 0.7: where on screen, left to right. */
  pan(x: number, y: number): number;
  /** 0.45..1: zoomed out, everything is quieter. */
  near(): number;
}

export class SoundCues {
  private doors: number[] = [];
  private keysAt = 0;
  private nextKeysAt = 0;
  private nextArcadeAt = 0;
  private rally = new Map<number, number>();

  constructor(
    private readonly sim: Sim,
    private readonly rng: () => number = Math.random,
  ) {}

  update(now: number, view: SoundView, emit: (cue: SoundCue) => void): void {
    const near = view.near();
    this.elevators(view, emit);
    this.keys(now, view, near, emit);
    this.social(now, view, near, emit);
  }

  /** "Ding" when a door starts opening; quieter off screen (it still tells you someone arrived). */
  private elevators(view: SoundView, emit: (cue: SoundCue) => void): void {
    this.sim.elevators.forEach((e, i) => {
      const prev = this.doors[i];
      this.doors[i] = e.door;
      if (prev === undefined || prev > 0.01 || e.door <= 0.01) return;
      const spot = this.sim.spots.get(e.spotId);
      if (!spot) return;
      emit({ kind: 'elevator', gain: view.visible(spot.x, spot.y) ? 1 : 0.5, pan: view.pan(spot.x, spot.y) });
    });
  }

  /** Bursts of keys, more often the more people type on screen. */
  private keys(now: number, view: SoundView, near: number, emit: (cue: SoundCue) => void): void {
    if (now - this.keysAt < KEYS_TICK_MS) return;
    this.keysAt = now;
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const ch of this.sim.chars.values()) {
      if (!typing(ch) || !view.visible(ch.x, ch.y)) continue;
      n++;
      sx += ch.x;
      sy += ch.y;
    }
    if (!n || now < this.nextKeysAt) return;
    if (this.rng() > Math.min(0.8, 0.3 + 0.12 * n)) return;
    this.nextKeysAt = now + (700 + this.rng() * 1500) / Math.sqrt(Math.min(n, 6));
    emit({ kind: 'keys', gain: near * Math.min(1, 0.6 + 0.1 * n), pan: view.pan(sx / n, sy / n), count: 2 + Math.floor(this.rng() * 5) });
  }

  /** Ping-pong (paddle, then table, in rhythm) and the arcade, while the game runs. */
  private social(now: number, view: SoundView, near: number, emit: (cue: SoundCue) => void): void {
    const alive = new Set<number>();
    for (const g of this.sim.social.gatherings.values()) {
      if (g.phase !== 'run' || (g.kind !== 'pingpong' && g.kind !== 'arcade')) continue;
      let x = 0;
      let y = 0;
      let k = 0;
      for (const m of g.members) {
        if (m.watcher || m.left) continue;
        const ch = this.sim.chars.get(m.id);
        if (!ch) continue;
        x += ch.x;
        y += ch.y;
        k++;
      }
      if (!k) continue;
      x /= k;
      y /= k;
      if (!view.visible(x, y)) continue;
      if (g.kind === 'pingpong') {
        alive.add(g.id);
        const seg = Math.floor((now - g.createdAt) / PINGPONG_HALF_MS);
        const prev = this.rally.get(g.id);
        this.rally.set(g.id, seg);
        if (prev !== undefined && prev !== seg) emit({ kind: seg % 2 === 0 ? 'pingpong' : 'table', gain: near, pan: view.pan(x, y) });
      } else if (now >= this.nextArcadeAt) {
        this.nextArcadeAt = now + 500 + this.rng() * 900;
        emit({ kind: 'arcade', gain: near * 0.8, pan: view.pan(x, y) });
      }
    }
    for (const id of this.rally.keys()) if (!alive.has(id)) this.rally.delete(id);
  }
}

/** Seated at its own desk, typing. */
function typing(ch: Character): boolean {
  return ch.mode === 'work' && ch.seated && ch.pose === 'type' && !ch.leaving && !ch.inside && ch.alpha > 0.5;
}
