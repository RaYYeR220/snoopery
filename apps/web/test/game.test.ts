import { describe, expect, it } from 'vitest';
import { solve } from '@snoopery/puzzle/play';
import type { RoomDoc } from '@snoopery/schema';
import { hint, looseItems, newGame, openPart, takeLoose, tryExit } from '../src/play/game';

const room = {
  id: 'r1',
  title: 'T',
  author: '',
  splat: { url: 'https://x/s.spz', format: 'spz', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  spawn: { pos: [0, 1.5, 0], yaw: 0, pitch: 0 },
  objects: [],
  puzzle: {
    containers: [
      { id: 'ns.drawer', objectId: 'ns', part: 'drawer', lock: { kind: 'code', code: '1984', clueIds: ['note'] }, inside: null },
      { id: 'box.lid', objectId: 'box', part: 'lid', lock: { kind: 'key', keyId: 'small' }, inside: null },
    ],
    items: [
      { id: 'note', kind: 'clue', label: 'Note', inside: null, text: 'Born in 1984.' },
      { id: 'small', kind: 'key', label: 'Small key', inside: 'ns.drawer' },
      { id: 'door', kind: 'key', label: 'Door key', inside: 'box.lid' },
    ],
    exit: { lock: { kind: 'key', keyId: 'door' } },
  },
  proof: [],
  verdict: { solvable: true, minSteps: 7 },
} as unknown as RoomDoc;

describe('game', () => {
  it('a code lock always asks for the code, even with the clue in hand', () => {
    let g = takeLoose(room, newGame(), 'note');
    const r = openPart(room, g, 'ns', 'drawer');
    expect(r.outcome).toMatchObject({ kind: 'locked', needs: 'code' });
    g = openPart(room, g, 'ns', 'drawer', '1984').game;
    expect(g.state.inventory).toContain('small');
  });

  it('a key lock rejects until the key is held, then opens and collects what is inside', () => {
    let g = newGame();
    expect(openPart(room, g, 'box', 'lid').outcome).toMatchObject({ kind: 'locked', needs: 'key' });
    g = takeLoose(room, g, 'note');
    g = openPart(room, g, 'ns', 'drawer', '1984').game;
    const r = openPart(room, g, 'box', 'lid');
    expect(r.outcome).toMatchObject({ kind: 'opened' });
    expect(r.game.state.inventory).toEqual(['note', 'small', 'door']);
  });

  it('counts the shortest legal play exactly as the solver does', () => {
    let g = takeLoose(room, newGame(), 'note');
    g = openPart(room, g, 'ns', 'drawer', '1984').game;
    g = openPart(room, g, 'box', 'lid').game;
    g = tryExit(room, g).game;
    expect(g.finishedAt).not.toBeNull();
    expect(g.steps).toBe(solve(room.puzzle)!.length);
  });

  it('never lets a guessed code finish under the shortest solution', () => {
    let g = openPart(room, newGame(), 'ns', 'drawer', '1984').game;
    g = openPart(room, g, 'box', 'lid').game;
    g = tryExit(room, g).game;
    expect(g.steps).toBeGreaterThanOrEqual(solve(room.puzzle)!.length);
  });

  it('hints point at things in plain sight first, then at the next part to open', () => {
    const g0 = newGame();
    expect(hint(room, g0)).toEqual({ type: 'take', item: 'note' });
    expect(looseItems(room, g0).map((i) => i.id)).toEqual(['note']);
    const g1 = takeLoose(room, g0, 'note');
    expect(hint(room, g1)).toEqual({ type: 'open', target: 'ns.drawer' });
    expect(looseItems(room, g1)).toEqual([]);
  });
});
