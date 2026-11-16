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

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;

/**
 * Bytes for a URL that came from room content (not from the user directly): public https only, size-capped.
 * Room files are untrusted input, so they never get to point the loader at local files or private networks.
 */
export async function loadRemoteAsset(source: string, fetchImpl: Fetch): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`not a URL: ${source.slice(0, 80)}`);
  }
  if (url.protocol !== 'https:') throw new Error(`room assets must be https URLs (got ${url.protocol})`);
  if (PRIVATE_HOST.test(url.hostname)) throw new Error(`room asset host not allowed: ${url.hostname}`);
  const res = await fetchImpl(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`GET ${url.hostname}${url.pathname} failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_ASSET_BYTES) throw new Error('room asset too large');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) throw new Error('room asset too large');
  return bytes;
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
