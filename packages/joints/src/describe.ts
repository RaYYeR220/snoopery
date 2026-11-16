import type { Document, Mesh } from '@gltf-transform/core';
import { round } from './math.ts';
import { clipRange, readTracks } from './sample.ts';
import { defaultScene, nodeRef, sceneNodes } from './scene.ts';

export interface ModelDescription {
  extensions: string[];
  nodes: {
    index: number;
    name: string;
    parent: string | null;
    mesh: string | null;
    translation: number[];
    rotation: number[];
    scale: number[];
  }[];
  meshes: { name: string; primitives: number; triangles: number }[];
  /** Triangles drawn by the default scene, counting every mesh instance. */
  triangles: number;
  animations: {
    name: string;
    start: number;
    end: number;
    duration: number;
    channels: { node: string | null; path: string | null; interpolation: string | null; keys: number }[];
  }[];
}

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

export function meshTriangles(mesh: Mesh): number {
  let total = 0;
  for (const prim of mesh.listPrimitives()) {
    const count = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
    const mode = prim.getMode();
    if (mode === TRIANGLES) total += Math.floor(count / 3);
    else if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) total += Math.max(0, count - 2);
  }
  return total;
}

/** Structural summary of a model: node tree, mesh sizes, animation clips. */
export function describeModel(doc: Document): ModelDescription {
  const root = doc.getRoot();
  const scene = defaultScene(doc);
  const meshes = root.listMeshes();
  const rendered = scene
    ? sceneNodes(scene).nodes.reduce((sum, n) => sum + (n.getMesh() ? meshTriangles(n.getMesh()!) : 0), 0)
    : meshes.reduce((sum, m) => sum + meshTriangles(m), 0);
  return {
    extensions: root.listExtensionsUsed().map((e) => e.extensionName),
    nodes: root.listNodes().map((node, index) => {
      const parent = node.getParentNode();
      return {
        index,
        name: node.getName(),
        parent: parent ? nodeRef(doc, parent) : null,
        mesh: node.getMesh()?.getName() ?? null,
        translation: node.getTranslation().map((v) => round(v)),
        rotation: node.getRotation().map((v) => round(v)),
        scale: node.getScale().map((v) => round(v)),
      };
    }),
    meshes: meshes.map((mesh) => ({
      name: mesh.getName(),
      primitives: mesh.listPrimitives().length,
      triangles: meshTriangles(mesh),
    })),
    triangles: rendered,
    animations: root.listAnimations().map((animation, index) => {
      const [start, end] = clipRange(readTracks(animation)) ?? [0, 0];
      return {
        name: animation.getName() || `animation_${index}`,
        start: round(start),
        end: round(end),
        duration: round(end - start),
        channels: animation.listChannels().map((channel) => {
          const node = channel.getTargetNode();
          const sampler = channel.getSampler();
          return {
            node: node ? nodeRef(doc, node) : null,
            path: channel.getTargetPath(),
            interpolation: sampler?.getInterpolation() ?? null,
            keys: sampler?.getInput()?.getCount() ?? 0,
          };
        }),
      };
    }),
  };
}
