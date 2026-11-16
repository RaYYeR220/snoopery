import type { PlacedObject, RoomDoc } from '@snoopery/schema';
import { clean, normalize, num, nums, yawQuat, zUp } from './math.ts';
import type { V3 } from './math.ts';
import { NameSet, fileStem, jointId, xmlAttr } from './names.ts';
import { emptyMesh, toOBJ, triangleCount } from './split.ts';
import type { Mesh, ObjectMeshes, PartJoint } from './split.ts';

/** Eye height the runtime puts the spawn camera at; the floor sits this far below it. */
export const EYE_HEIGHT = 1.55;

/** Default passive joint dynamics: a drawer runner and a cabinet hinge. */
export const JOINT_DEFAULTS = {
  prismatic: { damping: 4, armature: 0.05, frictionloss: 0.3 },
  revolute: { damping: 0.3, armature: 0.01, frictionloss: 0.02 },
} as const;

/** Bulk density (kg/m³) applied to each mesh's convex hull, and areal density (kg/m²) for flat panels. */
export const DENSITY = { solid: 400, panel: 8 } as const;

export interface MJCFExport {
  xml: string;
  /** OBJ files by path relative to the scene file (`meshes/<name>.obj`). */
  files: Record<string, string>;
}

/** Joints of a placed object resolved into its frame: from the split when available, else as authored. */
export function objectJoints(o: PlacedObject, m: ObjectMeshes): PartJoint[] {
  return o.joints.map((j) => m.joints?.find((r) => r.part === j.part) ?? { ...j, axis: normalize(j.axis), parent: null });
}

export function meshesFor(meshes: Record<string, ObjectMeshes>, objectId: string): ObjectMeshes {
  const m = meshes[objectId];
  if (!m) throw new Error(`No meshes for object "${objectId}"`);
  return m;
}

/** True when the mesh spans no volume (fewer than four points, or all points on one plane). */
export function isFlat(mesh: Mesh): boolean {
  const p = mesh.positions;
  const n = p.length / 3;
  if (n < 4) return true;
  const at = (i: number): V3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const o = at(0);
  let far = o;
  let best = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(...sub(at(i), o));
    if (d > best) [best, far] = [d, at(i)];
  }
  if (best < 1e-6) return true;
  const u = sub(far, o);
  let normal: V3 = [0, 0, 0];
  let area = 0;
  for (let i = 1; i < n; i++) {
    const v = sub(at(i), o);
    const c: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const a = Math.hypot(...c);
    if (a > area) [area, normal] = [a, c];
  }
  if (area < 1e-6 * best * best) return true;
  const k = 1 / area;
  const tolerance = 1e-5 * best;
  for (let i = 1; i < n; i++) {
    const v = sub(at(i), o);
    if (Math.abs((v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2]) * k) > tolerance) return false;
  }
  return true;
}

/** Mesh in a MuJoCo body frame: Y-up object frame → Z-up, scaled by the placement. */
function bodyMesh(mesh: Mesh, scale: number): Mesh {
  const src = mesh.positions;
  const positions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const v = zUp([src[i]!, src[i + 1]!, src[i + 2]!]);
    positions[i] = v[0] * scale;
    positions[i + 1] = v[1] * scale;
    positions[i + 2] = v[2] * scale;
  }
  return { positions, indices: mesh.indices };
}

const attrs = (a: Record<string, string | number | undefined>): string =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${typeof v === 'number' ? num(v) : xmlAttr(v!)}"`)
    .join(' ');

/**
 * MuJoCo scene of a room. Z-up world (runtime Y-up mapped x → x, y → z, z → −y), floor plane at
 * the spawn eye height minus 1.55 m, one static body per object at its placement (yaw about +Z),
 * its base as a fixed mesh geom, and one child body per jointed part with a limited slide or hinge
 * joint. Axes and pivots are in the object body frame; meshes are OBJ files in that frame with
 * the placement scale baked in. Bodies and joints are named `<objectId>__<part>`.
 */
