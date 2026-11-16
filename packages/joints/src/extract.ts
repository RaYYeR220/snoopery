import type { Document, Node } from '@gltf-transform/core';
import type { Joint, JointType } from '@snoopery/schema';
import {
  add,
  cross,
  dot,
  identity,
  invertAffine,
  len,
  maxScale,
  normalize,
  perpendicular,
  qangle,
  qconj,
  qmul,
  qrotate,
  round,
  roundV,
  scale,
  sub,
} from './math.ts';
import type { Q, V3 } from './math.ts';
import { readTracks, restPose, samplePoses, sampleTimes } from './sample.ts';
import type { LocalPose } from './sample.ts';
import {
  basePartName,
  boxCenter,
  defaultScene,
  meshBounds,
  nodeRef,
  sceneNodes,
  uniqueNames,
  worldMatrices,
} from './scene.ts';

export interface ExtractOptions {
  /** Evenly spaced samples per clip; key times are always added on top. Default 32. */
  samples?: number;
  /** Rotation (radians) a part must exceed to count as revolute. Default 3°. */
  minAngle?: number;
  /** Displacement (metres, world scale) a part must exceed to count as prismatic. Default 5 mm. */
  minDisplacement?: number;
}

interface Candidate {
  node: Node;
  type: JointType;
  axis: V3;
  pivot: V3;
  min: number;
  max: number;
  clip: string;
  /** Motion size relative to the detection threshold, used to arbitrate conflicting clips. */
  strength: number;
}

const DEG = Math.PI / 180;
const AXIS_AGREEMENT = Math.cos(10 * DEG);

/**
 * Recovers explicit joints from node TRS animation.
 *
 * Every node whose motion relative to its parent is non-trivial in some clip becomes one joint;
 * nodes that only ride along with a moving ancestor are skipped. Axis, pivot and limits are in the
 * part's parent frame, and limits are measured from the node's rest (static) pose, so the part's
 * local matrix at parameter t is `jointMatrix(joint, t) · restLocal`. When ancestors carry no
 * transform this is model space in metres. Results are ordered by scene traversal.
 */
export function extractJoints(doc: Document, options: ExtractOptions = {}): Joint[] {
  const samples = Math.max(2, Math.floor(options.samples ?? 32));
  const minAngle = options.minAngle ?? 3 * DEG;
  const minDisplacement = options.minDisplacement ?? 0.005;
  const scene = defaultScene(doc);
  if (!scene) return [];
  const { nodes, parent } = sceneNodes(scene);
  const inScene = new Set(nodes);
  const restWorld = worldMatrices(scene);
  const found = new Map<Node, Candidate>();

  doc.getRoot().listAnimations().forEach((animation, index) => {
    const tracks = readTracks(animation).filter((t) => inScene.has(t.node));
    if (tracks.length === 0) return;
    const clip = animation.getName() || `animation_${index}`;
    const poses = sampleTimes(tracks, samples).map((time) => samplePoses(tracks, time));
    const animated = new Set(tracks.map((t) => t.node));
    for (const node of nodes) {
      if (!animated.has(node)) continue;
      const trajectory = poses.map((p) => p.get(node)!);
      if (isStill(trajectory)) continue;
      const parentNode = parent.get(node) ?? null;
      const parentWorld = parentNode ? restWorld.get(parentNode)! : identity();
      const box = meshBounds([node], restWorld, invertAffine(parentWorld));
      const rest = restPose(node);
      const candidate = analyse({
        node,
        clip,
        rest,
        centre: box ? boxCenter(box) : rest.t,
        trajectory,
        unit: maxScale(parentWorld) || 1,
        minAngle,
        minDisplacement,
      });
      if (candidate) merge(found, candidate);
    }
  });

  const ordered = nodes.filter((n) => found.has(n)).map((n) => found.get(n)!);
  const parts = uniqueNames(ordered.map((c) => basePartName(doc, c.node)));
  return ordered.map((c, i) => ({
    part: parts[i]!,
    node: nodeRef(doc, c.node),
    type: c.type,
    axis: roundV(c.axis),
    pivot: roundV(c.pivot),
    min: round(c.min),
    max: round(c.max),
    clip: c.clip,
  }));
}

interface Motion {
  node: Node;
  clip: string;
  rest: LocalPose;
  /** Part bounding-box centre in the parent frame, rest pose. */
  centre: V3;
  trajectory: LocalPose[];
  /** Parent-frame length to world metres. */
  unit: number;
  minAngle: number;
  minDisplacement: number;
}

/** True when no sampled pose differs from the first (constant channels). */
function isStill(trajectory: LocalPose[]): boolean {
  const [first] = trajectory;
  if (!first) return true;
  return trajectory.every(
    (pose) =>
      len(sub(pose.t, first.t)) < 1e-9 &&
      Math.abs(Math.abs(pose.r[0] * first.r[0] + pose.r[1] * first.r[1] + pose.r[2] * first.r[2] + pose.r[3] * first.r[3]) - 1) < 1e-12,
  );
}

