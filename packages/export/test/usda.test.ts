import { beforeAll, describe, expect, it } from 'vitest';
import type { RoomDoc } from '@snoopery/schema';
import { jointFrame, splitParts, toUSDA } from '../src/index.ts';
import type { ObjectMeshes } from '../src/index.ts';
import { demoRoom, loadDevGlb } from './fixtures.ts';

type V3 = [number, number, number];

/** Body of the `def <type> "<name>"` prim (up to its matching closing brace). */
function prim(usda: string, type: string, name: string): string {
  const head = usda.indexOf(`def ${type} "${name}"`);
  if (head < 0) throw new Error(`no ${type} ${name}`);
  let depth = 0;
  for (let i = usda.indexOf('{', head); i < usda.length; i++) {
    if (usda[i] === '{') depth++;
    else if (usda[i] === '}' && --depth === 0) return usda.slice(head, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const attr = (block: string, name: string): string => {
  const m = block.match(new RegExp(`\\s${name.replace(/[:.]/g, (c) => `\\${c}`)} = ([^\\n]+)`));
  if (!m) throw new Error(`no ${name}`);
  return m[1]!.trim();
};
const tuple = (s: string): number[] => s.replace(/[()]/g, '').split(',').map(Number);

/** Rotates `v` by the USD quaternion (real, i, j, k). */
function rotate(q: number[], v: V3): V3 {
  const [w, x, y, z] = q as [number, number, number, number];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const unit = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] } as const;
const close = (a: ArrayLike<number>, b: number[], digits = 5) => b.forEach((x, i) => expect(a[i]).toBeCloseTo(x, digits));

describe('toUSDA', () => {
  let room: RoomDoc;
  let meshes: Record<string, ObjectMeshes>;
  let usda: string;

  beforeAll(async () => {
    room = demoRoom();
    meshes = {};
    for (const o of room.objects) meshes[o.objectId] = await splitParts(await loadDevGlb(o.glbUrl), o.joints);
    usda = toUSDA(room, meshes);
  });

  it('declares a Y-up, metre stage with a physics scene', () => {
    expect(usda.startsWith('#usda 1.0\n')).toBe(true);
    expect(usda).toContain('upAxis = "Y"');
    expect(usda).toContain('metersPerUnit = 1');
    expect(usda).toContain('def PhysicsScene "PhysicsScene"');
    expect(attr(prim(usda, 'PhysicsScene', 'PhysicsScene'), 'vector3f physics:gravityDirection')).toBe('(0, -1, 0)');
  });

  it('writes the revolute lid with limits in degrees and a frame turning X onto the −X hinge axis', () => {
    const lid = prim(usda, 'PhysicsRevoluteJoint', 'jewelry_box__lid');
    expect(Number(attr(lid, 'float physics:lowerLimit'))).toBeCloseTo(0, 2);
    expect(Number(attr(lid, 'float physics:upperLimit'))).toBeCloseTo(108.86, 2);
    const token = JSON.parse(attr(lid, 'uniform token physics:axis')) as keyof typeof unit;
    const rot0 = tuple(attr(lid, 'quatf physics:localRot0'));
    const rot1 = tuple(attr(lid, 'quatf physics:localRot1'));
    expect(rot1).toEqual(rot0);
    close(rotate(rot0, [...unit[token]] as V3), [-1, 0, 0]);
    close(tuple(attr(lid, 'point3f physics:localPos0')), [0, 0.1, -0.1]);
    expect(attr(lid, 'rel physics:body0')).toBe('</Room/jewelry_box/base>');
    expect(attr(lid, 'rel physics:body1')).toBe('</Room/jewelry_box/lid>');
  });

  it('writes the prismatic drawer with limits in metres along Z', () => {
    const drawer = prim(usda, 'PhysicsPrismaticJoint', 'nightstand__top_drawer');
    expect(attr(drawer, 'uniform token physics:axis')).toBe('"Z"');
    expect(Number(attr(drawer, 'float physics:lowerLimit'))).toBe(0);
    expect(Number(attr(drawer, 'float physics:upperLimit'))).toBeCloseTo(0.3, 6);
    expect(tuple(attr(drawer, 'quatf physics:localRot0'))).toEqual([1, 0, 0, 0]);
  });

  it('places each object with its translation and yaw, fixes its base to the world and marks it an articulation', () => {
    const nightstand = prim(usda, 'Xform', 'nightstand');
    expect(nightstand).toContain('PhysicsArticulationRootAPI');
    close(tuple(attr(nightstand, 'double3 xformOp:translate')), [-2.6, -0.5, 1]);
    expect(Number(attr(nightstand, 'float xformOp:rotateY'))).toBeCloseTo(-90, 6);
    const anchor = prim(nightstand, 'PhysicsFixedJoint', 'nightstand__anchor');
    expect(anchor).not.toContain('physics:body0');
    expect(attr(anchor, 'rel physics:body1')).toBe('</Room/nightstand/base>');
    close(tuple(attr(anchor, 'point3f physics:localPos0')), [-2.6, -0.5, 1]);
    const q = tuple(attr(anchor, 'quatf physics:localRot0'));
    close(rotate(q, [0, 0, 1]), [-1, 0, 0]);
  });

  it('inlines the triangle meshes of base and parts as convex-decomposed colliders', () => {
    const drawer = prim(prim(usda, 'Xform', 'nightstand'), 'Xform', 'top_drawer');
    expect(drawer).toContain('PhysicsRigidBodyAPI');
    const mesh = prim(drawer, 'Mesh', 'geom');
    expect(mesh).toContain('PhysicsCollisionAPI');
    expect(attr(mesh, 'uniform token physics:approximation')).toBe('"convexDecomposition"');
    const counts = attr(mesh, 'int\\[\\] faceVertexCounts');
    expect(counts.match(/3/g)).toHaveLength(36);
  });

  it('chooses an axis token and frame for any axis direction', () => {
    for (const axis of [[1, 0, 0], [0, -1, 0], [0.6, 0, 0.8], [-0.3, 0.4, -0.5]] as V3[]) {
      const n = Math.hypot(...axis);
      const { token, rot } = jointFrame(axis);
      close(rotate(rot, [...unit[token]] as V3), axis.map((v) => v / n));
    }
  });
});
