import { Storage } from '@google-cloud/storage';
import { contentTypeFor, type BlobStore, type DocStore } from './types';

const PUBLIC = 'https://storage.googleapis.com';

export function gcsStores(bucketName: string): { docs: DocStore; blobs: BlobStore } {
  const bucket = new Storage().bucket(bucketName);
  const publicUrl = (key: string) => `${PUBLIC}/${bucketName}/${key}`;
  const docKey = (key: string) => `docs/${key}.json`;

  const docs: DocStore = {
    async get<T>(key: string) {
      try {
        const [buf] = await bucket.file(docKey(key)).download();
        return JSON.parse(buf.toString('utf8')) as T;
      } catch (e) {
        if ((e as { code?: number }).code === 404) return null;
        throw e;
      }
    },
    async put(key, value) {
      await bucket.file(docKey(key)).save(JSON.stringify(value), {
        contentType: 'application/json',
        metadata: { cacheControl: 'no-cache, max-age=0' },
        resumable: false,
      });
    },
    async list(prefix) {
      const [files] = await bucket.getFiles({ prefix: `docs/${prefix}` });
      return files.map((f) => f.name.slice('docs/'.length, -'.json'.length));
    },
    publicUrl: (key) => publicUrl(docKey(key)),
  };

  const blobs: BlobStore = {
    publicUrl,
    async putBytes(key, bytes, contentType) {
      await bucket.file(key).save(Buffer.from(bytes), {
        contentType,
        metadata: { cacheControl: 'public, max-age=31536000, immutable' },
        resumable: bytes.length > 8 * 1024 * 1024,
      });
      return publicUrl(key);
    },
    async putFromUrl(key, url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`mirror ${url}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const contentType = contentTypeFor(key);
      return { url: await blobs.putBytes(key, bytes, contentType), bytes: bytes.length, contentType };
    },
    async getBytes(urlOrKey) {
      const prefix = `${PUBLIC}/${bucketName}/`;
      if (urlOrKey.startsWith(prefix) || !/^https?:/.test(urlOrKey)) {
        const [buf] = await bucket.file(urlOrKey.replace(prefix, '')).download();
        return new Uint8Array(buf);
      }
      const res = await fetch(urlOrKey);
      if (!res.ok) throw new Error(`fetch ${urlOrKey}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
  return { docs, blobs };
}
