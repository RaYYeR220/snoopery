import { basename } from 'node:path';
import { parseLux3dOutputs } from '@snoopery/aholo';
import type { Aholo, AholoCall, Lux3dKind, Lux3dOutputs } from '@snoopery/aholo';
import { extractJoints } from '@snoopery/joints';
import { readModel } from '@snoopery/joints/load';
import type { Joint } from '@snoopery/schema';
import { loadBytes } from './sources.ts';
import type { Fetch } from './sources.ts';

export const DEFAULT_MOTION =
  'Keep the body fixed. Every door, drawer and lid opens fully along its natural hinge or runner and closes again.';

export interface OpenableOptions {
  aholo: Aholo;
  calls: AholoCall[];
  fetch: Fetch;
  pollMs: number;
  taskTimeoutMs: number;
  signal?: AbortSignal;
  progress?: (step: number, total: number, message: string) => Promise<void>;
}

export interface OpenableResult {
  photo: string;
  motion: string;
  model: { taskId: string; glb: string; zip?: string };
  articulated: { taskId: string; url: string };
  joints: Joint[];
  warnings: string[];
  calls: AholoCall[];
  note: string;
}

const STEPS = 4;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Polls a Lux3D task to its end; anything but success is an error carrying Aholo's message. */
async function waitFor(kind: Lux3dKind, label: string, taskId: string, o: OpenableOptions): Promise<Lux3dOutputs> {
  const started = Date.now();
  for (;;) {
    const task = await o.aholo.task(taskId);
    if (task.status !== 0 && task.status !== 1) {
      const outputs = parseLux3dOutputs(kind, task.outputs);
      if (task.status !== 3) throw new Error(`${label} task ${taskId} failed: ${outputs.error ?? `status ${task.status}`}`);
      if (outputs.error) throw new Error(`${label} task ${taskId} failed: ${outputs.error}`);
      return outputs;
    }
    if (Date.now() - started > o.taskTimeoutMs) throw new Error(`${label} task ${taskId} did not finish within ${Math.round(o.taskTimeoutMs / 1000)} s`);
    await sleep(o.pollMs, o.signal);
  }
}

/**
 * Photo → Lux3D image-to-3D (G1, real-world size predicted) → articulation driven by the motion
 * prompt → joints recovered from the articulated model's animation.
 */
export async function makeOpenable(photo: string, motion: string | undefined, o: OpenableOptions): Promise<OpenableResult> {
  const prompt = motion?.trim() || DEFAULT_MOTION;
  const progress = o.progress ?? (async () => {});

  let img = photo;
  if (!/^https?:\/\//i.test(photo)) {
    await progress(0, STEPS, 'uploading the photo');
    img = await o.aholo.upload(await loadBytes(photo, o.fetch), basename(photo.replace(/^file:\/*/i, '')));
  }

  await progress(1, STEPS, 'image to 3D (G1)');
  const meshTask = await o.aholo.imgTo3d({ img, turbo: false, aiPredictSize: true });
  const mesh = await waitFor('imgTo3d', 'image-to-3D', meshTask, o);
  if (!mesh.glb) throw new Error(`image-to-3D task ${meshTask} returned no GLB`);

  await progress(2, STEPS, 'articulation');
  const artTask = await o.aholo.articulate(mesh.glb, prompt);
  const art = await waitFor('articulate', 'articulation', artTask, o);
  const url = art.glb ?? art.zip ?? art.url;
  if (!url) throw new Error(`articulation task ${artTask} returned no model`);

  await progress(3, STEPS, 'recovering joints');
  const model = await readModel(await loadBytes(url, o.fetch), basename(new URL(url).pathname) || 'articulated.glb');
  const joints = extractJoints(model.doc);
  const warnings = [...model.warnings];
  if (joints.length === 0) warnings.push('The articulated model has no moving part: no joint could be recovered from its animation.');
  await progress(4, STEPS, `${joints.length} joint(s) recovered`);

  return {
    photo: img,
    motion: prompt,
    model: { taskId: meshTask, glb: mesh.glb, ...(mesh.zip ? { zip: mesh.zip } : {}) },
    articulated: { taskId: artTask, url },
    joints,
    warnings,
    calls: o.calls,
    note: 'Aholo result URLs expire about 2 hours after generation; download or mirror them to keep them.',
  };
}
