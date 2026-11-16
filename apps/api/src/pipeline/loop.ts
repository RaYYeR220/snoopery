import { createJob, retryStep, tickJob, type Job, type JobKind, type StepDef } from './engine';
import type { PipelineCtx } from './context';
import { objectSteps } from './object';
import { characterSteps, propSteps, spaceSteps } from './room';

export const PIPELINES: Record<JobKind, StepDef<PipelineCtx>[]> = {
  object: objectSteps,
  room: spaceSteps,
  character: characterSteps,
  prop: propSteps,
};

const ACTIVE = 'jobs/_active';

async function activeIds(ctx: PipelineCtx): Promise<string[]> {
  return (await ctx.docs.get<string[]>(ACTIVE)) ?? [];
}

export async function submit(ctx: PipelineCtx, kind: JobKind, input: Record<string, unknown>): Promise<Job> {
  const job = createJob(kind, input, PIPELINES[kind]);
  await ctx.docs.put(`jobs/${job.id}`, job);
  await ctx.docs.put(ACTIVE, [...(await activeIds(ctx)), job.id]);
  return job;
}

export async function retry(ctx: PipelineCtx, jobId: string, step: string): Promise<Job | null> {
  const job = await ctx.docs.get<Job>(`jobs/${jobId}`);
  if (!job) return null;
  const next = retryStep(job, step);
  await ctx.docs.put(`jobs/${jobId}`, next);
  const ids = await activeIds(ctx);
  if (next.status === 'active' && !ids.includes(jobId)) await ctx.docs.put(ACTIVE, [...ids, jobId]);
  return next;
}

let running: Promise<{ ticked: number; finished: number }> | null = null;

/** Advances every active job once. Overlapping calls share one run. */
export function tickAll(ctx: PipelineCtx): Promise<{ ticked: number; finished: number }> {
  running ??= (async () => {
    try {
      const ids = await activeIds(ctx);
      const still: string[] = [];
      let finished = 0;
      for (const id of ids) {
        const job = await ctx.docs.get<Job>(`jobs/${id}`);
        if (!job) continue;
        const next = await tickJob(job, PIPELINES[job.kind], ctx);
        if (JSON.stringify(next.steps) !== JSON.stringify(job.steps) || next.status !== job.status) await ctx.docs.put(`jobs/${id}`, next);
        if (next.status === 'active') still.push(id);
        else finished++;
      }
      // Re-read so jobs submitted during this tick are not dropped.
      const latest = await activeIds(ctx);
      const added = latest.filter((id) => !ids.includes(id));
      await ctx.docs.put(ACTIVE, [...still, ...added]);
      return { ticked: ids.length, finished };
    } finally {
      running = null;
    }
  })();
  return running;
}
