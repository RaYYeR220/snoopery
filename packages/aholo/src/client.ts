import { createLux3dClient } from '@manycore/aholo-sdk-lux3d';
import { createWorldClient } from '@manycore/aholo-sdk-world';
import { createAssetClient } from '@manycore/aholo-sdk-asset';

export interface AholoCall {
  endpoint: string;
  taskId?: string;
  ms: number;
  status: 'ok' | 'failed' | 'rejected';
  error?: string;
  at: string;
}

/** Thrown when Aholo refuses a task because the account already has the maximum number in flight. Nothing is charged; queue and retry. */
export class AholoBusy extends Error {
  constructor(endpoint: string) {
    super(`${endpoint}: concurrency limit reached`);
    this.name = 'AholoBusy';
  }
}

const BUSY_PATTERN = /CONCURRENCY|in progress|too many/i;

function isBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { cmdCode?: string; bizCode?: string; status?: string; statusCode?: number };
  return e.statusCode === 429 || [e.cmdCode, e.bizCode, e.status, e.message].some((v) => typeof v === 'string' && BUSY_PATTERN.test(v));
}

export type TaskStatus = 0 | 1 | 3 | 4 | 6;
export interface TaskResult {
  status: TaskStatus;
  outputs: { content: string | null }[];
}
export interface WorldResult {
  status: string;
  progress?: number;
  splatUrl?: string;
  plyUrl?: string;
  panoUrl?: string;
  raw: unknown;
}

export type ExportFormat = 'usdz' | 'stl' | '3mf' | 'obj_zip' | 'fbx_zip';

export interface Aholo {
  imgTo3d(o: { img: string; turbo: boolean; ply?: boolean; faceCount?: number; aiPredictSize?: boolean; customSizeMm?: number }): Promise<string>;
  textTo3d(o: { prompt: string; style?: string; turbo?: boolean; faceCount?: number }): Promise<string>;
  partSplit(glbUrl: string): Promise<string>;
  articulate(glbUrl: string, prompt: string): Promise<string>;
  rig(modelUrl: string): Promise<string>;
  retarget(rigUrl: string, animationIds: string[]): Promise<string>;
  exportFormats(modelUrl: string, formats: ExportFormat[]): Promise<string>;
  task(id: string): Promise<TaskResult>;
  reconstruct(o: { name: string; video?: string; images?: string[]; insv?: string; scene: 'space' | 'model'; quality: 'low' | 'normal' | 'high' }): Promise<string>;
  generateWorld(o: { prompt?: string; image?: string }): Promise<string>;
  world(id: string): Promise<WorldResult>;
  upload(bytes: Uint8Array, filename: string): Promise<string>;
}

interface Clients {
  lux3d: any;
  world: any;
  asset: any;
}

export interface AholoOptions {
  apiKey: string;
  region?: 'com' | 'cn';
  onCall?: (c: AholoCall) => void;
  /** Injected clients (tests). Defaults to the official SDK clients. */
  clients?: Clients;
}

