// Ported from habblaud shared/names.ts (MIT, © 2026 Márcio Junior)
// Character names. Habblaud's list is Brazilian; ours is international. No duplicates and no near-identical
// variants (e.g. Laila/Leila), so every character is unmistakable in the office.
import { hash32 } from './hash';

export interface PersonName {
  name: string;
  /** Presentation hint the art may use to vary the look. */
  look: 'f' | 'm';
}

const F = [
  'Ada', 'Aiko', 'Aisha', 'Amara', 'Ana', 'Anya', 'Beatriz', 'Bianca', 'Camila', 'Carmen',
  'Chloe', 'Dalia', 'Dina', 'Divya', 'Elena', 'Emma', 'Esther', 'Eun-ji', 'Farah', 'Fatima',
  'Freya', 'Gabriela', 'Greta', 'Hana', 'Ines', 'Ingrid', 'Isla', 'Jana', 'Kaia', 'Kemi',
  'Laila', 'Lucia', 'Marta', 'Maya', 'Mei', 'Mira', 'Nadia', 'Naomi', 'Nia', 'Noor',
  'Olga', 'Oona', 'Paloma', 'Priya', 'Rin', 'Rosa', 'Sakura', 'Selin', 'Sofia', 'Talia',
  'Thandi', 'Uma', 'Valentina', 'Vera', 'Wanjiru', 'Ximena', 'Yara', 'Yuki', 'Zainab', 'Zara',
];
const M = [
  'Aarav', 'Ahmed', 'Akira', 'Alejandro', 'Amir', 'Andrei', 'Arjun', 'Bao', 'Bruno', 'Carlos',
  'Chidi', 'Dario', 'Diego', 'Elias', 'Emeka', 'Enzo', 'Felix', 'Finn', 'Hamza', 'Hiro',
  'Hugo', 'Ibrahim', 'Ivan', 'Jae', 'Javier', 'Jonas', 'Jun', 'Kai', 'Kenji', 'Kofi',
  'Kwame', 'Leo', 'Liam', 'Luca', 'Lukas', 'Malik', 'Marco', 'Mateo', 'Miguel', 'Minh',
  'Nikolai', 'Noah', 'Olu', 'Omar', 'Oscar', 'Pablo', 'Raj', 'Rohan', 'Santiago', 'Sami',
  'Sven', 'Tariq', 'Theo', 'Tomas', 'Viktor', 'Wei', 'Yusuf', 'Zane', 'Mehmet', 'Pedro',
];

export const NAME_POOL: readonly PersonName[] = Object.freeze(
  // Interleaved, so neighbors in the pool alternate the look hint.
  F.flatMap((f, i) => [{ name: f, look: 'f' as const }, ...(M[i] ? [{ name: M[i]!, look: 'm' as const }] : [])]),
);

/** Comparable key of a name: no difference between case or Unicode forms ("Júlia" NFD = NFC). */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('en');
}

/**
 * A deterministic name for `id`, avoiding the ones in use. When the pool runs out, adds a number ("Ana 2").
 */
export function pickName(id: string, used: ReadonlySet<string>): PersonName {
  const n = NAME_POOL.length;
  const start = hash32(id) % n;
  for (let i = 0; i < n; i++) {
    const cand = NAME_POOL[(start + i) % n]!;
    if (!used.has(cand.name)) return cand;
  }
  const base = NAME_POOL[start]!;
  for (let k = 2; ; k++) {
    const name = `${base.name} ${k}`;
    if (!used.has(name)) return { name, look: base.look };
  }
}
