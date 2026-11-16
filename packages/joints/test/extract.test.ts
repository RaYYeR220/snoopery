import { describe, expect, it } from 'vitest';
import { extractJoints } from '../src/extract.ts';
import { jointMatrix } from '../src/transform.ts';
import {
  HINGE,
  LID_OPEN,
  addNode,
  animate,
  applyMat,
  drawerOnSlide,
  lidOnHinge,
  linspace,
  newDoc,
  quatAxisAngle,
  rotateVec,
} from './fixtures.ts';
import type { V3 } from './fixtures.ts';

function distToHingeLine(p: V3): number {
  return Math.hypot(p[0] - HINGE[0], p[1] - HINGE[1]);
}

describe('extractJoints', () => {
  it('recovers a revolute lid: axis, pivot on the hinge line and the opening range', () => {
    const { doc } = lidOnHinge();
    const joints = extractJoints(doc);
    expect(joints).toHaveLength(1);
    const lid = joints[0]!;
    expect(lid.type).toBe('revolute');
    expect(lid.part).toBe('lid');
    expect(lid.node).toBe('Lid');
    expect(lid.clip).toBe('open_lid');
    expect(Math.abs(Math.abs(lid.axis[2]) - 1)).toBeLessThan(1e-3);
    expect(Math.abs(lid.axis[0])).toBeLessThan(1e-3);
    expect(Math.abs(lid.axis[1])).toBeLessThan(1e-3);
    expect(distToHingeLine(lid.pivot)).toBeLessThan(1e-3);
    expect(lid.min).toBeCloseTo(0, 6);
    expect(lid.max).toBeCloseTo(LID_OPEN, 3);
  });

  it('orients the revolute axis so that opening is a positive angle', () => {
    const { doc } = newDoc();
    const scene = doc.getRoot().getDefaultScene()!;
    const flap = addNode(doc, scene, 'Flap', { box: [[0, -0.01, -0.1], [0.3, 0.01, 0.1]] });
    const anim = doc.createAnimation('swing');
    const angles = linspace(0, -LID_OPEN, 11);
    animate(doc, anim, flap, 'rotation', linspace(0, 1, 11), angles.map((a) => quatAxisAngle([0, 0, 1], a)));
    const [joint] = extractJoints(doc);
    expect(joint!.axis[2]).toBeCloseTo(-1, 3);
    expect(joint!.min).toBeCloseTo(0, 6);
    expect(joint!.max).toBeCloseTo(LID_OPEN, 3);
    expect(Math.hypot(joint!.pivot[0], joint!.pivot[1])).toBeLessThan(1e-6);
  });

  it('unwraps rotations past 180 degrees', () => {
    const { doc, scene } = newDoc();
    const tray = addNode(doc, scene, 'Turntable', { box: [[-0.2, 0, -0.2], [0.2, 0.02, 0.2]] });
    const anim = doc.createAnimation('spin');
    const times = linspace(0, 1, 28);
    animate(doc, anim, tray, 'rotation', times, times.map((t) => quatAxisAngle([0, 1, 0], t * 1.5 * Math.PI)));
    const [joint] = extractJoints(doc);
    expect(joint!.type).toBe('revolute');
    expect(joint!.axis[1]).toBeCloseTo(1, 4);
    expect(joint!.min).toBeCloseTo(0, 6);
    expect(joint!.max).toBeCloseTo(1.5 * Math.PI, 4);
  });

  it('recovers a prismatic drawer sliding 0.3 m along +X', () => {
    const { doc } = drawerOnSlide();
    const joints = extractJoints(doc);
    expect(joints).toHaveLength(1);
    const drawer = joints[0]!;
    expect(drawer.type).toBe('prismatic');
    expect(drawer.part).toBe('top_drawer');
    expect(drawer.node).toBe('Top Drawer');
    expect(drawer.axis[0]).toBeCloseTo(1, 6);
    expect(drawer.axis[1]).toBeCloseTo(0, 6);
    expect(drawer.axis[2]).toBeCloseTo(0, 6);
    expect(drawer.min).toBeCloseTo(0, 6);
    expect(drawer.max).toBeCloseTo(0.3, 5);
  });

  it('reports no joint for a document without motion', () => {
    const { doc, scene } = newDoc();
    addNode(doc, scene, 'Table', { box: [[-0.5, 0, -0.5], [0.5, 0.75, 0.5]] });
    expect(extractJoints(doc)).toEqual([]);
  });

  it('ignores static nodes and constant channels in an animated document', () => {
    const { doc, body, anim } = drawerOnSlide();
    animate(doc, anim, body, 'translation', [0, 1], [[0, 0, 0], [0, 0, 0]]);
    const joints = extractJoints(doc);
    expect(joints.map((j) => j.part)).toEqual(['top_drawer']);
  });

  it('does not report a child that only rides along with a moving part', () => {
    const { doc, knob, anim } = drawerOnSlide();
    animate(doc, anim, knob, 'translation', [0, 1], [[0.2, 0, 0], [0.2, 0, 0]]);
    const joints = extractJoints(doc);
    expect(joints).toHaveLength(1);
    expect(joints[0]!.node).toBe('Top Drawer');
  });

  it('reports a child that moves relative to a moving parent, in the parent frame', () => {
    const { doc, knob, anim } = drawerOnSlide();
    const times = linspace(0, 1, 11);
    animate(doc, anim, knob, 'rotation', times, times.map((t) => quatAxisAngle([1, 0, 0], t * Math.PI / 2)));
    const joints = extractJoints(doc);
    expect(joints.map((j) => [j.part, j.type])).toEqual([
      ['top_drawer', 'prismatic'],
      ['knob', 'revolute'],
    ]);
    const knobJoint = joints[1]!;
    expect(Math.abs(knobJoint.axis[0])).toBeCloseTo(1, 6);
    expect(knobJoint.pivot[1]).toBeCloseTo(0, 6);
    expect(knobJoint.pivot[2]).toBeCloseTo(0, 6);
    expect(Math.abs(knobJoint.max - knobJoint.min)).toBeCloseTo(Math.PI / 2, 4);
  });

  it('extracts one joint per part from two clips, recording each clip', () => {
    const { doc, scene } = newDoc();
    addNode(doc, scene, 'Body', { box: [[-0.4, 0, -0.25], [0.4, 0.8, 0.25]] });
    const door = addNode(doc, scene, 'Door', { box: [[0, -0.35, -0.01], [0.4, 0.35, 0.01]], translation: [-0.4, 0.4, 0.26] });
    const drawer = addNode(doc, scene, 'Drawer', { box: [[-0.3, -0.05, -0.2], [0.3, 0.05, 0.2]], translation: [0, 0.05, 0.05] });
    const doorAnim = doc.createAnimation('door_open');
    const times = linspace(0, 1, 11);
    animate(doc, doorAnim, door, 'rotation', times, times.map((t) => quatAxisAngle([0, -1, 0], t * 1.5)));
    const drawerAnim = doc.createAnimation('drawer_open');
    animate(doc, drawerAnim, drawer, 'translation', [0, 1], [[0, 0.05, 0.05], [0, 0.05, 0.35]]);
    const joints = extractJoints(doc);
    expect(joints.map((j) => [j.part, j.type, j.clip])).toEqual([
      ['door', 'revolute', 'door_open'],
      ['drawer', 'prismatic', 'drawer_open'],
    ]);
    expect(joints[0]!.axis[1]).toBeCloseTo(-1, 4);
    expect(joints[0]!.pivot[0]).toBeCloseTo(-0.4, 4);
    expect(joints[0]!.pivot[2]).toBeCloseTo(0.26, 4);
    expect(joints[0]!.max).toBeCloseTo(1.5, 4);
    expect(joints[1]!.axis[2]).toBeCloseTo(1, 6);
    expect(joints[1]!.max).toBeCloseTo(0.3, 5);
  });

  it('merges the same part across clips into the union of ranges', () => {
    const { doc, drawer } = drawerOnSlide();
    const half = doc.createAnimation('peek');
    animate(doc, half, drawer, 'translation', [0, 1, 2], [[0.2, 0.6, 0], [0.15, 0.6, 0], [0.35, 0.6, 0]]);
    const joints = extractJoints(doc);
    expect(joints).toHaveLength(1);
    expect(joints[0]!.clip).toBe('open_drawer');
    expect(joints[0]!.min).toBeCloseTo(-0.05, 5);
    expect(joints[0]!.max).toBeCloseTo(0.3, 5);
  });

  it('measures every clip from the rest pose, so open and close clips agree', () => {
    const { doc, lid } = lidOnHinge();
    const forward = doc.getRoot().listAnimations()[0]!;
    const close = doc.createAnimation('close_lid');
    for (const channel of forward.listChannels()) {
      const sampler = channel.getSampler()!;
      const output = sampler.getOutput()!;
      const n = output.getCount();
      const reversed: number[][] = [];
      for (let i = n - 1; i >= 0; i--) reversed.push(output.getElement(i, []));
      const times = Array.from({ length: n }, (_, i) => sampler.getInput()!.getScalar(i));
      animate(doc, close, lid, channel.getTargetPath() as 'rotation' | 'translation', times, reversed);
    }
    const joints = extractJoints(doc);
    expect(joints).toHaveLength(1);
    expect(joints[0]!.axis[2]).toBeCloseTo(1, 3);
    expect(joints[0]!.min).toBeCloseTo(0, 4);
    expect(joints[0]!.max).toBeCloseTo(LID_OPEN, 3);
  });

  it('samples STEP interpolation', () => {
    const { doc } = drawerOnSlide('STEP');
    const [drawer] = extractJoints(doc);
    expect(drawer!.type).toBe('prismatic');
    expect(drawer!.axis[0]).toBeCloseTo(1, 6);
    expect(drawer!.max).toBeCloseTo(0.3, 5);
  });

  it('samples CUBICSPLINE interpolation', () => {
    const { doc } = drawerOnSlide('CUBICSPLINE');
    const [drawer] = extractJoints(doc);
    expect(drawer!.type).toBe('prismatic');
    expect(drawer!.max).toBeCloseTo(0.3, 5);
  });

  it('ignores motion below the thresholds', () => {
    const { doc, scene } = newDoc();
    const wobble = addNode(doc, scene, 'Wobble', { box: [[-0.1, 0, -0.1], [0.1, 0.1, 0.1]] });
    const anim = doc.createAnimation('jitter');
    animate(doc, anim, wobble, 'translation', [0, 1], [[0, 0, 0], [0.004, 0, 0]]);
    animate(doc, anim, wobble, 'rotation', [0, 1], [[0, 0, 0, 1], quatAxisAngle([0, 1, 0], (2 * Math.PI) / 180)]);
    expect(extractJoints(doc)).toEqual([]);
  });

  it('expresses joints in the part parent frame so jointMatrix reproduces the clip', () => {
    const parentRotation = quatAxisAngle([0, 1, 0], Math.PI / 2);
    const { doc, lid } = lidOnHinge({ translation: [1, 0, 2], rotation: parentRotation });
    const [joint] = extractJoints(doc);
    expect(joint!.axis[2]).toBeCloseTo(1, 3);
    expect(distToHingeLine(joint!.pivot)).toBeLessThan(1e-3);

    const local: V3 = [0.3, 0.01, 0.1];
    const rest = lid.getTranslation() as V3;
    const restPoint: V3 = [local[0] + rest[0], local[1] + rest[1], local[2] + rest[2]];
    const opened = applyMat(jointMatrix(joint!, 1), restPoint);
    const q = quatAxisAngle([0, 0, 1], LID_OPEN);
    const r = rotateVec(q, [restPoint[0] - HINGE[0], restPoint[1] - HINGE[1], restPoint[2] - HINGE[2]]);
    const expected: V3 = [HINGE[0] + r[0], HINGE[1] + r[1], HINGE[2] + r[2]];
    for (let i = 0; i < 3; i++) expect(Math.abs(opened[i]! - expected[i]!)).toBeLessThan(1e-3);
  });

  it('sanitises and de-duplicates part names', () => {
    const { doc, scene } = newDoc();
    const a = addNode(doc, scene, 'Door (L)', { box: [[0, 0, 0], [0.4, 0.7, 0.02]] });
    const b = addNode(doc, scene, 'door-l', { box: [[0, 0, 0], [0.4, 0.7, 0.02]], translation: [1, 0, 0] });
    const c = addNode(doc, scene, '', { box: [[0, 0, 0], [0.4, 0.7, 0.02]], translation: [2, 0, 0] });
    c.getMesh()!.setName('Handle.001');
    const anim = doc.createAnimation('open');
    for (const [node, x] of [[a, 0], [b, 1], [c, 2]] as const) {
      animate(doc, anim, node, 'translation', [0, 1], [[x, 0, 0], [x, 0, 0.2]]);
    }
    const joints = extractJoints(doc);
    expect(joints.map((j) => j.part)).toEqual(['door_l', 'door_l_2', 'handle_001']);
    expect(joints[2]!.node).toBe('node_2');
  });
});
