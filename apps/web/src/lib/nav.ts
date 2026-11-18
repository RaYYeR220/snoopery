/** The static build (mirrors without SPA fallback) routes through the hash; the hosted app uses real paths. */
export const HASH_ROUTING = import.meta.env.VITE_ROUTER === 'hash';
export const STATIC_BUILD = import.meta.env.VITE_STATIC === '1';

export const href = (path: string) => (HASH_ROUTING ? `#${path}` : path);

/** Files in public/ (fonts, hero data) resolved against the build base, which is relative in the static build. */
export const publicUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
