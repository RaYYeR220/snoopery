import { describe, expect, it } from 'vitest';
import { readTrack, sampleTrack } from '../src/sample.ts';
import { animate, newDoc, addNode, quatAxisAngle } from './fixtures.ts';

function trackFor(path: 'translation' | 'rotation', times: number[], values: number[][], interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE') {
  const { doc, scene } = newDoc();
  const node = addNode(doc, scene, 'n');
  const anim = doc.createAnimation('a');
  animate(doc, anim, node, path, times, values, interpolation);
  const track = readTrack(anim.listChannels()[0]!);
  if (!track) throw new Error('track expected');
  return track;
}

describe('sampleTrack', () => {
  it('holds the previous key for STEP', () => {
    const track = trackFor('translation', [0, 1, 2], [[0, 0, 0], [1, 0, 0], [2, 0, 0]], 'STEP');
    expect(sampleTrack(track, 0.99, [])[0]).toBe(0);
    expect(sampleTrack(track, 1.5, [])[0]).toBe(1);
    expect(sampleTrack(track, 2, [])[0]).toBe(2);
  });

  it('interpolates LINEAR translation and clamps outside the key range', () => {
    const track = trackFor('translation', [1, 3], [[0, 0, 0], [2, 4, 6]], 'LINEAR');
    expect(sampleTrack(track, 2, [])).toEqual([1, 2, 3]);
    expect(sampleTrack(track, 0, [])).toEqual([0, 0, 0]);
    expect(sampleTrack(track, 9, [])).toEqual([2, 4, 6]);
  });

  it('slerps LINEAR rotation', () => {
    const track = trackFor('rotation', [0, 1], [[0, 0, 0, 1], quatAxisAngle([0, 1, 0], Math.PI / 2)], 'LINEAR');
    const q = sampleTrack(track, 0.5, []);
    const expected = quatAxisAngle([0, 1, 0], Math.PI / 4);
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(expected[i]!, 6);
  });

  it('evaluates CUBICSPLINE as a Hermite curve through the value components', () => {
    const track = trackFor('translation', [0, 1], [
      [9, 9, 9], [0, 0, 0], [0, 0, 0],
      [0, 0, 0], [1, 0, 0], [9, 9, 9],
    ], 'CUBICSPLINE');
    expect(sampleTrack(track, 0, [])).toEqual([0, 0, 0]);
    expect(sampleTrack(track, 1, [])).toEqual([1, 0, 0]);
    expect(sampleTrack(track, 0.25, [])[0]).toBeCloseTo(3 * 0.0625 - 2 * 0.015625, 9);
  });
});
