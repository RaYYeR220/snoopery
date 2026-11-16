import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createAholo } from '@snoopery/aholo';
import type { Aholo, AholoCall } from '@snoopery/aholo';
import { exportRoom, zipListing } from '@snoopery/export';
import { verify } from '@snoopery/puzzle';
import type { Action } from '@snoopery/schema';
import { makeOpenable } from './openable.ts';
import { loadJson, loadRemoteAsset, puzzleFrom, roomFrom, type Lookup } from './sources.ts';
import type { Fetch } from './sources.ts';

export const SERVER_NAME = 'snoopery';
export const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  /** Environment to read AHOLO_API_KEY from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  /** Aholo client factory. Defaults to the Lux3D SDK client. */
  aholo?: (apiKey: string, onCall: (call: AholoCall) => void) => Aholo;
  /** Interval between Lux3D task polls. Default 8 s. */
  pollMs?: number;
  /** Longest a single Lux3D task may run. Default 20 min. */
  taskTimeoutMs?: number;
  /** DNS resolver used to vet hosts named by room files (tests inject one). */
  lookup?: Lookup;
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const messageOf = (error: unknown): string => {
  if (error instanceof z.ZodError) return `Invalid input: ${error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
  return error instanceof Error ? error.message : String(error);
};

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(messageOf(error));
  }
}

const describeAction = (a: Action): string => (a.type === 'open' ? `open ${a.target}` : a.type === 'take' ? `take ${a.item}` : 'exit');

const roomInput = z
  .union([z.string().min(1), z.record(z.string(), z.unknown())])
  .describe('The room: an http(s) URL (e.g. the API GET /rooms/:id), a path to a room JSON file, or the room JSON itself');

/** Where the zip goes: the given file, or `<room>-<format>.zip` inside a given directory. */
async function zipPath(outPath: string, roomId: string, format: string): Promise<string> {
  const target = resolve(outPath);
  const isDir = outPath.endsWith('/') || outPath.endsWith(sep) || (await stat(target).then((s) => s.isDirectory(), () => false));
  return isDir ? join(target, `${roomId.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${format}.zip`) : target;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const aholoFactory = options.aholo ?? ((apiKey, onCall) => createAholo({ apiKey, onCall }));
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'verify_room',
    {
      title: 'Verify an escape-room puzzle',
      description:
        'Checks a Snoopery puzzle (containers, items, exit lock) for solvability: duplicate or unknown ids, missing keys or clues, ' +
        'circular locks (a key inside the container it opens), unreachable parts, unused items. Returns the verdict with the shortest proof.',
      inputSchema: {
        puzzle: z
          .union([z.record(z.string(), z.unknown()), z.string().min(1)])
          .describe('The puzzle object { containers, items, exit } (a whole room is accepted too), or its JSON text'),
        min_steps: z.number().int().nonnegative().optional().describe('Difficulty floor: a shorter shortest solution is reported as TOO_SHORT'),
        allow_unused: z.boolean().optional().describe('Report unused items as warnings instead of issues'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ puzzle, min_steps, allow_unused }) =>
      guarded(async () => {
        const p = puzzleFrom(typeof puzzle === 'string' ? JSON.parse(puzzle) : puzzle);
        const verdict = verify(p, { ...(min_steps !== undefined ? { minSteps: min_steps } : {}), ...(allow_unused !== undefined ? { allowUnused: allow_unused } : {}) });
        return json(verdict);
      }),
  );

  server.registerTool(
    'solve_room',
    {
      title: 'Solve an escape room',
      description: 'Finds the shortest action sequence (open / take / exit) that escapes a Snoopery room, or explains why there is none.',
      inputSchema: { room_url_or_json: roomInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ room_url_or_json }) =>
      guarded(async () => {
        const verdict = verify(puzzleFrom(await loadJson(room_url_or_json, fetchImpl)));
        return json({
          solvable: verdict.solvable,
          minSteps: verdict.minSteps,
          steps: verdict.proof.map(describeAction),
          proof: verdict.proof,
          issues: verdict.issues,
        });
      }),
  );

  server.registerTool(
    'export_robot_task',
    {
      title: 'Export a room as a robot-learning task',
      description:
        'Writes a zip with the room\'s articulated furniture as a simulator scene and a task spec from its shortest solution. ' +
        'mjcf: MuJoCo scene.xml + meshes/*.obj + task.json + README.txt; usda: UsdPhysics scene.usda + task.json; task: task.json only.',
      inputSchema: {
        room_url_or_json: roomInput,
        format: z.enum(['mjcf', 'usda', 'task']).describe('mjcf (MuJoCo), usda (USD with UsdPhysics) or task (task spec only)'),
        out_path: z.string().min(1).describe('Zip file to write, or an existing directory to write <room>-<format>.zip into'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ room_url_or_json, format, out_path }) =>
      guarded(async () => {
        const room = roomFrom(await loadJson(room_url_or_json, fetchImpl));
        const zip = await exportRoom(room, (url) => loadRemoteAsset(url, fetchImpl, options.lookup), format);
        const path = await zipPath(out_path, room.id, format);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, zip);
        const files = zipListing(zip);
        return json({ path, bytes: zip.length, room: { id: room.id, title: room.title }, format, files });
      }),
  );

  server.registerTool(
    'make_openable',
    {
      title: 'Make a photographed object openable',
      description:
        'Turns a furniture photo into an articulated 3D model with Aholo Lux3D (image-to-3D G1 with real-world size, then articulation ' +
        'from a motion prompt) and recovers its joints (axis, pivot, limits). Takes several minutes and uses Aholo credits; needs AHOLO_API_KEY.',
      inputSchema: {
        photo_url: z.string().min(1).describe('Photo of the object: an http(s) URL, or a local image path (uploaded to Aholo first)'),
        motion: z
          .string()
          .max(400)
          .optional()
          .describe('How the parts move, e.g. "Keep the body fixed. The top drawer slides straight out about 30 cm and back."'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ photo_url, motion }, extra) =>
      guarded(async () => {
        const apiKey = env.AHOLO_API_KEY?.trim();
        if (!apiKey) {
          return failure('AHOLO_API_KEY is not set in the MCP server environment, so make_openable cannot call Aholo Lux3D. Nothing was generated.');
        }
        const calls: AholoCall[] = [];
        const token = extra._meta?.progressToken;
        const result = await makeOpenable(photo_url, motion, {
          aholo: aholoFactory(apiKey, (call) => calls.push(call)),
          calls,
          fetch: fetchImpl,
          pollMs: options.pollMs ?? 8000,
          taskTimeoutMs: options.taskTimeoutMs ?? 20 * 60_000,
          signal: extra.signal,
          progress: async (progress, total, message) => {
            if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } });
          },
        });
        return json(result);
      }),
  );

  return server;
}
