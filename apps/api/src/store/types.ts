/** JSON documents (rooms, objects, jobs, plays). Keys are slash paths without extension. */
export interface DocStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Public URL a browser can fetch the document from directly. */
  publicUrl(key: string): string;
}

/** Binary assets (splats, GLBs, photos). Everything written here is publicly readable. */
export interface BlobStore {
  putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  putFromUrl(key: string, url: string): Promise<{ url: string; bytes: number; contentType: string }>;
  getBytes(urlOrKey: string): Promise<Uint8Array>;
  publicUrl(key: string): string;
}

export function contentTypeFor(name: string): string {
  const ext = name.split('?')[0]!.split('.').pop()!.toLowerCase();
  return (
    {
      glb: 'model/gltf-binary',
      gltf: 'model/gltf+json',
      ply: 'application/octet-stream',
      spz: 'application/octet-stream',
      sog: 'application/octet-stream',
      zip: 'application/zip',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      json: 'application/json',
      usdz: 'model/vnd.usdz+zip',
      stl: 'model/stl',
      '3mf': 'model/3mf',
    } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}
