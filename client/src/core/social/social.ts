// Social life (P6-01): when an idle agent's outing comes up, it may gather others who are idle too — the TV,
// ping-pong, an arcade duel, a kitchen chat, a quick talk, rock-paper-scissors. This director picks the activity
// and the partners by personality, sends everyone to their places through the sim's step queue, and runs the scene
// (lines, scores, cheering and sulking). It holds no rendering state: poses, icons and bubbles go on the characters.
// (Inspired by Habblaud's social module; rewritten for this sim.)
import { mulberry32 } from '../../../../shared/hash';
import type { SpotDef } from '../layout/types';
import type { Character } from '../sim/character';
import type { SpotRegistry } from '../sim/spots';
import type { Step } from '../sim/steps';
import type { HeldItem, IconName, Pose } from '../vocab';
import { GATHER_KINDS, KINDS, partnerScore, pickGesture, pickKind, rpsResult, winChance, type GatherKind, type Gesture } from './gathering';
import { BYE, CHATTER, LOSE, OPENERS, pick, WIN } from './lines';
import { mix, personaFor } from './persona';

/** The parts of the sim the director uses. */
export interface SocialHost {
  readonly chars: ReadonlyMap<string, Character>;
  readonly spots: SpotRegistry;
  pushLeave(ch: Character, steps: Step[]): void;
  pushHome(ch: Character, held: 'none' | 'coffee' | 'water'): void;
  reserveTemp(ch: Character, spot: SpotDef): boolean;
  clearPlan(ch: Character): void;
}

type Hold = Extract<Step, { t: 'until' }>;

interface Member {
  id: string;
  spot: SpotDef;
  hold: Hold;
  watcher: boolean;
  arrived: boolean;
  left: boolean;
  score: number;
  basePose: Pose;
  baseHeld: HeldItem;
  /** A short pose over the base one (cheer, laugh, sulk) until this moment. */
  actUntil: number;
}

export interface Gathering {
  id: number;
  kind: GatherKind;
  host: string;
  members: Member[];
  phase: 'gather' | 'run' | 'final' | 'ended';
  createdAt: number;
  until: number;
  nextAt: number;
  rng: () => number;
}

/** Someone who doesn't reach their place in this long gives up. */
const GATHER_TIMEOUT_MS = 35_000;
/** A gathering lasts at most this long (matches end earlier when someone wins). */
const MAX_RUN_MS = 70_000;
const SAY_MS = 2_600;
const FINAL_MS = 3_200;
/** Chance an idle agent whose outing comes up tries a gathering instead of going alone (times its sociability). */
const GATHER_CHANCE = 0.75;

const RUN_MS: Record<GatherKind, [number, number]> = {
  tv: [25_000, 45_000],
  kitchen: [18_000, 32_000],
  talk: [10_000, 18_000],
  pingpong: [40_000, MAX_RUN_MS],
  arcade: [30_000, 50_000],
  rps: [12_000, 20_000],
};

const BASE: Record<GatherKind, { pose: Pose; held?: HeldItem }> = {
  tv: { pose: 'sit' },
  kitchen: { pose: 'sit', held: 'coffee' },
  talk: { pose: 'talk' },
  pingpong: { pose: 'play', held: 'paddle' },
  arcade: { pose: 'game' },
  rps: { pose: 'stand' },
};

const GESTURE_ICON: Record<Gesture, IconName> = { rock: 'hand_rock', paper: 'hand_paper', scissors: 'hand_scissors' };

export class Social {
  readonly gatherings = new Map<number, Gathering>();
  private byChar = new Map<string, Gathering>();
  private seq = 0;

  constructor(private readonly host: SocialHost) {}

  /** Is this character free to join a gathering (idle, sitting at its desk, nothing planned)? */
  canJoin(c: Character): boolean {
    return !c.gone && !c.leaving && c.mode === 'idle' && !c.step && !c.queue.length && !!c.homeSpot && c.atSpot === c.homeSpot && !this.byChar.has(c.id) && c.info.kind === 'main';
  }

