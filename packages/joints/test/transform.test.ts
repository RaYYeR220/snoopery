import { describe, expect, it } from 'vitest';
import type { Joint } from '@snoopery/schema';
import { jointMatrix } from '../src/transform.ts';
import { HINGE, LID_OPEN, applyMat } from './fixtures.ts';
import type { V3 } from './fixtures.ts';

const lid: Joint = { part: 'lid', node: 'Lid', type: 'revolute', axis: [0, 0, 1], pivot: HINGE, min: 0, max: LID_OPEN };
const drawer: Joint = { part: 'drawer', node: 'Drawer', type: 'prismatic', axis: [1, 0, 0], pivot: [0.2, 0.6, 0], min: 0, max: 0.3 };

function close(a: V3, b: V3, eps = 1e-5): void {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(eps);
}

describe('jointMatrix', () => {
  it('returns a column-major Float32Array', () => {
    const m = jointMatrix(drawer, 1);
    expect(m).toBeInstanceOf(Float32Array);
    expect(m).toHaveLength(16);
    expect(m[12]).toBeCloseTo(0.3, 6);
    expect(m[15]).toBe(1);
  });

  it('rotates the lid edge about the hinge at t=1', () => {
    const edge: V3 = [0.8, 0.3, 0.15];
    const r = 0.6;
    close(applyMat(jointMatrix(lid, 1), edge), [HINGE[0] + r * Math.cos(LID_OPEN), HINGE[1] + r * Math.sin(LID_OPEN), 0.15]);
  });

  it('keeps points on the hinge line fixed', () => {
    close(applyMat(jointMatrix(lid, 0.37), [0.2, 0.3, -0.4]), [0.2, 0.3, -0.4]);
  });

  it('maps t linearly onto min..max', () => {
    const half = jointMatrix(lid, 0.5);
    close(applyMat(half, [0.8, 0.3, 0]), [HINGE[0] + 0.6 * Math.cos(LID_OPEN / 2), HINGE[1] + 0.6 * Math.sin(LID_OPEN / 2), 0]);
    const offset: Joint = { ...drawer, min: 0.1, max: 0.3 };
    expect(jointMatrix(offset, 0)[12]).toBeCloseTo(0.1, 6);
    expect(jointMatrix(offset, 0.5)[12]).toBeCloseTo(0.2, 6);
  });

  it('clamps t outside [0, 1]', () => {
    expect(Array.from(jointMatrix(lid, 1.7))).toEqual(Array.from(jointMatrix(lid, 1)));
    expect(Array.from(jointMatrix(lid, -3))).toEqual(Array.from(jointMatrix(lid, 0)));
    expect(Array.from(jointMatrix(drawer, Number.NaN))).toEqual(Array.from(jointMatrix(drawer, 0)));
    close(applyMat(jointMatrix(lid, -3), [0.8, 0.3, 0]), [0.8, 0.3, 0]);
  });

  it('normalises a non-unit axis', () => {
    const scaled: Joint = { ...drawer, axis: [0, 0, 2] };
    expect(jointMatrix(scaled, 1)[14]).toBeCloseTo(0.3, 6);
  });

  it('returns identity for a degenerate axis', () => {
    const broken: Joint = { ...lid, axis: [0, 0, 0] };
    expect(Array.from(jointMatrix(broken, 1))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});
