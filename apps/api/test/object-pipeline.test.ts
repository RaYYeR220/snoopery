import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { Document, NodeIO } from '@gltf-transform/core';
import type { Aholo } from '@snoopery/aholo';
import { memoryBlobs, memoryDocs } from '../src/store/memory';
import { submit, tickAll } from '../src/pipeline/loop';
import type { PipelineCtx } from '../src/pipeline/context';
import type { ObjectDoc } from '../src/pipeline/object';

const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);

/** An axis-aligned box mesh as a GLB, standing in for one Lux3D link mesh. */
async function boxGlb(min: number[], max: number[]): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const [a, b, c] = min as [number, number, number];
  const [x, y, z] = max as [number, number, number];
  const pos = doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([a, b, c, x, b, c, x, y, c, a, y, z, x, y, z, a, b, z]));
  const prim = doc.createPrimitive().setAttribute('POSITION', pos);
  const node = doc.createNode('geometry_0').setMesh(doc.createMesh('geometry_0').addPrimitive(prim));
  doc.createScene().addChild(node);
  return new NodeIO().writeBinary(doc);
}

/** The shape of Lux3D's current articulation result: robot.urdf + meshes/<link>.glb. */
async function urdfPackage(): Promise<Uint8Array> {
  const urdf = `<?xml version="1.0"?><robot name="robot">
    <link name="base"><visual><geometry><mesh filename="meshes/base.glb" /></geometry></visual></link>
    <link name="lid"><visual><geometry><mesh filename="meshes/lid.glb" /></geometry></visual></link>
    <link name="drawer"><visual><geometry><mesh filename="meshes/drawer.glb" /></geometry></visual></link>
    <joint name="lid_joint" type="revolute"><parent link="base" /><child link="lid" />
      <origin rpy="0 0 0" xyz="0 0.66 -0.23" /><axis xyz="-1 0 0" /><limit lower="0" upper="1.570796" effort="10" velocity="1" /></joint>
    <joint name="drawer_joint" type="prismatic"><parent link="base" /><child link="drawer" />
      <origin rpy="0 0 0" xyz="0 0.26 0.22" /><axis xyz="0 0 1" /><limit lower="0" upper="0.013" effort="10" velocity="1" /></joint>
  </robot>`;
  return zipSync({
    'urdf/robot.urdf': strToU8(urdf),
    'urdf/meshes/base.glb': await boxGlb([-0.45, 0, -0.25], [0.45, 0.66, 0.25]),
    'urdf/meshes/lid.glb': await boxGlb([-0.45, -0.02, 0], [0.45, 0.02, 0.46]),
    'urdf/meshes/drawer.glb': await boxGlb([-0.4, -0.1, -0.02], [0.4, 0.1, 0.03]),
  });
}

function fakeAholo(opts: { articulateZip?: boolean; articulateFails?: boolean; articulateUrdf?: boolean } = {}) {
  const tasks = new Map<string, { kind: string; polls: number }>();
  let n = 0;
  const started: string[] = [];
  const inputs: string[] = [];
  const mk = (kind: string) => async (input?: unknown) => {
    started.push(kind);
    if (typeof input === 'string') inputs.push(input);
    const id = `t${++n}`;
    tasks.set(id, { kind, polls: 0 });
    return id;
  };
  const outputs: Record<string, { content: string }[]> = {
    turbo: [{ content: 'https://aholo.cdn/preview.ply' }],
    g1: [{ content: 'https://aholo.cdn/mesh.zip' }, { content: 'https://aholo.cdn/mesh.glb' }],
    split: [{ content: 'https://aholo.cdn/parts.glb' }],
    articulate: [{ content: opts.articulateUrdf ? 'https://aholo.cdn/urdf.zip' : opts.articulateZip ? 'https://aholo.cdn/art.zip' : 'https://aholo.cdn/art.glb' }],
  };
  const aholo: Partial<Aholo> = {
    imgTo3d: async (o) => mk(o.turbo ? 'turbo' : 'g1')(o.img),
    upload: async (_bytes, filename) => `https://holo.test/${filename}`,
    partSplit: mk('split'),
    articulate: mk('articulate'),
    task: async (id) => {
      const t = tasks.get(id)!;
      t.polls++;
      if (t.polls < 2) return { status: 1, outputs: [] };
      if (t.kind === 'articulate' && opts.articulateFails) return { status: 4, outputs: [{ content: JSON.stringify({ error: { code: 'NO_PARTS', message: 'nothing movable' } }) }] };
      return { status: 3, outputs: outputs[t.kind]! };
    },
  };
  return { aholo: aholo as Aholo, started, inputs };
}

