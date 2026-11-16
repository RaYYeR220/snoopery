import { describe, expect, it } from 'vitest';
import { affordanceCard as affordanceSchema } from '@snoopery/schema';
import { affordanceCard } from '../src/affordance.ts';
import { inferFromParts } from '../src/infer.ts';
import { addNode, newDoc } from './fixtures.ts';

function dresser() {
  const { doc, scene } = newDoc();
  addNode(doc, scene, 'Body', { box: [[-0.5, 0, -0.3], [0.5, 1.2, 0.3]] });
  addNode(doc, scene, 'Tiny', { box: [[-0.05, 1.0, 0.2], [0.05, 1.1, 0.3]] });
  addNode(doc, scene, 'Mid', { box: [[-0.15, 0.6, 0.0], [0.15, 0.8, 0.3]] });
  addNode(doc, scene, 'Big', { box: [[-0.25, 0.0, -0.2], [0.25, 0.4, 0.3]] });
  return doc;
}

describe('affordanceCard', () => {
  it('buckets drawer capacity by part volume and reports the object size', () => {
    const doc = dresser();
    const joints = inferFromParts(doc, ['tiny', 'mid', 'big'].map((part) => ({ part, joint: 'prismatic' as const })));
    const card = affordanceCard('obj_1', 'Dresser', doc, joints);
    expect(affordanceSchema.parse(card)).toEqual(card);
    expect(card.objectId).toBe('obj_1');
    expect(card.label).toBe('Dresser');
    expect(card.sizeM[0]).toBeCloseTo(1, 6);
    expect(card.sizeM[1]).toBeCloseTo(1.2, 6);
    expect(card.sizeM[2]).toBeCloseTo(0.6, 6);
    expect(card.parts).toEqual([
      { part: 'tiny', joint: 'prismatic', capacity: 'small' },
      { part: 'mid', joint: 'prismatic', capacity: 'medium' },
      { part: 'big', joint: 'prismatic', capacity: 'large' },
    ]);
  });

  it('sizes a hinged lid by the space it closes, not by the panel', () => {
    const { doc, scene } = newDoc();
    addNode(doc, scene, 'Box', { box: [[-0.3, 0, -0.2], [0.3, 0.4, 0.2]] });
    addNode(doc, scene, 'Lid', { box: [[-0.3, 0, -0.2], [0.3, 0.02, 0.2]], translation: [0, 0.4, 0] });
    const joints = inferFromParts(doc, [{ part: 'lid', joint: 'revolute' }]);
    const card = affordanceCard('chest', 'Chest', doc, joints);
    expect(card.parts).toEqual([{ part: 'lid', joint: 'revolute', capacity: 'large' }]);
  });

  it('keeps a small trinket box small', () => {
    const { doc, scene } = newDoc();
    addNode(doc, scene, 'Box', { box: [[-0.05, 0, -0.04], [0.05, 0.05, 0.04]] });
    addNode(doc, scene, 'Lid', { box: [[-0.05, 0, -0.04], [0.05, 0.01, 0.04]], translation: [0, 0.05, 0] });
    const joints = inferFromParts(doc, [{ part: 'lid', joint: 'revolute' }]);
    expect(affordanceCard('box', 'Trinket box', doc, joints).parts[0]!.capacity).toBe('small');
  });

  it('returns an empty part list for an object without joints', () => {
    const { doc, scene } = newDoc();
    addNode(doc, scene, 'Table', { box: [[-0.5, 0, -0.5], [0.5, 0.75, 0.5]] });
    const card = affordanceCard('t', 'Table', doc, []);
    expect(card.parts).toEqual([]);
    expect(card.sizeM).toEqual([1, 0.75, 1]);
  });

  it('rejects joints that name a node missing from the document', () => {
    const doc = dresser();
    expect(() =>
      affordanceCard('x', 'X', doc, [
        { part: 'ghost', node: 'Ghost', type: 'prismatic', axis: [0, 0, 1], pivot: [0, 0, 0], min: 0, max: 0.2 },
      ]),
    ).toThrow(/Ghost/);
  });
});
