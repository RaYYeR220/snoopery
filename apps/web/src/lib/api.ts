import { parseRoomDoc, type RoomDoc } from '@snoopery/schema';

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080';
export const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE as string | undefined) ?? 'https://storage.googleapis.com/snoopery-assets';

export const docUrl = (key: string) => `${ASSET_BASE}/docs/${key}.json`;

/** Published rooms are static JSON next to their assets, so playing never depends on the API being up. */
export async function loadRoom(id: string): Promise<RoomDoc> {
  const local = id.startsWith('dev:') ? `/dev/${id.slice(4)}.json` : null;
  const res = await fetch(local ?? docUrl(`rooms/${id}`), { cache: 'no-cache' });
  if (!res.ok) throw new Error(res.status === 404 ? 'This room does not exist (or was never published).' : `Could not load the room (HTTP ${res.status}).`);
  return parseRoomDoc(await res.json());
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
