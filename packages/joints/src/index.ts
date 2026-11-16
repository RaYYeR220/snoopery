export { extractJoints } from './extract.ts';
export type { ExtractOptions } from './extract.ts';
export { inferFromParts, INFERRED_HINGE_RANGE, INFERRED_SLIDE_FRACTION } from './infer.ts';
export type { PartHint } from './infer.ts';
export { affordanceCard, capacityBucket, CAPACITY_LITRES } from './affordance.ts';
export { jointMatrix, jointValue } from './transform.ts';
export { describeModel, meshTriangles } from './describe.ts';
export type { ModelDescription } from './describe.ts';
export { findNode, nodeRef, sanitizePartName } from './scene.ts';
