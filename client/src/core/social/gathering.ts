// Gatherings (P6-01): what idle agents do together, as pure rules: the kinds, who picks what, partner choice,
// matches and who wins. social.ts runs them in the sim.
import type { SpotKind } from '../layout/types';
import { bondBetween, hasTrait, personaFor, type Persona } from './persona';

export type GatherKind = 'tv' | 'pingpong' | 'arcade' | 'kitchen' | 'talk' | 'rps';
export type Gesture = 'rock' | 'paper' | 'scissors';

export interface KindInfo {
  /** "Watching TV" (the sidebar: "Watching TV with Ana"). */
  label: string;
  emoji: string;
  min: number;
  max: number;
  /** A game with a winner. */
  match?: boolean;
  /** Where players go (spot kinds, in order of preference). */
  seats: readonly SpotKind[];
  /** Where extra people watch, if anywhere. */
  watch?: readonly SpotKind[];
  /** Points to win (matches). */
  target?: number;
}

export const KINDS: Readonly<Record<GatherKind, KindInfo>> = {
  tv: { label: 'Watching TV', emoji: '📺', min: 2, max: 5, seats: ['sofa', 'armchair'] },
  pingpong: { label: 'Playing ping-pong', emoji: '🏓', min: 2, max: 4, match: true, seats: ['pingpong'], watch: ['watch'], target: 5 },
  arcade: { label: 'An arcade duel', emoji: '👾', min: 2, max: 2, match: true, seats: ['arcade'], target: 3 },
  kitchen: { label: 'Chatting in the kitchen', emoji: '☕', min: 2, max: 4, seats: ['cafe_seat'] },
  talk: { label: 'Chatting', emoji: '💬', min: 2, max: 2, seats: ['talk'] },
  rps: { label: 'Rock, paper, scissors', emoji: '✊', min: 2, max: 2, match: true, seats: ['talk'], target: 2 },
};

export const GATHER_KINDS = Object.keys(KINDS) as GatherKind[];

/** How much a personality likes each kind (base 1). */
export function kindWeights(p: Persona): Record<GatherKind, number> {
  const w: Record<GatherKind, number> = { tv: 1, pingpong: 1, arcade: 0.8, kitchen: 1.2, talk: 1.2, rps: 0.6 };
  if (hasTrait(p, 'gamer')) (w.arcade *= 3), (w.tv *= 1.3);
  if (hasTrait(p, 'sporty')) w.pingpong *= 3;
  if (hasTrait(p, 'chatty')) (w.talk *= 2.5), (w.kitchen *= 2);
  if (hasTrait(p, 'coffee')) w.kitchen *= 2;
  if (hasTrait(p, 'napper')) w.tv *= 2.5;
  if (hasTrait(p, 'joker')) w.rps *= 3;
  if (hasTrait(p, 'competitive')) (w.pingpong *= 1.6), (w.arcade *= 1.6), (w.rps *= 1.6);
  if (hasTrait(p, 'shy')) (w.talk *= 0.5), (w.tv *= 1.5);
  return w;
}

/** Picks a kind among the available ones, weighted by the host's personality. */
export function pickKind(p: Persona, available: ReadonlySet<GatherKind>, rng: () => number): GatherKind | null {
  const w = kindWeights(p);
  let total = 0;
  for (const k of available) total += w[k];
  if (total <= 0) return null;
  let r = rng() * total;
  for (const k of available) {
    r -= w[k];
    if (r < 0) return k;
  }
  return null;
}

/** How much the host wants this partner: friends first; rivals for a match; the more sociable, the likelier. */
export function partnerScore(hostSeed: number, seed: number, kind: GatherKind): number {
  const bond = bondBetween(hostSeed, seed);
  const p = personaFor(seed);
  let s = 0.5 + p.sociability;
  if (bond === 'friends') s += 1.5;
  if (bond === 'rivals') s += KINDS[kind].match ? 1.2 : -0.6;
  if (KINDS[kind].match && hasTrait(p, 'competitive')) s += 0.4;
  return Math.max(0.05, s);
}

/** Chance that A wins a point against B (skill, plus a little luck). */
export function winChance(a: Persona, b: Persona): number {
  return Math.max(0.15, Math.min(0.85, 0.5 + (a.skill - b.skill) * 0.6));
}

const BEATS: Record<Gesture, Gesture> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/** 1 = a wins, -1 = b wins, 0 = a draw. */
export function rpsResult(a: Gesture, b: Gesture): 1 | -1 | 0 {
  return a === b ? 0 : BEATS[a] === b ? 1 : -1;
}

export function pickGesture(rng: () => number): Gesture {
  return (['rock', 'paper', 'scissors'] as const)[Math.floor(rng() * 3) % 3]!;
}
