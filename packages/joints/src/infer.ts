import type { Document, Node } from '@gltf-transform/core';
import type { Joint, JointType } from '@snoopery/schema';
import { cross, identity, invertAffine, round, roundV } from './math.ts';
import type { V3 } from './math.ts';
import {
  basePartName,
  boxCenter,
  boxSize,
  defaultScene,
  meshBounds,
  nodeRef,
  sanitizePartName,
  sceneNodes,
  uniqueNames,
  worldMatrices,
} from './scene.ts';
import type { Box } from './scene.ts';

export interface PartHint {
  /** Node name (raw or sanitised) of the movable part. */
  part: string;
  joint: JointType;
}

/** Opening range given to an inferred hinge, radians (~109°). */
export const INFERRED_HINGE_RANGE = 1.9;
/** Fraction of a drawer's depth it slides out when inferred. */
export const INFERRED_SLIDE_FRACTION = 0.8;

const FACE_TOLERANCE = 0.002;
const unit = (axis: number, sign: number): V3 => {
  const v: V3 = [0, 0, 0];
  v[axis] = sign;
  return v;
};

/**
 * Fallback joints from part geometry alone, for models without articulation animation.
 *
 * The body is every mesh outside the hinted parts. A hinged part opens away from the body side it
 * sits on: a lid (on top or underneath) hinges at its back edge, a door at the side edge farthest
 * from the body centre. A sliding part moves out through the horizontal face that sits farthest
 * out relative to the body (ties prefer the front, +Z). Joints are in the part's parent frame, rest
 * pose. Hints that match no node, or a node without geometry, are skipped.
 */
export function inferFromParts(doc: Document, hints: PartHint[]): Joint[] {
  const scene = defaultScene(doc);
  if (!scene) return [];
  const { nodes, parent } = sceneNodes(scene);
  const world = worldMatrices(scene);
  const resolved = hints
    .map((hint) => ({ hint, node: resolvePart(nodes, hint.part) }))
    .filter((r): r is { hint: PartHint; node: Node } => r.node !== null);
  const hinted = new Set(resolved.map((r) => r.node));

  const joints: Omit<Joint, 'part'>[] = [];
  const names: string[] = [];
  for (const { hint, node } of resolved) {
    const parentNode = parent.get(node) ?? null;
    const frame = invertAffine(parentNode ? world.get(parentNode)! : identity());
    const part = meshBounds([node], world, frame);
    if (!part) continue;
    const roots = scene.listChildren();
    const body = meshBounds(roots, world, frame, hinted) ?? meshBounds(roots, world, frame, new Set([node])) ?? part;
    const motion = hint.joint === 'revolute' ? hinge(part, body) : slide(part, body);
    joints.push({
      node: nodeRef(doc, node),
      type: hint.joint,
      axis: roundV(motion.axis),
      pivot: roundV(motion.pivot),
      min: 0,
      max: round(motion.max),
    });
    names.push(sanitizePartName(hint.part) || basePartName(doc, node));
  }
  const parts = uniqueNames(names);
  return joints.map((j, i) => ({ part: parts[i]!, ...j }));
}

function resolvePart(nodes: Node[], name: string): Node | null {
  const wanted = sanitizePartName(name);
  return (
    nodes.find((n) => n.getName() === name) ??
    nodes.find((n) => wanted !== '' && sanitizePartName(n.getName()) === wanted) ??
    nodes.find((n) => !n.getName() && wanted !== '' && sanitizePartName(n.getMesh()?.getName() ?? '') === wanted) ??
    null
  );
}

interface Motion {
  axis: V3;
  pivot: V3;
  max: number;
}

function hinge(part: Box, body: Box): Motion {
  const pc = boxCenter(part);
  const bc = boxCenter(body);
  const half = boxSize(body).map((s) => Math.max(s / 2, 1e-6));
  let side = 2;
  let sign = 1;
  let best = 0.05;
  for (let i = 0; i < 3; i++) {
    const offset = (pc[i]! - bc[i]!) / half[i]!;
    if (Math.abs(offset) > best) [side, sign, best] = [i, Math.sign(offset), Math.abs(offset)];
  }
  const normal = unit(side, sign);
  const pivot: V3 = [...pc];
  pivot[side] = sign > 0 ? part.min[side]! : part.max[side]!;
  let free: V3;
  if (side === 1) {
    pivot[2] = part.min[2];
    free = [0, 0, 1];
  } else {
    const h = side === 2 ? 0 : 2;
    const atMin = pc[h]! <= bc[h]! + 1e-9;
    pivot[h] = atMin ? part.min[h]! : part.max[h]!;
    free = unit(h, atMin ? 1 : -1);
  }
  return { axis: cross(free, normal), pivot, max: INFERRED_HINGE_RANGE };
}

const SLIDE_DIRECTIONS: [number, number][] = [
  [2, 1],
  [0, 1],
  [0, -1],
  [2, -1],
];

function slide(part: Box, body: Box): Motion {
  let choice = SLIDE_DIRECTIONS[0]!;
  let best = -Infinity;
  for (const dir of SLIDE_DIRECTIONS) {
    const [i, s] = dir;
    const protrusion = s > 0 ? part.max[i]! - body.max[i]! : body.min[i]! - part.min[i]!;
    if (protrusion > best + FACE_TOLERANCE) [choice, best] = [dir, protrusion];
  }
  const [i, s] = choice;
  return {
    axis: unit(i, s),
    pivot: boxCenter(part),
    max: INFERRED_SLIDE_FRACTION * boxSize(part)[i]!,
  };
}
