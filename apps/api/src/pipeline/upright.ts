import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Phone reconstructions come back in the camera's frame — often Z-up — while the player, the walk controller and
 * voxel collision assume Y-up with the floor at y = 0. This rewrites an SPZ (read v2 or v3, written as v2) so its gravity axis is +Y and
 * the floor sits at 0. Positions move by a signed axis permutation, which is exact in SPZ's fixed point; rotations
 * are composed with the same rotation; SH band 1 is rotated and higher bands are dropped.
 */

type M3 = [number, number, number, number, number, number, number, number, number]; // row-major

export interface Splat {
  version: number;
  n: number;
  shDegree: number;
  fractionalBits: number;
  flags: number;
  positions: Float64Array; // metres, xyz per point
  alphas: Uint8Array;
  colors: Uint8Array;
  scales: Uint8Array;
  rotations: Float64Array; // unit quaternion xyzw per point
  sh: Uint8Array; // per point: coefficients × rgb
}

const SH_DIM = [0, 3, 8, 15];

export function decodeSpz(file: Uint8Array): Splat {
  const raw = gunzipSync(file);
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint32(0, true) !== 0x5053474e) throw new Error('not an SPZ file');
  const version = v.getUint32(4, true);
  if (version !== 2 && version !== 3) throw new Error(`SPZ version ${version} is not supported`);
  const n = v.getUint32(8, true);
  const shDegree = raw[12]!;
  const fractionalBits = raw[13]!;
  const flags = raw[14]!;
  let o = 16;
  const positions = new Float64Array(n * 3);
  const scale = 1 / (1 << fractionalBits);
  for (let i = 0; i < n * 3; i++, o += 3) {
    let x = raw[o]! | (raw[o + 1]! << 8) | (raw[o + 2]! << 16);
    if (x & 0x800000) x -= 1 << 24;
    positions[i] = x * scale;
  }
  const alphas = raw.slice(o, (o += n));
  const colors = raw.slice(o, (o += n * 3));
  const scales = raw.slice(o, (o += n * 3));
  const rotations = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (version === 2) {
      const x = raw[o++]! / 127.5 - 1;
      const y = raw[o++]! / 127.5 - 1;
      const z = raw[o++]! / 127.5 - 1;
      rotations.set([x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z))], i * 4);
      continue;
    }
    // v3 "smallest three": top 2 bits index the largest component; the other three are 1 sign + 9 magnitude
    // bits each, scaled to [0, 1/√2], packed from the last component down.
    let comp = (raw[o]! | (raw[o + 1]! << 8) | (raw[o + 2]! << 16) | (raw[o + 3]! << 24)) >>> 0;
    o += 4;
    const largest = comp >>> 30;
    const q = [0, 0, 0, 0];
    let sum = 0;
    for (let k = 3; k >= 0; k--) {
      if (k === largest) continue;
      const mag = comp & 0x1ff;
      const neg = (comp >>> 9) & 1;
      comp >>>= 10;
      const val = (Math.SQRT1_2 * mag) / 0x1ff;
      q[k] = neg ? -val : val;
      sum += val * val;
    }
    q[largest] = Math.sqrt(Math.max(0, 1 - sum));
    rotations.set(q, i * 4);
  }
  const sh = raw.slice(o, o + n * SH_DIM[shDegree]! * 3);
  return { version, n, shDegree, fractionalBits, flags, positions, alphas, colors, scales, rotations, sh };
}

export function encodeSpz(s: Splat): Uint8Array {
  const dim = SH_DIM[s.shDegree]!;
  const out = new Uint8Array(16 + s.n * (9 + 1 + 3 + 3 + 3 + dim * 3));
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x5053474e, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, s.n, true);
  out[12] = s.shDegree;
  out[13] = s.fractionalBits;
  out[14] = s.flags;
  let o = 16;
  const k = 1 << s.fractionalBits;
  for (let i = 0; i < s.n * 3; i++, o += 3) {
    const x = Math.max(-0x800000, Math.min(0x7fffff, Math.round(s.positions[i]! * k))) & 0xffffff;
    out[o] = x & 0xff;
    out[o + 1] = (x >> 8) & 0xff;
    out[o + 2] = (x >> 16) & 0xff;
  }
  out.set(s.alphas, o);
  o += s.n;
  out.set(s.colors, o);
  o += s.n * 3;
  out.set(s.scales, o);
  o += s.n * 3;
  for (let i = 0; i < s.n; i++) {
    let [x, y, z, w] = [s.rotations[i * 4]!, s.rotations[i * 4 + 1]!, s.rotations[i * 4 + 2]!, s.rotations[i * 4 + 3]!];
    const len = Math.hypot(x, y, z, w) || 1;
    if (w < 0) [x, y, z, w] = [-x, -y, -z, -w];
    for (const c of [x / len, y / len, z / len]) out[o++] = Math.max(0, Math.min(255, Math.round(c * 127.5 + 127.5)));
  }
  out.set(s.sh, o);
  return gzipSync(out, { level: 6 });
}

