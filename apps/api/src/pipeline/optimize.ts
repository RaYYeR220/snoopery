import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export function triangleCount(doc: Awaited<ReturnType<typeof io.readBinary>>): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += (idx ? idx.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0)) / 3;
    }
  }
  return n;
}

/**
 * Web-ready GLB for the in-browser room: welded, simplified to a triangle budget, textures capped at 1024 px.
 * Keeps node hierarchy and animations untouched so recovered joints still line up. No compression extensions,
 * so any glTF loader can read the result.
 */
export async function optimizeGlb(bytes: Uint8Array, maxTriangles = 60_000, maxTexture = 1024): Promise<Uint8Array> {
  const doc = await io.readBinary(bytes);
  await doc.transform(dedup(), weld());
  const tris = triangleCount(doc);
  if (tris > maxTriangles) {
    await MeshoptSimplifier.ready;
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.max(0.05, maxTriangles / tris), error: 0.02 }));
  }
  // JPEG is core glTF and far smaller than the source PNGs; textures with an alpha channel stay PNG.
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', quality: 85, resize: [maxTexture, maxTexture], slots: /^(?!.*(alpha|opacity)).*$/i }),
    prune({ keepAttributes: true }),
  );
  return io.writeBinary(doc);
}
