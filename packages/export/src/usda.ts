import type { RoomDoc } from '@snoopery/schema';
import { EYE_HEIGHT, DENSITY, isFlat, meshesFor, objectJoints } from './mjcf.ts';
import { RAD_TO_DEG, clean, cross, dot, normalize, num, nums, yawQuat } from './math.ts';
import type { Quat, V3 } from './math.ts';
import { NameSet, jointId, usdName, usdString } from './names.ts';
import { emptyMesh, triangleCount } from './split.ts';
import type { Mesh, ObjectMeshes } from './split.ts';

export type AxisToken = 'X' | 'Y' | 'Z';

/**
 * UsdPhysics joints take their axis as a token of the joint frame. For any unit direction this
 * picks the closest token and the frame rotation (`physics:localRot0/1`) that turns the token's
 * axis onto the direction, so limits keep their sign and meaning.
 */
export function jointFrame(axis: V3): { token: AxisToken; rot: Quat } {
  const a = normalize(axis);
  const k = [0, 1, 2].reduce((best, i) => (Math.abs(a[i]!) > Math.abs(a[best]!) ? i : best), 0);
  const token = (['X', 'Y', 'Z'] as const)[k]!;
  const e: V3 = [0, 0, 0];
  e[k] = 1;
  const d = dot(e, a);
  if (d > 1 - 1e-12) return { token, rot: [1, 0, 0, 0] };
  if (d < -1 + 1e-12) {
    const half: Quat = [0, 0, 0, 0];
    half[1 + ((k + 1) % 3)] = 1;
    return { token, rot: half };
  }
  const c = cross(e, a);
  const n = Math.hypot(1 + d, c[0], c[1], c[2]);
  return { token, rot: [(1 + d) / n, c[0] / n, c[1] / n, c[2] / n] };
}

const tuple = (v: ArrayLike<number>, digits = 6): string => `(${nums(v, digits, ', ')})`;
const quat = (q: Quat): string => tuple(q, 9);

function surfaceArea(mesh: Mesh): number {
  const p = mesh.positions;
  const f = mesh.indices;
  let area = 0;
  for (let t = 0; t < f.length; t += 3) {
    const [a, b, c] = [f[t]! * 3, f[t + 1]! * 3, f[t + 2]! * 3];
    const u: V3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const v: V3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    area += Math.hypot(...cross(u, v)) / 2;
  }
  return area;
}

function scaled(mesh: Mesh, s: number): Mesh {
  return s === 1 ? mesh : { positions: mesh.positions.map((v) => v * s), indices: mesh.indices };
}

class Writer {
  readonly lines: string[] = [];
  private depth = 0;

  line(s = ''): void {
    this.lines.push(s ? `${'    '.repeat(this.depth)}${s}` : '');
  }

  open(head: string, schemas: string[] = []): void {
    if (schemas.length) {
      this.line(`${head} (`);
      this.line(`    prepend apiSchemas = [${schemas.map((s) => usdString(s)).join(', ')}]`);
      this.line(')');
    } else {
      this.line(head);
    }
    this.line('{');
    this.depth++;
  }

  close(): void {
    this.depth--;
    this.line('}');
  }
}

const BASE_COLOR = [0.62, 0.5, 0.4];
const PART_COLOR = [0.86, 0.6, 0.32];

/** A rigid body prim holding one mesh collider (convex-decomposed; flat panels are visual only). */
function body(w: Writer, name: string, mesh: Mesh, color: number[], filtered: string[]): void {
  const empty = triangleCount(mesh) === 0;
  const flat = !empty && isFlat(mesh);
  const schemas = ['PhysicsRigidBodyAPI', 'PhysicsMassAPI', ...(filtered.length ? ['PhysicsFilteredPairsAPI'] : [])];
  w.open(`def Xform ${usdString(name)}`, schemas);
  if (empty) w.line('float physics:mass = 0.05');
  else if (flat) w.line(`float physics:mass = ${num(Math.max(0.05, surfaceArea(mesh) * DENSITY.panel))}`);
  else w.line(`float physics:density = ${DENSITY.solid}`);
  if (filtered.length) w.line(`rel physics:filteredPairs = [${filtered.map((p) => `<${p}>`).join(', ')}]`);
  if (!empty) {
    w.line();
    w.open('def Mesh "geom"', flat ? [] : ['PhysicsCollisionAPI', 'PhysicsMeshCollisionAPI']);
    if (!flat) w.line('uniform token physics:approximation = "convexDecomposition"');
    const p = mesh.positions;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const points: string[] = [];
    for (let i = 0; i < p.length; i += 3) {
      points.push(tuple([p[i]!, p[i + 1]!, p[i + 2]!]));
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[i + k]!);
        max[k] = Math.max(max[k]!, p[i + k]!);
      }
    }
    w.line(`float3[] extent = [${tuple(min)}, ${tuple(max)}]`);
    w.line(`int[] faceVertexCounts = [${new Array(triangleCount(mesh)).fill('3').join(', ')}]`);
    w.line(`int[] faceVertexIndices = [${Array.from(mesh.indices).join(', ')}]`);
    w.line(`point3f[] points = [${points.join(', ')}]`);
    w.line(`color3f[] primvars:displayColor = [${tuple(color)}]`);
    w.line('uniform token subdivisionScheme = "none"');
    w.close();
  }
  w.close();
}