  /** The gathering a character is in, if any. */
  of(id: string): Gathering | undefined {
    return this.byChar.get(id);
  }

  /** "Playing ping-pong with Ana" for the UI, or null. */
  doing(id: string): string | null {
    const g = this.byChar.get(id);
    if (!g || g.phase === 'ended') return null;
    const others = g.members.filter((m) => m.id !== id && !m.left).map((m) => this.host.chars.get(m.id)?.info.name ?? '?');
    return others.length ? `${KINDS[g.kind].label} with ${others.join(', ')}` : KINDS[g.kind].label;
  }

  /**
   * An idle agent's outing came up: maybe gather some others. Returns true when a gathering was planned (the
   * caller then skips the solo outing).
   */
  tryInitiate(ch: Character, now: number): boolean {
    const p = personaFor(ch.info.seed);
    if (ch.rng() > p.sociability * GATHER_CHANCE) return false;
    const pool = [...this.host.chars.values()].filter((c) => c !== ch && this.canJoin(c));
    if (!pool.length) return false;
    const available = new Set(GATHER_KINDS.filter((k) => this.placesFor(k, KINDS[k].min, ch) !== null));
    const kind = pickKind(p, available, ch.rng);
    if (!kind) return false;
    // partners, by bond and personality (weighted draw without replacement)
    const info = KINDS[kind];
    const want = Math.min(info.max, info.min + Math.floor(ch.rng() * (info.max - info.min + 1)));
    const chosen: Character[] = [ch];
    const cands = pool.map((c) => ({ c, w: partnerScore(ch.info.seed, c.info.seed, kind) }));
    while (chosen.length < want && cands.length) {
      const total = cands.reduce((n, x) => n + x.w, 0);
      let r = ch.rng() * total;
      const i = Math.max(0, cands.findIndex((x) => (r -= x.w) < 0));
      chosen.push(cands.splice(i, 1)[0]!.c);
    }
    if (chosen.length < info.min) return false;
    const places = this.placesFor(kind, chosen.length, ch);
    if (!places || places.length < info.min) return false;
    const members = chosen.slice(0, places.length);
    const id = ++this.seq;
    const g: Gathering = { id, kind, host: ch.id, members: [], phase: 'gather', createdAt: now, until: 0, nextAt: 0, rng: mulberry32(mix(id * 7919 + ch.info.seed)) };
    members.forEach((c, i) => {
      const spot = places[i]!;
      if (!this.host.reserveTemp(c, spot)) return;
      const watcher = !!info.watch?.includes(spot.kind);
      const base = watcher ? { pose: 'stand' as Pose, held: 'none' as HeldItem } : BASE[kind];
      const hold: Hold = { t: 'until', cond: () => g.phase === 'ended' || m.left, minMs: 0, maxMs: GATHER_TIMEOUT_MS + MAX_RUN_MS + FINAL_MS, pose: base.pose, held: base.held ?? 'none', dir: spot.dir };
      const m: Member = { id: c.id, spot, hold, watcher, arrived: false, left: false, score: 0, basePose: base.pose, baseHeld: base.held ?? 'none', actUntil: 0 };
      g.members.push(m);
      this.byChar.set(c.id, g);
      const steps: Step[] = [];
      this.host.pushLeave(c, steps);
      steps.push({ t: 'go', tx: spot.tx, ty: spot.ty, fx: spot.x, fy: spot.y, dir: spot.dir, held: base.held === 'coffee' ? 'coffee' : 'none' });
      if (spot.seated) steps.push({ t: 'enter', spot: spot.id });
      steps.push({ t: 'do', fn: () => (m.arrived = true) }, hold);
      if (spot.seated) steps.push({ t: 'exit' });
      steps.push({ t: 'do', fn: () => this.forget(c.id, g) });
      c.queue.push(...steps);
      this.host.pushHome(c, kind === 'kitchen' && c.rng() < 0.5 ? 'coffee' : 'none');
    });
    if (g.members.length < info.min) {
      for (const m of g.members) {
        const c = this.host.chars.get(m.id);
        this.byChar.delete(m.id);
        if (c) this.host.clearPlan(c);
      }
      return false;
    }
    this.gatherings.set(id, g);
    return true;
  }

