import { describe, expect, it } from 'vitest';
import type { Aholo } from '@snoopery/aholo';
import { buildServer } from '../src/server';
import { memoryBlobs, memoryDocs } from '../src/store/memory';
import type { PipelineCtx } from '../src/pipeline/context';

async function setup(paused = false) {
  const docs = memoryDocs();
  const blobs = memoryBlobs();
  const ctx: PipelineCtx = {
    aholo: {} as Aholo,
    docs,
    blobs,
    describe: async () => ({ label: 'Box', category: 'box', parts: [{ name: 'lid', joint: 'revolute' }], motionPrompt: 'Keep the base fixed; the lid hinges open.' }),
    optimize: async (b) => b,
    analyze: async () => ({ joints: [], card: { objectId: 'x', label: 'x', sizeM: [1, 1, 1], parts: [] }, source: 'animation' }),
    config: { articulateFrom: 'split', faceCount: 40000, characterClips: [] },
  };
  await docs.put('spaces/s1', { id: 's1', splatUrl: 'https://blobs.test/spaces/s1/scene.spz', format: 'spz' });
  await docs.put('objects/box', {
    id: 'box',
    status: 'ready',
    library: true,
    webGlb: 'https://blobs.test/objects/box/web.glb',
    joints: [{ part: 'lid', node: 'lid', type: 'revolute', axis: [1, 0, 0], pivot: [0, 0.3, -0.2], min: 0, max: 1.7 }],
    card: { objectId: 'box', label: 'Box', sizeM: [0.4, 0.3, 0.3], parts: [{ part: 'lid', joint: 'revolute', capacity: 'small' }] },
  });
  const app = await buildServer({
    ctx,
    llm: { complete: async () => '{}' },
    signUpload: async (key) => ({ uploadUrl: `https://signed/${key}`, publicUrl: blobs.publicUrl(key), headers: {} }),
    tickToken: 't',
    generationPaused: () => paused,
    ledger: [],
  });
  return { app, docs };
}

const draftBody = { title: 'Den', author: 'me', spaceId: 's1', spawn: { pos: [0, 1.6, 0], yaw: 0, pitch: 0 }, objects: [{ objectId: 'box', position: [0, 0, 0], rotationY: 0, scale: 1 }] };

const solvablePuzzle = {
  containers: [{ id: 'box.lid', objectId: 'box', part: 'lid', lock: { kind: 'none' }, inside: null }],
  items: [{ id: 'door_key', kind: 'key', label: 'Door key', inside: 'box.lid' }],
  exit: { lock: { kind: 'key', keyId: 'door_key' } },
};
const circularPuzzle = {
  containers: [{ id: 'box.lid', objectId: 'box', part: 'lid', lock: { kind: 'key', keyId: 'k' }, inside: null }],
  items: [{ id: 'k', kind: 'key', label: 'Key', inside: 'box.lid' }],
  exit: { lock: { kind: 'key', keyId: 'k' } },
};

describe('api', () => {
  it('refuses to sign uploads of arbitrary content types', async () => {
    const { app } = await setup();
    const bad = await app.inject({ method: 'POST', url: '/uploads/sign', payload: { filename: 'x.html', contentType: 'text/html' } });
    expect(bad.statusCode).toBe(415);
    const ok = await app.inject({ method: 'POST', url: '/uploads/sign', payload: { filename: 'dresser.jpg', contentType: 'image/jpeg' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().publicUrl).toMatch(/^https:\/\/blobs\.test\/uploads\/.+\.jpg$/);
  });

  it('only accepts photos that were uploaded through the signed-upload path', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/objects', payload: { photoUrl: 'http://169.254.169.254/latest/meta-data' } });
    expect(res.statusCode).toBe(400);
  });

  it('pauses generation endpoints when credits are unavailable', async () => {
    const { app } = await setup(true);
    const res = await app.inject({ method: 'POST', url: '/objects', payload: { photoUrl: 'https://blobs.test/uploads/a.jpg' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().generation).toBe('paused');
  });

  it('requires the edit token for every draft mutation and never exposes its hash', async () => {
    const { app } = await setup();
    const created = (await app.inject({ method: 'POST', url: '/rooms', payload: draftBody })).json();
    expect(created.editToken).toHaveLength(24);
    expect(created.tokenHash).toBeUndefined();
    const id = created.id;
    expect((await app.inject({ method: 'PUT', url: `/rooms/${id}/puzzle`, payload: solvablePuzzle })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/rooms/${id}/puzzle`, payload: solvablePuzzle, headers: { 'x-edit-token': 'wrong' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/rooms/${id}/publish` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/rooms/${id}` })).json().tokenHash).toBeUndefined();
  });

  it('publishes only a provably solvable room and stores the shortest proof', async () => {
    const { app, docs } = await setup();
    const { id, editToken } = (await app.inject({ method: 'POST', url: '/rooms', payload: draftBody })).json();
    const headers = { 'x-edit-token': editToken };

    await app.inject({ method: 'PUT', url: `/rooms/${id}/puzzle`, payload: circularPuzzle, headers });
    const refused = await app.inject({ method: 'POST', url: `/rooms/${id}/publish`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().issues.map((i: { code: string }) => i.code)).toContain('CIRCULAR');

    await app.inject({ method: 'PUT', url: `/rooms/${id}/puzzle`, payload: solvablePuzzle, headers });
    const published = await app.inject({ method: 'POST', url: `/rooms/${id}/publish`, headers });
    expect(published.statusCode).toBe(200);
    const room = await docs.get<any>(`rooms/${id}`);
    expect(room.verdict).toEqual({ solvable: true, minSteps: 3 });
    expect(room.proof.map((a: { type: string }) => a.type)).toEqual(['open', 'take', 'exit']);
    expect(room.objects[0].glbUrl).toBe('https://blobs.test/objects/box/web.glb');
  });

  it('rejects a leaderboard entry faster than the shortest solution allows', async () => {
    const { app } = await setup();
    const { id, editToken } = (await app.inject({ method: 'POST', url: '/rooms', payload: draftBody })).json();
    const headers = { 'x-edit-token': editToken };
    await app.inject({ method: 'PUT', url: `/rooms/${id}/puzzle`, payload: solvablePuzzle, headers });
    await app.inject({ method: 'POST', url: `/rooms/${id}/publish`, headers });
    expect((await app.inject({ method: 'POST', url: '/plays', payload: { roomId: id, name: 'a', ms: 5000, steps: 2, hints: 0 } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/plays', payload: { roomId: id, name: 'a', ms: 5000, steps: 3, hints: 0 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/rooms/${id}/leaderboard` })).json()).toEqual([{ name: 'a', ms: 5000, steps: 3, hints: 0 }]);
  });
});
