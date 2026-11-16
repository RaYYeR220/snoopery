import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import type { Node } from '@gltf-transform/core';
import { parseRoomDoc } from '@snoopery/schema';
import type { RoomDoc } from '@snoopery/schema';

export const DEV_DIR = fileURLToPath(new URL('../../../apps/web/public/dev/', import.meta.url));

export const readDev = (name: string): Uint8Array => new Uint8Array(readFileSync(join(DEV_DIR, name)));

export const demoRoom = (): RoomDoc => parseRoomDoc(JSON.parse(readFileSync(join(DEV_DIR, 'demo.json'), 'utf8')));

/** Resolves a room's localhost GLB URL to the file of the same name in the dev fixtures. */
export const loadDevGlb = async (url: string): Promise<Uint8Array> => readDev(basename(new URL(url).pathname));

type V3 = [number, number, number];

export function addBox(doc: Document, parent: Node, name: string, min: V3, max: V3, spec: { t?: V3; r?: [number, number, number, number]; s?: V3 } = {}): Node {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices));
  const node = doc.createNode(name).setMesh(doc.createMesh(`${name}_mesh`).addPrimitive(prim));
  if (spec.t) node.setTranslation(spec.t);
  if (spec.r) node.setRotation(spec.r);
  if (spec.s) node.setScale(spec.s);
  parent.addChild(node);
  return node;
}

/**
 * A cabinet whose model root is turned 90° about +Y and scaled ×2, with a drawer and a jewellery
 * box lid nested inside the drawer. Joints are authored in each part's parent frame.
 */
export async function nestedCabinet(): Promise<Uint8Array> {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('scene');
  doc.getRoot().setDefaultScene(scene);
  const s = Math.SQRT1_2;
  const root = doc.createNode('cabinet').setRotation([0, s, 0, s]).setScale([2, 2, 2]);
  scene.addChild(root);
  addBox(doc, root, 'carcass', [-0.2, 0, -0.2], [0.2, 0.4, 0.2]);
  const drawer = doc.createNode('drawer');
  root.addChild(drawer);
  addBox(doc, drawer, 'tray', [-0.18, 0.2, -0.18], [0.18, 0.3, 0.2]);
  const lid = doc.createNode('lid').setTranslation([0, 0.3, 0]);
  drawer.addChild(lid);
  addBox(doc, lid, 'lid_panel', [-0.05, 0, 0], [0.05, 0.01, 0.1]);
  return new NodeIO().writeBinary(doc);
}
