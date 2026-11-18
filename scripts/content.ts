// Snapshot of the published content (objects, rooms, pipeline timings) from the public bucket into results/content.json,
// with each object's size compared to its museum catalogue entry. Anyone can rerun it; it reads public URLs only.
//   tsx scripts/content.ts [--rooms id,id,id]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const BASE = 'https://storage.googleapis.com/snoopery-assets';
const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${BASE}/${path}?v=${Date.now()}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

interface Source { objectId: string; photo: string; source: string; credit: string; license: string; catalogueCm: { h: number; w: number; d: number | null } | null }
interface Step { name: string; status: string; startedAt?: string; finishedAt?: string; ms?: number }
const sources = JSON.parse(readFileSync(join(root, 'results/sources.json'), 'utf8')) as Source[];
const roomsArg = process.argv.indexOf('--rooms');
const roomIds = roomsArg > 0 ? process.argv[roomsArg + 1]!.split(',') : ['uto4YH9awv', '2XB7Xjzh2-', 'yo9TXltcd9'];

const seconds = (steps: Step[], name: string) => {
  const s = steps.find((x) => x.name === name);
  return s?.ms ? Math.round(s.ms / 1000) : null;
};
const err = (got: number, want: number | null | undefined) => (want ? Math.round(((got * 100 - want) / want) * 100) : null);

const objects = [];
for (const s of sources) {
  const doc = await get<any>(`docs/objects/${s.objectId}.json`);
  const job = await get<{ steps: Step[] }>(`docs/jobs/${doc.jobId}.json`);
  const [w, h, d] = doc.card.sizeM as [number, number, number];
  objects.push({
    objectId: s.objectId,
    label: doc.label,
    photo: s.photo,
    credit: s.credit,
    license: s.license,
    sizeM: { w: +w.toFixed(3), h: +h.toFixed(3), d: +d.toFixed(3) },
    catalogueCm: s.catalogueCm,
    sizeErrorPct: s.catalogueCm ? { w: err(w, s.catalogueCm.w), h: err(h, s.catalogueCm.h), d: err(d, s.catalogueCm.d) } : null,
    jointSource: doc.jointSource,
    joints: doc.joints.map((j: any) => ({ part: j.part, type: j.type, open: +j.max.toFixed(3) })),
    notes: doc.jointNotes ?? [],
    seconds: { preview: seconds(job.steps, 'preview'), mesh: seconds(job.steps, 'mesh'), articulate: seconds(job.steps, 'articulate') },
  });
}

const rooms = [];
for (const id of roomIds) {
  const room = await get<any>(`docs/rooms/${id}.json`);
  const spaceId = /\/spaces\/([^/]+)\//.exec(room.splat.url)?.[1];
  const space = spaceId ? await get<any>(`docs/spaces/${spaceId}.json`).catch(() => null) : null;
  rooms.push({ id, title: room.title, space: space ? { id: spaceId, source: space.source, upAxis: space.upAxis ?? null } : null, objects: room.objects.map((o: any) => o.objectId), minSteps: room.verdict.minSteps });
}

writeFileSync(join(root, 'results/content.json'), `${JSON.stringify({ capturedAt: new Date().toISOString(), objects, rooms }, null, 2)}\n`);
console.log(`${objects.length} objects, ${rooms.length} rooms → results/content.json`);
