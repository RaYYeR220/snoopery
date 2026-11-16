import { describeModel } from '../src/describe.ts';
import { extractJoints } from '../src/extract.ts';
import { loadModel } from '../src/load.ts';

const USAGE = 'usage: node --experimental-strip-types scripts/inspect.ts <model.glb | model.gltf | archive.zip | directory>';

const path = process.argv[2];
if (!path || path === '-h' || path === '--help') {
  console.error(USAGE);
  process.exit(path ? 0 : 2);
}

try {
  const model = await loadModel(path);
  const report = {
    source: model.source,
    ...(model.entries ? { entries: model.entries } : {}),
    warnings: model.warnings,
    ...describeModel(model.doc),
    joints: extractJoints(model.doc),
  };
  const json = JSON.stringify(report, null, 2).replace(
    /\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g,
    (_, inner: string) => `[${inner.split(/,\s+/).join(', ')}]`,
  );
  process.stdout.write(`${json}\n`);
} catch (error) {
  console.error(`inspect: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
