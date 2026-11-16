// Compares the true-scale size Lux3D predicted for each object with its measured size (e.g. a museum catalogue).
//   tsx scripts/scale-check.ts --api https://… --seed seed-results.json --dims dims.json --out ../../results/scale-check.json
import { readFileSync, writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/core';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${name}`);
  return process.argv[i + 1]!;
};
const api = arg('--api').replace(/\/$/, '');
const seed = JSON.parse(readFileSync(arg('--seed'), 'utf8')) as { source?: string; ref: string; status?: string }[];
const dims = JSON.parse(readFileSync(arg('--dims'), 'utf8')) as Record<string, (number | null)[]>;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const rows: { source: string; objectId: string; measuredCm: (number | null)[]; predictedCm: number[]; errorPct: (number | null)[] }[] = [];
for (const s of seed) {
  const measured = s.source ? dims[s.source] : undefined;
  if (!measured || s.status !== 'done') continue;
  const obj = (await (await fetch(`${api}/objects/${s.ref}`)).json()) as { meshGlb?: string };
  if (!obj.meshGlb) continue;
  const doc = await io.readBinary(new Uint8Array(await (await fetch(obj.meshGlb)).arrayBuffer()));
  const { min, max } = getBounds(doc.getRoot().getDefaultScene()!);
  const h = (max[1] - min[1]) * 100;
  // Width is the longer horizontal extent, depth the shorter: photos don't fix which axis is which.
  const [w, d] = [(max[0] - min[0]) * 100, (max[2] - min[2]) * 100].sort((a, b) => b - a) as [number, number];
  const predicted = [h, w, d].map((v) => Math.round(v * 10) / 10);
  const errorPct = measured.map((m, i) => (m ? Math.round((Math.abs(predicted[i]! - m) / m) * 1000) / 10 : null));
  rows.push({ source: s.source!, objectId: s.ref, measuredCm: measured, predictedCm: predicted, errorPct });
}
const all = rows.flatMap((r) => r.errorPct.filter((e): e is number => e !== null));
const heights = rows.map((r) => r.errorPct[0]).filter((e): e is number => e !== null);
const summary = {
  objects: rows.length,
  medianErrorPct: all.sort((a, b) => a - b)[Math.floor(all.length / 2)] ?? null,
  medianHeightErrorPct: heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] ?? null,
  within15Pct: `${all.filter((e) => e <= 15).length}/${all.length}`,
};
writeFileSync(arg('--out'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary), '\n', rows.map((r) => `${r.source}: measured ${r.measuredCm.join('×')} cm, predicted ${r.predictedCm.join('×')} cm, error ${r.errorPct.join('/')}%`).join('\n'));
