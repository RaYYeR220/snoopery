// Copies published rooms — their documents and every asset they reference — next to a static build, rewriting
// links to relative ones. The result plays with no API and no third-party storage: one folder, any static host.
//
//   tsx scripts/bake.ts --out dist-static/baked --rooms abc123,def456 [--source https://storage.googleapis.com/snoopery-assets]
//   tsx scripts/bake.ts --out dist-static/baked --api https://…   (every published room)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = opt('out');
const source = (opt('source') ?? 'https://storage.googleapis.com/snoopery-assets').replace(/\/$/, '');
const api = opt('api')?.replace(/\/$/, '');
if (!out) throw new Error('pass --out <dir>');

async function json<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const roomIds = opt('rooms')?.split(',').filter(Boolean) ?? (api ? ((await json<{ id: string }[]>(`${api}/rooms`)) ?? []).map((r) => r.id) : []);
if (!roomIds.length) throw new Error('no rooms: pass --rooms a,b or --api <url>');

const assets = new Map<string, string>(); // source URL → path under out/
const foreign = new Set<string>();

// Raw generation outputs that no page renders (the full splat preview, archives, pre-optimisation meshes) stay
// as links to the bucket instead of being copied.
const RAW = /\/(preview\.ply|mesh\.zip|parts\.glb|articulated\.glb|articulation-urdf\.zip|source\.[a-z0-9]+)$/;

/** Rewrites every link into our bucket to "./baked/<path>" and remembers it for download. */
function relink<T>(value: T): T {
  if (typeof value === 'string') {
    if (value.startsWith(`${source}/`) && !RAW.test(value)) {
      const path = decodeURIComponent(new URL(value).pathname.slice(new URL(source).pathname.length + 1));
      assets.set(value, path);
      return `./baked/${path}` as T;
    }
    if (/^https?:\/\//.test(value)) foreign.add(new URL(value).host);
    return value;
  }
  if (Array.isArray(value)) return value.map(relink) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relink(v)])) as T;
  return value;
}

function write(path: string, data: string | Uint8Array) {
  const file = join(out!, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

interface Room {
  id: string;
  title: string;
  author?: string;
  verdict: { minSteps: number };
  objects: { objectId: string }[];
}

const index: { id: string; title: string; author?: string; minSteps: number; objects: number }[] = [];
const objectIds = new Set<string>();
for (const id of roomIds) {
  const room = await json<Room>(`${source}/docs/rooms/${encodeURIComponent(id)}.json`);
  if (!room) throw new Error(`room ${id} is not published`);
  write(`docs/rooms/${id}.json`, JSON.stringify(relink(room)));
  index.push({ id: room.id, title: room.title, author: room.author, minSteps: room.verdict.minSteps, objects: room.objects.length });
  for (const o of room.objects) objectIds.add(o.objectId);
}
write('docs/rooms-index.json', JSON.stringify(index));

// Object documents feed the inspector (photo → preview → mesh → parts → joints), so a judge can open any piece.
for (const id of objectIds) {
  const doc = await json<unknown>(`${source}/docs/objects/${encodeURIComponent(id)}.json`);
  if (doc) write(`docs/objects/${id}.json`, JSON.stringify(relink(doc)));
}

let bytes = 0;
const missing: string[] = [];
const queue = [...assets];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [url, path] = next;
      const res = await fetch(url);
      if (res.status === 404) {
        missing.push(path);
        continue;
      }
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      bytes += buf.length;
      write(path, buf);
    }
  }),
);

console.log(`baked ${roomIds.length} rooms, ${objectIds.size} objects, ${assets.size} files, ${(bytes / 1e6).toFixed(1)} MB → ${out}`);
if (missing.length) console.warn(`missing in the bucket (links will 404): ${missing.join(', ')}`);
if (foreign.size) console.log(`links left on other hosts: ${[...foreign].join(', ')}`);
