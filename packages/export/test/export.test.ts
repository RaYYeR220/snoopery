import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { exportRoom } from '../src/index.ts';
import { demoRoom, loadDevGlb } from './fixtures.ts';

describe('exportRoom', () => {
  it('bundles an MJCF scene with its meshes, the task and a readme', async () => {
    const urls: string[] = [];
    const zip = await exportRoom(demoRoom(), async (url) => (urls.push(url), loadDevGlb(url)), 'mjcf');
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      'README.txt',
      'meshes/jewelry_box.obj',
      'meshes/jewelry_box__lid.obj',
      'meshes/nightstand.obj',
      'meshes/nightstand__top_drawer.obj',
      'scene.xml',
      'task.json',
    ]);
    expect(urls).toHaveLength(2);
    expect(strFromU8(entries['scene.xml']!)).toContain('name="nightstand__top_drawer"');
    const task = JSON.parse(strFromU8(entries['task.json']!));
    expect(task.room).toEqual({ id: 'dev:demo', title: 'Test room' });
    expect(task.steps).toHaveLength(5);
    expect(task.joints).toContainEqual({ name: 'jewelry_box__lid', object: 'jewelry_box', part: 'lid', type: 'revolute', range: [0, 1.9], unit: 'rad' });
    const readme = strFromU8(entries['README.txt']!);
    expect(readme).toContain('scene.xml');
    expect(readme).toContain('nightstand__top_drawer');
  });

  it('bundles a USD scene with the task', async () => {
    const entries = unzipSync(await exportRoom(demoRoom(), loadDevGlb, 'usda'));
    expect(Object.keys(entries).sort()).toEqual(['scene.usda', 'task.json']);
    expect(strFromU8(entries['scene.usda']!)).toContain('PhysicsRevoluteJoint');
  });

  it('exports the task alone without fetching any model', async () => {
    const entries = unzipSync(
      await exportRoom(demoRoom(), async () => {
        throw new Error('no fetch expected');
      }, 'task'),
    );
    expect(Object.keys(entries)).toEqual(['task.json']);
  });

  it('loads a model shared by several placements once', async () => {
    const room = demoRoom();
    const twin = { ...room, objects: [...room.objects, { ...room.objects[0]!, objectId: 'nightstand_2', position: [0, -0.5, 0] as [number, number, number] }] };
    let loads = 0;
    const entries = unzipSync(await exportRoom(twin, async (url) => (loads++, loadDevGlb(url)), 'mjcf'));
    expect(loads).toBe(2);
    expect(entries['meshes/nightstand_2__top_drawer.obj']).toBeDefined();
  });

  it('rejects an unknown format', async () => {
    await expect(exportRoom(demoRoom(), loadDevGlb, 'urdf' as never)).rejects.toThrow(/format/);
  });
});