function ctxWith(aholo: Aholo, articulateFrom: 'split' | 'mesh' = 'split', urdfZip?: Uint8Array): PipelineCtx {
  const zipped = zipSync({ 'model/scene.glb': GLB });
  const blobs = memoryBlobs(async (url) => (url.endsWith('urdf.zip') && urdfZip ? urdfZip : url.endsWith('.zip') && url.includes('art') ? zipped : GLB));
  return {
    aholo,
    docs: memoryDocs(),
    blobs,
    describe: async () => ({ label: 'Oak dresser', category: 'dresser', parts: [{ name: 'top_drawer', joint: 'prismatic' }], motionPrompt: 'Keep the body fixed. The top drawer slides out 30 cm.' }),
    optimize: async (b) => b,
    voxelize: async () => ({ meta: new Uint8Array([123]), bin: new Uint8Array([0]) }),
    analyze: async (_b, objectId, label, _hints, given) =>
      given?.length
        ? { joints: given, card: { objectId, label, sizeM: [0.9, 0.66, 0.5], parts: given.map((g) => ({ part: g.part, joint: g.type, capacity: 'medium' as const })) }, source: 'urdf' as const }
        : {
      joints: [{ part: 'top_drawer', node: 'top_drawer', type: 'prismatic', axis: [1, 0, 0], pivot: [0, 0, 0], min: 0, max: 0.3 }],
      card: { objectId, label, sizeM: [1, 1, 0.5], parts: [{ part: 'top_drawer', joint: 'prismatic', capacity: 'medium' }] },
      source: 'animation' as const,
    },
    config: { articulateFrom, faceCount: 40000, characterClips: ['Walk_Loop'] },
  };
}

async function runToEnd(ctx: PipelineCtx, max = 20) {
  for (let i = 0; i < max; i++) {
    const { ticked } = await tickAll(ctx);
    if (ticked === 0) return;
  }
}