export function createAholo(opts: AholoOptions): Aholo {
  const region = opts.region ?? 'com';
  const clients: Clients = opts.clients ?? {
    lux3d: createLux3dClient({ region, apiKey: opts.apiKey }),
    world: createWorldClient({ region, apiKey: opts.apiKey }),
    asset: createAssetClient({ region, apiKey: opts.apiKey }),
  };
  const record = opts.onCall ?? (() => {});

  async function call<T>(endpoint: string, fn: () => Promise<T>, idOf: (r: T) => string | undefined = () => undefined): Promise<T> {
    const t0 = performance.now();
    const at = new Date().toISOString();
    try {
      const r = await fn();
      record({ endpoint, taskId: idOf(r), ms: Math.round(performance.now() - t0), status: 'ok', at });
      return r;
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      if (isBusy(err)) {
        record({ endpoint, ms, status: 'rejected', error: (err as Error).message, at });
        throw new AholoBusy(endpoint);
      }
      record({ endpoint, ms, status: 'failed', error: err instanceof Error ? err.message : String(err), at });
      throw err;
    }
  }

  const create = (endpoint: string, fn: () => Promise<number | string>) =>
    call(endpoint, async () => String(await fn()), (id) => id);

  return {
    imgTo3d: ({ img, turbo, ply, faceCount, aiPredictSize, customSizeMm }) =>
      create(turbo ? 'lux3d.imgTo3d.turbo' : 'lux3d.imgTo3d', () =>
        clients.lux3d.imgTo3d.create(
          turbo
            ? { img, version: 'G1-Turbo', outputFormat: ['ply'] }
            : {
                img,
                version: 'G1',
                outputFormat: ply ? ['zip', 'glb', 'ply'] : ['zip', 'glb'],
                enablePbr: true,
                ...(faceCount ? { faceCount } : {}),
                ...(aiPredictSize !== undefined ? { aiPredictSize } : {}),
                ...(customSizeMm ? { customSize: customSizeMm } : {}),
              },
        ),
      ),
    textTo3d: ({ prompt, style, turbo, faceCount }) =>
      create('lux3d.textTo3d', () =>
        clients.lux3d.textTo3d.create({
          prompt,
          version: turbo ? 'G1-Turbo' : 'G1',
          outputFormat: ['glb'],
          ...(style ? { style } : {}),
          ...(faceCount ? { faceCount } : {}),
        }),
      ),
    partSplit: (glbUrl) => create('lux3d.partSplit', () => clients.lux3d.partSplit.create({ glbUrl })),
    articulate: (glbUrl, prompt) => create('lux3d.articulate', () => clients.lux3d.articulationAnimation.create({ glbUrl, prompt })),
    rig: (modelUrl) => create('lux3d.rig', () => clients.lux3d.humanoidAutoRig.create({ modelUrl })),
    retarget: (rigModelUrl, animationIds) =>
      create('lux3d.retarget', () =>
        clients.lux3d.humanoidAnimationRetarget.create({ rigModelUrl, animationIds, animationOutputMode: 'separate', outFormat: 'glb' }),
      ),
    exportFormats: (modelUrl, outputFormat) => create('lux3d.export', () => clients.lux3d.multiFormatExport.create({ modelUrl, outputFormat })),
    task: async (id) => {
      const r = await clients.lux3d.tasks.retrieve(id);
      return { status: r.status as TaskStatus, outputs: (r.outputs ?? []) as { content: string | null }[] };
    },
    reconstruct: ({ name, video, images, insv, scene, quality }) => {
      const resources = video
        ? [{ url: video, type: 'video' }]
        : insv
          ? [{ url: insv, type: 'insv' }]
          : (images ?? []).map((url) => ({ url, type: 'image' }));
      return call(
        'world.reconstruct',
        async () => (await clients.world.reconstructions.create({ name, resources, taskQuality: quality, scene })).worldId as string,
        (id) => id,
      );
    },
    generateWorld: ({ prompt, image }) =>
      call(
        'world.generate',
        async () =>
          (await clients.world.generations.create({ ...(prompt ? { prompt } : {}), ...(image ? { resources: [{ url: image, type: 'image' }] } : {}) }))
            .worldId as string,
        (id) => id,
      ),
    world: async (id) => {
      const d = await clients.world.retrieve(id);
      const urls = d?.assets?.splats?.urls ?? {};
      return {
        status: d.status,
        progress: d.progress,
        splatUrl: urls.spzPath ?? urls.plyPath,
        plyUrl: urls.plyPath,
        panoUrl: d?.assets?.imagery?.panoUrl,
        raw: d,
      };
    },
    upload: (bytes, filename) =>
      call('asset.upload', async () => (await clients.asset.uploadBuffer(Buffer.from(bytes), { filename })).url as string),
  };
}
