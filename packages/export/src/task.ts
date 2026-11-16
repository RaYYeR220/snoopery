import type { Joint, LockSpec, PlacedObject, RoomDoc } from '@snoopery/schema';
import { num } from './math.ts';
import { jointId } from './names.ts';

export type TaskAction = 'open' | 'take' | 'exit';

/**
 * One step of the robot task. `open`: drive `joint` (body/joint name in the exported scene) of
 * `object`.`part` to `target` (its upper limit: metres for a slide, radians for a hinge); `item`
 * is the key it needs and `code` the combination to enter. `take`: pick up `item`, found in
 * `object`.`part` when given. `exit`: leave the room, with `item` or `code` when the door is locked.
 */
export interface TaskStep {
  action: TaskAction;
  object?: string;
  part?: string;
  joint?: string;
  target?: number;
  item?: string;
  code?: string;
}

export interface TaskSpec {
  goal: string;
  steps: TaskStep[];
  successCriterion: string;
}

/** Fraction of a joint's travel that counts as "open" in the success criterion. */
export const OPEN_FRACTION = 0.9;

/** Joint limits as the exported scene sees them (object frame, placement scale applied), keyed by joint id. */
export type JointLimits = Record<string, { type: Joint['type']; min: number; max: number }>;

/** Limits of every joint in the room, scaled by each placement (slide travel grows with scale; angles do not). */
export function roomJointLimits(room: RoomDoc): JointLimits {
  const out: JointLimits = {};
  for (const o of room.objects) {
    for (const j of o.joints) out[jointId(o.objectId, j.part)] = scaledLimits(o, j);
  }
  return out;
}

export function scaledLimits(o: PlacedObject, j: Pick<Joint, 'type' | 'min' | 'max'>): { type: Joint['type']; min: number; max: number } {
  const k = j.type === 'prismatic' ? o.scale : 1;
  return { type: j.type, min: j.min * k, max: j.max * k };
}

const unitOf = (type: Joint['type']): 'm' | 'rad' => (type === 'prismatic' ? 'm' : 'rad');

function unlock(lock: LockSpec, step: TaskStep): string {
  if (lock.kind === 'key') step.item = lock.keyId;
  if (lock.kind === 'code') {
    step.code = lock.code;
    return ` (code ${lock.code})`;
  }
  return '';
}

/**
 * Robot task from a room's shortest solution (`room.proof`): one step per action, in order.
 * `limits` overrides joint limits (e.g. resolved from the model); by default they come from the room.
 */
export function toTaskSpec(room: RoomDoc, limits: JointLimits = roomJointLimits(room)): TaskSpec {
  if (room.proof.length === 0) throw new Error(`Room "${room.id}" has no solution to turn into a task`);
  const containers = new Map(room.puzzle.containers.map((c) => [c.id, c]));
  const items = new Map(room.puzzle.items.map((i) => [i.id, i]));
  const steps: TaskStep[] = [];
  const phrases: string[] = [];
  const opened: string[] = [];
  const taken: string[] = [];

  for (const action of room.proof) {
    if (action.type === 'open') {
      const c = containers.get(action.target);
      if (!c) throw new Error(`Solution opens unknown container "${action.target}"`);
      const id = jointId(c.objectId, c.part);
      const limit = limits[id];
      if (!limit) throw new Error(`Container "${c.id}": object "${c.objectId}" has no joint for part "${c.part}"`);
      const step: TaskStep = { action: 'open', object: c.objectId, part: c.part, joint: id, target: limit.max };
      phrases.push(`open ${c.id}${unlock(c.lock, step)}`);
      steps.push(step);
      const threshold = limit.min + OPEN_FRACTION * (limit.max - limit.min);
      opened.push(`${id} >= ${num(threshold, 4)} ${unitOf(limit.type)}`);
    } else if (action.type === 'take') {
      const item = items.get(action.item);
      if (!item) throw new Error(`Solution takes unknown item "${action.item}"`);
      const step: TaskStep = { action: 'take', item: item.id };
      const holder = item.inside ? containers.get(item.inside) : undefined;
      if (holder) {
        step.object = holder.objectId;
        step.part = holder.part;
      }
      phrases.push(`take ${item.id}`);
      steps.push(step);
      taken.push(item.id);
    } else {
      const step: TaskStep = { action: 'exit' };
      phrases.push(`exit${unlock(room.puzzle.exit.lock, step)}`);
      steps.push(step);
    }
  }

  const exitLock = room.puzzle.exit.lock;
  const door =
    exitLock.kind === 'key' ? `the exit is unlocked with ${exitLock.keyId}` : exitLock.kind === 'code' ? `the exit code ${exitLock.code} is entered` : 'the exit is reached';
  const criteria = [
    opened.length > 0 ? `every opened part reaches ${Math.round(OPEN_FRACTION * 100)}% of its travel (${opened.join(', ')})` : '',
    taken.length > 0 ? `the items ${taken.join(', ')} are taken` : '',
    door,
  ].filter(Boolean);
  return {
    goal: `Escape "${room.title}": ${phrases.join(', ')}.`,
    steps,
    successCriterion: `Success when ${criteria.join('; ')}.`,
  };
}
