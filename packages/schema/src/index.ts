import { z } from 'zod';

const id = z.string().min(1);
export const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof vec3>;

export const jointType = z.enum(['revolute', 'prismatic']);
export type JointType = z.infer<typeof jointType>;

/** A recovered joint: rotate about `axis` through `pivot`, or slide along `axis`. Limits in rad or m. */
export const joint = z.object({
  part: id,
  node: id,
  type: jointType,
  axis: vec3,
  pivot: vec3,
  min: z.number(),
  max: z.number(),
  clip: z.string().optional(),
});
export type Joint = z.infer<typeof joint>;

export const affordancePart = z.object({
  part: id,
  joint: jointType,
  capacity: z.enum(['small', 'medium', 'large']),
});
export type AffordancePart = z.infer<typeof affordancePart>;

/** What the room designer is allowed to know about one object. */
export const affordanceCard = z.object({
  objectId: id,
  label: z.string().min(1),
  sizeM: vec3,
  parts: z.array(affordancePart),
});
export type AffordanceCard = z.infer<typeof affordanceCard>;

export const lockSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('key'), keyId: id }),
  z.object({ kind: z.literal('code'), code: z.string().regex(/^[0-9]{3,6}$/), clueIds: z.array(id).min(1) }),
]);
export type LockSpec = z.infer<typeof lockSpec>;

export const puzzleContainer = z.object({
  id,
  objectId: id,
  part: id,
  lock: lockSpec,
  /** Id of the container this one sits inside (e.g. a box in a drawer), or null. */
  inside: id.nullable(),
});
export type PuzzleContainer = z.infer<typeof puzzleContainer>;

export const puzzleItem = z.object({
  id,
  kind: z.enum(['key', 'clue', 'prop']),
  label: z.string().min(1),
  /** Container id the item is hidden in, or null when it lies loose in the room. */
  inside: id.nullable(),
  text: z.string().optional(),
});
export type PuzzleItem = z.infer<typeof puzzleItem>;

export const puzzle = z.object({
  containers: z.array(puzzleContainer),
  items: z.array(puzzleItem),
  exit: z.object({ lock: lockSpec }),
});
export type Puzzle = z.infer<typeof puzzle>;

export const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), target: id }),
  z.object({ type: z.literal('take'), item: id }),
  z.object({ type: z.literal('exit') }),
]);
export type Action = z.infer<typeof action>;

export const placedObject = z.object({
  objectId: id,
  glbUrl: z.string().url(),
  joints: z.array(joint),
  position: vec3,
  rotationY: z.number(),
  scale: z.number().positive(),
  cutout: z.object({ center: vec3, size: vec3 }).optional(),
});
export type PlacedObject = z.infer<typeof placedObject>;

export const roomDoc = z.object({
  id,
  title: z.string().min(1),
  author: z.string(),
  /** One or two sentences setting the scene for the player. */
  intro: z.string().max(400).optional(),
  splat: z.object({
    url: z.string().url(),
    format: z.enum(['spz', 'ply', 'sog']),
    transform: z.array(z.number()).length(16),
    collision: z.object({ metaUrl: z.string().url(), binUrl: z.string().url() }).optional(),
  }),
  spawn: z.object({ pos: vec3, yaw: z.number(), pitch: z.number() }),
  objects: z.array(placedObject),
  puzzle,
  proof: z.array(action),
  verdict: z.object({ solvable: z.boolean(), minSteps: z.number().int().nonnegative() }),
});
export type RoomDoc = z.infer<typeof roomDoc>;

export const parsePuzzle = (x: unknown): Puzzle => puzzle.parse(x);
export const parseRoomDoc = (x: unknown): RoomDoc => roomDoc.parse(x);
