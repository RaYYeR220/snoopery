/** Float64 vector, quaternion and affine-matrix helpers used by joint recovery. */

export type V3 = [number, number, number];
/** Quaternion as [x, y, z, w], matching glTF. */
export type Q = [number, number, number, number];
/** Column-major 4x4 matrix. */
export type M4 = number[];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function normalize(a: V3): V3 {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
}

export function qnormalize(q: Q): Q {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 0 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}

export function qmul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];

/** Rotates `v` by the unit quaternion `q`. */
export function qrotate(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Spherical interpolation along the shorter arc. */
export function qslerp(a: Q, b: Q, t: number): Q {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb: Q = b;
  if (cos < 0) {
    cos = -cos;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  let k0: number;
  let k1: number;
  if (cos > 1 - 1e-9) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const omega = Math.acos(cos);
    const sin = Math.sin(omega);
    k0 = Math.sin((1 - t) * omega) / sin;
    k1 = Math.sin(t * omega) / sin;
  }
  return qnormalize([
    k0 * a[0] + k1 * bb[0],
    k0 * a[1] + k1 * bb[1],
    k0 * a[2] + k1 * bb[2],
    k0 * a[3] + k1 * bb[3],
  ]);
}

/** Rotation angle of a unit quaternion in [0, π]. */
export function qangle(q: Q): number {
  return 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));
}

/** 3x3 rotation matrix (row-major, rows r0..r2) of a unit quaternion. */
export function qmat3(q: Q): number[] {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

export function composeTRS(t: V3, r: Q, s: V3): M4 {
  const m = qmat3(r);
  return [
    m[0]! * s[0], m[3]! * s[0], m[6]! * s[0], 0,
    m[1]! * s[1], m[4]! * s[1], m[7]! * s[1], 0,
    m[2]! * s[2], m[5]! * s[2], m[8]! * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export function identity(): M4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mul(a: ArrayLike<number>, b: ArrayLike<number>): M4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

/** Inverse of an affine matrix (last row 0 0 0 1); identity when singular. */
export function invertAffine(m: ArrayLike<number>): M4 {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return identity();
  const inv = 1 / det;
  const r00 = A * inv, r01 = -(b * i - c * h) * inv, r02 = (b * f - c * e) * inv;
  const r10 = B * inv, r11 = (a * i - c * g) * inv, r12 = -(a * f - c * d) * inv;
  const r20 = C * inv, r21 = -(a * h - b * g) * inv, r22 = (a * e - b * d) * inv;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  return [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    -(r00 * tx + r01 * ty + r02 * tz), -(r10 * tx + r11 * ty + r12 * tz), -(r20 * tx + r21 * ty + r22 * tz), 1,
  ];
}

export function transformPoint(m: ArrayLike<number>, p: V3): V3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

export function transformDir(m: ArrayLike<number>, v: V3): V3 {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
}

/** Largest column norm of the linear part: the factor applied to lengths at most. */
export function maxScale(m: ArrayLike<number>): number {
  return Math.max(
    Math.hypot(m[0]!, m[1]!, m[2]!),
    Math.hypot(m[4]!, m[5]!, m[6]!),
    Math.hypot(m[8]!, m[9]!, m[10]!),
  );
}

/** Any unit vector perpendicular to the unit vector `a`. */
export function perpendicular(a: V3): V3 {
  const helper: V3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(a, helper));
}

export function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export const roundV = (v: V3, digits = 6): V3 => [round(v[0], digits), round(v[1], digits), round(v[2], digits)];
