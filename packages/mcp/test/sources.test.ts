import { describe as d2, expect as e2, it as i2 } from 'vitest';
import { loadRemoteAsset } from '../src/sources.ts';

d2('loadRemoteAsset', () => {
  const never = (async () => {
    throw new Error('must not fetch');
  }) as unknown as typeof fetch;
  i2('refuses local files and private networks named by room content', async () => {
    for (const u of ['file:///etc/passwd', 'http://example.com/a.glb', 'https://127.0.0.1/a.glb', 'https://169.254.169.254/latest', 'https://localhost/a.glb', 'https://10.0.0.5/a.glb', 'https://[::1]/a.glb']) {
      await e2(loadRemoteAsset(u, never), u).rejects.toThrow();
    }
  });
  i2('fetches public https assets', async () => {
    const ok = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    e2(await loadRemoteAsset('https://storage.googleapis.com/b/a.glb', ok)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
