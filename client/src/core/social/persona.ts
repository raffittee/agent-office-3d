// Personalities (P6-01): pure and deterministic, so the same agent is the same person in every browser. Each agent
// gets 2 or 3 traits that change what it likes to do when idle, who it hangs out with and what it says; pairs of
// agents may be friends or rivals. (Idea from Habblaud's social module; the traits and lines are our own.)
import { mulberry32 } from '../../../../shared/hash';
import { IDLE_WEIGHTS, type IdleActivity } from '../sim/behavior';

export const TRAIT_IDS = ['coffee', 'gamer', 'chatty', 'shy', 'sporty', 'bookworm', 'napper', 'calm', 'joker', 'competitive', 'tidy'] as const;
export type TraitId = (typeof TRAIT_IDS)[number];

/** Pairs that don't go together in one person. */
const CLASHES: ReadonlyArray<[TraitId, TraitId]> = [
  ['chatty', 'shy'],
  ['napper', 'sporty'],
  ['calm', 'competitive'],
  ['joker', 'shy'],
];

export function traitsClash(a: TraitId, b: TraitId): boolean {
  return CLASHES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export const CATCHPHRASES = ['Ship it!', 'Let’s go!', 'Easy peasy.', 'No worries.', 'Green build!', 'Nailed it.', 'One more test…', 'LGTM!', 'Works on my machine.', 'Coffee first.', 'To the moon!', 'Clean code!'] as const;

export interface Persona {
  traits: TraitId[];
  /** 0..1: how eager to join gatherings. */
  sociability: number;
  /** 0..1: luck and skill in games. */
  skill: number;
  catchphrase: string;
}

/** A 32-bit mix (neighbouring seeds become very different sequences). */
export function mix(seed: number): number {
  let h = (seed ^ 0x5bd1e995) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const cache = new Map<number, Persona>();

/** The personality of the agent with this seed (2 or 3 traits that don't clash). */
export function personaFor(seed: number): Persona {
  const hit = cache.get(seed);
  if (hit) return hit;
  const rng = mulberry32(mix(seed));
  const n = rng() < 0.55 ? 2 : 3;
  const traits: TraitId[] = [];
  for (let guard = 0; traits.length < n && guard < 40; guard++) {
    const tr = TRAIT_IDS[Math.floor(rng() * TRAIT_IDS.length) % TRAIT_IDS.length]!;
    if (traits.includes(tr) || traits.some((o) => traitsClash(o, tr))) continue;
    traits.push(tr);
  }
  let sociability = 0.45 + rng() * 0.3;
  if (traits.includes('shy')) sociability -= 0.3;
  if (traits.includes('chatty')) sociability += 0.2;
  if (traits.includes('joker')) sociability += 0.12;
  let skill = 0.3 + rng() * 0.4;
  if (traits.includes('gamer')) skill += 0.2;
  if (traits.includes('sporty')) skill += 0.15;
  if (traits.includes('napper')) skill -= 0.1;
  const catchphrase = CATCHPHRASES[Math.floor(rng() * CATCHPHRASES.length) % CATCHPHRASES.length]!;
  const p: Persona = { traits, sociability: clamp(sociability), skill: clamp(skill), catchphrase };
  if (cache.size > 500) cache.clear();
  cache.set(seed, p);
  return p;
}

function clamp(v: number): number {
  return Math.max(0.05, Math.min(0.95, v));
}

export function hasTrait(p: Persona, tr: TraitId): boolean {
  return p.traits.includes(tr);
}

export type Bond = 'friends' | 'rivals';

/**
 * The bond between two agents (symmetric): ~22% friends, ~12% rivals, the rest just colleagues. Two competitive
 * people lean to rivalry; chatty or joking people to friendship.
 */
export function bondBetween(seedA: number, seedB: number): Bond | null {
  if (seedA === seedB) return null;
  const lo = Math.min(seedA >>> 0, seedB >>> 0);
  const hi = Math.max(seedA >>> 0, seedB >>> 0);
  const r = mulberry32(mix(lo ^ Math.imul(hi, 0x9e3779b1)))();
  const a = personaFor(seedA);
  const b = personaFor(seedB);
  const rivalry = 0.12 + (hasTrait(a, 'competitive') && hasTrait(b, 'competitive') ? 0.18 : 0);
  const friendship = 0.22 + ([a, b].some((p) => hasTrait(p, 'chatty') || hasTrait(p, 'joker')) ? 0.08 : 0);
  if (r < rivalry) return 'rivals';
  if (r < rivalry + friendship) return 'friends';
  return null;
}

/** How each trait multiplies the solo outings it likes. */
const SOLO_K: Partial<Record<TraitId, Partial<Record<IdleActivity, number>>>> = {
  coffee: { coffee: 3 },
  tidy: { mirror: 4, bathroom: 1.3 },
  bookworm: { shelf: 3, phone: 1.4, window: 1.2 },
  napper: { lounge: 2.5 },
  sporty: { stretch: 2.5, water: 1.5 },
  calm: { window: 2.5, stretch: 1.5 },
  gamer: { arcade: 3, phone: 1.4 },
  shy: { window: 1.5, shelf: 1.5, phone: 1.5 },
  chatty: { coffee: 1.4, phone: 1.4 },
};

/** Solo outing weights for this personality. */
export function soloWeights(p: Persona): Record<IdleActivity, number> {
  const out = { ...IDLE_WEIGHTS };
  for (const tr of p.traits) for (const [k, v] of Object.entries(SOLO_K[tr] ?? {})) out[k as IdleActivity] *= v as number;
  return out;
}