function percentile(values: Float64Array, axis: number, ps: number[]): number[] {
  const a = new Float64Array(values.length / 3);
  for (let i = 0; i < a.length; i++) a[i] = values[i * 3 + axis]!;
  a.sort();
  return ps.map((p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!);
}

export interface Upright {
  /** The axis the reconstruction used as "up", e.g. "+z". */
  up: string;
  /** Room footprint centre on the new floor, for a default spawn point. */
  centre: [number, number];
  heightM: number;
}

/** Gravity: the room's shortest extent; the floor is the end where points pile up in a thin plane. */
export function detectUp(s: Splat): { up: string; floor: number; heightM: number } {
  const stats = [0, 1, 2].map((axis) => {
    const [p1, p5, p95, p99] = percentile(s.positions, axis, [1, 5, 95, 99]) as [number, number, number, number];
    return { axis, extent: p99 - p1, lowBand: p5 - p1, highBand: p99 - p95, p1, p99 };
  });
  const v = stats.reduce((a, b) => (b.extent < a.extent ? b : a));
  const sign = v.lowBand <= v.highBand ? 1 : -1; // floor at the low end → up is +axis
  return { up: `${sign > 0 ? '+' : '-'}${'xyz'[v.axis]}`, floor: sign > 0 ? v.p1 : -v.p99, heightM: v.extent };
}

/** Footprint centre (x, z) of a Y-up splat. */
export function footprintCentre(s: Splat): [number, number] {
  const [x1, x2] = percentile(s.positions, 0, [5, 95]) as [number, number];
  const [z1, z2] = percentile(s.positions, 2, [5, 95]) as [number, number];
  return [(x1 + x2) / 2, (z1 + z2) / 2];
}

/** Rotates gravity onto +Y and puts the floor at y = 0. */
export function uprightSplat(s: Splat, detected = detectUp(s)): Upright {
  const { up, floor } = detected;

  // Signed permutation sending the up vector to +Y (a proper rotation, det = +1).
  const R: Record<string, M3> = {
    '+y': [1, 0, 0, 0, 1, 0, 0, 0, 1],
    '-y': [1, 0, 0, 0, -1, 0, 0, 0, -1],
    '+z': [1, 0, 0, 0, 0, 1, 0, -1, 0],
    '-z': [1, 0, 0, 0, 0, -1, 0, 1, 0],
    '+x': [0, -1, 0, 1, 0, 0, 0, 0, 1],
    '-x': [0, 1, 0, -1, 0, 0, 0, 0, 1],
  };
  const m = R[up]!;
  const q = quatFromMatrix(m);
  const P = s.positions;
  for (let i = 0; i < s.n; i++) {
    const [x, y, z] = [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
    P[i * 3] = m[0] * x + m[1] * y + m[2] * z;
    P[i * 3 + 1] = m[3] * x + m[4] * y + m[5] * z - floor;
    P[i * 3 + 2] = m[6] * x + m[7] * y + m[8] * z;
    const r = mul(q, [s.rotations[i * 4]!, s.rotations[i * 4 + 1]!, s.rotations[i * 4 + 2]!, s.rotations[i * 4 + 3]!]);
    s.rotations.set(r, i * 4);
  }

  // SH band 1 is a linear function of the view direction: colour ∝ −y·s1 + z·s2 − x·s3, i.e. c = (−s3, −s1, s2).
  // Rotate c with the scene, then keep only that band.
  if (s.shDegree > 0) {
    const dim = SH_DIM[s.shDegree]!;
    const out = new Uint8Array(s.n * 9);
    for (let i = 0; i < s.n; i++) {
      for (let ch = 0; ch < 3; ch++) {
        const at = (k: number) => (s.sh[(i * dim + k) * 3 + ch]! - 128) / 128;
        const c = [-at(2), -at(0), at(1)];
        const r = [m[0] * c[0]! + m[1] * c[1]! + m[2] * c[2]!, m[3] * c[0]! + m[4] * c[1]! + m[5] * c[2]!, m[6] * c[0]! + m[7] * c[1]! + m[8] * c[2]!];
        const s1 = -r[1]!;
        const s2 = r[2]!;
        const s3 = -r[0]!;
        [s1, s2, s3].forEach((val, k) => (out[(i * 3 + k) * 3 + ch] = Math.max(0, Math.min(255, Math.round(val * 128 + 128)))));
      }
    }
    s.sh = out;
    s.shDegree = 1;
  }

  return { up, centre: footprintCentre(s), heightM: detected.heightM };
}

function quatFromMatrix(m: M3): [number, number, number, number] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const t = a + e + i;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    return [(h - f) / s, (c - g) / s, (d - b) / s, s / 4];
  }
  if (a > e && a > i) {
    const s = Math.sqrt(1 + a - e - i) * 2;
    return [s / 4, (b + d) / s, (c + g) / s, (h - f) / s];
  }
  if (e > i) {
    const s = Math.sqrt(1 + e - a - i) * 2;
    return [(b + d) / s, s / 4, (f + h) / s, (c - g) / s];
  }
  const s = Math.sqrt(1 + i - a - e) * 2;
  return [(c + g) / s, (f + h) / s, s / 4, (d - b) / s];
}

function mul(a: number[], b: number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
