import { contentTypeFor, type BlobStore, type DocStore } from './types';

export function memoryDocs(): DocStore & { dump(): Map<string, unknown> } {
  const m = new Map<string, string>();
  return {
    async get<T>(key: string) {
      const v = m.get(key);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    async put(key, value) {
      m.set(key, JSON.stringify(value));
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    publicUrl: (key) => `memory://docs/${key}.json`,
    dump: () => new Map([...m].map(([k, v]) => [k, JSON.parse(v)])),
  };
}

export function memoryBlobs(fetcher: (url: string) => Promise<Uint8Array> = async () => new Uint8Array([1, 2, 3])): BlobStore & {
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  const publicUrl = (key: string) => `https://blobs.test/${key}`;
  return {
    files,
    publicUrl,
    async putBytes(key, bytes) {
      files.set(key, bytes);
      return publicUrl(key);
    },
    async putFromUrl(key, url) {
      const bytes = await fetcher(url);
      files.set(key, bytes);
      return { url: publicUrl(key), bytes: bytes.length, contentType: contentTypeFor(key) };
    },
    async getBytes(urlOrKey) {
      const key = urlOrKey.replace('https://blobs.test/', '');
      const f = files.get(key);
      if (f) return f;
      return fetcher(urlOrKey);
    },
  };
}
