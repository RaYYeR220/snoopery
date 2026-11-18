import { nanoid } from 'nanoid';
import { AholoBusy } from '@snoopery/aholo';

export type StepStatus = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepState {
  name: string;
  status: StepStatus;
  ref?: string;
  startedAt?: string;
  finishedAt?: string;
  ms?: number;
  output?: Record<string, any>;
  error?: string;
  attempts: number;
}

export type JobKind = 'object' | 'room' | 'character' | 'prop';

export interface Job {
  id: string;
  kind: JobKind;
  input: Record<string, any>;
  steps: StepState[];
  status: 'active' | 'done' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export type StepResult =
  | { state: 'done'; output: Record<string, any> }
  | { state: 'running'; ref: string }
  | { state: 'failed'; error: string };

export interface StepDef<C> {
  name: string;
  needs: string[];
  enabled?: (job: Job, ctx: C) => boolean;
  run: (ctx: C, job: Job) => Promise<StepResult>;
  poll?: (ctx: C, ref: string, job: Job) => Promise<StepResult>;
}

export function createJob<C>(kind: JobKind, input: Record<string, any>, defs: StepDef<C>[]): Job {
  const now = new Date().toISOString();
  return {
    id: nanoid(12),
    kind,
    input,
    steps: defs.map((d) => ({ name: d.name, status: 'pending', attempts: 0 })),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

const settled = (s: StepState) => s.status === 'done' || s.status === 'skipped';

function apply(step: StepState, r: StepResult) {
  const now = new Date();
  if (r.state === 'running') {
    step.status = 'running';
    step.ref = r.ref;
    return;
  }
  step.status = r.state === 'done' ? 'done' : 'failed';
  if (r.state === 'done') step.output = r.output;
  else step.error = r.error;
  step.finishedAt = now.toISOString();
  if (step.startedAt) step.ms = now.getTime() - new Date(step.startedAt).getTime();
}

/** Advances every step whose dependencies are settled by one move (start, or poll once). Never throws. */
export async function tickJob<C>(input: Job, defs: StepDef<C>[], ctx: C): Promise<Job> {
  const job: Job = structuredClone(input);
  if (job.status !== 'active') return job;
  // Jobs created before a step was added to their pipeline get it as pending, in pipeline order.
  if (defs.some((d) => !job.steps.some((s) => s.name === d.name))) {
    job.steps = defs.map((d) => job.steps.find((s) => s.name === d.name) ?? { name: d.name, status: 'pending', attempts: 0 });
  }
  const byName = new Map(job.steps.map((s) => [s.name, s]));

  const busy = new Set<string>();
  // Several passes so synchronous steps unlocked within this tick also run.
  for (let pass = 0; pass < defs.length; pass++) {
    let moved = false;
    for (const def of defs) {
      const step = byName.get(def.name)!;
      if (settled(step) || step.status === 'failed' || busy.has(def.name)) continue;
      if (!def.needs.every((n) => settled(byName.get(n)!))) continue;
      if (step.status === 'pending' && def.enabled && !def.enabled(job, ctx)) {
        step.status = 'skipped';
        moved = true;
        continue;
      }
      try {
        if (step.status === 'running') {
          if (!def.poll || !step.ref) throw new Error(`step ${def.name} is running without a poller`);
          if (pass > 0) continue; // poll once per tick
          apply(step, await def.poll(ctx, step.ref, job));
        } else {
          step.attempts += 1;
          step.startedAt ??= new Date().toISOString();
          step.error = undefined;
          apply(step, await def.run(ctx, job));
        }
        moved = moved || settled(step);
      } catch (err) {
        if (err instanceof AholoBusy) {
          step.status = 'queued';
          busy.add(def.name);
          continue;
        }
        step.status = 'failed';
        step.error = err instanceof Error ? err.message : String(err);
        step.finishedAt = new Date().toISOString();
      }
    }
    if (!moved) break;
  }

  if (job.steps.every(settled)) job.status = 'done';
  else if (job.steps.some((s) => s.status === 'failed') && !job.steps.some((s) => s.status === 'running' || s.status === 'queued')) {
    const failed = new Set(job.steps.filter((s) => s.status === 'failed').map((s) => s.name));
    const blocked = (name: string, seen = new Set<string>()): boolean => {
      if (failed.has(name)) return true;
      if (seen.has(name)) return false;
      seen.add(name);
      return defs.find((d) => d.name === name)!.needs.some((n) => blocked(n, seen));
    };
    const canProgress = defs.some((d) => {
      const s = byName.get(d.name)!;
      return !settled(s) && !failed.has(d.name) && !blocked(d.name);
    });
    if (!canProgress) job.status = 'failed';
  }
  job.updatedAt = new Date().toISOString();
  return job;
}

export function retryStep(input: Job, name: string): Job {
  const job: Job = structuredClone(input);
  const step = job.steps.find((s) => s.name === name);
  if (!step || step.status !== 'failed') return job;
  Object.assign(step, { status: 'pending', ref: undefined, error: undefined, startedAt: undefined, finishedAt: undefined, ms: undefined });
  job.status = 'active';
  return job;
}
