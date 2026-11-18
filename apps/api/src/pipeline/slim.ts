import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/**
 * Lux3D retargeting returns every motion as a full model (~20 MB each with textures). The player binds motions by
 * node name, so a motion file only needs the node tree and its animations.
 */
export async function animationOnly(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await io.readBinary(bytes);
  const root = doc.getRoot();
  for (const node of root.listNodes()) node.setMesh(null).setSkin(null);
  for (const p of [...root.listMeshes(), ...root.listSkins(), ...root.listMaterials(), ...root.listTextures()]) p.dispose();
  await doc.transform(prune({ keepLeaves: true, keepAttributes: false }));
  return io.writeBinary(doc);
}
