import type { AffordanceCard } from '@snoopery/schema';
import { ARCHETYPES, THEMES } from './archetypes';

export const EVAL_SEED = 20261116;

export interface EvalRoom {
  index: number;
  theme: string;
  difficulty: 2 | 3;
  cards: AffordanceCard[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each room: 3–5 distinct archetypes, a theme, and alternating difficulty 2/3. */
export function sampleRooms(seed: number, count: number): EvalRoom[] {
  const rng = mulberry32(seed);
  const pick = (n: number) => Math.floor(rng() * n);
  return Array.from({ length: count }, (_, index) => {
    const pool = [...ARCHETYPES];
    const size = 3 + pick(3);
    for (let k = 0; k < size; k++) {
      const j = k + pick(pool.length - k);
      [pool[k], pool[j]] = [pool[j]!, pool[k]!];
    }
    return { index, theme: THEMES[pick(THEMES.length)]!, difficulty: index % 2 === 0 ? 2 : 3, cards: pool.slice(0, size) };
  });
}
