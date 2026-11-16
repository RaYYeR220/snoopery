import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { parsePuzzle, type AffordanceCard, type PlacedObject, type Puzzle, type RoomDoc } from '@snoopery/schema';
import { designRoom, verify, type DesignResult, type LLM } from '@snoopery/puzzle';
import type { AholoCall } from '@snoopery/aholo';
import type { PipelineCtx } from './pipeline/context';
import type { Job } from './pipeline/engine';
import { retry, submit, tickAll } from './pipeline/loop';
import type { ObjectDoc } from './pipeline/object';

export interface ServerDeps {
  ctx: PipelineCtx;
  llm: LLM;
  /** Signs a direct browser upload into the asset bucket. */
  signUpload(key: string, contentType: string): Promise<{ uploadUrl: string; publicUrl: string }>;
  tickToken: string;
  generationPaused(): boolean;
  ledger: AholoCall[];
}

const MIN_STEPS = { 1: 4, 2: 7, 3: 10 } as const;

const draftSchema = z.object({
  title: z.string().min(1).max(80),
  author: z.string().max(40).default(''),
  spaceId: z.string().min(1),
  spawn: z.object({ pos: z.tuple([z.number(), z.number(), z.number()]), yaw: z.number(), pitch: z.number() }),
  objects: z.array(
    z.object({
      objectId: z.string(),
      position: z.tuple([z.number(), z.number(), z.number()]),
      rotationY: z.number(),
      scale: z.number().positive(),
      cutout: z.object({ center: z.tuple([z.number(), z.number(), z.number()]), size: z.tuple([z.number(), z.number(), z.number()]) }).optional(),
    }),
  ),
  splatTransform: z.array(z.number()).length(16).optional(),
});
type Draft = z.infer<typeof draftSchema> & { id: string; puzzle?: Puzzle; design?: Omit<DesignResult, 'puzzle'>; intro?: string; updatedAt: string };

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { ctx } = deps;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  const notFound = (what: string) => ({ error: `${what} not found` });

  app.get('/health', async () => ({ ok: true }));
  app.get('/status', async () => ({ generation: deps.generationPaused() ? 'paused' : 'live' }));

  app.post('/uploads/sign', async (req, reply) => {
    const body = z.object({ filename: z.string().min(1).max(120), contentType: z.string().min(3) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const ext = body.data.filename.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '');
    return deps.signUpload(`uploads/${nanoid(10)}.${ext}`, body.data.contentType);
  });

  const generationGuard = (reply: any) => {
    if (!deps.generationPaused()) return false;
    reply.code(503).send({ error: 'generation paused', generation: 'paused' });
    return true;
  };

  app.post('/objects', async (req, reply) => {
    const body = z.object({ photoUrl: z.string().url(), hint: z.string().max(200).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (generationGuard(reply)) return;
    const objectId = nanoid(10);
    const job = await submit(ctx, 'object', { objectId, photoUrl: body.data.photoUrl, hint: body.data.hint });
    void tickAll(ctx);
    return { objectId, jobId: job.id };
  });

  app.get('/objects/:id', async (req, reply) => {
    const doc = await ctx.docs.get<ObjectDoc>(`objects/${(req.params as { id: string }).id}`);
    return doc ?? reply.code(404).send(notFound('object'));
  });

  app.post('/spaces', async (req, reply) => {
    const body = z
      .object({ title: z.string().min(1).max(80), videoUrl: z.string().url().optional(), prompt: z.string().max(400).optional(), imageUrl: z.string().url().optional(), quality: z.enum(['low', 'normal', 'high']).optional() })
      .refine((b) => b.videoUrl || b.prompt || b.imageUrl, 'videoUrl, prompt or imageUrl required')
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (generationGuard(reply)) return;
    const spaceId = nanoid(10);
    const job = await submit(ctx, 'room', { spaceId, ...body.data });
    void tickAll(ctx);
    return { spaceId, jobId: job.id };
  });

  app.post('/characters', async (req, reply) => {
    const body = z.object({ prompt: z.string().min(3).max(300), style: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (generationGuard(reply)) return;
    const characterId = nanoid(10);
    const job = await submit(ctx, 'character', { characterId, ...body.data });
    void tickAll(ctx);
    return { characterId, jobId: job.id };
  });

  app.get('/library', async () => {
    const [objects, spaces, characters] = await Promise.all(['objects/', 'spaces/', 'characters/'].map((p) => ctx.docs.list(p)));
    const load = async <T>(keys: string[]) => (await Promise.all(keys.map((k) => ctx.docs.get<T>(k)))).filter(Boolean) as T[];
    return {
      objects: (await load<ObjectDoc>(objects!)).filter((o) => o.status === 'ready' && o.library),
      spaces: await load(spaces!),
      characters: await load(characters!),
    };
  });

  app.get('/jobs/:id', async (req, reply) => {
    const job = await ctx.docs.get<Job>(`jobs/${(req.params as { id: string }).id}`);
    return job ?? reply.code(404).send(notFound('job'));
  });

  app.post('/jobs/:id/retry', async (req, reply) => {
    const step = z.object({ step: z.string() }).safeParse(req.body);
    if (!step.success) return reply.code(400).send({ error: step.error.message });
    const job = await retry(ctx, (req.params as { id: string }).id, step.data.step);
    if (!job) return reply.code(404).send(notFound('job'));
    void tickAll(ctx);
    return job;
  });

  app.post('/tick', async (req, reply) => {
    if (req.headers['x-tick-token'] !== deps.tickToken) return reply.code(401).send({ error: 'bad token' });
    return tickAll(ctx);
  });

  // Rooms: drafts are editable; publishing re-verifies and writes the immutable public document.
  app.post('/rooms', async (req, reply) => {
    const body = draftSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const draft: Draft = { ...body.data, id: nanoid(10), updatedAt: new Date().toISOString() };
    await ctx.docs.put(`drafts/${draft.id}`, draft);
    return draft;
  });

  app.put('/rooms/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const prev = await ctx.docs.get<Draft>(`drafts/${id}`);
    if (!prev) return reply.code(404).send(notFound('room'));
    const body = draftSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const draft: Draft = { ...prev, ...body.data, updatedAt: new Date().toISOString() };
    await ctx.docs.put(`drafts/${id}`, draft);
    return draft;
  });

  async function cardsFor(draft: Draft): Promise<{ cards: AffordanceCard[]; objects: Map<string, ObjectDoc> }> {
    const objects = new Map<string, ObjectDoc>();
    for (const o of draft.objects) {
      const doc = await ctx.docs.get<ObjectDoc>(`objects/${o.objectId}`);
      if (doc?.status === 'ready') objects.set(o.objectId, doc);
    }
    const cards = [...objects.values()].map((o) => o.card as AffordanceCard).filter((c) => c && c.parts.length > 0);
    return { cards, objects };
  }

  app.post('/rooms/:id/design', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ theme: z.string().min(2).max(200), difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const draft = await ctx.docs.get<Draft>(`drafts/${id}`);
    if (!draft) return reply.code(404).send(notFound('room'));
    const { cards } = await cardsFor(draft);
    if (cards.length === 0) return reply.code(422).send({ error: 'place at least one object with an openable part' });
    const result = await designRoom({ cards, theme: body.data.theme, difficulty: body.data.difficulty }, deps.llm);
    const { puzzle, ...design } = result;
    const next: Draft = { ...draft, puzzle: result.ok ? puzzle : draft.puzzle, design, updatedAt: new Date().toISOString() };
    await ctx.docs.put(`drafts/${id}`, next);
    return result;
  });

  app.put('/rooms/:id/puzzle', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const draft = await ctx.docs.get<Draft>(`drafts/${id}`);
    if (!draft) return reply.code(404).send(notFound('room'));
    let puzzle: Puzzle;
    try {
      puzzle = parsePuzzle(req.body);
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
    await ctx.docs.put(`drafts/${id}`, { ...draft, puzzle, updatedAt: new Date().toISOString() });
    return verify(puzzle, { minSteps: 1 });
  });

  app.post('/rooms/:id/publish', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const draft = await ctx.docs.get<Draft>(`drafts/${id}`);
    if (!draft) return reply.code(404).send(notFound('room'));
    if (!draft.puzzle) return reply.code(409).send({ error: 'room has no puzzle yet' });
    const verdict = verify(draft.puzzle, { minSteps: 1 });
    if (!verdict.solvable) return reply.code(409).send({ error: 'room is not solvable', issues: verdict.issues });
    const space = await ctx.docs.get<{ splatUrl: string; format: 'spz' | 'ply' | 'sog'; collision?: { metaUrl: string; binUrl: string } }>(`spaces/${draft.spaceId}`);
    if (!space) return reply.code(422).send({ error: 'space not ready' });
    const { objects } = await cardsFor(draft);
    const placed: PlacedObject[] = draft.objects
      .filter((o) => objects.has(o.objectId))
      .map((o) => ({ ...o, glbUrl: objects.get(o.objectId)!.webGlb!, joints: (objects.get(o.objectId)!.joints ?? []) as PlacedObject['joints'] }));
    const room: RoomDoc = {
      id,
      title: draft.title,
      author: draft.author,
      splat: { url: space.splatUrl, format: space.format, transform: draft.splatTransform ?? IDENTITY, ...(space.collision ? { collision: space.collision } : {}) },
      spawn: draft.spawn,
      objects: placed,
      puzzle: draft.puzzle,
      proof: verdict.proof,
      verdict: { solvable: true, minSteps: verdict.minSteps },
    };
    await ctx.docs.put(`rooms/${id}`, room);
    return { room, url: ctx.docs.publicUrl(`rooms/${id}`) };
  });

  app.get('/rooms/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    return (await ctx.docs.get<RoomDoc>(`rooms/${id}`)) ?? (await ctx.docs.get<Draft>(`drafts/${id}`)) ?? reply.code(404).send(notFound('room'));
  });

  app.get('/rooms', async () => {
    const keys = await ctx.docs.list('rooms/');
    const rooms = (await Promise.all(keys.map((k) => ctx.docs.get<RoomDoc>(k)))).filter(Boolean) as RoomDoc[];
    return rooms.map((r) => ({ id: r.id, title: r.title, author: r.author, minSteps: r.verdict.minSteps, objects: r.objects.length }));
  });

  const playSchema = z.object({ roomId: z.string(), name: z.string().min(1).max(24), ms: z.number().int().positive().max(24 * 3600 * 1000), steps: z.number().int().positive().max(10_000), hints: z.number().int().min(0).max(1000) });
  app.post('/plays', async (req, reply) => {
    const body = playSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const room = await ctx.docs.get<RoomDoc>(`rooms/${body.data.roomId}`);
    if (!room) return reply.code(404).send(notFound('room'));
    if (body.data.steps < room.verdict.minSteps) return reply.code(422).send({ error: 'fewer steps than the shortest solution' });
    const plays = (await ctx.docs.get<unknown[]>(`plays/${room.id}`)) ?? [];
    plays.push({ ...body.data, at: new Date().toISOString() });
    await ctx.docs.put(`plays/${room.id}`, plays.slice(-500));
    return { ok: true };
  });

  app.get('/rooms/:id/leaderboard', async (req) => {
    const plays = ((await ctx.docs.get<z.infer<typeof playSchema>[]>(`plays/${(req.params as { id: string }).id}`)) ?? []).slice();
    plays.sort((a, b) => a.hints - b.hints || a.ms - b.ms);
    return plays.slice(0, 20).map(({ name, ms, steps, hints }) => ({ name, ms, steps, hints }));
  });

  app.get('/evidence', async () => {
    const by = new Map<string, { calls: number; ok: number; failed: number; rejected: number; ms: number[] }>();
    for (const c of deps.ledger) {
      const e = by.get(c.endpoint) ?? { calls: 0, ok: 0, failed: 0, rejected: 0, ms: [] };
      e.calls++;
      e[c.status]++;
      e.ms.push(c.ms);
      by.set(c.endpoint, e);
    }
    return [...by].map(([endpoint, e]) => ({ endpoint, calls: e.calls, ok: e.ok, failed: e.failed, rejected: e.rejected, p50ms: e.ms.sort((a, b) => a - b)[Math.floor(e.ms.length / 2)] ?? 0 }));
  });

  return app;
}
