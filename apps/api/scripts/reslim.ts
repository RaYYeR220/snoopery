// Rebuilds the player's copy of a character (optimised model + animation-only motions) and makes it the library one.
//   ASSET_BUCKET=snoopery-assets tsx scripts/reslim.ts <characterId>
import { optimizeGlb } from '../src/pipeline/optimize';
import { slimCharacter, type CharacterDoc } from '../src/pipeline/room';
import { gcsStores } from '../src/store/gcs';
import type { PipelineCtx } from '../src/pipeline/context';

const { docs, blobs } = gcsStores(process.env.ASSET_BUCKET ?? '');
const id = process.argv[2]!;
const doc = await docs.get<CharacterDoc>(`characters/${id}`);
if (!doc) throw new Error(`no character ${id}`);
const lib = await slimCharacter({ blobs, optimize: (b: Uint8Array) => optimizeGlb(b, 30_000) } as unknown as PipelineCtx, doc);
await docs.put('library/character', lib);
for (const url of [lib.modelUrl, ...Object.values(lib.clipUrls)]) console.log(url, (await blobs.getBytes(url)).length);
