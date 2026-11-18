// Adds the web copy of each object's G1-Turbo preview (thinned SPZ) for objects built before the pipeline made one.
//   ASSET_BUCKET=snoopery-assets tsx scripts/web-previews.ts <objectId> [...]
import type { ObjectDoc } from '../src/pipeline/object';
import { webPreview } from '../src/pipeline/preview';
import { gcsStores } from '../src/store/gcs';

const { docs, blobs } = gcsStores(process.env.ASSET_BUCKET ?? '');
for (const id of process.argv.slice(2)) {
  const doc = await docs.get<ObjectDoc>(`objects/${id}`);
  if (!doc?.previewPly) continue;
  const spz = await webPreview(await blobs.getBytes(doc.previewPly));
  const previewSplat = await blobs.putBytes(`objects/${id}/preview-web.spz`, spz, 'application/octet-stream');
  await docs.put(`objects/${id}`, { ...doc, previewSplat });
  console.log(id, doc.label, (spz.length / 1e6).toFixed(1), 'MB');
}
