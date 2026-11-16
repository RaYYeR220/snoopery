import type { Document, Node, Primitive } from '@gltf-transform/core';
import { findNode } from '@snoopery/joints';
import { readModel } from '@snoopery/joints/load';
import type { Joint } from '@snoopery/schema';
import { clean, cleanV, det3, identity, mul, normalize, num, transformDir, transformPoint } from './math.ts';
import type { M4, V3 } from './math.ts';

/** Indexed triangle mesh: xyz triples and three vertex indices per triangle. */
export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * A joint resolved into the object frame (the model's scene root frame, in the rest pose):
 * axis is a unit vector, pivot a point, and prismatic limits are distances in that frame.
 * `parent` is the jointed part this one rides on, or null when it hangs off the static base.
 */
export interface PartJoint extends Joint {
  parent: string | null;
}

/** Geometry of one placed object split by joints. `joints` is omitted when the caller built the meshes by hand. */
export interface ObjectMeshes {
  base: Mesh;
  parts: Record<string, Mesh>;
  joints?: PartJoint[];
}

export interface SplitResult extends ObjectMeshes {
  joints: PartJoint[];
}

export const triangleCount = (mesh: Mesh): number => mesh.indices.length / 3;

export const emptyMesh = (): Mesh => ({ positions: new Float32Array(0), indices: new Uint32Array(0) });

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];

  /** Appends the triangles of a primitive, transformed by `world`. Only referenced vertices are kept. */
  add(prim: Primitive, world: M4): void {
    const mode = prim.getMode();
    if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) return;
    const position = prim.getAttribute('POSITION');
    if (!position) return;
    const indexAccessor = prim.getIndices();
    const count = indexAccessor ? indexAccessor.getCount() : position.getCount();
    const at = indexAccessor ? (k: number) => indexAccessor.getScalar(k) : (k: number) => k;
    const flip = det3(world) < 0;
    const remap = new Map<number, number>();
    const el: number[] = [];
    const vertex = (source: number): number => {
      let index = remap.get(source);
      if (index === undefined) {
        position.getElement(source, el);
        const p = transformPoint(world, el[0]!, el[1]!, el[2]!);
        index = this.positions.length / 3;
        this.positions.push(p[0], p[1], p[2]);
        remap.set(source, index);
      }
      return index;
    };
    const triangle = (a: number, b: number, c: number): void => {
      if (a === b || b === c || a === c) return;
      const [ia, ib, ic] = [vertex(a), vertex(b), vertex(c)];
      if (flip) this.indices.push(ia, ic, ib);
      else this.indices.push(ia, ib, ic);
    };
    if (mode === TRIANGLES) {
      for (let k = 0; k + 2 < count; k += 3) triangle(at(k), at(k + 1), at(k + 2));
    } else if (mode === TRIANGLE_STRIP) {
      for (let k = 0; k + 2 < count; k++) {
        if (k % 2 === 0) triangle(at(k), at(k + 1), at(k + 2));
        else triangle(at(k + 1), at(k), at(k + 2));
      }
    } else {
      for (let k = 1; k + 1 < count; k++) triangle(at(0), at(k), at(k + 1));
    }
  }

  build(): Mesh {
    return { positions: new Float32Array(this.positions), indices: new Uint32Array(this.indices) };
  }
}

const COMPRESSED = /KHR_draco_mesh_compression|EXT_meshopt_compression/;

async function readGlb(glb: Uint8Array): Promise<Document> {
  const model = await readModel(glb, 'model.glb');
  const compressed = model.warnings.find((w) => COMPRESSED.test(w));
  if (compressed) throw new Error(`Compressed geometry cannot be split (${compressed}); export from an uncompressed GLB`);
  return model.doc;
}

