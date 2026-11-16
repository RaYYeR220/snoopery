// Bulk-creates library content through the public API: furniture from photos, spaces from a video or a prompt,
// and the character that walks solutions. Prints every job's steps with timings when they finish.
//
//   tsx scripts/seed.ts --api https://… --photo dresser.jpg "three drawers" --photo box.jpg \
//                       --space-video room.mp4 "Living room" --space-prompt "A cluttered attic study" \
//                       --character "A small brass clockwork detective in a long coat"
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

interface Job {
  id: string;
  status: 'active' | 'done' | 'failed';
  steps: { name: string; status: string; ms?: number; error?: string }[];
}

const args = process.argv.slice(2);
const api = (args[args.indexOf('--api') + 1] ?? process.env.SNOOPERY_API ?? '').replace(/\/$/, '');
if (!api) throw new Error('pass --api <url> or set SNOOPERY_API');

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

// Operator token (the API's TICK_TOKEN) is needed for shared library assets: --character and --prop.
const operatorToken = process.env.SNOOPERY_OPERATOR_TOKEN ?? '';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(body ? { 'content-type': 'application/json' } : {}), ...(operatorToken ? { 'x-tick-token': operatorToken } : {}) };
  const res = await fetch(`${api}${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${json.error ?? ''}`);
  return json;
}

async function upload(path: string): Promise<string> {
  const contentType = TYPES[extname(path).toLowerCase()];
  if (!contentType) throw new Error(`unsupported file type: ${path}`);
  const signed = await call<{ uploadUrl: string; publicUrl: string; headers: Record<string, string> }>('/uploads/sign', { filename: basename(path), contentType });
  const res = await fetch(signed.uploadUrl, { method: 'PUT', headers: signed.headers, body: readFileSync(path) });
  if (!res.ok) throw new Error(`upload ${path}: HTTP ${res.status} ${await res.text()}`);
  return signed.publicUrl;
}

const queued: { label: string; jobId: string; ref: string }[] = [];

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = args[i + 1];
  const extra = args[i + 2] && !args[i + 2]!.startsWith('--') ? args[i + 2] : undefined;
  if (!flag?.startsWith('--') || flag === '--api') continue;
  if (!value) throw new Error(`${flag} needs a value`);
  if (flag === '--photo') {
    const photoUrl = await upload(value);
    const r = await call<{ objectId: string; jobId: string }>('/objects', { photoUrl, ...(extra ? { hint: extra } : {}) });
    queued.push({ label: `object ${basename(value)}`, jobId: r.jobId, ref: r.objectId });
  } else if (flag === '--space-video') {
    const videoUrl = await upload(value);
    const r = await call<{ spaceId: string; jobId: string }>('/spaces', { title: extra ?? 'Filmed room', videoUrl, quality: 'high' });
    queued.push({ label: `space ${basename(value)}`, jobId: r.jobId, ref: r.spaceId });
  } else if (flag === '--space-prompt') {
    const r = await call<{ spaceId: string; jobId: string }>('/spaces', { title: value.slice(0, 80), prompt: value });
    queued.push({ label: `space "${value.slice(0, 40)}"`, jobId: r.jobId, ref: r.spaceId });
  } else if (flag === '--prop') {
    // --prop key "An antique brass key"
    if (!extra) throw new Error('--prop needs a kind (key|clue|prop) and a prompt');
    const r = await call<{ jobId: string }>('/props', { kind: value, prompt: extra });
    queued.push({ label: `prop ${value}`, jobId: r.jobId, ref: value });
  } else if (flag === '--character') {
    const r = await call<{ characterId: string; jobId: string }>('/characters', { prompt: value });
    queued.push({ label: 'character', jobId: r.jobId, ref: r.characterId });
  }
  if (extra) i++;
  i++;
}

console.log(`submitted ${queued.length} jobs`);
const pending = new Set(queued.map((q) => q.jobId));
while (pending.size) {
  await new Promise((r) => setTimeout(r, 20_000));
  for (const q of queued) {
    if (!pending.has(q.jobId)) continue;
    const job = await call<Job>(`/jobs/${q.jobId}`);
    if (job.status === 'active') continue;
    pending.delete(q.jobId);
    const steps = job.steps.map((s) => `${s.name}:${s.status}${s.ms ? `(${Math.round(s.ms / 1000)}s)` : ''}${s.error ? ` [${s.error}]` : ''}`).join(' ');
    console.log(`${job.status.toUpperCase()} ${q.label} → ${q.ref}\n  ${steps}`);
  }
  if (pending.size) console.log(`… ${pending.size} still running`);
}
