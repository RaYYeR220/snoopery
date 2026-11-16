/**
 * Fetches only from hosts we expect assets to come from (Aholo result CDNs and our own bucket),
 * over https, with a timeout and a size cap. Everything else is refused before a request is made.
 */
const ALLOWED_SUFFIXES = [
  'kujiale.com',
  'aholo3d.com',
  'aholo3d.cn',
  'aholo.ai',
  'aholo.cn',
  'coohom.com',
  'myqcloud.com',
  'aliyuncs.com',
];

export class DisallowedUrl extends Error {}

export function assertAllowedUrl(raw: string, extraPrefixes: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DisallowedUrl(`not a URL: ${raw.slice(0, 80)}`);
  }
  if (extraPrefixes.some((p) => raw.startsWith(p))) return url;
  if (url.protocol !== 'https:') throw new DisallowedUrl(`only https URLs are accepted: ${url.origin}`);
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) throw new DisallowedUrl(`host not allowed: ${host}`);
  return url;
}

export async function fetchBytes(raw: string, opts: { maxBytes?: number; timeoutMs?: number; extraPrefixes?: string[] } = {}): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? 600 * 1024 * 1024;
  assertAllowedUrl(raw, opts.extraPrefixes);
  const res = await fetch(raw, { redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000) });
  if (res.url && res.url !== raw) assertAllowedUrl(res.url, opts.extraPrefixes);
  if (!res.ok || !res.body) throw new Error(`fetch ${new URL(raw).hostname}: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`file too large (${declared} bytes)`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`file too large (> ${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
