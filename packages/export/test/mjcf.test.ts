import { beforeAll, describe, expect, it } from 'vitest';
import type { RoomDoc } from '@snoopery/schema';
import { isFlat, splitParts, toMJCF } from '../src/index.ts';
import type { ObjectMeshes } from '../src/index.ts';
import { demoRoom, loadDevGlb } from './fixtures.ts';

type V3 = [number, number, number];

/** Attributes of the first `<tag ...>` element whose name attribute equals `name`. */
function element(xml: string, tag: string, name: string): Record<string, string> {
  for (const m of xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))) {
    const attrs = Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]));
    if (attrs.name === name) return attrs;
  }
  throw new Error(`no <${tag} name="${name}">`);
}

const nums = (s: string | undefined): number[] => (s ?? '').trim().split(/\s+/).map(Number);

/** Rotates `v` by the MuJoCo quaternion `q` = [w, x, y, z]. */
function rotate(q: number[], v: V3): V3 {
  const [w, x, y, z] = q as [number, number, number, number];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const close = (a: ArrayLike<number>, b: number[], digits = 5) => b.forEach((x, i) => expect(a[i]).toBeCloseTo(x, digits));

describe('toMJCF', () => {
  let room: RoomDoc;
  let meshes: Record<string, ObjectMeshes>;
  let xml: string;
  let files: Record<string, string>;

  beforeAll(async () => {
    room = demoRoom();
    meshes = {};
    for (const o of room.objects) meshes[o.objectId] = await splitParts(await loadDevGlb(o.glbUrl), o.joints);
    ({ xml, files } = toMJCF(room, meshes));
  });

  it('uses radians and a meshes directory', () => {
    expect(xml).toMatch(/^<mujoco model="Test room">/);
    const compiler = xml.match(/<compiler ([^>]*)\/>/)![1]!;
    expect(compiler).toContain('angle="radian"');
    expect(compiler).toContain('meshdir="meshes"');
  });

  it('places the floor plane at the spawn eye height minus 1.55 m (Z-up)', () => {
    const floor = element(xml, 'geom', 'floor');
    expect(floor.type).toBe('plane');
    close(nums(floor.pos), [0, 0, -0.55]);
  });

  it('places each object body at its placement, converted to Z-up with the yaw about +Z', () => {
    const body = element(xml, 'body', 'nightstand');
    close(nums(body.pos), [-2.6, -1, -0.5]);
    const q = nums(body.quat);
    close(q, [Math.cos(-Math.PI / 4), 0, 0, Math.sin(-Math.PI / 4)]);
  });

  it('turns the prismatic drawer into a limited slide joint whose world axis follows the yaw', () => {
    const joint = element(xml, 'joint', 'nightstand__top_drawer');
    expect(joint.type).toBe('slide');
    expect(joint.range).toBe('0 0.3');
    expect(joint.limited).toBe('true');
    expect(Number(joint.damping)).toBeGreaterThan(0);
    expect(Number(joint.armature)).toBeGreaterThan(0);
    // Model +Z (Y-up) is body −Y (Z-up); turned −90° about the vertical it points along world −X.
    close(nums(joint.axis), [0, -1, 0]);
    const q = nums(element(xml, 'body', 'nightstand').quat);
    close(rotate(q, nums(joint.axis) as V3), [-1, 0, 0]);
  });

  it('turns the revolute lid into a limited hinge about the pivot', () => {
    const joint = element(xml, 'joint', 'jewelry_box__lid');
    expect(joint.type).toBe('hinge');
    expect(joint.range).toBe('0 1.9');
    expect(joint.limited).toBe('true');
    close(nums(joint.axis), [-1, 0, 0]);
    close(nums(joint.pos), [0, 0.1, 0.1]);
    const body = element(xml, 'body', 'jewelry_box');
    const q = nums(body.quat);
    close(rotate(q, nums(joint.axis) as V3), [0, 1, 0]);
    const anchor = rotate(q, nums(joint.pos) as V3).map((v, i) => v + nums(body.pos)[i]!);
    // Y-up world pivot: placement + R_y(−π/2)·(0, 0.1, −0.1) = (−2.6 + 0.1, 0.23, 1) → Z-up (−2.5, −1, 0.23).
    close(anchor, [-2.5, -1, 0.23]);
  });

  it('references one OBJ per base and per part, with mesh vertices in the body frame', () => {
    expect(Object.keys(files).sort()).toEqual([
      'meshes/jewelry_box.obj',
      'meshes/jewelry_box__lid.obj',
      'meshes/nightstand.obj',
      'meshes/nightstand__top_drawer.obj',
    ]);
    for (const name of ['nightstand', 'nightstand__top_drawer', 'jewelry_box', 'jewelry_box__lid']) {
      expect(element(xml, 'mesh', name).file).toBe(`${name}.obj`);
      expect(element(xml, 'geom', name).mesh).toBe(name);
    }
    // Drawer knob front at model z = 0.25 → body y = −0.25.
    const ys = files['meshes/nightstand__top_drawer.obj']!
      .split('\n')
      .filter((l) => l.startsWith('v '))
      .map((l) => Number(l.split(' ')[2]));
    expect(Math.min(...ys)).toBeCloseTo(-0.25, 5);
  });

  it('nests each part body inside its object body', () => {
    const start = xml.indexOf('<body name="nightstand"');
    const part = xml.indexOf('<body name="nightstand__top_drawer"');
    const end = xml.indexOf('</body>', part);
    expect(start).toBeGreaterThan(0);
    expect(part).toBeGreaterThan(start);
    expect(xml.indexOf('</body>', end + 1)).toBeGreaterThan(end);
  });

  it('scales meshes, pivots and slide travel by the placement scale', () => {
    const scaled: RoomDoc = { ...room, objects: room.objects.map((o) => ({ ...o, scale: 2 })) };
    const out = toMJCF(scaled, meshes);
    expect(element(out.xml, 'joint', 'nightstand__top_drawer').range).toBe('0 0.6');
    expect(element(out.xml, 'joint', 'jewelry_box__lid').range).toBe('0 1.9');
    close(nums(element(out.xml, 'joint', 'jewelry_box__lid').pos), [0, 0.2, 0.2]);
  });

  it('keeps a flat panel visual-only with shell inertia, since a plane has no convex hull', () => {
    const panel = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    expect(isFlat(panel)).toBe(true);
    expect(isFlat(meshes.nightstand!.parts.top_drawer!)).toBe(false);
    const out = toMJCF(room, { ...meshes, jewelry_box: { ...meshes.jewelry_box!, parts: { lid: panel } } });
    expect(element(out.xml, 'mesh', 'jewelry_box__lid').inertia).toBe('shell');
    const lid = element(out.xml, 'geom', 'jewelry_box__lid');
    expect([lid.contype, lid.conaffinity]).toEqual(['0', '0']);
    expect(element(out.xml, 'mesh', 'nightstand__top_drawer').inertia).toBe('convex');
  });

  it('rejects a room whose object has no meshes', () => {
    expect(() => toMJCF(room, { nightstand: meshes.nightstand! })).toThrow(/jewelry_box/);
  });
});
