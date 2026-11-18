import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@manycore/aholo-splat-transform';

/**
 * G1-Turbo previews arrive as ~1.4M-Gaussian float PLYs (~100 MB). For the web, keep the most opaque Gaussians
 * (they carry the visible surface) and write SPZ with Aholo splat-transform: ~4 MB.
 */
export async function webPreview(ply: Uint8Array, keep = 350_000): Promise<Uint8Array> {
  const end = Buffer.from(ply.subarray(0, 4096)).indexOf('end_header\n') + 'end_header\n'.length;
  const header = Buffer.from(ply.subarray(0, end)).toString('latin1');
  const props = header.split('\n').filter((l) => l.startsWith('property')).map((l) => l.trim().split(/\s+/).pop()!);
  if (!header.includes('format binary_little_endian') || header.split('\n').some((l) => l.startsWith('property') && !l.includes(' float '))) {
    throw new Error('expected a little-endian float PLY');
  }
  const n = Number(/element vertex (\d+)/.exec(header)![1]);
  const stride = props.length;
  const data = new Float32Array(ply.buffer.slice(ply.byteOffset + end, ply.byteOffset + end + n * stride * 4));
  const op = props.indexOf('opacity');
  let order = Array.from({ length: n }, (_, i) => i);
  if (n > keep && op >= 0) order = order.sort((a, b) => data[b * stride + op]! - data[a * stride + op]!).slice(0, keep);
  const out = new Float32Array(order.length * stride);
  order.forEach((src, i) => out.set(data.subarray(src * stride, src * stride + stride), i * stride));

  const dir = await mkdtemp(join(tmpdir(), 'preview-'));
  try {
    await writeFile(join(dir, 'thin.ply'), Buffer.concat([Buffer.from(header.replace(`element vertex ${n}`, `element vertex ${order.length}`), 'latin1'), Buffer.from(out.buffer)]));
    await run(
      { version: 1, tasks: [
        { id: 'read', type: 'Read', config: { inputs: ['thin.ply'], output: 'src' } },
        { id: 'write', type: 'Write', config: { input: 'src', output: 'preview.spz' } },
      ] } as never,
      { cwd: dir },
    );
    return new Uint8Array(await readFile(join(dir, 'preview.spz')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
