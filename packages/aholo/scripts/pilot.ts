// Runs one furniture photo through every Lux3D step we depend on and records latency, output kinds and file structure.
// Usage: tsx scripts/pilot.ts <photo path|url> "<motion prompt>"
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createAholo, parseLux3dOutputs, type AholoCall, type Lux3dKind } from '../src/index';

const [input, motion = 'Keep the body fixed. The top drawer slides straight out about 30 cm and back.'] = process.argv.slice(2);
const apiKey = process.env.AHOLO_API_KEY;
if (!input || !apiKey) {
  console.error('usage: AHOLO_API_KEY=... pilot.ts <photo> "<motion prompt>"');
  process.exit(1);
}

const outDir = join('pilot', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });
const ledger: AholoCall[] = [];
const aholo = createAholo({ apiKey, onCall: (c) => ledger.push(c) });
const report: Record<string, unknown> = { input, motion, steps: {} as Record<string, unknown> };
const steps = report.steps as Record<string, unknown>;
const save = () => writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, ledger }, null, 2));

async function wait(kind: Lux3dKind, label: string, taskId: string, timeoutMs = 20 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await aholo.task(taskId);
    if (r.status === 3 || r.status === 4 || r.status === 6) {
      const parsed = parseLux3dOutputs(kind, r.outputs);
      steps[label] = { taskId, status: r.status, seconds: Math.round((Date.now() - t0) / 1000), raw: r.outputs, parsed };
      save();
      console.log(`[${label}] status ${r.status} in ${Math.round((Date.now() - t0) / 1000)} s`, parsed);
      return parsed;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise((res) => setTimeout(res, 8000));
  }
}

async function download(label: string, url: string | undefined) {
  if (!url) return undefined;
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  const file = join(outDir, `${label}-${basename(new URL(url).pathname)}`);
  writeFileSync(file, buf);
  (steps[label] as Record<string, unknown>).file = { path: file, bytes: buf.length };
  save();
  return file;
}

async function main() {
  const img = /^https?:/.test(input!) ? input! : await aholo.upload(readFileSync(input!), basename(input!));
  report.img = img;

  const [turboId, g1Id, keyId] = await Promise.all([
    aholo.imgTo3d({ img, turbo: true }),
    aholo.imgTo3d({ img, turbo: false, ply: true, faceCount: 40000, aiPredictSize: true }),
    aholo.textTo3d({ prompt: 'A small antique brass key with an ornate bow', turbo: true }),
  ]);

  const [turbo, g1, key] = await Promise.all([
    wait('imgTo3d', 'turbo', turboId),
    wait('imgTo3d', 'g1', g1Id),
    wait('textTo3d', 'key', keyId),
  ]);
  await Promise.all([download('turbo', turbo.ply), download('g1', g1.glb), download('g1-zip', g1.zip), download('key', key.glb ?? key.url)]);
  if (!g1.glb) throw new Error('G1 produced no GLB');

  // Articulation on the fused mesh and part split run in parallel; then articulation on the split result.
  const [artFusedId, splitId] = await Promise.all([aholo.articulate(g1.glb, motion), aholo.partSplit(g1.glb)]);
  const [artFused, split] = await Promise.all([wait('articulate', 'articulate-fused', artFusedId), wait('partSplit', 'split', splitId)]);
  await Promise.all([download('articulate-fused', artFused.glb ?? artFused.zip ?? artFused.url), download('split', split.glb ?? split.url)]);

  const splitGlb = split.glb ?? split.url;
  if (splitGlb) {
    const artSplitId = await aholo.articulate(splitGlb, motion);
    const artSplit = await wait('articulate', 'articulate-split', artSplitId);
    await download('articulate-split', artSplit.glb ?? artSplit.zip ?? artSplit.url);
  }
  save();
  console.log('report:', join(outDir, 'report.json'));
}

main().catch((e) => {
  report.error = String(e?.stack ?? e);
  save();
  console.error(e);
  process.exit(1);
});
