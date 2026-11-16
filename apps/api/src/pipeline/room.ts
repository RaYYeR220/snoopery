import type { StepDef, StepResult } from './engine';
import { lux3dStep, mirror, out, type PipelineCtx } from './context';

/** A scanned or generated space a room can be built in. */
export interface SpaceDoc {
  id: string;
  title: string;
  source: 'reconstruction' | 'generation' | 'library';
  splatUrl: string;
  format: 'spz' | 'ply' | 'sog';
  panoUrl?: string;
  collision?: { metaUrl: string; binUrl: string };
  input: { videoUrl?: string; prompt?: string; imageUrl?: string };
  jobId?: string;
  createdAt: string;
}

const DONE = new Set(['SUCCEEDED']);
const FAILED = new Set(['FAILED', 'CANCELED', 'TIMEOUT', 'REJECTED']);

async function pollWorld(ctx: PipelineCtx, ref: string): Promise<StepResult> {
  const w = await ctx.aholo.world(ref);
  if (FAILED.has(w.status)) return { state: 'failed', error: `world ${ref} ${w.status}` };
  if (!DONE.has(w.status) || !w.splatUrl) return { state: 'running', ref };
  return { state: 'done', output: { worldId: ref, splatSource: w.splatUrl, panoSource: w.panoUrl } };
}

export const spaceSteps: StepDef<PipelineCtx>[] = [
  {
    name: 'source',
    needs: [],
    run: async (ctx, job) => {
      const { videoUrl, imageUrl } = job.input;
      const media = videoUrl ?? imageUrl;
      if (!media) return { state: 'done', output: {} };
      const ext = videoUrl ? (videoUrl.toLowerCase().includes('.mov') ? 'mov' : videoUrl.toLowerCase().includes('.insv') ? 'insv' : 'mp4') : 'jpg';
      const url = media.startsWith(ctx.blobs.publicUrl('')) ? media : (await ctx.blobs.putFromUrl(`spaces/${job.input.spaceId}/source.${ext}`, media)).url;
      return { state: 'done', output: { url, ext } };
    },
  },
  {
    name: 'world',
    needs: ['source'],
    run: async (ctx, job) => {
      const src = out(job, 'source');
      const ref = job.input.videoUrl
        ? await ctx.aholo.reconstruct({
            name: job.input.title,
            ...(src.ext === 'insv' ? { insv: src.url } : { video: src.url }),
            scene: 'space',
            quality: job.input.quality ?? 'high',
          })
        : await ctx.aholo.generateWorld({ prompt: job.input.prompt, image: src.url });
      return { state: 'running', ref };
    },
    poll: (ctx, ref) => pollWorld(ctx, ref),
  },
  {
    name: 'mirror',
    needs: ['world'],
    run: async (ctx, job) => {
      const w = out(job, 'world');
      const format = /\.spz(\?|$)/i.test(w.splatSource) ? 'spz' : 'ply';
      const splat = await mirror(ctx, `spaces/${job.input.spaceId}/scene.${format}`, w.splatSource);
      const pano = await mirror(ctx, `spaces/${job.input.spaceId}/pano.jpg`, w.panoSource);
      return { state: 'done', output: { splatUrl: splat, format, panoUrl: pano } };
    },
  },
  {
    // Walk collision is a nicety: if voxelizing fails the space still publishes, walking just uses room bounds.
    name: 'collision',
    needs: ['mirror'],
    run: async (ctx, job) => {
      const m = out(job, 'mirror');
      try {
        const { meta, bin } = await ctx.voxelize(await ctx.blobs.getBytes(m.splatUrl), m.format);
        const base = `spaces/${job.input.spaceId}/voxel`;
        return {
          state: 'done',
          output: {
            metaUrl: await ctx.blobs.putBytes(`${base}/voxel-meta.json`, meta, 'application/json'),
            binUrl: await ctx.blobs.putBytes(`${base}/voxel.bin`, bin, 'application/octet-stream'),
          },
        };
      } catch (e) {
        return { state: 'done', output: { skipped: String((e as Error).message).slice(0, 200) } };
      }
    },
  },
  {
    name: 'publish',
    needs: ['mirror', 'collision'],
    run: async (ctx, job) => {
      const m = out(job, 'mirror');
      const c = out(job, 'collision');
      const doc: SpaceDoc = {
        id: job.input.spaceId,
        title: job.input.title,
        source: job.input.videoUrl ? 'reconstruction' : 'generation',
        splatUrl: m.splatUrl,
        format: m.format,
        panoUrl: m.panoUrl,
        ...(c.metaUrl ? { collision: { metaUrl: c.metaUrl, binUrl: c.binUrl } } : {}),
        input: { videoUrl: job.input.videoUrl, prompt: job.input.prompt, imageUrl: job.input.imageUrl },
        jobId: job.id,
        createdAt: job.createdAt,
      };
      await ctx.docs.put(`spaces/${doc.id}`, doc);
      return { state: 'done', output: { spaceId: doc.id } };
    },
  },
];

export interface CharacterDoc {
  id: string;
  prompt: string;
  rigGlb: string;
  clips: Record<string, string>;
  createdAt: string;
}

/** The figure that walks a room's shortest solution: Lux3D model → auto-rig → preset motions. */
export const characterSteps: StepDef<PipelineCtx>[] = [
  lux3dStep(
    'model',
    'textTo3d',
    [],
    (ctx, job) => ctx.aholo.textTo3d({ prompt: job.input.prompt, style: job.input.style, faceCount: 40000 }),
    async (ctx, job, o) => ({ glb: await mirror(ctx, `characters/${job.input.characterId}/model.glb`, o.glb ?? o.url) }),
  ),
  lux3dStep(
    'rig',
    'rig',
    ['model'],
    (ctx, job) => ctx.aholo.rig(out(job, 'model').glb),
    async (ctx, job, o) => ({ glb: await mirror(ctx, `characters/${job.input.characterId}/rig.glb`, o.glb ?? o.url) }),
  ),
  lux3dStep(
    'clips',
    'retarget',
    ['rig'],
    (ctx, job) => ctx.aholo.retarget(out(job, 'rig').glb, ctx.config.characterClips),
    async (ctx, job, o) => {
      const clips: Record<string, string> = {};
      for (const [name, url] of Object.entries(o.actions ?? {})) {
        clips[name] = (await mirror(ctx, `characters/${job.input.characterId}/${name}.glb`, url))!;
      }
      return { clips, failed: o.failed ?? [] };
    },
  ),
  {
    name: 'publish',
    needs: ['clips'],
    run: async (ctx, job) => {
      const doc: CharacterDoc = {
        id: job.input.characterId,
        prompt: job.input.prompt,
        rigGlb: out(job, 'rig').glb,
        clips: out(job, 'clips').clips,
        createdAt: job.createdAt,
      };
      await ctx.docs.put(`characters/${doc.id}`, doc);
      return { state: 'done', output: { characterId: doc.id } };
    },
  },
];
