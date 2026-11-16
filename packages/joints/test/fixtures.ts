import { Document } from '@gltf-transform/core';
import type { Animation, Mesh, Node, Scene } from '@gltf-transform/core';

export type V3 = [number, number, number];
export type Q = [number, number, number, number];

export interface Fixture {
  doc: Document;
  scene: Scene;
}

export function newDoc(): Fixture {
  const doc = new Document();
  const scene = doc.createScene('scene');
  doc.getRoot().setDefaultScene(scene);
  return { doc, scene };
}

/** Axis-aligned box mesh spanning `min`..`max` in the node's local frame. */
export function boxMesh(doc: Document, min: V3, max: V3, name = 'box'): Mesh {
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
  const position = doc.createAccessor().setType('VEC3').setArray(positions);
  const index = doc.createAccessor().setType('SCALAR').setArray(indices);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(index);
  return doc.createMesh(name).addPrimitive(prim);
}

export interface NodeSpec {
  box?: [V3, V3];
  translation?: V3;
  rotation?: Q;
  scale?: V3;
}

export function addNode(doc: Document, parent: Scene | Node, name: string, spec: NodeSpec = {}): Node {
  const node = doc.createNode(name);
  if (spec.box) node.setMesh(boxMesh(doc, spec.box[0], spec.box[1], `${name}_mesh`));
  if (spec.translation) node.setTranslation(spec.translation);
  if (spec.rotation) node.setRotation(spec.rotation);
  if (spec.scale) node.setScale(spec.scale);
  parent.addChild(node);
  return node;
}

export function animate(
  doc: Document,
  anim: Animation,
  node: Node,
  path: 'translation' | 'rotation' | 'scale',
  times: number[],
  values: number[][],
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE' = 'LINEAR',
): void {
  const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times));
  const output = doc
    .createAccessor()
    .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
    .setArray(new Float32Array(values.flat()));
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(interpolation);
  const channel = doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler);
  anim.addSampler(sampler).addChannel(channel);
}

export function quatAxisAngle(axis: V3, angle: number): Q {
  const len = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / len;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function rotateVec(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function linspace(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** Column-major 4x4 times point. */
export function applyMat(m: ArrayLike<number>, p: V3): V3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

export const HINGE: V3 = [0.2, 0.3, 0];
export const LID_OPEN = (100 * Math.PI) / 180;

/**
 * A chest body plus a lid whose node origin sits at the lid centre, rotating 0→100° about the
 * hinge line x=0.2, y=0.3 (along Z). Both translation and rotation channels are keyed every 5°,
 * as an exporter baking a hinge motion would.
 */
export function lidOnHinge(parent?: { translation?: V3; rotation?: Q }): Fixture & { lid: Node; body: Node; anim: Animation } {
  const { doc, scene } = newDoc();
  const holder = parent ? addNode(doc, scene, 'chest', parent) : scene;
  const body = addNode(doc, holder, 'Body', { box: [[-0.4, 0, -0.2], [0.2, 0.3, 0.2]] });
  const restT: V3 = [0.5, 0.31, 0];
  const lid = addNode(doc, holder, 'Lid', { box: [[-0.3, -0.01, -0.2], [0.3, 0.01, 0.2]], translation: restT });
  const anim = doc.createAnimation('open_lid');
  const angles = linspace(0, LID_OPEN, 21);
  const rel: V3 = [restT[0] - HINGE[0], restT[1] - HINGE[1], restT[2] - HINGE[2]];
  const rotations = angles.map((a) => quatAxisAngle([0, 0, 1], a));
  const translations = rotations.map((q) => {
    const r = rotateVec(q, rel);
    return [HINGE[0] + r[0], HINGE[1] + r[1], HINGE[2] + r[2]];
  });
  const times = linspace(0, 2, 21);
  animate(doc, anim, lid, 'rotation', times, rotations);
  animate(doc, anim, lid, 'translation', times, translations);
  return { doc, scene, lid, body, anim };
}

/** A cabinet body with a drawer sliding 0→0.3 m along +X; the drawer carries a knob child. */
export function drawerOnSlide(
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE' = 'LINEAR',
): Fixture & { drawer: Node; knob: Node; body: Node; anim: Animation } {
  const { doc, scene } = newDoc();
  const body = addNode(doc, scene, 'Cabinet', { box: [[-0.4, 0, -0.25], [0.4, 0.8, 0.25]] });
  const drawer = addNode(doc, scene, 'Top Drawer', {
    box: [[-0.2, -0.1, -0.2], [0.2, 0.1, 0.2]],
    translation: [0.2, 0.6, 0],
  });
  const knob = addNode(doc, drawer, 'Knob', { box: [[0, -0.01, -0.01], [0.02, 0.01, 0.01]], translation: [0.2, 0, 0] });
  const anim = doc.createAnimation('open_drawer');
  if (interpolation === 'CUBICSPLINE') {
    animate(doc, anim, drawer, 'translation', [0, 1], [
      [0, 0, 0], [0.2, 0.6, 0], [0, 0, 0],
      [0, 0, 0], [0.5, 0.6, 0], [0, 0, 0],
    ], 'CUBICSPLINE');
  } else if (interpolation === 'STEP') {
    animate(doc, anim, drawer, 'translation', [0, 1, 2, 3], [
      [0.2, 0.6, 0], [0.3, 0.6, 0], [0.4, 0.6, 0], [0.5, 0.6, 0],
    ], 'STEP');
  } else {
    animate(doc, anim, drawer, 'translation', [0, 1], [[0.2, 0.6, 0], [0.5, 0.6, 0]]);
  }
  return { doc, scene, drawer, knob, body, anim };
}
