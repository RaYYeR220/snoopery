import type { Animation, AnimationChannel, Node } from '@gltf-transform/core';
import { qnormalize, qslerp } from './math.ts';
import type { Q, V3 } from './math.ts';

export type TrsPath = 'translation' | 'rotation' | 'scale';
export type Interpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

/** One animation channel decoded into float64 arrays. */
export interface Track {
  node: Node;
  path: TrsPath;
  interpolation: Interpolation;
  times: Float64Array;
  /** Flat keyframe outputs; for CUBICSPLINE each key holds in-tangent, value, out-tangent. */
  values: Float64Array;
  size: 3 | 4;
}

/** Decodes a TRS channel; returns null for morph-weight channels and incomplete channels. */
export function readTrack(channel: AnimationChannel): Track | null {
  const node = channel.getTargetNode();
  const path = channel.getTargetPath();
  const sampler = channel.getSampler();
  if (!node || !sampler || (path !== 'translation' && path !== 'rotation' && path !== 'scale')) return null;
  const input = sampler.getInput();
  const output = sampler.getOutput();
  if (!input || !output) return null;
  const size = path === 'rotation' ? 4 : 3;
  if (output.getElementSize() !== size) return null;
  const interpolation = sampler.getInterpolation();
  const keys = input.getCount();
  const perKey = interpolation === 'CUBICSPLINE' ? 3 : 1;
  if (keys === 0 || output.getCount() < keys * perKey) return null;
  const times = new Float64Array(keys);
  for (let i = 0; i < keys; i++) times[i] = input.getScalar(i);
  const values = new Float64Array(keys * perKey * size);
  const el: number[] = [];
  for (let i = 0; i < keys * perKey; i++) {
    output.getElement(i, el);
    for (let j = 0; j < size; j++) values[i * size + j] = el[j]!;
  }
  return { node, path, interpolation, times, values, size };
}

export function readTracks(animation: Animation): Track[] {
  const tracks: Track[] = [];
  for (const channel of animation.listChannels()) {
    const track = readTrack(channel);
    if (track) tracks.push(track);
  }
  return tracks;
}

function keyValue(track: Track, key: number, component: 0 | 1 | 2, out: number[]): number[] {
  const perKey = track.interpolation === 'CUBICSPLINE' ? 3 : 1;
  const offset = (key * perKey + (perKey === 3 ? component : 0)) * track.size;
  for (let j = 0; j < track.size; j++) out[j] = track.values[offset + j]!;
  out.length = track.size;
  return out;
}

/** Evaluates a track at `time`, clamping to the first and last keys. */
export function sampleTrack(track: Track, time: number, out: number[]): number[] {
  const { times } = track;
  const last = times.length - 1;
  if (!(time > times[0]!)) return keyValue(track, 0, 1, out);
  if (time >= times[last]!) return keyValue(track, last, 1, out);
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo]!;
  const dt = times[hi]! - t0;
  if (track.interpolation === 'STEP' || !(dt > 0)) return keyValue(track, lo, 1, out);
  const u = (time - t0) / dt;
  const a = keyValue(track, lo, 1, []);
  const b = keyValue(track, hi, 1, []);
  if (track.interpolation === 'CUBICSPLINE') {
    const outTangent = keyValue(track, lo, 2, []);
    const inTangent = keyValue(track, hi, 0, []);
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let j = 0; j < track.size; j++) {
      out[j] = h00 * a[j]! + h10 * dt * outTangent[j]! + h01 * b[j]! + h11 * dt * inTangent[j]!;
    }
    out.length = track.size;
    if (track.size === 4) {
      const q = qnormalize(out as Q);
      for (let j = 0; j < 4; j++) out[j] = q[j]!;
    }
    return out;
  }
  if (track.size === 4) {
    const q = qslerp(a as Q, b as Q, u);
    for (let j = 0; j < 4; j++) out[j] = q[j]!;
    out.length = 4;
    return out;
  }
  for (let j = 0; j < track.size; j++) out[j] = a[j]! + (b[j]! - a[j]!) * u;
  out.length = track.size;
  return out;
}

export interface LocalPose {
  t: V3;
  r: Q;
  s: V3;
}

export function restPose(node: Node): LocalPose {
  return {
    t: [...node.getTranslation()] as V3,
    r: qnormalize([...node.getRotation()] as Q),
    s: [...node.getScale()] as V3,
  };
}

/** Local pose of every animated node at `time`; nodes absent from the map keep their rest pose. */
export function samplePoses(tracks: Track[], time: number): Map<Node, LocalPose> {
  const poses = new Map<Node, LocalPose>();
  for (const track of tracks) {
    let pose = poses.get(track.node);
    if (!pose) {
      pose = restPose(track.node);
      poses.set(track.node, pose);
    }
    const v = sampleTrack(track, time, []);
    if (track.path === 'translation') pose.t = [v[0]!, v[1]!, v[2]!];
    else if (track.path === 'scale') pose.s = [v[0]!, v[1]!, v[2]!];
    else pose.r = qnormalize([v[0]!, v[1]!, v[2]!, v[3]!]);
  }
  return poses;
}

/** Key range covered by the tracks, or null when there are none. */
export function clipRange(tracks: Track[]): [number, number] | null {
  let start = Infinity;
  let end = -Infinity;
  for (const track of tracks) {
    start = Math.min(start, track.times[0]!);
    end = Math.max(end, track.times[track.times.length - 1]!);
  }
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
}

/**
 * Sample times for a clip: `count` evenly spaced times plus every key time (so extremes that sit
 * on keyframes are hit exactly), capped at `maxKeys` key times.
 */
export function sampleTimes(tracks: Track[], count = 32, maxKeys = 512): number[] {
  const range = clipRange(tracks);
  if (!range) return [];
  const [start, end] = range;
  const set = new Set<number>();
  for (let i = 0; i < count; i++) set.add(count === 1 ? start : start + ((end - start) * i) / (count - 1));
  const keys = new Set<number>();
  for (const track of tracks) for (const t of track.times) keys.add(t);
  const sortedKeys = [...keys].sort((a, b) => a - b);
  const stride = Math.max(1, Math.ceil(sortedKeys.length / maxKeys));
  for (let i = 0; i < sortedKeys.length; i += stride) set.add(sortedKeys[i]!);
  set.add(start);
  set.add(end);
  return [...set].sort((a, b) => a - b);
}
