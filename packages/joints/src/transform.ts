import type { Joint } from '@snoopery/schema';

type JointMotion = Pick<Joint, 'type' | 'axis' | 'pivot' | 'min' | 'max'>;

/** Joint coordinate for an open fraction: t ∈ [0, 1] (clamped; NaN → 0) maps linearly onto min..max. */
export function jointValue(joint: Pick<Joint, 'min' | 'max'>, t: number): number {
  const f = t > 0 ? Math.min(t, 1) : 0;
  return joint.min + (joint.max - joint.min) * f;
}

/**
 * Column-major 4x4 transform of a part at open fraction `t`, in the part's parent frame.
 * Pre-multiply it onto the part's rest local matrix: `local(t) = jointMatrix(joint, t) · restLocal`.
 * Revolute: translate(pivot) · rotate(axis, angle) · translate(−pivot). Prismatic: translate(axis · d).
 */
export function jointMatrix(joint: JointMotion, t: number): Float32Array {
  const out = new Float32Array(16);
  out[0] = out[5] = out[10] = out[15] = 1;
  const [ax, ay, az] = joint.axis;
  const length = Math.hypot(ax, ay, az);
  if (!(length > 1e-9)) return out;
  const x = ax / length;
  const y = ay / length;
  const z = az / length;
  const value = jointValue(joint, t);
  if (joint.type === 'prismatic') {
    out[12] = x * value;
    out[13] = y * value;
    out[14] = z * value;
    return out;
  }
  const c = Math.cos(value);
  const s = Math.sin(value);
  const k = 1 - c;
  const r00 = c + x * x * k, r01 = x * y * k - z * s, r02 = x * z * k + y * s;
  const r10 = y * x * k + z * s, r11 = c + y * y * k, r12 = y * z * k - x * s;
  const r20 = z * x * k - y * s, r21 = z * y * k + x * s, r22 = c + z * z * k;
  const [px, py, pz] = joint.pivot;
  out[0] = r00; out[1] = r10; out[2] = r20;
  out[4] = r01; out[5] = r11; out[6] = r21;
  out[8] = r02; out[9] = r12; out[10] = r22;
  out[12] = px - (r00 * px + r01 * py + r02 * pz);
  out[13] = py - (r10 * px + r11 * py + r12 * pz);
  out[14] = pz - (r20 * px + r21 * py + r22 * pz);
  return out;
}
