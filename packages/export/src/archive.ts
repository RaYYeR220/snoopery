import { strToU8, unzipSync, zipSync } from 'fflate';
import type { RoomDoc } from '@snoopery/schema';
import { EYE_HEIGHT, JOINT_DEFAULTS, meshesFor, objectJoints, toMJCF } from './mjcf.ts';
import { num } from './math.ts';
import { jointId } from './names.ts';
import { splitParts } from './split.ts';
import type { ObjectMeshes } from './split.ts';
import { roomJointLimits, scaledLimits, toTaskSpec } from './task.ts';
import type { JointLimits, TaskSpec } from './task.ts';
import { toUSDA } from './usda.ts';

export type ExportFormat = 'mjcf' | 'usda' | 'task';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['mjcf', 'usda', 'task'];

export type LoadGlb = (url: string) => Promise<Uint8Array>;

/** Fixed entry timestamp so the same room always zips to the same bytes. */
const ENTRY_TIME = new Date(2026, 0, 1);

/** Splits every placed object's model by its joints, loading each distinct model URL once. */
export async function splitRoom(room: RoomDoc, loadGlb: LoadGlb): Promise<Record<string, ObjectMeshes>> {
  const glbs = new Map<string, Promise<Uint8Array>>();
  const load = (url: string) => {
    let pending = glbs.get(url);
    if (!pending) glbs.set(url, (pending = loadGlb(url)));
    return pending;
  };
  const out: Record<string, ObjectMeshes> = {};
  for (const o of room.objects) {
    try {
      out[o.objectId] = await splitParts(await load(o.glbUrl), o.joints);
    } catch (error) {
      throw new Error(`Object "${o.objectId}" (${o.glbUrl}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

/** Joint limits as exported: resolved into each object frame from the model, then scaled by the placement. */
export function exportedLimits(room: RoomDoc, meshes: Record<string, ObjectMeshes>): JointLimits {
  const out: JointLimits = {};
  for (const o of room.objects) {
    for (const j of objectJoints(o, meshesFor(meshes, o.objectId))) out[jointId(o.objectId, j.part)] = scaledLimits(o, j);
  }
  return out;
}

export interface TaskFile extends TaskSpec {
  room: { id: string; title: string };
  joints: { name: string; object: string; part: string; type: 'revolute' | 'prismatic'; range: [number, number]; unit: 'rad' | 'm' }[];
}

export function taskFile(room: RoomDoc, limits: JointLimits = roomJointLimits(room)): TaskFile {
  const spec = toTaskSpec(room, limits);
  const joints: TaskFile['joints'] = [];
  for (const o of room.objects) {
    for (const j of o.joints) {
      const name = jointId(o.objectId, j.part);
      const limit = limits[name]!;
      joints.push({ name, object: o.objectId, part: j.part, type: limit.type, range: [limit.min, limit.max], unit: limit.type === 'prismatic' ? 'm' : 'rad' });
    }
  }
  return { room: { id: room.id, title: room.title }, ...spec, joints };
}

function mjcfReadme(room: RoomDoc, task: TaskFile): string {
  const floorZ = room.spawn.pos[1] - EYE_HEIGHT;
  const width = Math.max(4, ...task.joints.map((j) => j.name.length));
  const joints = task.joints.map(
    (j) =>
      `  ${j.name.padEnd(width)}  ${(j.type === 'prismatic' ? 'slide' : 'hinge').padEnd(5)}  ${num(j.range[0])} .. ${num(j.range[1])} ${j.unit}`,
  );
  const steps = task.steps.map((s, i) => {
    const what =
      s.action === 'open'
        ? `open ${s.object}.${s.part}: drive ${s.joint} to ${num(s.target!)}${s.code ? ` (code ${s.code})` : ''}${s.item ? ` (key ${s.item})` : ''}`
        : s.action === 'take'
          ? `take ${s.item}${s.object ? ` from ${s.object}.${s.part}` : ''}`
          : `exit${s.item ? ` (key ${s.item})` : ''}${s.code ? ` (code ${s.code})` : ''}`;
    return `  ${i + 1}. ${what}`;
  });
  return [
    `${room.title} (${room.id}): robot task export`,
    '',
    'Files',
    '  scene.xml     MuJoCo (MJCF) scene: floor, every object as a static body, every movable part as a jointed child body',
    '  meshes/*.obj  triangle meshes in each body frame (placement scale baked in)',
    '  task.json     goal, ordered steps, success criterion and joint table',
    '',
    'Frames and units',
    '  Z-up, metres, radians. The room was authored Y-up; it maps as x -> x, y -> z, z -> -y.',
    `  Floor plane at z = ${num(floorZ)}. Each object body sits at its placement, turned about +Z by its yaw.`,
    '',
    'Joints (body and joint share the name <object>__<part>)',
    ...joints,
    `  Passive: slide damping ${JOINT_DEFAULTS.prismatic.damping}, armature ${JOINT_DEFAULTS.prismatic.armature}, frictionloss ${JOINT_DEFAULTS.prismatic.frictionloss};` +
      ` hinge damping ${JOINT_DEFAULTS.revolute.damping}, armature ${JOINT_DEFAULTS.revolute.armature}, frictionloss ${JOINT_DEFAULTS.revolute.frictionloss}.`,
    '  There are no actuators: a robot opens the parts by contact, or add <position joint="..."/> actuators to script them.',
    '',
    'Collision',
    '  Each mesh collides through its convex hull. Parts of the same object do not collide with each other',
    '  (their hulls overlap by construction); for contact-rich work replace the hulls with a convex decomposition.',
    '  Masses come from hull volume at 400 kg/m3; set density or mass per geom to match real furniture.',
    '',
    'Task',
    `  ${task.goal}`,
    ...steps,
    `  ${task.successCriterion}`,
    '',
    'Load',
    '  python -m mujoco.viewer --mjcf=scene.xml',
    '',
  ].join('\n');
}

const json = (value: unknown): Uint8Array => strToU8(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Exports a room as a zip: `mjcf` → scene.xml + meshes/*.obj + task.json + README.txt,
 * `usda` → scene.usda + task.json, `task` → task.json (no model is loaded).
 */
export async function exportRoom(room: RoomDoc, loadGlb: LoadGlb, format: ExportFormat): Promise<Uint8Array> {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`Unknown export format "${String(format)}" (expected ${EXPORT_FORMATS.join(', ')})`);
  if (format === 'task') return zipSync({ 'task.json': json(taskFile(room)) }, { level: 6, mtime: ENTRY_TIME });

  const meshes = await splitRoom(room, loadGlb);
  const task = taskFile(room, exportedLimits(room, meshes));
  const entries: Record<string, Uint8Array> = {};
  if (format === 'mjcf') {
    const { xml, files } = toMJCF(room, meshes);
    entries['scene.xml'] = strToU8(xml);
    for (const [path, text] of Object.entries(files)) entries[path] = strToU8(text);
    entries['task.json'] = json(task);
    entries['README.txt'] = strToU8(mjcfReadme(room, task));
  } else {
    entries['scene.usda'] = strToU8(toUSDA(room, meshes));
    entries['task.json'] = json(task);
  }
  return zipSync(entries, { level: 6, mtime: ENTRY_TIME });
}

/** Entry names and sizes of an exported zip. */
export function zipListing(zip: Uint8Array): { name: string; bytes: number }[] {
  return Object.entries(unzipSync(zip)).map(([name, data]) => ({ name, bytes: data.length }));
}
