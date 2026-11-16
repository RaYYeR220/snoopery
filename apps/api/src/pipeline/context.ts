import type { Aholo, Lux3dKind, Lux3dOutputs } from '@snoopery/aholo';
import { parseLux3dOutputs } from '@snoopery/aholo';
import type { AffordanceCard, Joint, JointType } from '@snoopery/schema';
import type { BlobStore, DocStore } from '../store/types';
import type { Job, StepDef, StepResult } from './engine';

export interface ObjectDescription {
  label: string;
  category: string;
  parts: { name: string; joint: JointType }[];
  /** Motion prompt for Lux3D articulation, e.g. "Keep the body fixed. The top drawer slides out 30 cm." */
  motionPrompt: string;
}

export interface PipelineConfig {
  /** Articulate the part-split mesh or the fused mesh. */
  articulateFrom: 'split' | 'mesh';
  faceCount: number;
  characterClips: string[];
}

export interface PipelineCtx {
  aholo: Aholo;
  docs: DocStore;
  blobs: BlobStore;
  describe(photoUrl: string): Promise<ObjectDescription>;
  optimize(glb: Uint8Array): Promise<Uint8Array>;
  voxelize(splat: Uint8Array, format: 'spz' | 'ply' | 'sog'): Promise<{ meta: Uint8Array; bin: Uint8Array }>;
  analyze(glb: Uint8Array, objectId: string, label: string, hints: ObjectDescription['parts']): Promise<{ joints: Joint[]; card: AffordanceCard; source: 'animation' | 'inferred' }>;
  config: PipelineConfig;
}

export const out = (job: Job, step: string): Record<string, any> => job.steps.find((s) => s.name === step)?.output ?? {};

/** A step backed by one Lux3D task: start returns the task id, finish mirrors outputs before the 2 h URLs expire. */
export function lux3dStep(
  name: string,
  kind: Lux3dKind,
  needs: string[],
  start: (ctx: PipelineCtx, job: Job) => Promise<string>,
  finish: (ctx: PipelineCtx, job: Job, o: Lux3dOutputs) => Promise<Record<string, any>>,
  extra: Partial<StepDef<PipelineCtx>> = {},
): StepDef<PipelineCtx> {
  return {
    name,
    needs,
    ...extra,
    run: async (ctx, job) => ({ state: 'running', ref: await start(ctx, job) }),
    poll: async (ctx, ref, job): Promise<StepResult> => {
      const t = await ctx.aholo.task(ref);
      if (t.status === 0 || t.status === 1) return { state: 'running', ref };
      const o = parseLux3dOutputs(kind, t.outputs);
      if (t.status !== 3) return { state: 'failed', error: o.error ?? `task ${ref} ended with status ${t.status}` };
      if (o.error) return { state: 'failed', error: o.error };
      return { state: 'done', output: { taskId: ref, ...(await finish(ctx, job, o)) } };
    },
  };
}

export async function mirror(ctx: PipelineCtx, key: string, url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  return (await ctx.blobs.putFromUrl(key, url)).url;
}
