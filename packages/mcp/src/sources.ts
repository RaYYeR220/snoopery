import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parsePuzzle, parseRoomDoc } from '@snoopery/schema';
import type { Puzzle, RoomDoc } from '@snoopery/schema';

export type Fetch = typeof globalThis.fetch;

const isHttp = (s: string): boolean => /^https?:\/\//i.test(s);

/** Bytes from an http(s) URL, a file: URL or a local path. */
export async function loadBytes(source: string, fetchImpl: Fetch): Promise<Uint8Array> {
  if (isHttp(source)) {
    const res = await fetchImpl(source);
    if (!res.ok) throw new Error(`GET ${source} failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const path = /^file:/i.test(source) ? fileURLToPath(source) : source;
  return new Uint8Array(await readFile(path));
}

/** JSON given inline (object or text), or loaded from an http(s) URL, file: URL or local path. */
export async function loadJson(input: unknown, fetchImpl: Fetch): Promise<unknown> {
  if (typeof input !== 'string') return input;
  const text = input.trim();
  if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
  const bytes = await loadBytes(text, fetchImpl);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${text} is not JSON`);
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Unwraps `{ room: {...} }` (the publish response) to the room itself. */
function unwrap(json: unknown): unknown {
  return isRecord(json) && isRecord(json.room) && !('puzzle' in json) ? json.room : json;
}

export function roomFrom(json: unknown): RoomDoc {
  return parseRoomDoc(unwrap(json));
}

/** A bare puzzle, or the puzzle of a room or room draft. */
export function puzzleFrom(json: unknown): Puzzle {
  const value = unwrap(json);
  return parsePuzzle(isRecord(value) && 'puzzle' in value && !('containers' in value) ? value.puzzle : value);
}
