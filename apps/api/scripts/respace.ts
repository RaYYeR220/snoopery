// Runs the upright + collision stages again for spaces published before those stages existed.
//   ASSET_BUCKET=snoopery-assets tsx scripts/respace.ts <spaceId> [...]
import type { SpaceDoc } from '../src/pipeline/room';
import { decodeSpz, detectUp, encodeSpz, footprintCentre, uprightSplat } from '../src/pipeline/upright';
import { voxelize } from '../src/pipeline/voxel';
import { gcsStores } from '../src/store/gcs';

const bucket = process.env.ASSET_BUCKET;
if (!bucket) throw new Error('set ASSET_BUCKET');
const { docs, blobs } = gcsStores(bucket);

for (const id of process.argv.slice(2)) {
  const doc = await docs.get<SpaceDoc>(`spaces/${id}`);
  if (!doc || doc.format !== 'spz') {
    console.log(`${id}: not an SPZ space, skipped`);
    continue;
  }
  const source = blobs.publicUrl(`spaces/${id}/scene.spz`);
  const s = decodeSpz(await blobs.getBytes(source));
  const d = detectUp(s);
  let splatUrl = source;
  let spawn: SpaceDoc['spawn'];
  if (d.up === '+y') {
    const [x, z] = footprintCentre(s);
    spawn = { pos: [x, d.floor + 1.55, z], yaw: 0, pitch: 0 };
  } else {
    const r = uprightSplat(s, d);
    const bytes = encodeSpz(s);
    splatUrl = await blobs.putBytes(`spaces/${id}/scene-upright.spz`, bytes, 'application/octet-stream');
    spawn = { pos: [r.centre[0], 1.55, r.centre[1]], yaw: 0, pitch: 0 };
  }
  const { meta, bin } = await voxelize(await blobs.getBytes(splatUrl), 'spz');
  const collision = {
    metaUrl: await blobs.putBytes(`spaces/${id}/voxel-upright/voxel-meta.json`, meta, 'application/json'),
    binUrl: await blobs.putBytes(`spaces/${id}/voxel-upright/voxel.bin`, bin, 'application/octet-stream'),
  };
  await docs.put(`spaces/${id}`, { ...doc, splatUrl, collision, spawn, upAxis: d.up });
  console.log(`${id} ${doc.title.slice(0, 40)}: up ${d.up}, height ${d.heightM.toFixed(2)} m, spawn ${spawn.pos.map((v) => v.toFixed(2)).join(', ')}`);
}
