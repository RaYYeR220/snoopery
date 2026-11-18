import { Document, NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, mergeDocuments, unpartition } from '@gltf-transform/functions';
import type { Joint } from '@snoopery/schema';
import { unzipSync } from 'fflate';

type V3 = [number, number, number];
type Q = [number, number, number, number];

export interface UrdfJoint {
  name: string;
  type: string;
  parent: string;
  child: string;
  xyz: V3;
  rpy: V3;
  axis: V3;
  lower: number;
  upper: number;
}

export interface Urdf {
  links: { name: string; mesh?: string }[];
  joints: UrdfJoint[];
}

const attr = (tag: string | undefined, name: string) => tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const vec = (s: string | undefined, fallback: V3): V3 => {
  const v = s?.trim().split(/\s+/).map(Number);
  return v && v.length === 3 && v.every(Number.isFinite) ? (v as V3) : fallback;
};

/** Reads the subset of URDF that Lux3D articulation writes: links with one visual mesh, and their joints. */
export function parseUrdf(xml: string): Urdf {
  const links: Urdf['links'] = [];
  for (const m of xml.matchAll(/<link\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link>)/g)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    const mesh = m[2]?.match(/<mesh\b[^>]*filename="([^"]+)"/)?.[1];
    links.push({ name, ...(mesh ? { mesh } : {}) });
  }
  const joints: UrdfJoint[] = [];
  for (const m of xml.matchAll(/<joint\b([^>]*)>([\s\S]*?)<\/joint>/g)) {
    const body = m[2]!;
    const tag = (name: string) => body.match(new RegExp(`<${name}\\b[^>]*>`))?.[0];
    joints.push({
      name: attr(m[1], 'name') ?? '',
      type: attr(m[1], 'type') ?? 'fixed',
      parent: attr(tag('parent'), 'link') ?? '',
      child: attr(tag('child'), 'link') ?? '',
      xyz: vec(attr(tag('origin'), 'xyz'), [0, 0, 0]),
      rpy: vec(attr(tag('origin'), 'rpy'), [0, 0, 0]),
      axis: vec(attr(tag('axis'), 'xyz'), [1, 0, 0]),
      lower: Number(attr(tag('limit'), 'lower') ?? 0),
      upper: Number(attr(tag('limit'), 'upper') ?? 0),
    });
  }
  return { links, joints };
}

/** URDF fixed-axis roll-pitch-yaw (R = Rz·Ry·Rx) as a glTF quaternion [x, y, z, w]. */
export function quatFromRpy([r, p, y]: V3): Q {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(r / 2), Math.sin(r / 2), Math.cos(p / 2), Math.sin(p / 2), Math.cos(y / 2), Math.sin(y / 2)];
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}

function rotate([x, y, z, w]: Q, [vx, vy, vz]: V3): V3 {
  // v' = v + 2w(q×v) + 2q×(q×v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

const MOVING = new Set(['revolute', 'continuous', 'prismatic']);

/** [rest, fully open] from URDF limits. */
export function openRange(lower: number, upper: number): [number, number] {
  if (lower <= 0 && upper >= 0) return [0, Math.abs(upper) >= Math.abs(lower) ? upper : lower];
  return Math.abs(lower) <= Math.abs(upper) ? [lower, upper] : [upper, lower];
}

export interface Articulated {
  glb: Uint8Array;
  joints: Joint[];
  /** Human-readable corrections applied to what the model returned, kept on the object for honesty. */
  notes: string[];
}

/**
 * Turns Lux3D's articulation package (robot.urdf + one GLB per link) into one GLB whose node tree mirrors the
 * kinematic tree: each moving link is a node placed at its joint origin, so `jointMatrix` about the pivot moves it.
 */
export async function assembleUrdfPackage(zip: Uint8Array): Promise<Articulated> {
  const files = unzipSync(zip);
  const urdfPath = Object.keys(files).find((n) => n.toLowerCase().endsWith('.urdf'));
  if (!urdfPath) throw new Error(`articulation package has no .urdf (entries: ${Object.keys(files).join(', ')})`);
  const dir = urdfPath.includes('/') ? urdfPath.slice(0, urdfPath.lastIndexOf('/') + 1) : '';
  const urdf = parseUrdf(new TextDecoder().decode(files[urdfPath]));
  if (!urdf.links.length) throw new Error('articulation URDF has no links');

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const target = new Document();
  target.createBuffer();
  const scene = target.createScene('scene');
  target.getRoot().setDefaultScene(scene);
  const nodes = new Map<string, Node>();

  for (const link of urdf.links) {
    const node = target.createNode(link.name);
    nodes.set(link.name, node);
    if (!link.mesh) continue;
    const bytes = files[dir + link.mesh] ?? files[link.mesh];
    if (!bytes) throw new Error(`link ${link.name}: mesh ${link.mesh} missing from the package`);
    const source = await io.readBinary(bytes);
    const roots = source.getRoot().getDefaultScene()?.listChildren() ?? source.getRoot().listScenes()[0]?.listChildren() ?? [];
    const map = mergeDocuments(target, source);
    for (const root of roots) node.addChild(map.get(root) as Node);
    for (const s of target.getRoot().listScenes()) if (s !== scene) s.dispose();
  }

  const childOf = new Map(urdf.joints.map((j) => [j.child, j]));
  for (const link of urdf.links) {
    const node = nodes.get(link.name)!;
    const j = childOf.get(link.name);
    const parent = j ? nodes.get(j.parent) : undefined;
    if (!j || !parent) {
      scene.addChild(node);
      continue;
    }
    parent.addChild(node);
    node.setTranslation(j.xyz).setRotation(quatFromRpy(j.rpy));
  }
  await target.transform(unpartition());

  const notes: string[] = [];
  const joints: Joint[] = [];
  for (const j of urdf.joints) {
    if (!MOVING.has(j.type) || !nodes.has(j.child)) continue;
    const axis = rotate(quatFromRpy(j.rpy), j.axis);
    // The part rests at 0 and opens towards whichever limit lies further from it; Lux3D often writes doors and
    // lids as [-90°, 0], i.e. opening in the negative direction.
    let [min, max] = j.type === 'continuous' ? [0, Math.PI / 2] : openRange(j.lower, j.upper);
    if (j.type === 'prismatic' && Math.abs(max - min) < 0.05) {
      // Lux3D's drawer travel often comes back as ~1 cm and only the drawer front is segmented (no box behind it),
      // so the front slides out by under a third of the carcass depth: clearly open, without exposing the gap.
      const b = getBounds(nodes.get(j.parent)!);
      const depth = Math.abs(axis[0]) * (b.max[0] - b.min[0]) + Math.abs(axis[1]) * (b.max[1] - b.min[1]) + Math.abs(axis[2]) * (b.max[2] - b.min[2]);
      const travel = Math.min(0.22, Math.max(0.06, 0.3 * depth));
      notes.push(`${j.child}: travel raised from ${(max * 100).toFixed(1)} cm to ${(travel * 100).toFixed(0)} cm (30% of the ${(depth * 100).toFixed(0)} cm carcass)`);
      min = 0;
      max = travel;
    }
    joints.push({ part: j.child, node: j.child, type: j.type === 'prismatic' ? 'prismatic' : 'revolute', axis, pivot: j.xyz, min, max });
  }
  return { glb: await io.writeBinary(target), joints, notes };
}