describe('object pipeline', () => {
  it('turns a photo into a published object with joints and mirrored assets', async () => {
    const { aholo, started, inputs } = fakeAholo();
    const ctx = ctxWith(aholo);
    await submit(ctx, 'object', { objectId: 'o1', photoUrl: 'https://phone/dresser.jpg' });
    await runToEnd(ctx);
    const doc = await ctx.docs.get<ObjectDoc>('objects/o1');
    expect(doc).toMatchObject({ id: 'o1', label: 'Oak dresser', status: 'ready', jointSource: 'animation' });
    expect(doc!.webGlb).toBe('https://blobs.test/objects/o1/web.glb');
    expect(doc!.previewPly).toBe('https://blobs.test/objects/o1/preview.ply');
    expect(started).toEqual(['turbo', 'g1', 'split', 'articulate']);
    // Aholo only ever receives files from its own storage, never links into our bucket.
    expect(inputs).toEqual(['https://holo.test/photo.jpg', 'https://holo.test/photo.jpg', 'https://holo.test/mesh.glb', 'https://holo.test/parts.glb']);
  });

  it('extracts the GLB when articulation returns an archive', async () => {
    const { aholo } = fakeAholo({ articulateZip: true });
    const ctx = ctxWith(aholo);
    await submit(ctx, 'object', { objectId: 'o2', photoUrl: 'https://phone/box.jpg' });
    await runToEnd(ctx);
    const blobs = ctx.blobs as ReturnType<typeof memoryBlobs>;
    expect(blobs.files.get('objects/o2/articulated.glb')).toEqual(GLB);
  });

  it('skips part split when configured to articulate the fused mesh', async () => {
    const { aholo, started } = fakeAholo();
    const ctx = ctxWith(aholo, 'mesh');
    await submit(ctx, 'object', { objectId: 'o3', photoUrl: 'https://phone/x.jpg' });
    await runToEnd(ctx);
    expect(started.filter((s) => s === 'split')).toHaveLength(0);
  });

  it('takes joints from the URDF package articulation returns and keeps the package for robots', async () => {
    const { aholo } = fakeAholo({ articulateUrdf: true });
    const ctx = ctxWith(aholo, 'mesh', await urdfPackage());
    await submit(ctx, 'object', { objectId: 'o5', photoUrl: 'https://phone/chest.jpg' });
    await runToEnd(ctx);
    const doc = await ctx.docs.get<ObjectDoc>('objects/o5');
    expect(doc).toMatchObject({ status: 'ready', jointSource: 'urdf', urdfPackage: 'https://blobs.test/objects/o5/articulation-urdf.zip' });
    const [lid, drawer] = doc!.joints as any[];
    expect(lid).toMatchObject({ part: 'lid', node: 'lid', type: 'revolute', axis: [-1, 0, 0], pivot: [0, 0.66, -0.23], min: 0 });
    expect(lid.max).toBeCloseTo(Math.PI / 2, 5);
    // 1.3 cm of drawer travel is raised to 30% of the 50 cm carcass depth, and the correction is recorded.
    expect(drawer).toMatchObject({ part: 'drawer', type: 'prismatic', axis: [0, 0, 1], min: 0 });
    expect(drawer.max).toBeCloseTo(0.15, 3);
    expect(doc!.jointNotes).toEqual(['drawer: travel raised from 1.3 cm to 15 cm (30% of the 50 cm carcass)']);
    // One GLB whose node tree is the kinematic tree, with each link placed at its joint origin.
    const glb = await new NodeIO().readBinary((ctx.blobs as ReturnType<typeof memoryBlobs>).files.get('objects/o5/articulated.glb')!);
    const node = (name: string) => glb.getRoot().listNodes().find((n) => n.getName() === name)!;
    expect(node('lid').getParentNode()?.getName()).toBe('base');
    expect(node('lid').getTranslation()).toEqual([0, 0.66, -0.23]);
    expect(node('drawer').getTranslation()).toEqual([0, 0.26, 0.22]);
  });

  it('picks up a job whose id was lost from the active list', async () => {
    const { aholo } = fakeAholo();
    const ctx = ctxWith(aholo);
    await submit(ctx, 'object', { objectId: 'o6', photoUrl: 'https://phone/a.jpg' });
    await submit(ctx, 'object', { objectId: 'o7', photoUrl: 'https://phone/b.jpg' });
    // A submit racing a tick overwrote the list without the second job.
    await ctx.docs.put('jobs/_active', (await ctx.docs.get<string[]>('jobs/_active'))!.slice(0, 1));
    await runToEnd(ctx);
    expect((await ctx.docs.get<ObjectDoc>('objects/o6'))?.status).toBe('ready');
    expect((await ctx.docs.get<ObjectDoc>('objects/o7'))?.status).toBe('ready');
  });

  it('surfaces the Aholo error text when articulation fails and leaves no published object', async () => {
    const { aholo } = fakeAholo({ articulateFails: true });
    const ctx = ctxWith(aholo);
    const job = await submit(ctx, 'object', { objectId: 'o4', photoUrl: 'https://phone/x.jpg' });
    await runToEnd(ctx);
    const saved = await ctx.docs.get<any>(`jobs/${job.id}`);
    expect(saved.status).toBe('failed');
    expect(saved.steps.find((s: any) => s.name === 'articulate').error).toBe('NO_PARTS: nothing movable');
    expect(await ctx.docs.get('objects/o4')).toBeNull();
  });
});