  /** Places for `n` people (players first, then watchers), or null when the kind can't happen now. */
  private placesFor(kind: GatherKind, n: number, ch: Character): SpotDef[] | null {
    const info = KINDS[kind];
    const free = (s: SpotDef) => this.host.spots.isFree(s.id, ch.id);
    const spots = this.host.spots;
    let players: SpotDef[] = [];
    switch (kind) {
      case 'pingpong':
      case 'talk':
      case 'rps': {
        const group = spots.findFreeGroup(info.seats[0]!, { rng: ch.rng });
        if (!group || group.length < 2) return null;
        players = [...group].slice(0, 2);
        break;
      }
      case 'arcade':
        players = spots.ofKind('arcade').filter(free).slice(0, 2);
        break;
      case 'tv':
        players = [...spots.ofKind('sofa'), ...spots.ofKind('armchair')].filter((s) => free(s) && /lounge/.test(s.areaId));
        break;
      case 'kitchen': {
        // seats at one table: the free seat nearest to a random first one
        const seats = spots.ofKind('cafe_seat').filter(free);
        if (!seats.length) return null;
        const first = seats[Math.floor(ch.rng() * seats.length) % seats.length]!;
        players = seats.sort((a, b) => Math.abs(a.tx - first.tx) + Math.abs(a.ty - first.ty) - (Math.abs(b.tx - first.tx) + Math.abs(b.ty - first.ty)));
        break;
      }
    }
    if (players.length < info.min) return null;
    const out = players.slice(0, Math.min(n, info.match ? 2 : info.max));
    for (const k of info.watch ?? []) for (const s of spots.ofKind(k)) if (out.length < n && free(s)) out.push(s);
    return out;
  }

  /** A member was called away (its plan was dropped: work came in, or it leaves). */
  calledAway(ch: Character): void {
    const g = this.byChar.get(ch.id);
    if (!g) return;
    const m = g.members.find((x) => x.id === ch.id);
    if (m) m.left = true;
    this.byChar.delete(ch.id);
  }

  private forget(id: string, g: Gathering): void {
    if (this.byChar.get(id) === g) this.byChar.delete(id);
  }

  /** Ends everything (a fast-forward after the tab was hidden). */
  reset(): void {
    for (const g of this.gatherings.values()) g.phase = 'ended';
    this.gatherings.clear();
    this.byChar.clear();
  }

  /** Runs the scenes; call once per frame. */
  update(now: number): void {
    for (const g of [...this.gatherings.values()]) {
      const present = g.members.filter((m) => !m.left);
      if (g.phase !== 'ended' && present.length < KINDS[g.kind].min && (g.phase !== 'final' || present.length === 0)) {
        g.phase = 'ended';
      }
      switch (g.phase) {
        case 'gather': {
          const arrived = present.filter((m) => m.arrived);
          if (arrived.length === present.length || now - g.createdAt > GATHER_TIMEOUT_MS) {
            // whoever didn't make it gives up
            for (const m of present) if (!m.arrived) this.dropOut(m);
            if (present.filter((m) => m.arrived).length < KINDS[g.kind].min) {
              g.phase = 'ended';
              break;
            }
            g.phase = 'run';
            const [a, b] = RUN_MS[g.kind];
            g.until = now + a + g.rng() * (b - a);
            g.nextAt = now + 1_200;
            this.say(g, g.host, pick(OPENERS[g.kind], g.rng), now);
          }
          break;
        }
        case 'run':
          if (now >= g.nextAt) this.beat(g, now);
          if (g.phase === 'run' && now >= g.until) this.finish(g, now, null);
          break;
        case 'final':
          if (now >= g.until) g.phase = 'ended';
          break;
        case 'ended':
          break;
      }
      // short poses run out
      for (const m of g.members) {
        if (m.actUntil && now >= m.actUntil) {
          m.actUntil = 0;
          m.hold.pose = m.basePose;
          m.hold.held = m.baseHeld;
        }
      }
      if (g.phase === 'ended') this.gatherings.delete(g.id);
    }
  }