/**
 * USD ASCII scene of a room with UsdPhysics: Y-up, metres, kilograms. Each object is an
 * articulation (Xform with its placement) whose base is welded to the world by a fixed joint and
 * whose parts are sibling rigid bodies connected by revolute (limits in degrees) or prismatic
 * (limits in metres) joints named `<objectId>__<part>`. Meshes are inline, scale baked in.
 */
export function toUSDA(room: RoomDoc, meshes: Record<string, ObjectMeshes>): string {
  const w = new Writer();
  const floorY = room.spawn.pos[1] - EYE_HEIGHT;
  const n = Math.max(1, room.objects.length);
  const cx = room.objects.reduce((sum, o) => sum + o.position[0], 0) / n;
  const cz = room.objects.reduce((sum, o) => sum + o.position[2], 0) / n;

  w.line('#usda 1.0');
  w.line('(');
  w.line('    defaultPrim = "Room"');
  w.line(`    doc = ${usdString(`${room.title} (${room.id})`)}`);
  w.line('    kilogramsPerUnit = 1');
  w.line('    metersPerUnit = 1');
  w.line('    upAxis = "Y"');
  w.line(')');
  w.line();
  w.open('def Xform "Room"');
  w.open('def PhysicsScene "PhysicsScene"');
  w.line('vector3f physics:gravityDirection = (0, -1, 0)');
  w.line('float physics:gravityMagnitude = 9.81');
  w.close();
  w.line();
  w.open('def Cube "floor"', ['PhysicsCollisionAPI']);
  w.line('double size = 1');
  w.line(`double3 xformOp:translate = ${tuple([cx, floorY - 0.01, cz])}`);
  w.line('float3 xformOp:scale = (40, 0.02, 40)');
  w.line('uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]');
  w.line('color3f[] primvars:displayColor = [(0.82, 0.81, 0.78)]');
  w.close();

  const objectNames = new NameSet(['PhysicsScene', 'floor']);
  for (const o of room.objects) {
    const m = meshesFor(meshes, o.objectId);
    const s = o.scale;
    const joints = objectJoints(o, m);
    const objectName = objectNames.take(usdName(o.objectId));
    const root = `/Room/${objectName}`;
    const names = new NameSet(['base']);
    const partPrim = new Map(joints.map((j) => [j.part, `${root}/${names.take(usdName(j.part))}`]));
    const anchorName = names.take(usdName(`${o.objectId}__anchor`));
    const bodies = [`${root}/base`, ...partPrim.values()];
    const others = (self: string) => (bodies.length > 1 ? bodies.filter((b) => b !== self) : []);

    w.line();
    w.open(`def Xform ${usdString(objectName)}`, ['PhysicsArticulationRootAPI']);
    w.line(`double3 xformOp:translate = ${tuple(o.position)}`);
    w.line(`float xformOp:rotateY = ${num(o.rotationY * RAD_TO_DEG)}`);
    w.line('uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateY"]');
    w.line();
    body(w, 'base', scaled(m.base, s), BASE_COLOR, others(`${root}/base`));
    for (const j of joints) {
      const prim = partPrim.get(j.part)!;
      w.line();
      body(w, prim.slice(root.length + 1), scaled(m.parts[j.part] ?? emptyMesh(), s), PART_COLOR, others(prim));
    }

    w.line();
    w.open(`def PhysicsFixedJoint ${usdString(anchorName)}`);
    w.line(`rel physics:body1 = <${root}/base>`);
    w.line(`point3f physics:localPos0 = ${tuple(o.position)}`);
    w.line(`quatf physics:localRot0 = ${quat(yawQuat(o.rotationY, 'y'))}`);
    w.line('point3f physics:localPos1 = (0, 0, 0)');
    w.line('quatf physics:localRot1 = (1, 0, 0, 0)');
    w.close();

    for (const j of joints) {
      const revolute = j.type === 'revolute';
      const { token, rot } = jointFrame(j.axis);
      const pivot = j.pivot.map((v) => v * s);
      const parent = j.parent !== null && partPrim.has(j.parent) ? partPrim.get(j.parent)! : `${root}/base`;
      const [lo, hi] = revolute ? [j.min * RAD_TO_DEG, j.max * RAD_TO_DEG] : [j.min * s, j.max * s];
      w.line();
      w.open(`def ${revolute ? 'PhysicsRevoluteJoint' : 'PhysicsPrismaticJoint'} ${usdString(names.take(usdName(jointId(o.objectId, j.part))))}`);
      w.line(`uniform token physics:axis = ${usdString(token)}`);
      w.line(`rel physics:body0 = <${parent}>`);
      w.line(`rel physics:body1 = <${partPrim.get(j.part)!}>`);
      w.line(`point3f physics:localPos0 = ${tuple(pivot)}`);
      w.line(`quatf physics:localRot0 = ${quat(rot)}`);
      w.line(`point3f physics:localPos1 = ${tuple(pivot)}`);
      w.line(`quatf physics:localRot1 = ${quat(rot)}`);
      w.line(`float physics:lowerLimit = ${num(clean(lo))}`);
      w.line(`float physics:upperLimit = ${num(clean(hi))}`);
      w.close();
    }
    w.close();
  }
  w.close();
  w.line();
  return w.lines.join('\n');
}
