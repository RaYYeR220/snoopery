// Static mirror: hash routing, relative asset paths, rooms baked into ./baked. Upload dist-static/ to any static host.
//   tsx scripts/build-static.ts --rooms abc123,def456   (or --api https://… for every published room)
import { execFileSync } from 'node:child_process';
import { build } from 'vite';

const API = process.env.SNOOPERY_API ?? 'https://snoopery-api-983650425028.asia-east1.run.app';
Object.assign(process.env, { VITE_BASE: './', VITE_ROUTER: 'hash', VITE_STATIC: '1', VITE_ASSET_BASE: './baked', VITE_API_URL: API });

await build({ build: { outDir: 'dist-static', emptyOutDir: true } });
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bake.ts', '--out', 'dist-static/baked', ...process.argv.slice(2)], { stdio: 'inherit' });