export function toMJCF(room: RoomDoc, meshes: Record<string, ObjectMeshes>): MJCFExport {
  const seen = new Set<string>();
  for (const o of room.objects) {
    if (seen.has(o.objectId)) throw new Error(`Object id "${o.objectId}" is used more than once`);
    seen.add(o.objectId);
  }

  const files: Record<string, string> = {};
  const fileNames = new NameSet();
  const assets: string[] = [];
  const bodies: string[] = [];
  const excludes: string[] = [];

  const addMesh = (name: string, mesh: Mesh, scale: number): { flat: boolean } | null => {
    if (triangleCount(mesh) === 0) return null;
    const local = bodyMesh(mesh, scale);
    const flat = isFlat(local);
    const file = `${fileNames.take(fileStem(name))}.obj`;
    files[`meshes/${file}`] = toOBJ(local, name);
    assets.push(`    <mesh ${attrs({ name, file, inertia: flat ? 'shell' : 'convex' })}/>`);
    return { flat };
  };

  const geom = (name: string, material: string, flat: boolean): string =>
    `<geom ${attrs({
      name,
      type: 'mesh',
      mesh: name,
      material,
      ...(flat ? { contype: 0, conaffinity: 0, density: DENSITY.panel } : {}),
    })}/>`;

  for (const o of room.objects) {
    const m = meshesFor(meshes, o.objectId);
    const s = o.scale;
    const joints = objectJoints(o, m);
    const pad = (depth: number) => '  '.repeat(depth + 1);
    const lines: string[] = [];
    const pos = zUp(o.position);
    lines.push(`${pad(1)}<body ${attrs({ name: o.objectId })} pos="${nums(pos)}" quat="${nums(yawQuat(o.rotationY, 'z'))}">`);
    const base = addMesh(o.objectId, m.base, s);
    if (base) lines.push(`${pad(2)}${geom(o.objectId, 'snoopery_base', base.flat)}`);

    const known = new Set(joints.map((j) => j.part));
    const children = (parent: string | null) => joints.filter((j) => (j.parent !== null && known.has(j.parent) ? j.parent : null) === parent);
    const emit = (j: PartJoint, depth: number): void => {
      const id = jointId(o.objectId, j.part);
      const slide = j.type === 'prismatic';
      const k = slide ? s : 1;
      const pivot = zUp(j.pivot).map((v) => v * s);
      const dyn = JOINT_DEFAULTS[j.type];
      lines.push(`${pad(depth)}<body ${attrs({ name: id })}>`);
      lines.push(
        `${pad(depth + 1)}<joint ${attrs({ name: id, type: slide ? 'slide' : 'hinge' })} pos="${nums(pivot)}" axis="${nums(zUp(j.axis))}" range="${num(clean(j.min * k))} ${num(clean(j.max * k))}" limited="true" ${attrs(dyn)}/>`,
      );
      const part = addMesh(id, m.parts[j.part] ?? emptyMesh(), s);
      if (part) lines.push(`${pad(depth + 1)}${geom(id, 'snoopery_part', part.flat)}`);
      else lines.push(`${pad(depth + 1)}<inertial pos="${nums(pivot)}" mass="0.05" diaginertia="0.0001 0.0001 0.0001"/>`);
      for (const child of children(j.part)) emit(child, depth + 1);
      lines.push(`${pad(depth)}</body>`);
    };
    for (const j of children(null)) emit(j, 2);
    lines.push(`${pad(1)}</body>`);
    bodies.push(lines.join('\n'));

    // Convex hulls of parts of one object overlap by construction; contacts between them are meaningless.
    const names = [o.objectId, ...joints.map((j) => jointId(o.objectId, j.part))];
    for (let a = 0; a < names.length; a++) {
      for (let b = a + 1; b < names.length; b++) excludes.push(`    <exclude ${attrs({ body1: names[a]!, body2: names[b]! })}/>`);
    }
  }

  const floorZ = room.spawn.pos[1] - EYE_HEIGHT;
  const centres = room.objects.map((o) => zUp(o.position));
  const mean = (k: number) => centres.reduce((sum, c) => sum + c[k]!, 0) / centres.length;
  const center: V3 = centres.length ? [mean(0), mean(1), mean(2)] : zUp(room.spawn.pos);
  const extent = Math.max(1.5, ...centres.map((c) => 2 * Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]) + 1));

  const xml = [
    `<mujoco ${attrs({ model: room.title })}>`,
    '  <compiler angle="radian" meshdir="meshes" autolimits="true"/>',
    '  <option timestep="0.002" integrator="implicitfast" gravity="0 0 -9.81"/>',
    `  <statistic center="${nums(center)}" extent="${num(extent)}"/>`,
    '  <visual>',
    '    <headlight diffuse="0.6 0.6 0.6" ambient="0.35 0.35 0.35" specular="0 0 0"/>',
    '    <global azimuth="135" elevation="-25"/>',
    '  </visual>',
    '  <default>',
    `    <geom density="${DENSITY.solid}" friction="0.8 0.02 0.001" condim="3"/>`,
    '  </default>',
    '  <asset>',
    '    <texture name="snoopery_grid" type="2d" builtin="checker" rgb1="0.86 0.85 0.82" rgb2="0.78 0.77 0.74" width="512" height="512"/>',
    '    <material name="snoopery_floor" texture="snoopery_grid" texrepeat="8 8" texuniform="true"/>',
    '    <material name="snoopery_base" rgba="0.62 0.5 0.4 1"/>',
    '    <material name="snoopery_part" rgba="0.86 0.6 0.32 1"/>',
    ...assets,
    '  </asset>',
    '  <worldbody>',
    `    <light name="key" pos="${nums([center[0], center[1], floorZ + 4])}" dir="0 0 -1" directional="true"/>`,
    `    <geom name="floor" type="plane" pos="0 0 ${num(floorZ)}" size="0 0 0.05" material="snoopery_floor"/>`,
    ...bodies,
    '  </worldbody>',
    ...(excludes.length ? ['  <contact>', ...excludes, '  </contact>'] : []),
    '</mujoco>',
    '',
  ].join('\n');
  return { xml, files };
}
