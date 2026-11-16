import { readFile } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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

const MAX_ASSET_BYTES = 200 * 1024 * 1024;

/** Address ranges a room file must never make us talk to. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Bytes for a URL that came from room content (not from the user directly): public https only, every resolved
 * address checked against private ranges, body streamed with a hard size cap. Room files are untrusted input.
 */
export async function loadRemoteAsset(source: string, fetchImpl: Fetch, lookup: Lookup = defaultLookup): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`not a URL: ${source.slice(0, 80)}`);
  }
  if (url.protocol !== 'https:') throw new Error(`room assets must be https URLs (got ${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address.
  const isBlocked = (a: { address: string; family: number }) => {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a.address)?.[1];
    if (mapped) return blocked.check(mapped, 'ipv4');
    if (/^::ffff:/i.test(a.address)) return true;
    return blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4');
  };
  if (addresses.length === 0 || addresses.some(isBlocked))
    throw new Error(`room asset host not allowed: ${host}`);
  const res = await fetchImpl(url, { redirect: 'error', headers: { 'accept-encoding': 'identity' } });
  if (!res.ok) throw new Error(`GET ${host}${url.pathname} failed: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_ASSET_BYTES) throw new Error('room asset too large');
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ASSET_BYTES) {
      await reader.cancel();
      throw new Error('room asset too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
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