const canonical = (q: Q): Q => (q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);
const vec = (q: Q): V3 => [q[0], q[1], q[2]];

/** Signed rotation angle of `q` about the unit `axis`, in (-π, π]. */
function signedAngle(q: Q, axis: V3): number {
  const c = canonical(q);
  return 2 * Math.atan2(dot(vec(c), axis), c[3]);
}

function analyse(m: Motion): Candidate | null {
  const first = m.trajectory[0]!;
  const toFirst = qmul(first.r, qconj(m.rest.r));
  const centreFirst = add(qrotate(toFirst, sub(m.centre, m.rest.t)), first.t);
  const steps = m.trajectory.map((pose) => {
    const q = canonical(qmul(pose.r, qconj(first.r)));
    const t = sub(pose.t, qrotate(q, first.t));
    return { q, t, disp: sub(add(qrotate(q, centreFirst), t), centreFirst) };
  });

  let maxAngle = 0;
  let kAngle = 0;
  let maxDisp = 0;
  let kDisp = 0;
  steps.forEach((s, k) => {
    const a = qangle(s.q);
    if (a > maxAngle) [maxAngle, kAngle] = [a, k];
    const d = len(s.disp);
    if (d > maxDisp) [maxDisp, kDisp] = [d, k];
  });

  if (maxAngle > m.minAngle) {
    const axis = normalize(vec(steps[kAngle]!.q));
    let prev = 0;
    const angles = steps.map((s) => {
      let a = signedAngle(s.q, axis);
      while (a - prev > Math.PI) a -= 2 * Math.PI;
      while (a - prev < -Math.PI) a += 2 * Math.PI;
      prev = a;
      return a;
    });
    const offset = signedAngle(toFirst, axis);
    return {
      node: m.node,
      type: 'revolute',
      axis,
      pivot: solvePivot(steps, axis, m.centre),
      min: Math.min(...angles) + offset,
      max: Math.max(...angles) + offset,
      clip: m.clip,
      strength: maxAngle / m.minAngle,
    };
  }

  if (maxDisp * m.unit > m.minDisplacement) {
    const axis = normalize(steps[kDisp]!.disp);
    const along = steps.map((s) => dot(s.disp, axis));
    const offset = dot(sub(centreFirst, m.centre), axis);
    return {
      node: m.node,
      type: 'prismatic',
      axis,
      pivot: m.centre,
      min: Math.min(...along) + offset,
      max: Math.max(...along) + offset,
      clip: m.clip,
      strength: (maxDisp * m.unit) / m.minDisplacement,
    };
  }
  return null;
}

/**
 * Least-squares fixed point of the sampled rotations: (I − R_k) p = t_k for every sample,
 * constrained to the plane through `centre` perpendicular to `axis` (the solution is a line
 * along the axis; the constraint picks the point level with the part).
 */
function solvePivot(steps: { q: Q; t: V3 }[], axis: V3, centre: V3): V3 {
  const u = perpendicular(axis);
  const v = cross(axis, u);
  const apply = (q: Q, x: V3): V3 => sub(x, qrotate(q, x));
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let ru = 0;
  let rv = 0;
  for (const { q, t } of steps) {
    const au = apply(q, u);
    const av = apply(q, v);
    const b = sub(t, apply(q, centre));
    suu += dot(au, au);
    suv += dot(au, av);
    svv += dot(av, av);
    ru += dot(au, b);
    rv += dot(av, b);
  }
  const damping = 1e-12 * (suu + svv);
  suu += damping;
  svv += damping;
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-18)) return centre;
  const alpha = (svv * ru - suv * rv) / det;
  const beta = (suu * rv - suv * ru) / det;
  return add(centre, add(scale(u, alpha), scale(v, beta)));
}

function merge(found: Map<Node, Candidate>, next: Candidate): void {
  const prev = found.get(next.node);
  if (!prev) {
    found.set(next.node, next);
    return;
  }
  const agreement = dot(prev.axis, next.axis);
  if (prev.type !== next.type || Math.abs(agreement) < AXIS_AGREEMENT) {
    if (next.strength > prev.strength) found.set(next.node, next);
    return;
  }
  const aligned: Candidate =
    agreement >= 0 ? next : { ...next, axis: scale(next.axis, -1), min: -next.max, max: -next.min };
  const primary = aligned.max - aligned.min > prev.max - prev.min ? aligned : prev;
  found.set(next.node, {
    ...primary,
    min: Math.min(prev.min, aligned.min),
    max: Math.max(prev.max, aligned.max),
    strength: Math.max(prev.strength, next.strength),
  });
}
