import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { affordanceCard, extractJoints, inferFromParts } from '@snoopery/joints';
import type { AffordanceCard, Joint } from '@snoopery/schema';
import type { ObjectDescription } from './context';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Joints from the articulation animation; falls back to geometric inference from the described parts. */
export async function analyzeGlb(
  bytes: Uint8Array,
  objectId: string,
  label: string,
  hints: ObjectDescription['parts'],
): Promise<{ joints: Joint[]; card: AffordanceCard; source: 'animation' | 'inferred' }> {
  const doc = await io.readBinary(bytes);
  let joints = extractJoints(doc);
  let source: 'animation' | 'inferred' = 'animation';
  if (joints.length === 0 && hints.length > 0) {
    joints = inferFromParts(doc, hints.map((h) => ({ part: h.name, joint: h.joint })));
    source = 'inferred';
  }
  return { joints, card: affordanceCard(objectId, label, doc, joints), source };
}
