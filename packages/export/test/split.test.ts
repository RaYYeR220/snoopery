import { describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import type { Joint } from '@snoopery/schema';
import { splitParts, toOBJ, triangleCount } from '../src/index.ts';
import type { Mesh } from '../src/index.ts';
import { addBox, nestedCabinet, readDev } from './fixtures.ts';

const nightstandJoints: Joint[] = JSON.parse(new TextDecoder().decode(readDev('nightstand.joints.json')));
const jewelryJoints: Joint[] = JSON.parse(new TextDecoder().decode(readDev('jewelry_box.joints.json')));

function bounds(mesh: Mesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, mesh.positions[i + k]!);
      max[k] = Math.max(max[k]!, mesh.positions[i + k]!);
    }
  }
  return { min, max };
}

/** Signed volume enclosed by the triangles; positive when faces wind counter-clockwise seen from outside. */
function signedVolume(mesh: Mesh): number {
  const p = mesh.positions;
  let v = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t]! * 3, mesh.indices[t + 1]! * 3, mesh.indices[t + 2]! * 3];
    v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
      - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
      + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return v / 6;
}

const close = (a: ArrayLike<number>, b: number[], digits = 5) => b.forEach((x, i) => expect(a[i]).toBeCloseTo(x, digits));

describe('splitParts', () => {
  it('puts the nightstand drawer subtree in its part and the carcass in base', async () => {
    const split = await splitParts(readDev('nightstand.glb'), nightstandJoints);
    expect(Object.keys(split.parts)).toEqual(['top_drawer']);
    const drawer = split.parts.top_drawer!;
    expect(triangleCount(drawer)).toBe(36);
    expect(triangleCount(split.base)).toBe(60);
    const d = bounds(drawer);
    close(d.min, [-0.225, 0.43, -0.18]);
    close(d.max, [0.225, 0.595, 0.25]);
    const b = bounds(split.base);
    close(b.min, [-0.27, 0, -0.24]);
    close(b.max, [0.27, 0.63, 0.24]);
    for (const i of drawer.indices) expect(i).toBeLessThan(drawer.positions.length / 3);
  });

  it('bakes the lid node transform into the lid mesh (rest pose, object frame)', async () => {
    const split = await splitParts(readDev('jewelry_box.glb'), jewelryJoints);
    expect(triangleCount(split.parts.lid!)).toBe(24);
    expect(triangleCount(split.base)).toBe(12);
    const lid = bounds(split.parts.lid!);
    close(lid.min, [-0.155, 0.09, -0.1]);
    close(lid.max, [0.155, 0.14, 0.11]);
    expect(split.joints).toEqual([{ ...jewelryJoints[0], parent: null }]);
  });

  it('resolves joints of nested parts into the object frame', async () => {
    const joints: Joint[] = [
      { part: 'drawer', node: 'drawer', type: 'prismatic', axis: [0, 0, 1], pivot: [0, 0.25, 0.2], min: 0, max: 0.15 },
      { part: 'lid', node: 'lid', type: 'revolute', axis: [1, 0, 0], pivot: [0, 0.3, 0], min: 0, max: 1.2 },
    ];
    const split = await splitParts(await nestedCabinet(), joints);
    expect(triangleCount(split.base)).toBe(12);
    expect(triangleCount(split.parts.drawer!)).toBe(12);
    expect(triangleCount(split.parts.lid!)).toBe(12);
    const lid = bounds(split.parts.lid!);
    close(lid.min, [0, 0.6, -0.1]);
    close(lid.max, [0.2, 0.62, 0.1]);
    const [drawer, hinge] = split.joints;
    expect(drawer!.parent).toBeNull();
    close(drawer!.axis, [1, 0, 0]);
    close(drawer!.pivot, [0.4, 0.5, 0]);
    expect(drawer!.max).toBeCloseTo(0.3, 9);
    expect(hinge!.parent).toBe('drawer');
    close(hinge!.axis, [0, 0, -1]);
    close(hinge!.pivot, [0, 0.6, 0]);
    expect(hinge!.max).toBe(1.2);
  });

  it('keeps faces outward-facing under a mirroring node transform', async () => {
    const doc = new Document();
    doc.createBuffer();
    const scene = doc.createScene('scene');
    doc.getRoot().setDefaultScene(scene);
    const root = doc.createNode('root');
    scene.addChild(root);
    addBox(doc, root, 'plain', [0, 0, 0], [1, 1, 1]);
    const door = doc.createNode('door').setScale([-1, 1, 1]);
    root.addChild(door);
    addBox(doc, door, 'panel', [0, 0, 0], [1, 1, 1]);
    const glb = await new NodeIO().writeBinary(doc);
    const split = await splitParts(glb, [{ part: 'door', node: 'door', type: 'revolute', axis: [0, 1, 0], pivot: [0, 0, 0], min: 0, max: 1 }]);
    expect(signedVolume(split.base)).toBeCloseTo(1, 5);
    expect(signedVolume(split.parts.door!)).toBeCloseTo(1, 5);
  });

  it('falls back to the part name when the node reference is unknown, and fails loudly when neither exists', async () => {
    const glb = readDev('jewelry_box.glb');
    const byPart = await splitParts(glb, [{ ...jewelryJoints[0]!, node: 'node_999' }]);
    expect(triangleCount(byPart.parts.lid!)).toBe(24);
    await expect(splitParts(glb, [{ ...jewelryJoints[0]!, node: 'hinge', part: 'flap' }])).rejects.toThrow(/flap.*not found/);
  });
});

describe('toOBJ', () => {
  it('writes vertices and 1-based triangle faces', () => {
    const obj = toOBJ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0.5, -0.25]), indices: new Uint32Array([0, 1, 2]) }, 'tri');
    expect(obj.split('\n')).toEqual(['o tri', 'v 0 0 0', 'v 1 0 0', 'v 0 0.5 -0.25', 'f 1 2 3', '']);
  });
});
