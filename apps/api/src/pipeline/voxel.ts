import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@manycore/aholo-splat-transform';

/**
 * Voxel collision for a splat scene (walls, floor, furniture) so the player can't walk through the room.
 * Runs Aholo splat-transform's Voxel task on CPU; ~5 s for a 3M-Gaussian room.
 */
export async function voxelize(splat: Uint8Array, format: 'spz' | 'ply' | 'sog'): Promise<{ meta: Uint8Array; bin: Uint8Array }> {
  const dir = await mkdtemp(join(tmpdir(), 'voxel-'));
  try {
    await writeFile(join(dir, `scene.${format}`), splat);
    await run(
      {
        version: 1,
        tasks: [
          { id: 'read', type: 'Read', config: { inputs: [`scene.${format}`], output: 'src' } },
          { id: 'voxel', type: 'Voxel', config: { input: 'src', output: 'voxel', voxelResolution: 0.05, opacityCutoff: 0.1, backend: 'cpu' } },
        ],
      } as never,
      { cwd: dir },
    );
    return { meta: new Uint8Array(await readFile(join(dir, 'voxel', 'voxel-meta.json'))), bin: new Uint8Array(await readFile(join(dir, 'voxel', 'voxel.bin'))) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
