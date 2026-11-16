import { describe, expect, it } from 'vitest';
import { parsePuzzle, parseRoomDoc } from '../src/index';

const puzzle = {
  containers: [
    { id: 'dresser.drawer2', objectId: 'dresser', part: 'drawer2', lock: { kind: 'key', keyId: 'brass_key' }, inside: null },
    { id: 'jewelry_box.lid', objectId: 'jewelry_box', part: 'lid', lock: { kind: 'code', code: '0412', clueIds: ['note_1'] }, inside: null },
  ],
  items: [
    { id: 'brass_key', kind: 'key', label: 'Brass key', inside: 'jewelry_box.lid' },
    { id: 'note_1', kind: 'clue', label: 'Folded note', inside: null, text: 'April the twelfth' },
    { id: 'door_key', kind: 'key', label: 'Door key', inside: 'dresser.drawer2' },
  ],
  exit: { lock: { kind: 'key', keyId: 'door_key' } },
};

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const room = {
  id: 'r1',
  title: 'Test room',
  author: 'tester',
  splat: { url: 'https://example.com/room.spz', format: 'spz', transform: identity },
  spawn: { pos: [0, 1.6, 0], yaw: 0, pitch: 0 },
  objects: [],
  puzzle,
  proof: [{ type: 'take', item: 'note_1' }],
  verdict: { solvable: true, minSteps: 1 },
};

describe('parsePuzzle', () => {
  it('accepts the reference puzzle shape', () => {
    const p = parsePuzzle(puzzle);
    expect(p.containers).toHaveLength(2);
    expect(p.exit.lock).toEqual({ kind: 'key', keyId: 'door_key' });
  });

  it('rejects an unknown lock kind', () => {
    const bad = structuredClone(puzzle) as any;
    bad.containers[0].lock = { kind: 'laser' };
    expect(() => parsePuzzle(bad)).toThrow();
  });

  it('rejects a container with an empty part name', () => {
    const bad = structuredClone(puzzle) as any;
    bad.containers[0].part = '';
    expect(() => parsePuzzle(bad)).toThrow();
  });

  it('rejects a code lock without clues', () => {
    const bad = structuredClone(puzzle) as any;
    bad.containers[1].lock.clueIds = [];
    expect(() => parsePuzzle(bad)).toThrow();
  });
});

describe('parseRoomDoc', () => {
  it('accepts a minimal room', () => {
    expect(parseRoomDoc(room).id).toBe('r1');
  });

  it('rejects a splat transform that is not a 4x4 matrix', () => {
    const bad = structuredClone(room) as any;
    bad.splat.transform = [1, 0, 0];
    expect(() => parseRoomDoc(bad)).toThrow();
  });
});
