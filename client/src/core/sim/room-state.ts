// Ported from habblaud client/src/world/sim/room-state.ts (MIT, © 2026 Márcio Junior)
// A project room's state in the world: lifecycle (build/dismantle) and light.
import type { RoomInfo } from '../../../../shared/protocol';
import { BUILD_MS, DISMANTLE_MS } from '../constants';
import type { AreaLayout } from '../layout/types';
import type { RoomTheme } from '../vocab';
import { lightLevel } from './behavior';

/**
 * - building: the build animation;
 * - ready: the room is ready;
 * - dismantling: the dismantle animation;
 * - gone: dismantled (about to be removed).
 */
export type RoomPhase = 'building' | 'ready' | 'dismantling' | 'gone';

export class RoomState {
  info: RoomInfo;
  /** The seed the palette and layout were made from (fixed at creation, even if info.seed changes). */
  readonly seed: number;
  /** The building slot the client picked (no gaps; see Sim.compact). May differ from info.slot. */
  slot: number;
  theme: RoomTheme;
  layout: AreaLayout;
  phase: RoomPhase;
  phaseAt: number;
  listed = true;
  unlistedAt = 0;
  lightOn: boolean;
  lightAt = -1e9;
  /** The character in charge of the switch (lights on when arriving, off when leaving). */
  switchClaim: string | null = null;
  /** When all dismantle conditions became true (0 = they aren't). */
  readyToDismantleAt = 0;
  /** Accounts present (for the sign's dots), updated by the world. */
  accounts: string[] = [];
  /** The kanban board's items. */
  board: { status: 'pending' | 'in_progress' | 'completed' }[] = [];
  /** Bumped when something static changes (name, palette). */
  version = 0;
  /**
   * The old address of a room that moved: it stays only until whoever was in it leaves, the light goes off and it's
   * dismantled. Nobody belongs to it and it isn't in the snapshot.
   */
  ghost = false;

  constructor(info: RoomInfo, theme: RoomTheme, layout: AreaLayout, phase: RoomPhase, now: number, lit: boolean, slot: number) {
    this.info = info;
    this.seed = info.seed;
    this.slot = slot;
    this.theme = theme;
    this.layout = layout;
    this.phase = phase;
    this.phaseAt = now;
    this.lightOn = lit;
    if (lit) this.lightAt = now - 10_000;
  }

  get id(): string {
    return this.info.id;
  }

  /** Progress of the current phase's animation (0..1). */
  progress(now: number): number {
    if (this.phase === 'building') return Math.min(1, (now - this.phaseAt) / BUILD_MS);
    if (this.phase === 'dismantling') return Math.min(1, (now - this.phaseAt) / DISMANTLE_MS);
    if (this.phase === 'ready') return 1;
    return 0;
  }

  /** Takes part in the walk grid and is drawn. */
  get present(): boolean {
    return this.phase === 'building' || this.phase === 'ready' || this.phase === 'dismantling';
  }

  setPhase(phase: RoomPhase, now: number): void {
    this.phase = phase;
    this.phaseAt = now;
  }

  /** Turns a dismantle in progress back into a build, from the equivalent visual point. */
  rebuild(now: number): void {
    if (this.phase === 'dismantling') {
      const p = this.progress(now);
      this.phase = 'building';
      this.phaseAt = now - (1 - p) * BUILD_MS;
    } else if (this.phase === 'gone') {
      this.setPhase('building', now);
    }
  }

  setLight(on: boolean, now: number): void {
    if (this.lightOn === on) return;
    this.lightOn = on;
    this.lightAt = now;
  }

  light(now: number): number {
    return lightLevel(this.lightOn, now - this.lightAt);
  }
}
