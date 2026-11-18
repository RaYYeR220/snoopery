import { parseRoomDoc, type RoomDoc } from '@snoopery/schema';

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080';
export const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE as string | undefined) ?? 'https://storage.googleapis.com/snoopery-assets';

export const docUrl = (key: string) => `${ASSET_BASE}/docs/${key}.json`;

/**
 * The static mirror stores asset links relative to the page ("./baked/…"). Workers inside the viewer would resolve
 * those against their own script URL, so every relative link is made absolute before a document is used.
 */
export function absolutize<T>(value: T): T {
  if (typeof value === 'string') return (value.startsWith('./') ? new URL(value, document.baseURI).href : value) as T;
  if (Array.isArray(value)) return value.map(absolutize) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, absolutize(v)])) as T;
  return value;
}

/** Published rooms are static JSON next to their assets, so playing never depends on the API being up. */
const ROOM_ID = /^[A-Za-z0-9_-]{4,40}$/;

export async function loadRoom(id: string): Promise<RoomDoc> {
  const dev = import.meta.env.DEV && id.startsWith('dev:') ? id.slice(4) : null;
  const slug = dev ?? id;
  if (!ROOM_ID.test(slug)) throw new Error('This room link is not valid.');
  const res = await fetch(dev ? `/dev/${encodeURIComponent(dev)}.json` : docUrl(`rooms/${encodeURIComponent(slug)}`), { cache: 'no-cache' });
  if (!res.ok) throw new Error(res.status === 404 ? 'This room does not exist (or was never published).' : `Could not load the room (HTTP ${res.status}).`);
  const doc = parseRoomDoc(absolutize(await res.json()));
  if (doc.id !== id) throw new Error('This room link is not valid.');
  return doc;
}

export async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.token ? { 'x-edit-token': init.token } : {}) };
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status, body });
  return body as T;
}

export interface LeaderRow {
  name: string;
  ms: number;
  steps: number;
  hints: number;
}
