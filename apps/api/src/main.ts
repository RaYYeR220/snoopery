import { Storage } from '@google-cloud/storage';
import { createAholo, type AholoCall } from '@snoopery/aholo';
import { veniceLLM } from '@snoopery/puzzle';
import { buildServer } from './server';
import { gcsStores } from './store/gcs';
import { analyzeGlb } from './pipeline/analyze';
import { describeObject, veniceVision } from './pipeline/describe';
import { optimizeGlb } from './pipeline/optimize';
import { tickAll } from './pipeline/loop';
import type { PipelineCtx } from './pipeline/context';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};

const bucket = env('ASSET_BUCKET');
const { docs, blobs } = gcsStores(bucket);
const ledger: AholoCall[] = (await docs.get<AholoCall[]>('ledger/aholo')) ?? [];
let flush: NodeJS.Timeout | undefined;
const record = (c: AholoCall) => {
  ledger.push(c);
  clearTimeout(flush);
  flush = setTimeout(() => void docs.put('ledger/aholo', ledger.slice(-5000)), 2000);
};

const venice = env('VENICE_API_KEY');
const vision = veniceVision(venice, env('VISION_MODEL', 'qwen3-vl-235b-a22b'));

const ctx: PipelineCtx = {
  aholo: createAholo({ apiKey: env('AHOLO_API_KEY'), onCall: record }),
  docs,
  blobs,
  describe: (photoUrl) => describeObject(vision, photoUrl),
  optimize: (glb) => optimizeGlb(glb),
  analyze: analyzeGlb,
  config: {
    articulateFrom: env('ARTICULATE_FROM', 'split') as 'split' | 'mesh',
    faceCount: Number(env('FACE_COUNT', '40000')),
    characterClips: ['Idle_Loop', 'Walk_Loop', 'Crouch_Fwd_Loop', 'Chest_Open', 'PickUp_Table', 'Dance_Loop'],
  },
};

const storage = new Storage();
const app = await buildServer({
  ctx,
  llm: veniceLLM(env('PUZZLE_MODEL', 'qwen-3-8-flash'), venice),
  tickToken: env('TICK_TOKEN'),
  generationPaused: () => process.env.GENERATION_PAUSED === '1',
  ledger,
  signUpload: async (key, contentType, maxBytes) => {
    const headers = { 'x-goog-content-length-range': `0,${maxBytes}` };
    const [uploadUrl] = await storage
      .bucket(bucket)
      .file(key)
      .getSignedUrl({ version: 'v4', action: 'write', contentType, expires: Date.now() + 30 * 60_000, extensionHeaders: headers });
    return { uploadUrl, publicUrl: blobs.publicUrl(key), headers: { ...headers, 'content-type': contentType } };
  },
});

// Local/dev fallback for the scheduler: advance jobs every 15 s when nothing external is ticking.
if (process.env.SELF_TICK === '1') setInterval(() => void tickAll(ctx).catch((e) => console.error('tick', e)), 15_000);

await app.listen({ host: '0.0.0.0', port: Number(env('PORT', '8080')) });
console.log(`api listening on ${env('PORT', '8080')}`);
