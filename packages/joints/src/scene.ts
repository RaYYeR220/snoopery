import type { Document, Node, Scene } from '@gltf-transform/core';
import { composeTRS, identity, mul, transformPoint } from './math.ts';
import type { LocalPose } from './sample.ts';
import { restPose } from './sample.ts';
import type { M4, V3 } from './math.ts';

export interface Box {
  min: V3;
  max: V3;
}

export const boxCenter = (b: Box): V3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
export const boxSize = (b: Box): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

export function defaultScene(doc: Document): Scene | null {
  const root = doc.getRoot();
  return root.getDefaultScene() ?? root.listScenes()[0] ?? null;
}

/** Scene nodes in depth-first order with their parents (null for scene roots). */
export function sceneNodes(scene: Scene): { nodes: Node[]; parent: Map<Node, Node | null> } {
  const nodes: Node[] = [];
  const parent = new Map<Node, Node | null>();
  const visit = (node: Node, p: Node | null): void => {
    if (parent.has(node)) return;
    parent.set(node, p);
    nodes.push(node);
    for (const child of node.listChildren()) visit(child, node);
  };
  for (const root of scene.listChildren()) visit(root, null);
  return { nodes, parent };
}

/** World matrices of every scene node, with `poses` overriding the rest pose of some nodes. */
export function worldMatrices(scene: Scene, poses?: Map<Node, LocalPose>): Map<Node, M4> {
  const world = new Map<Node, M4>();
  const visit = (node: Node, parentWorld: M4): void => {
    if (world.has(node)) return;
    const pose = poses?.get(node) ?? restPose(node);
    const m = mul(parentWorld, composeTRS(pose.t, pose.r, pose.s));
    world.set(node, m);
    for (const child of node.listChildren()) visit(child, m);
  };
  for (const root of scene.listChildren()) visit(root, identity());
  return world;
}

/**
 * Vertex-exact bounds of the meshes under `roots`, transformed by `frame · world(node)`.
 * Subtrees rooted at nodes in `exclude` are skipped. Returns null when there is no geometry.
 */
export function meshBounds(
  roots: Iterable<Node>,
  world: Map<Node, M4>,
  frame: M4 = identity(),
  exclude: Set<Node> = new Set(),
): Box | null {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const el: number[] = [];
  const visit = (node: Node): void => {
    if (exclude.has(node)) return;
    const mesh = node.getMesh();
    const nodeWorld = world.get(node);
    if (mesh && nodeWorld) {
      const m = mul(frame, nodeWorld);
      for (const prim of mesh.listPrimitives()) {
        const position = prim.getAttribute('POSITION');
        if (!position) continue;
        const count = position.getCount();
        for (let i = 0; i < count; i++) {
          position.getElement(i, el);
          const p = transformPoint(m, [el[0]!, el[1]!, el[2]!]);
          for (let k = 0; k < 3; k++) {
            if (p[k]! < min[k]!) min[k] = p[k]!;
            if (p[k]! > max[k]!) max[k] = p[k]!;
          }
        }
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const root of roots) visit(root);
  return Number.isFinite(min[0]) && Number.isFinite(max[0]) ? { min, max } : null;
}

/** Lowercase `[a-z0-9_]` identifier; empty when nothing usable remains. */
export function sanitizePartName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Stable reference to a node for runtime lookup: its name, or `node_<index>` (index in the
 * document's node list) when it has none.
 */
export function nodeRef(doc: Document, node: Node): string {
  const name = node.getName();
  return name ? name : `node_${doc.getRoot().listNodes().indexOf(node)}`;
}

/** Resolves a reference produced by {@link nodeRef}. */
export function findNode(doc: Document, ref: string): Node | null {
  const nodes = doc.getRoot().listNodes();
  const named = nodes.find((n) => n.getName() === ref);
  if (named) return named;
  const match = /^node_(\d+)$/.exec(ref);
  return match ? (nodes[Number(match[1])] ?? null) : null;
}

/** Part name candidates for a node: its own name, else its mesh name, else its reference. */
export function basePartName(doc: Document, node: Node): string {
  return (
    sanitizePartName(node.getName()) ||
    sanitizePartName(node.getMesh()?.getName() ?? '') ||
    sanitizePartName(nodeRef(doc, node))
  );
}

/** Makes names unique by suffixing `_2`, `_3`, … in order of appearance. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((base) => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  });
}
