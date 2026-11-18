import { describe, expect, it } from 'vitest';
import { AholoBusy } from '@snoopery/aholo';
import { createJob, retryStep, tickJob, type StepDef } from '../src/pipeline/engine';

type Ctx = { log: string[]; polls: Record<string, number>; busyOnce: Set<string>; failOn?: string };

function defs(): StepDef<Ctx>[] {
  return [
    { name: 'a', needs: [], run: async (c) => (c.log.push('a'), { state: 'done', output: { a: 1 } }) },
    {
      name: 'b',
      needs: ['a'],
      run: async (c) => {
        if (c.busyOnce.has('b')) {
          c.busyOnce.delete('b');
          throw new AholoBusy('lux3d.b');
        }
        c.log.push('b:start');
        return { state: 'running', ref: 'task-b' };
      },
      poll: async (c, ref) => {
        c.polls[ref] = (c.polls[ref] ?? 0) + 1;
        if (c.failOn === 'b') return { state: 'failed', error: 'MODEL_BROKEN: bad mesh' };
        return c.polls[ref]! >= 2 ? { state: 'done', output: { b: ref } } : { state: 'running', ref };
      },
    },
    { name: 'c', needs: ['a'], run: async (c) => (c.log.push('c'), { state: 'done', output: { c: 3 } }) },
    { name: 'd', needs: ['b', 'c'], run: async (c, job) => (c.log.push(`d:${job.steps.find((s) => s.name === 'b')!.output!.b}`), { state: 'done', output: {} }) },
  ];
}

const ctx = (): Ctx => ({ log: [], polls: {}, busyOnce: new Set() });

describe('pipeline engine', () => {
  it('advances independent steps in the same tick and finishes the job', async () => {
    const c = ctx();
    let job = createJob('object', { photo: 'x' }, defs());
    for (let i = 0; i < 6 && job.status === 'active'; i++) job = await tickJob(job, defs(), c);
    expect(job.status).toBe('done');
    expect(c.log).toEqual(['a', 'b:start', 'c', 'd:task-b']);
    expect(job.steps.every((s) => s.status === 'done')).toBe(true);
    expect(job.steps.find((s) => s.name === 'b')!.ms).toBeGreaterThanOrEqual(0);
  });

  it('keeps a step queued when Aholo is at its concurrency limit and starts it next tick', async () => {
    const c = ctx();
    c.busyOnce.add('b');
    let job = createJob('object', {}, defs());
    job = await tickJob(job, defs(), c);
    expect(job.steps.find((s) => s.name === 'b')!.status).toBe('queued');
    job = await tickJob(job, defs(), c);
    expect(job.steps.find((s) => s.name === 'b')!.status).toBe('running');
  });

  it('fails only the broken step, blocks its dependents, and retry re-runs just that step', async () => {
    const c = ctx();
    c.failOn = 'b';
    let job = createJob('object', {}, defs());
    for (let i = 0; i < 4; i++) job = await tickJob(job, defs(), c);
    expect(job.status).toBe('failed');
    expect(job.steps.find((s) => s.name === 'b')).toMatchObject({ status: 'failed', error: 'MODEL_BROKEN: bad mesh' });
    expect(job.steps.find((s) => s.name === 'c')!.status).toBe('done');
    expect(job.steps.find((s) => s.name === 'd')!.status).toBe('pending');

    c.failOn = undefined;
    job = retryStep(job, 'b');
    expect(job.status).toBe('active');
    for (let i = 0; i < 4 && job.status === 'active'; i++) job = await tickJob(job, defs(), c);
    expect(job.status).toBe('done');
    expect(c.log.filter((l) => l === 'a')).toHaveLength(1);
  });

  it('records an exception thrown by a step as a failure instead of crashing the tick', async () => {
    const bad: StepDef<Ctx>[] = [{ name: 'x', needs: [], run: async () => { throw new Error('boom'); } }];
    const job = await tickJob(createJob('object', {}, bad), bad, ctx());
    expect(job.steps[0]).toMatchObject({ status: 'failed', error: 'boom' });
    expect(job.status).toBe('failed');
  });

  it('skips disabled steps and treats them as satisfied', async () => {
    const d: StepDef<Ctx>[] = [
      { name: 'opt', needs: [], enabled: () => false, run: async () => ({ state: 'done', output: {} }) },
      { name: 'z', needs: ['opt'], run: async () => ({ state: 'done', output: { z: 1 } }) },
    ];
    const job = await tickJob(createJob('object', {}, d), d, ctx());
    expect(job.steps.map((s) => s.status)).toEqual(['skipped', 'done']);
    expect(job.status).toBe('done');
  });
  it('adds steps that were introduced after a job was created', async () => {
    const c = ctx();
    const job = createJob('object', {}, defs().filter((d) => d.name !== 'c'));
    const next = await tickJob(job, defs(), c);
    expect(next.steps.map((st) => st.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(c.log).toContain('c');
  });
});
