import type { Document, Node } from '@gltf-transform/core';
import type { AffordanceCard, AffordancePart, Joint } from '@snoopery/schema';
import { cross, dot, identity, len, normalize, roundV, scale, sub, transformDir, transformPoint } from './math.ts';
import type { M4, V3 } from './math.ts';
import { boxCenter, boxSize, defaultScene, findNode, meshBounds, worldMatrices } from './scene.ts';
import type { Box } from './scene.ts';

/** Upper bounds (litres, exclusive) of the small and medium capacity buckets. */
export const CAPACITY_LITRES = { small: 2, medium: 30 } as const;

export function capacityBucket(litres: number): AffordancePart['capacity'] {
  if (litres < CAPACITY_LITRES.small) return 'small';
  if (litres < CAPACITY_LITRES.medium) return 'medium';
  return 'large';
}

/**
 * What the room designer may know about an object: its overall size and, for every joint, the part,
 * its joint type and how much it can hold. A sliding part holds its own bounding-box volume; a hinged
 * panel holds the larger of its own volume and the space it closes off (panel area times the body's
 * depth behind it), so a chest lid reports the chest, not the lid board.
 * Throws when a joint names a node the document does not contain.
 */
export function affordanceCard(objectId: string, label: string, doc: Document, joints: Joint[]): AffordanceCard {
  const scene = defaultScene(doc);
  const world = scene ? worldMatrices(scene) : new Map<Node, M4>();
  const roots = scene?.listChildren() ?? [];
  const whole = meshBounds(roots, world);
  const partNodes = joints.map((joint) => {
    const node = findNode(doc, joint.node);
    if (!node) throw new Error(`Joint "${joint.part}" refers to node "${joint.node}", which is not in the document`);
    return node;
  });
  const body = meshBounds(roots, world, identity(), new Set(partNodes));
  return {
    objectId,
    label,
    sizeM: whole ? roundV(boxSize(whole)) : [0, 0, 0],
    parts: joints.map((joint, i) => ({
      part: joint.part,
      joint: joint.type,
      capacity: capacityBucket(capacityLitres(joint, partNodes[i]!, world, body)),
    })),
  };
}

function capacityLitres(joint: Joint, node: Node, world: Map<Node, M4>, body: Box | null): number {
  const box = meshBounds([node], world);
  if (!box) return 0;
  const size = boxSize(box);
  let volume = size[0] * size[1] * size[2];
  if (joint.type === 'revolute' && body) {
    const parentNode = node.getParentNode();
    const parentWorld = (parentNode && world.get(parentNode)) || identity();
    const axis = normalize(transformDir(parentWorld, joint.axis));
    const pivot = transformPoint(parentWorld, joint.pivot);
    const toCentre = sub(boxCenter(box), pivot);
    const free = sub(toCentre, scale(axis, dot(toCentre, axis)));
    if (len(free) > 1e-6) {
      const normal = cross(axis, normalize(free));
      const i = dominantAxis(normal);
      const area = i === 0 ? size[1] * size[2] : i === 1 ? size[0] * size[2] : size[0] * size[1];
      volume = Math.max(volume, area * boxSize(body)[i]!);
    }
  }
  return volume * 1000;
}

function dominantAxis(v: V3): number {
  const a = v.map(Math.abs);
  return a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
}
