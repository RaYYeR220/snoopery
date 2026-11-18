import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { affordanceCard, extractJoints, inferFromParts } from '@snoopery/joints';
import type { AffordanceCard, Joint } from '@snoopery/schema';
import type { ObjectDescription } from './context';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export type JointSource = 'urdf' | 'animation' | 'inferred';

/**
 * Joints, best source first: the URDF that came with the articulation, then the articulation animation, then
 * geometric inference from the described parts.
 */
export async function analyzeGlb(
  bytes: Uint8Array,
  objectId: string,
  label: string,
  hints: ObjectDescription['parts'],
  given: Joint[] = [],
): Promise<{ joints: Joint[]; card: AffordanceCard; source: JointSource }> {
  const doc = await io.readBinary(bytes);
  if (given.length) return { joints: given, card: affordanceCard(objectId, label, doc, given), source: 'urdf' };
  let joints = extractJoints(doc);
  let source: JointSource = 'animation';
  if (joints.length === 0 && hints.length > 0) {
    joints = inferFromParts(doc, hints.map((h) => ({ part: h.name, joint: h.joint })));
    source = 'inferred';
  }
  return { joints, card: affordanceCard(objectId, label, doc, joints), source };
}
