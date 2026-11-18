import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import type { Aholo } from '@snoopery/aholo';
import { memoryBlobs, memoryDocs } from '../src/store/memory';
import { submit, tickAll } from '../src/pipeline/loop';
import type { PipelineCtx } from '../src/pipeline/context';
import type { ObjectDoc } from '../src/pipeline/object';

const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);

function fakeAholo(opts: { articulateZip?: boolean; articulateFails?: boolean } = {}) {
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
    articulate: [{ content: opts.articulateZip ? 'https://aholo.cdn/art.zip' : 'https://aholo.cdn/art.glb' }],
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

function ctxWith(aholo: Aholo, articulateFrom: 'split' | 'mesh' = 'split'): PipelineCtx {
  const zipped = zipSync({ 'model/scene.glb': GLB });
  const blobs = memoryBlobs(async (url) => (url.endsWith('.zip') && url.includes('art') ? zipped : GLB));
  return {
    aholo,
    docs: memoryDocs(),
    blobs,
    describe: async () => ({ label: 'Oak dresser', category: 'dresser', parts: [{ name: 'top_drawer', joint: 'prismatic' }], motionPrompt: 'Keep the body fixed. The top drawer slides out 30 cm.' }),
    optimize: async (b) => b,
    voxelize: async () => ({ meta: new Uint8Array([123]), bin: new Uint8Array([0]) }),
    analyze: async (_b, objectId, label) => ({
      joints: [{ part: 'top_drawer', node: 'top_drawer', type: 'prismatic', axis: [1, 0, 0], pivot: [0, 0, 0], min: 0, max: 0.3 }],
      card: { objectId, label, sizeM: [1, 1, 0.5], parts: [{ part: 'top_drawer', joint: 'prismatic', capacity: 'medium' }] },
      source: 'animation',
    }),
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
