import { describe, expect, it } from 'vitest';
import { affordanceCard } from '@snoopery/schema';
import { ARCHETYPES } from '../eval/archetypes';
import { EVAL_SEED, mulberry32, sampleRooms } from '../eval/rooms';

describe('eval rooms', () => {
  it('has 20 valid archetypes with unique ids and openable parts', () => {
    expect(ARCHETYPES).toHaveLength(20);
    expect(new Set(ARCHETYPES.map((a) => a.objectId)).size).toBe(20);
    for (const card of ARCHETYPES) {
      expect(() => affordanceCard.parse(card)).not.toThrow();
      expect(card.parts.length).toBeGreaterThan(0);
    }
  });

  it('samples the same 40 rooms for the same seed', () => {
    const a = sampleRooms(EVAL_SEED, 40);
    expect(sampleRooms(EVAL_SEED, 40)).toEqual(a);
    expect(sampleRooms(EVAL_SEED + 1, 40)).not.toEqual(a);
    for (const room of a) {
      expect(room.cards.length).toBeGreaterThanOrEqual(3);
      expect(room.cards.length).toBeLessThanOrEqual(5);
      expect(new Set(room.cards.map((c) => c.objectId)).size).toBe(room.cards.length);
    }
    expect(a.filter((r) => r.difficulty === 3)).toHaveLength(20);
  });

  it('mulberry32 is deterministic and in [0, 1)', () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const x = r1();
      expect(x).toBe(r2());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