  private dropOut(m: Member): void {
    m.left = true;
    this.byChar.delete(m.id);
  }

  /** One beat of the scene: a line, a point, a round. */
  private beat(g: Gathering, now: number): void {
    const info = KINDS[g.kind];
    const players = g.members.filter((m) => !m.left && m.arrived && !m.watcher);
    g.nextAt = now + 2_400 + g.rng() * 2_200;
    if (!info.match) {
      const m = players[Math.floor(g.rng() * players.length) % players.length];
      if (!m) return;
      this.say(g, m.id, pick(CHATTER[g.kind], g.rng), now);
      this.act(m, g.kind === 'talk' || g.kind === 'kitchen' ? 'talk' : 'laugh', 1_800, now);
      // the others react
      for (const o of players) if (o !== m && g.rng() < 0.35) this.act(o, 'laugh', 1_400, now);
      return;
    }
    const [a, b] = players;
    if (!a || !b) return;
    const pa = personaFor(this.seedOf(a.id));
    const pb = personaFor(this.seedOf(b.id));
    if (g.kind === 'rps') {
      const ga = pickGesture(g.rng);
      const gb = pickGesture(g.rng);
      this.icon(a, GESTURE_ICON[ga], now);
      this.icon(b, GESTURE_ICON[gb], now);
      this.act(a, 'rps', 1_600, now);
      this.act(b, 'rps', 1_600, now);
      const r = rpsResult(ga, gb);
      if (r === 0) this.say(g, a.id, pick(CHATTER.rps, g.rng), now);
      else (r > 0 ? a : b).score++;
    } else {
      const scorer = g.rng() < winChance(pa, pb) ? a : b;
      scorer.score++;
      this.act(scorer, 'cheer', 900, now);
      if (g.rng() < 0.5) this.say(g, scorer.id, pick(CHATTER[g.kind], g.rng), now);
    }
    const target = info.target ?? 3;
    // watchers cheer now and then
    for (const w of g.members) if (w.watcher && !w.left && w.arrived && g.rng() < 0.4) this.act(w, 'cheer', 1_000, now);
    if (a.score >= target || b.score >= target) this.finish(g, now, a.score >= target ? a : b);
    else if (g.kind !== 'rps' || g.rng() < 0.4) this.chat(a, `${a.score}–${b.score}`, now);
  }

  private finish(g: Gathering, now: number, winner: Member | null): void {
    g.phase = 'final';
    g.until = now + FINAL_MS;
    if (winner) {
      this.act(winner, 'cheer', FINAL_MS, now);
      this.icon(winner, 'trophy', now, FINAL_MS);
      this.say(g, winner.id, pick(WIN, g.rng), now);
      for (const m of g.members) {
        if (m === winner || m.left || m.watcher) continue;
        this.act(m, 'sulk', FINAL_MS, now);
        if (g.rng() < 0.6) this.say(g, m.id, pick(LOSE, g.rng), now);
      }
    } else {
      const m = g.members.find((x) => !x.left && x.arrived);
      if (m) this.say(g, m.id, pick(BYE, g.rng), now);
    }
  }

  private seedOf(id: string): number {
    return this.host.chars.get(id)?.info.seed ?? 0;
  }

  private say(g: Gathering, id: string, text: string, now: number): void {
    const c = this.host.chars.get(id);
    if (c) c.showBubble(KINDS[g.kind].emoji, text, SAY_MS, now);
  }

  private chat(m: Member, text: string, now: number): void {
    const c = this.host.chars.get(m.id);
    if (c) c.showBubble('', text, 1_600, now);
  }

  private icon(m: Member, icon: IconName, now: number, ms = 1_600): void {
    this.host.chars.get(m.id)?.setIcon(icon, ms, now);
  }

  private act(m: Member, pose: Pose, ms: number, now: number): void {
    m.hold.pose = pose;
    m.hold.held = pose === 'cheer' || pose === 'sulk' ? 'none' : m.baseHeld;
    m.actUntil = now + ms;
  }
}