/** Resolves a joint's node the way the runtime does: by reference, else by the part name. */
function jointNode(doc: Document, joint: Joint): Node {
  const node = findNode(doc, joint.node) ?? doc.getRoot().listNodes().find((n) => n.getName() === joint.part);
  if (!node) throw new Error(`Joint "${joint.part}": node "${joint.node}" not found in the model`);
  return node;
}

function localMatrix(node: Node): M4 {
  return Array.from(node.getMatrix());
}

/** Expresses a joint given in its node's parent frame in the object frame, `parentWorld` mapping one to the other. */
function resolveJoint(joint: Joint, parentWorld: M4, parent: string | null): PartJoint {
  const axis = normalize(joint.axis);
  const moved = transformDir(parentWorld, axis);
  const stretch = Math.hypot(...moved);
  const objectAxis = stretch > 1e-12 ? cleanV([moved[0] / stretch, moved[1] / stretch, moved[2] / stretch]) : cleanV(axis);
  const pivot = cleanV(transformPoint(parentWorld, ...(joint.pivot as V3)));
  const travel = joint.type === 'prismatic' && stretch > 1e-12 ? stretch : 1;
  return { ...joint, axis: objectAxis, pivot, min: clean(joint.min * travel), max: clean(joint.max * travel), parent };
}

/**
 * Bakes a model into triangle meshes in its rest pose and object frame: one mesh per joint holding
 * the joint node's subtree (minus any nested jointed subtree, which gets its own part), and `base`
 * for everything else. Joints are returned resolved into the object frame, in input order.
 */
export async function splitParts(glb: Uint8Array, joints: Joint[]): Promise<SplitResult> {
  const doc = await readGlb(glb);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new Error('The model has no scene');

  const owners = new Map<Node, Joint>();
  const parts = new Set<string>();
  for (const joint of joints) {
    if (parts.has(joint.part)) throw new Error(`Part "${joint.part}" has more than one joint`);
    parts.add(joint.part);
    const node = jointNode(doc, joint);
    const other = owners.get(node);
    if (other) throw new Error(`Parts "${other.part}" and "${joint.part}" share node "${joint.node}"`);
    owners.set(node, joint);
  }

  const base = new MeshBuilder();
  const builders = new Map<string, MeshBuilder>(joints.map((j) => [j.part, new MeshBuilder()]));
  const resolved = new Map<string, PartJoint>();
  const visited = new Set<Node>();

  const visit = (node: Node, parentWorld: M4, owner: string | null): void => {
    if (visited.has(node)) return;
    visited.add(node);
    const joint = owners.get(node);
    if (joint) {
      resolved.set(joint.part, resolveJoint(joint, parentWorld, owner));
      owner = joint.part;
    }
    const world = mul(parentWorld, localMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      const builder = owner === null ? base : builders.get(owner)!;
      for (const prim of mesh.listPrimitives()) builder.add(prim, world);
    }
    for (const child of node.listChildren()) visit(child, world, owner);
  };
  for (const root of scene.listChildren()) visit(root, identity(), null);

  const missing = joints.find((j) => !resolved.has(j.part));
  if (missing) throw new Error(`Joint "${missing.part}": node "${missing.node}" is not part of the model's scene`);

  return {
    base: base.build(),
    parts: Object.fromEntries(joints.map((j) => [j.part, builders.get(j.part)!.build()])),
    joints: joints.map((j) => resolved.get(j.part)!),
  };
}

/** Wavefront OBJ text: one `v` line per vertex and one 1-based `f` line per triangle. */
export function toOBJ(mesh: Mesh, name?: string): string {
  const lines: string[] = [];
  if (name) lines.push(`o ${name}`);
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${num(p[i]!)} ${num(p[i + 1]!)} ${num(p[i + 2]!)}`);
  const f = mesh.indices;
  for (let i = 0; i < f.length; i += 3) lines.push(`f ${f[i]! + 1} ${f[i + 1]! + 1} ${f[i + 2]! + 1}`);
  lines.push('');
  return lines.join('\n');
}

