// Exports a room in every format, reading its models from a local directory by file name.
// Usage: tsx scripts/export-demo.ts [room.json] [models dir] [out dir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { parseRoomDoc } from '@snoopery/schema';
import { EXPORT_FORMATS, exportRoom } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const devDir = resolve(here, '../../../apps/web/public/dev');
const [roomPath = join(devDir, 'demo.json'), modelDir = dirname(roomPath), outDir = resolve(here, '../results')] = process.argv.slice(2);

const room = parseRoomDoc(JSON.parse(readFileSync(roomPath, 'utf8')));
const loadGlb = async (url: string) => new Uint8Array(readFileSync(join(modelDir, basename(new URL(url).pathname))));
const stem = basename(roomPath).replace(/\.json$/i, '');

mkdirSync(outDir, { recursive: true });
for (const format of EXPORT_FORMATS) {
  const zip = await exportRoom(room, loadGlb, format);
  const file = join(outDir, `${stem}-${format}.zip`);
  writeFileSync(file, zip);
  const entries = Object.entries(unzipSync(zip)).map(([name, data]) => `${name} (${data.length} B)`);
  console.log(`${file}: ${entries.join(', ')}`);
}
