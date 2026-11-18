import { describe, expect, it } from 'vitest';
import { decodeSpz, encodeSpz, uprightSplat, type Splat } from '../src/pipeline/upright';

/** A Z-up "room": a dense floor plane at z = -1.2, sparse walls up to z = 1.1, 6 m by 4 m. */
function zUpRoom(): Splat {
  const pts: number[] = [];
  for (let i = 0; i < 400; i++) pts.push(-3 + (i % 20) * 0.3, -2 + Math.floor(i / 20) * 0.2, -1.2);
  for (let i = 0; i < 100; i++) pts.push(-3 + (i % 10) * 0.6, 2, -1.2 + (Math.floor(i / 10) / 9) * 2.3);
  const n = pts.length / 3;
  const rotations = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) rotations[i * 4 + 3] = 1;
  const sh = new Uint8Array(n * 15 * 3).fill(128);
  // Band 1 for point 0, red channel: s1 = 0.5 (a colour that varies with -y of the view direction).
  sh[0] = 192;
  return { version: 2, n, shDegree: 3, fractionalBits: 12, flags: 0, positions: new Float64Array(pts), alphas: new Uint8Array(n).fill(200), colors: new Uint8Array(n * 3).fill(100), scales: new Uint8Array(n * 3).fill(80), rotations, sh };
}

describe('upright', () => {
  it('bakes a Z-up reconstruction onto +Y with the floor at 0, through an SPZ round trip', () => {
    const s = decodeSpz(encodeSpz(zUpRoom()));
    const r = uprightSplat(s);
    expect(r.up).toBe('+z');
    expect(r.heightM).toBeCloseTo(2.3, 1);
    const back = decodeSpz(encodeSpz(s));
    // (x, y, z) → (x, z − floor, −y): the first floor point (-3, -2, -1.2) lands at (-3, 0, 2).
    expect(back.positions[0]).toBeCloseTo(-3, 3);
    expect(back.positions[1]).toBeCloseTo(0, 3);
    expect(back.positions[2]).toBeCloseTo(2, 3);
    // Identity orientations become the scene rotation: -90° about X.
    expect(back.rotations[0]).toBeCloseTo(-Math.SQRT1_2, 1);
    expect(back.rotations[3]).toBeCloseTo(Math.SQRT1_2, 1);
    // SH band 1 is rotated with the scene (s1 → s2 for this rotation) and higher bands are dropped.
    expect(back.shDegree).toBe(1);
    expect((back.sh[3]! - 128) / 128).toBeCloseTo(0.5, 1);
    expect(back.sh[0]).toBe(128);
  });

  it('leaves a Y-up room where it is', () => {
    const s = zUpRoom();
    for (let i = 0; i < s.n; i++) [s.positions[i * 3 + 1], s.positions[i * 3 + 2]] = [s.positions[i * 3 + 2]!, -s.positions[i * 3 + 1]!];
    expect(uprightSplat(s).up).toBe('+y');
  });
});
