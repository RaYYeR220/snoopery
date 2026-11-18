import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // The static mirror is served from an unknown sub-path, so its asset URLs are relative.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  // The viewer ships its own module workers; pre-bundling breaks their URLs.
  optimizeDeps: { exclude: ['@manycore/aholo-viewer'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5180 },
});
