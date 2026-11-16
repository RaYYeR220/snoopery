import { describe, expect, it } from 'vitest';
import { inferFromParts } from '../src/infer.ts';
import { jointMatrix } from '../src/transform.ts';
import { addNode, applyMat, newDoc } from './fixtures.ts';
import type { V3 } from './fixtures.ts';

function chest() {
  const { doc, scene } = newDoc();
  addNode(doc, scene, 'Box', { box: [[-0.3, 0, -0.2], [0.3, 0.4, 0.2]] });
  addNode(doc, scene, 'Lid', { box: [[-0.3, 0, -0.2], [0.3, 0.02, 0.2]], translation: [0, 0.4, 0] });
  return doc;
}

function cabinet() {
  const { doc, scene } = newDoc();
  addNode(doc, scene, 'Carcass', { box: [[-0.4, 0, -0.25], [0.4, 0.8, 0.25]] });
  addNode(doc, scene, 'Left Door', { box: [[-0.4, 0, 0.25], [0, 0.5, 0.27]] });
  addNode(doc, scene, 'Drawer', { box: [[-0.35, 0.55, -0.2], [0.35, 0.75, 0.25]] });
  return doc;
}

function close(a: readonly number[], b: readonly number[], eps = 1e-6): void {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(eps);
}

describe('inferFromParts', () => {
  it('hinges a lid at the back top edge of the box', () => {
    const [lid] = inferFromParts(chest(), [{ part: 'lid', joint: 'revolute' }]);
    expect(lid).toMatchObject({ part: 'lid', node: 'Lid', type: 'revolute', min: 0, max: 1.9 });
    close(lid!.axis, [-1, 0, 0]);
    close(lid!.pivot, [0, 0.4, -0.2]);
    const front: V3 = [0, 0.42, 0.2];
    const opened = applyMat(jointMatrix(lid!, 0.5), front);
    expect(opened[1]).toBeGreaterThan(0.6);
    expect(opened[2]).toBeLessThan(0.2);
  });

  it('hinges a door at its outer side edge so it swings outward', () => {
    const [door] = inferFromParts(cabinet(), [{ part: 'left_door', joint: 'revolute' }]);
    expect(door!.type).toBe('revolute');
    close(door!.axis, [0, -1, 0]);
    expect(door!.pivot[0]).toBeCloseTo(-0.4, 6);
    expect(door!.pivot[2]).toBeCloseTo(0.25, 6);
    const freeEdge: V3 = [0, 0.25, 0.27];
    expect(applyMat(jointMatrix(door!, 0.5), freeEdge)[2]).toBeGreaterThan(0.5);
  });

  it('slides a drawer out through the face flush with the body boundary', () => {
    const [drawer] = inferFromParts(cabinet(), [{ part: 'Drawer', joint: 'prismatic' }]);
    expect(drawer).toMatchObject({ part: 'drawer', node: 'Drawer', type: 'prismatic', min: 0 });
    close(drawer!.axis, [0, 0, 1]);
    expect(drawer!.max).toBeCloseTo(0.8 * 0.45, 6);
    close(drawer!.pivot, [0, 0.65, 0.025]);
  });

  it('prefers a face that protrudes past the body over flush sides', () => {
    const { doc, scene } = newDoc();
    addNode(doc, scene, 'Body', { box: [[-0.4, 0, -0.25], [0.4, 0.8, 0.25]] });
    addNode(doc, scene, 'Drawer', { box: [[-0.4, 0.6, -0.2], [0, 0.8, 0.28]] });
    const [drawer] = inferFromParts(doc, [{ part: 'drawer', joint: 'prismatic' }]);
    close(drawer!.axis, [0, 0, 1]);
  });

  it('works in the part parent frame', () => {
    const { doc, scene } = newDoc();
    const root = addNode(doc, scene, 'Chest', { translation: [5, 0, -3], scale: [2, 2, 2] });
    addNode(doc, root, 'Box', { box: [[-0.3, 0, -0.2], [0.3, 0.4, 0.2]] });
    addNode(doc, root, 'Lid', { box: [[-0.3, 0, -0.2], [0.3, 0.02, 0.2]], translation: [0, 0.4, 0] });
    const [lid] = inferFromParts(doc, [{ part: 'lid', joint: 'revolute' }]);
    close(lid!.pivot, [0, 0.4, -0.2]);
  });

  it('skips hints that name no node', () => {
    expect(inferFromParts(chest(), [{ part: 'door', joint: 'revolute' }])).toEqual([]);
  });
});
