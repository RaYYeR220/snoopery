// Re-derives joints for published objects from the URDF package each one keeps, after a change to the joint rules.
// Geometry is untouched; only `joints`, `card` and `jointNotes` are rewritten.
//   ASSET_BUCKET=snoopery-assets tsx scripts/rejoint.ts <objectId> [...]
import type { ObjectDoc } from '../src/pipeline/object';
import { analyzeGlb } from '../src/pipeline/analyze';
import { assembleUrdfPackage } from '../src/pipeline/urdf';
import { gcsStores } from '../src/store/gcs';

const bucket = process.env.ASSET_BUCKET;
if (!bucket) throw new Error('set ASSET_BUCKET');
const { docs, blobs } = gcsStores(bucket);

for (const id of process.argv.slice(2)) {
  const doc = await docs.get<ObjectDoc>(`objects/${id}`);
  if (!doc?.urdfPackage || !doc.webGlb) {
    console.log(`${id}: no URDF package, skipped`);
    continue;
  }
  const a = await assembleUrdfPackage(await blobs.getBytes(doc.urdfPackage));
  const r = await analyzeGlb(await blobs.getBytes(doc.webGlb), id, doc.label, [], a.joints);
  const next: ObjectDoc = { ...doc, joints: r.joints, card: r.card, jointSource: r.source };
  if (a.notes.length) next.jointNotes = a.notes;
  else delete next.jointNotes;
  await docs.put(`objects/${id}`, next);
  console.log(`${id} ${doc.label}: ${r.joints.map((j) => `${j.part} ${j.type} ${j.min.toFixed(2)}→${j.max.toFixed(2)}`).join(', ')}`);
}
