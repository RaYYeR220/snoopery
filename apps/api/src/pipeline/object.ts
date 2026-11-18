import { unzipSync } from 'fflate';
import type { StepDef } from './engine';
import { handoff, lux3dStep, mirror, out, type PipelineCtx } from './context';
import { assembleUrdfPackage } from './urdf';

export interface ObjectDoc {
  id: string;
  label: string;
  category: string;
  photo: string;
  status: 'building' | 'ready' | 'failed';
  jobId: string;
  previewPly?: string;
  meshGlb?: string;
  partsGlb?: string;
  articulatedGlb?: string;
  webGlb?: string;
  joints?: unknown[];
  card?: unknown;
  jointSource?: 'urdf' | 'animation' | 'inferred';
  /** Corrections applied to the joints Lux3D returned (e.g. drawer travel), shown next to the object. */
  jointNotes?: string[];
  /** The URDF package exactly as articulation returned it (robot.urdf + one GLB per link). */
  urdfPackage?: string;
  motionPrompt?: string;
  createdAt: string;
  library: boolean;
}

const key = (id: string, file: string) => `objects/${id}/${file}`;

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

function glbFromArchive(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return bytes; // "glTF"
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.glb'));
  if (!name) throw new Error(`archive has no .glb (entries: ${Object.keys(files).join(', ')})`);
  return files[name]!;
}

export const objectSteps: StepDef<PipelineCtx>[] = [
  {
    name: 'photo',
    needs: [],
    run: async (ctx, job) => {
      const src = job.input.photoUrl as string;
      const url = src.startsWith(ctx.blobs.publicUrl('')) ? src : (await ctx.blobs.putFromUrl(key(job.input.objectId, 'photo.jpg'), src)).url;
      return { state: 'done', output: { photo: url, holo: await handoff(ctx, url, 'photo.jpg') } };
    },
  },
  {
    name: 'describe',
    needs: ['photo'],
    run: async (ctx, job) => {
      const d = job.input.description ?? (await ctx.describe(out(job, 'photo').photo));
      return { state: 'done', output: d };
    },
  },
  lux3dStep(
    'preview',
    'imgTo3d',
    ['photo'],
    (ctx, job) => ctx.aholo.imgTo3d({ img: out(job, 'photo').holo ?? out(job, 'photo').photo, turbo: true }),
    async (ctx, job, o) => ({ ply: await mirror(ctx, key(job.input.objectId, 'preview.ply'), o.ply) }),
  ),
  lux3dStep(
    'mesh',
    'imgTo3d',
    ['photo'],
    (ctx, job) => ctx.aholo.imgTo3d({ img: out(job, 'photo').holo ?? out(job, 'photo').photo, turbo: false, faceCount: ctx.config.faceCount, aiPredictSize: true }),
    async (ctx, job, o) => {
      const glb = await mirror(ctx, key(job.input.objectId, 'mesh.glb'), o.glb);
      if (!glb) throw new Error('image-to-3D returned no GLB');
      return { glb, zip: await mirror(ctx, key(job.input.objectId, 'mesh.zip'), o.zip), holo: await handoff(ctx, glb, 'mesh.glb') };
    },
  ),
  lux3dStep(
    'split',
    'partSplit',
    ['mesh'],
    (ctx, job) => ctx.aholo.partSplit(out(job, 'mesh').holo ?? out(job, 'mesh').glb),
    async (ctx, job, o) => {
      const glb = await mirror(ctx, key(job.input.objectId, 'parts.glb'), o.glb ?? o.url);
      return { glb, holo: glb ? await handoff(ctx, glb, 'parts.glb') : undefined };
    },
    { enabled: (_job, ctx) => ctx.config.articulateFrom === 'split' },
  ),
  lux3dStep(
    'articulate',
    'articulate',
    ['mesh', 'split', 'describe'],
    (ctx, job) => {
      const split = out(job, 'split');
      const mesh = out(job, 'mesh');
      const from = split.holo ?? split.glb ?? mesh.holo ?? mesh.glb;
      return ctx.aholo.articulate(from, out(job, 'describe').motionPrompt);
    },
    async (ctx, job, o) => {
      const src = o.glb ?? o.zip ?? o.url;
      if (!src) throw new Error('articulation returned no file');
      const raw = await ctx.blobs.getBytes(src);
      const id = job.input.objectId as string;
      if (isZip(raw) && Object.keys(unzipSync(raw)).some((n) => n.toLowerCase().endsWith('.urdf'))) {
        // Current Lux3D articulation: a URDF with one mesh per link. Its joints are authoritative.
        const a = await assembleUrdfPackage(raw);
        return {
          glb: await ctx.blobs.putBytes(key(id, 'articulated.glb'), a.glb, 'model/gltf-binary'),
          urdfPackage: await ctx.blobs.putBytes(key(id, 'articulation-urdf.zip'), raw, 'application/zip'),
          joints: a.joints,
          notes: a.notes,
          source: src,
        };
      }
      return { glb: await ctx.blobs.putBytes(key(id, 'articulated.glb'), glbFromArchive(raw), 'model/gltf-binary'), source: src };
    },
  ),
  {
    name: 'optimize',
    needs: ['articulate'],
    run: async (ctx, job) => {
      const bytes = await ctx.blobs.getBytes(out(job, 'articulate').glb);
      const web = await ctx.optimize(bytes);
      const url = await ctx.blobs.putBytes(key(job.input.objectId, 'web.glb'), web, 'model/gltf-binary');
      return { state: 'done', output: { glb: url, bytesIn: bytes.length, bytesOut: web.length } };
    },
  },
  {
    name: 'joints',
    needs: ['optimize', 'describe'],
    run: async (ctx, job) => {
      const d = out(job, 'describe');
      const bytes = await ctx.blobs.getBytes(out(job, 'optimize').glb);
      const r = await ctx.analyze(bytes, job.input.objectId, d.label, d.parts ?? [], out(job, 'articulate').joints ?? []);
      if (r.joints.length === 0) return { state: 'failed', error: 'no openable part found in the articulated model' };
      return { state: 'done', output: r };
    },
  },
  {
    name: 'publish',
    needs: ['joints', 'preview'],
    run: async (ctx, job) => {
      const id = job.input.objectId as string;
      const d = out(job, 'describe');
      const j = out(job, 'joints');
      const doc: ObjectDoc = {
        id,
        label: d.label,
        category: d.category,
        photo: out(job, 'photo').photo,
        status: 'ready',
        jobId: job.id,
        previewPly: out(job, 'preview').ply,
        meshGlb: out(job, 'mesh').glb,
        partsGlb: out(job, 'split').glb,
        articulatedGlb: out(job, 'articulate').glb,
        webGlb: out(job, 'optimize').glb,
        joints: j.joints,
        card: j.card,
        jointSource: j.source,
        ...(out(job, 'articulate').notes?.length ? { jointNotes: out(job, 'articulate').notes } : {}),
        ...(out(job, 'articulate').urdfPackage ? { urdfPackage: out(job, 'articulate').urdfPackage } : {}),
        motionPrompt: d.motionPrompt,
        createdAt: job.createdAt,
        library: job.input.library !== false,
      };
      await ctx.docs.put(`objects/${id}`, doc);
      return { state: 'done', output: { objectId: id } };
    },
  },
];
