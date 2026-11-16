/** Small float64 helpers shared by the exporters. Matrices are column-major 4x4 arrays, as in glTF. */

export type V3 = [number, number, number];
/** Quaternion as [w, x, y, z] (real part first), the order used by both MJCF and USD. */
export type Quat = [number, number, number, number];
export type M4 = number[];

export const identity = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: ArrayLike<number>, b: ArrayLike<number>): M4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

export const transformPoint = (m: ArrayLike<number>, x: number, y: number, z: number): V3 => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
  m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
];

export const transformDir = (m: ArrayLike<number>, v: V3): V3 => [
  m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
  m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
  m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
];

/** Determinant of the linear part; negative when the transform mirrors. */
export const det3 = (m: ArrayLike<number>): number =>
  m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);

export const len = (v: V3): number => Math.hypot(v[0], v[1], v[2]);
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function normalize(v: V3): V3 {
  const l = len(v);
  if (!(l > 1e-12)) throw new Error(`Cannot normalise a zero-length axis (${v.join(', ')})`);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Rounds away float noise (and negative zero) without touching meaningful digits. */
export function clean(x: number, digits = 12): number {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

export const cleanV = (v: V3): V3 => [clean(v[0]), clean(v[1]), clean(v[2])];

/** Compact decimal for text formats: at most `digits` decimals, no trailing zeros, no "-0". */
export function num(x: number, digits = 6): string {
  if (!Number.isFinite(x)) throw new Error(`Non-finite number in export: ${x}`);
  const s = String(Number(x.toFixed(digits)));
  return s === '-0' ? '0' : s;
}

export const nums = (v: ArrayLike<number>, digits = 6, sep = ' '): string => Array.from(v, (x) => num(x, digits)).join(sep);

/** Rotation about the vertical (+Y in a Y-up frame, +Z in a Z-up frame) by `angle` radians. */
export const yawQuat = (angle: number, up: 'y' | 'z'): Quat =>
  up === 'y' ? [Math.cos(angle / 2), 0, Math.sin(angle / 2), 0] : [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)];

/** Y-up (glTF, runtime) to Z-up (MuJoCo): x → x, y → z, z → −y. A +90° turn about X, so handedness is kept. */
export const zUp = (v: ArrayLike<number>): V3 => [v[0]!, -v[2]!, v[1]!];

export const RAD_TO_DEG = 180 / Math.PI;
