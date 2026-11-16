import { describe, expect, it } from 'vitest';
import { AholoBusy, createAholo, parseLux3dOutputs, type AholoCall } from '../src/index';

class FakeBusinessError extends Error {
  cmdCode = 'GENERATION_CONCURRENCY_LIMIT_EXCEEDED';
}

function fakeClients(overrides: Record<string, unknown> = {}) {
  const calls: { op: string; body: unknown }[] = [];
  const res = (op: string, id = 101) => ({
    create: async (body: unknown) => {
      calls.push({ op, body });
      return id;
    },
  });
  const lux3d = {
    imgTo3d: res('imgTo3d'),
    textTo3d: res('textTo3d'),
    partSplit: res('partSplit'),
    articulationAnimation: res('articulation'),
    humanoidAutoRig: res('rig'),
    humanoidAnimationRetarget: res('retarget'),
    multiFormatExport: res('export'),
    tasks: {
      retrieve: async () => ({ taskId: 101, status: 3, outputs: [{ content: 'https://cdn/x.zip' }, { content: 'https://cdn/x.glb' }] }),
    },
    ...overrides,
  };
  const world = {
    reconstructions: { create: async (b: unknown) => (calls.push({ op: 'reconstruct', body: b }), { worldId: 'w1' }) },
    generations: { create: async (b: unknown) => (calls.push({ op: 'generate', body: b }), { worldId: 'w2' }) },
    retrieve: async () => ({ worldId: 'w1', status: 'SUCCEEDED', assets: { splats: { urls: { spzPath: 'https://cdn/s.spz' } } } }),
  };
  const asset = { uploadBuffer: async () => ({ url: 'https://ous/up.jpg', md5: 'x' }) };
  return { calls, clients: { lux3d, world, asset } as any };
}

describe('createAholo', () => {
  it('maps image-to-3D options onto the Lux3D request and returns the task id as a string', async () => {
    const { calls, clients } = fakeClients();
    const a = createAholo({ apiKey: 'k', clients });
    const id = await a.imgTo3d({ img: 'https://x/p.jpg', turbo: false, ply: true, faceCount: 40000, aiPredictSize: true });
    expect(id).toBe('101');
    expect(calls[0]).toEqual({
      op: 'imgTo3d',
      body: { img: 'https://x/p.jpg', version: 'G1', outputFormat: ['zip', 'glb', 'ply'], enablePbr: true, faceCount: 40000, aiPredictSize: true },
    });
  });

  it('turbo preview asks only for the splat', async () => {
    const { calls, clients } = fakeClients();
    await createAholo({ apiKey: 'k', clients }).imgTo3d({ img: 'https://x/p.jpg', turbo: true });
    expect(calls[0]!.body).toMatchObject({ version: 'G1-Turbo', outputFormat: ['ply'] });
  });

  it('turns a concurrency rejection into AholoBusy and records it as rejected', async () => {
    const ledger: AholoCall[] = [];
    const { clients } = fakeClients({
      partSplit: { create: async () => { throw new FakeBusinessError('busy'); } },
    });
    const a = createAholo({ apiKey: 'k', clients, onCall: (c) => ledger.push(c) });
    await expect(a.partSplit('https://x/m.glb')).rejects.toBeInstanceOf(AholoBusy);
    expect(ledger[0]).toMatchObject({ endpoint: 'lux3d.partSplit', status: 'rejected' });
  });

  it('records successful calls with timing', async () => {
    const ledger: AholoCall[] = [];
    const { clients } = fakeClients();
    await createAholo({ apiKey: 'k', clients, onCall: (c) => ledger.push(c) }).articulate('https://x/m.glb', 'lid hinges open');
    expect(ledger[0]).toMatchObject({ endpoint: 'lux3d.articulate', status: 'ok', taskId: '101' });
    expect(ledger[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it('normalises world detail to a splat url', async () => {
    const { clients } = fakeClients();
    const w = await createAholo({ apiKey: 'k', clients }).world('w1');
    expect(w).toMatchObject({ status: 'SUCCEEDED', splatUrl: 'https://cdn/s.spz' });
  });
});

describe('parseLux3dOutputs', () => {
  it('reads G1 zip/glb/ply in order', () => {
    expect(parseLux3dOutputs('imgTo3d', [{ content: 'a.zip' }, { content: 'b.glb' }, { content: 'c.ply' }])).toEqual({ zip: 'a.zip', glb: 'b.glb', ply: 'c.ply' });
  });
  it('reads a turbo ply-only result', () => {
    expect(parseLux3dOutputs('imgTo3d', [{ content: 'c.ply' }])).toEqual({ ply: 'c.ply' });
  });
  it('treats NOT_REQUESTED as absent', () => {
    expect(parseLux3dOutputs('imgTo3d', [{ content: 'a.zip' }, { content: 'NOT_REQUESTED' }])).toEqual({ zip: 'a.zip' });
  });
  it('parses retarget JSON actions', () => {
    const out = parseLux3dOutputs('retarget', [{ content: JSON.stringify({ actions: [{ animation_id: 'Walk_Loop', status: 'success', animationGlbUrl: 'w.glb' }, { animation_id: 'Roll', status: 'failed', error: { code: 'X' } }] }) }]);
    expect(out).toEqual({ actions: { Walk_Loop: 'w.glb' }, failed: ['Roll'] });
  });
  it('surfaces a failure payload', () => {
    expect(parseLux3dOutputs('rig', [{ content: JSON.stringify({ error: { code: 'MODEL_NOT_RIGGABLE', message: 'no' } }) }])).toEqual({ error: 'MODEL_NOT_RIGGABLE: no' });
  });
});
