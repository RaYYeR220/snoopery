import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Aholo, TaskResult } from '@snoopery/aholo';
import type { Puzzle } from '@snoopery/schema';
import { createServer } from '../src/index.ts';
import type { ServerOptions } from '../src/index.ts';

const DEV = fileURLToPath(new URL('../../../apps/web/public/dev/', import.meta.url));
const DEMO = join(DEV, 'demo.json');

/** Serves any URL from the dev fixtures by file name; no network. */
const devFetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new Response(readFileSync(join(DEV, basename(new URL(url).pathname))));
  } catch {
    return new Response('not found', { status: 404 });
  }
}) as typeof fetch;

const clients: Client[] = [];

async function connect(options: ServerOptions = {}): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ env: {}, fetch: devFetch, ...options });
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;
const text = (r: CallToolResult): string => (r.content[0] as { type: 'text'; text: string }).text;

const circular: Puzzle = {
  containers: [{ id: 'nightstand.top_drawer', objectId: 'nightstand', part: 'top_drawer', lock: { kind: 'key', keyId: 'brass_key' }, inside: null }],
  items: [{ id: 'brass_key', kind: 'key', label: 'Brass key', inside: 'nightstand.top_drawer' }],
  exit: { lock: { kind: 'key', keyId: 'brass_key' } },
};

describe('snoopery MCP server', () => {
  it('lists its four tools with input schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['export_robot_task', 'make_openable', 'solve_room', 'verify_room']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.verify_room!.inputSchema.required).toEqual(['puzzle']);
    expect(byName.export_robot_task!.inputSchema.required).toEqual(['room_url_or_json', 'format', 'out_path']);
    expect(byName.make_openable!.inputSchema.required).toEqual(['photo_url']);
    expect(Object.keys(byName.make_openable!.inputSchema.properties ?? {})).toContain('motion');
  });

  it('verify_room reports a key locked inside the drawer it opens as CIRCULAR', async () => {
    const client = await connect();
    const result = await call(client, 'verify_room', { puzzle: circular });
    expect(result.isError).toBeFalsy();
    const verdict = JSON.parse(text(result));
    expect(verdict.solvable).toBe(false);
    expect(verdict.issues.map((i: { code: string }) => i.code)).toContain('CIRCULAR');
  });

  it('verify_room explains malformed input instead of throwing', async () => {
    const client = await connect();
    const result = await call(client, 'verify_room', { puzzle: { containers: 'drawer' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Invalid input: .*containers/);
  });

  it('solve_room returns the shortest solution of a room file', async () => {
    const client = await connect();
    const result = JSON.parse(text(await call(client, 'solve_room', { room_url_or_json: DEMO })));
    expect(result.solvable).toBe(true);
    expect(result.steps).toEqual(['open nightstand.top_drawer', 'take note', 'open jewelry_box.lid', 'take door_key', 'exit']);
  });

  it('export_robot_task writes the MuJoCo bundle into a directory and lists its files', async () => {
    const client = await connect();
    const dir = mkdtempSync(join(tmpdir(), 'snoopery-mcp-'));
    const room = readFileSync(DEMO, 'utf8').replaceAll('http://localhost:5180/dev/', 'https://assets.example.com/dev/');
    const result = await call(client, 'export_robot_task', { room_url_or_json: room, format: 'mjcf', out_path: dir });
    expect(result.isError).toBeFalsy();
    const out = JSON.parse(text(result));
    expect(out.path).toBe(join(dir, 'dev_demo-mjcf.zip'));
    expect(readFileSync(out.path).length).toBe(out.bytes);
    expect(out.files.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining(['scene.xml', 'task.json', 'README.txt', 'meshes/nightstand__top_drawer.obj', 'meshes/jewelry_box__lid.obj']),
    );
  });

  it('export_robot_task refuses room content that points at local files', async () => {
    const client = await connect();
    const dir = mkdtempSync(join(tmpdir(), 'snoopery-mcp-'));
    const room = readFileSync(DEMO, 'utf8').replaceAll('http://localhost:5180/dev/', 'file:///etc/');
    const result = await call(client, 'export_robot_task', { room_url_or_json: room, format: 'mjcf', out_path: dir });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/https/);
  });

  it('make_openable refuses clearly without an Aholo key', async () => {
    const client = await connect({ env: {} });
    const result = await call(client, 'make_openable', { photo_url: 'https://example.com/nightstand.jpg' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('AHOLO_API_KEY is not set');
  });

  it('make_openable runs image-to-3D then articulation and recovers the joints', async () => {
    const seen: string[] = [];
    const polls = new Map<string, number>();
    const fake: Partial<Aholo> = {
      imgTo3d: async (o) => (seen.push(`imgTo3d ${o.img} turbo=${o.turbo} size=${o.aiPredictSize}`), 'mesh-1'),
      articulate: async (glb, prompt) => (seen.push(`articulate ${glb} | ${prompt}`), 'art-1'),
      task: async (id): Promise<TaskResult> => {
        const n = (polls.get(id) ?? 0) + 1;
        polls.set(id, n);
        if (n === 1) return { status: 1, outputs: [] };
        return id === 'mesh-1'
          ? { status: 3, outputs: [{ content: 'https://cdn.example/out/mesh.zip' }, { content: 'https://cdn.example/out/mesh.glb' }] }
          : { status: 3, outputs: [{ content: 'https://cdn.example/out/jewelry_box.glb' }] };
      },
    };
    const client = await connect({ env: { AHOLO_API_KEY: 'test-key' }, aholo: () => fake as Aholo, pollMs: 1 });
    const result = await call(client, 'make_openable', { photo_url: 'https://example.com/box.jpg', motion: 'The lid swings open on its back hinge.' });
    expect(result.isError).toBeFalsy();
    const out = JSON.parse(text(result));
    expect(seen).toEqual([
      'imgTo3d https://example.com/box.jpg turbo=false size=true',
      'articulate https://cdn.example/out/mesh.glb | The lid swings open on its back hinge.',
    ]);
    expect(out.articulated).toEqual({ taskId: 'art-1', url: 'https://cdn.example/out/jewelry_box.glb' });
    expect(out.joints).toHaveLength(1);
    expect(out.joints[0]).toMatchObject({ part: 'lid', type: 'revolute', min: 0 });
    expect(out.joints[0].max).toBeCloseTo(1.9, 3);
  });

  it('make_openable surfaces a failed Lux3D task with its error', async () => {
    const fake: Partial<Aholo> = {
      imgTo3d: async () => 'mesh-2',
      task: async () => ({ status: 4, outputs: [{ content: '{"error":{"code":"BAD_IMAGE","message":"no object found"}}' }] }),
    };
    const client = await connect({ env: { AHOLO_API_KEY: 'test-key' }, aholo: () => fake as Aholo, pollMs: 1 });
    const result = await call(client, 'make_openable', { photo_url: 'https://example.com/blur.jpg' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('BAD_IMAGE: no object found');
  });
});
