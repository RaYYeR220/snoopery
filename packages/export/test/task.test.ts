import { describe, expect, it } from 'vitest';
import type { RoomDoc } from '@snoopery/schema';
import { toTaskSpec } from '../src/index.ts';
import { demoRoom } from './fixtures.ts';

describe('toTaskSpec', () => {
  it('turns the demo proof into five steps in order, with joint targets and the lid code', () => {
    const spec = toTaskSpec(demoRoom());
    expect(spec.steps).toEqual([
      { action: 'open', object: 'nightstand', part: 'top_drawer', joint: 'nightstand__top_drawer', target: 0.3 },
      { action: 'take', item: 'note', object: 'nightstand', part: 'top_drawer' },
      { action: 'open', object: 'jewelry_box', part: 'lid', joint: 'jewelry_box__lid', target: 1.9, code: '0412' },
      { action: 'take', item: 'door_key', object: 'jewelry_box', part: 'lid' },
      { action: 'exit', item: 'door_key' },
    ]);
    expect(spec.goal).toContain('open nightstand.top_drawer, take note, open jewelry_box.lid (code 0412), take door_key, exit');
    expect(spec.successCriterion).toContain('nightstand__top_drawer >= 0.27 m');
    expect(spec.successCriterion).toContain('jewelry_box__lid >= 1.71 rad');
    expect(spec.successCriterion).toContain('door_key');
  });

  it('names the key that unlocks a key-locked container', () => {
    const room = demoRoom();
    const locked: RoomDoc = {
      ...room,
      puzzle: {
        ...room.puzzle,
        containers: room.puzzle.containers.map((c) => (c.id === 'jewelry_box.lid' ? { ...c, lock: { kind: 'key', keyId: 'note' } } : c)),
      },
    };
    expect(toTaskSpec(locked).steps[2]).toEqual({ action: 'open', object: 'jewelry_box', part: 'lid', joint: 'jewelry_box__lid', target: 1.9, item: 'note' });
  });

  it('refuses a room without a proof or with a proof that names a part without a joint', () => {
    const room = demoRoom();
    expect(() => toTaskSpec({ ...room, proof: [] })).toThrow(/no solution/);
    const jointless: RoomDoc = { ...room, objects: room.objects.map((o) => ({ ...o, joints: [] })) };
    expect(() => toTaskSpec(jointless)).toThrow(/nightstand.*top_drawer/);
  });
});
