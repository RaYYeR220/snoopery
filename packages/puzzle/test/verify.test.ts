import { describe, expect, it } from 'vitest';
import type { AffordanceCard, LockSpec, Puzzle, PuzzleContainer, PuzzleItem } from '@snoopery/schema';
import { verify, solve } from '../src/verify';
import { initialState, reduce, type PlayState } from '../src/state';

const none: LockSpec = { kind: 'none' };
const keyLock = (keyId: string): LockSpec => ({ kind: 'key', keyId });
const codeLock = (code: string, ...clueIds: string[]): LockSpec => ({ kind: 'code', code, clueIds });

function box(id: string, lock: LockSpec = none, inside: string | null = null): PuzzleContainer {
  const [objectId, part] = id.split('.');
  return { id, objectId: objectId!, part: part!, lock, inside };
}
const key = (id: string, inside: string | null): PuzzleItem => ({ id, kind: 'key', label: id, inside });
const clue = (id: string, inside: string | null, text: string): PuzzleItem => ({ id, kind: 'clue', label: id, inside, text });
const prop = (id: string, inside: string | null): PuzzleItem => ({ id, kind: 'prop', label: id, inside });

const codes = (v: { issues: { code: string }[] }) => v.issues.map((i) => i.code);

// drawer (open) → brass key → nightstand drawer → door key → exit
const chain: Puzzle = {
  containers: [box('dresser.drawer1'), box('nightstand.drawer1', keyLock('brass_key'))],
  items: [key('brass_key', 'dresser.drawer1'), key('door_key', 'nightstand.drawer1')],
  exit: { lock: keyLock('door_key') },
};

describe('verify', () => {
  it('solves a straight chain with the shortest proof', () => {
    const v = verify(chain);
    expect(v.issues).toEqual([]);
    expect(v.solvable).toBe(true);
    expect(v.minSteps).toBe(5);
    expect(v.proof[0]).toEqual({ type: 'open', target: 'dresser.drawer1' });
    expect(v.proof).toEqual([
      { type: 'open', target: 'dresser.drawer1' },
      { type: 'take', item: 'brass_key' },
      { type: 'open', target: 'nightstand.drawer1' },
      { type: 'take', item: 'door_key' },
      { type: 'exit' },
    ]);
  });

  it('reports a key locked inside its own drawer as CIRCULAR', () => {
    const p: Puzzle = {
      containers: [box('dresser.drawer1', keyLock('brass_key'))],
      items: [key('brass_key', 'dresser.drawer1')],
      exit: { lock: keyLock('brass_key') },
    };
    const v = verify(p);
    expect(v.solvable).toBe(false);
    const circular = v.issues.find((i) => i.code === 'CIRCULAR');
    expect(circular?.ids).toEqual(['brass_key', 'dresser.drawer1']);
    expect(circular?.detail).toContain('brass_key is inside dresser.drawer1');
    expect(codes(v)).toContain('EXIT_UNREACHABLE');
  });

  it('reports a two-container key swap as CIRCULAR', () => {
    const p: Puzzle = {
      containers: [box('dresser.drawer1', keyLock('key_a')), box('wardrobe.door', keyLock('key_b'))],
      items: [key('key_a', 'wardrobe.door'), key('key_b', 'dresser.drawer1'), key('door_key', 'dresser.drawer1')],
      exit: { lock: keyLock('door_key') },
    };
    const v = verify(p);
    expect(v.solvable).toBe(false);
    const circular = v.issues.find((i) => i.code === 'CIRCULAR');
    expect(circular?.ids).toEqual(['key_a', 'wardrobe.door', 'key_b', 'dresser.drawer1']);
  });

  it('never calls a room solvable when a side container is circular', () => {
    const p: Puzzle = {
      containers: [...chain.containers, box('desk.drawer1', keyLock('desk_key'))],
      items: [...chain.items, key('desk_key', 'desk.drawer1')],
      exit: chain.exit,
    };
    const v = verify(p);
    expect(v.minSteps).toBe(5);
    expect(codes(v)).toContain('CIRCULAR');
    expect(v.solvable).toBe(false);
  });

  it('reports a code lock whose clue does not exist', () => {
    const p: Puzzle = {
      containers: [box('jewelry_box.lid', codeLock('0412', 'note_9'))],
      items: [key('door_key', 'jewelry_box.lid')],
      exit: { lock: keyLock('door_key') },
    };
    const v = verify(p);
    expect(v.solvable).toBe(false);
    const missing = v.issues.find((i) => i.code === 'MISSING_CLUE');
    expect(missing?.ids).toContain('note_9');
  });

  it('opens the outer drawer before the box nested in it', () => {
    const p: Puzzle = {
      containers: [box('jewelry_box.lid', none, 'dresser.drawer1'), box('dresser.drawer1', keyLock('brass_key'))],
      items: [key('brass_key', null), key('door_key', 'jewelry_box.lid')],
      exit: { lock: keyLock('door_key') },
    };
    const v = verify(p);
    expect(v.solvable).toBe(true);
    const at = (target: string) => v.proof.findIndex((a) => a.type === 'open' && a.target === target);
    expect(at('dresser.drawer1')).toBeGreaterThanOrEqual(0);
    expect(at('dresser.drawer1')).toBeLessThan(at('jewelry_box.lid'));
    expect(v.minSteps).toBe(5);
  });

  it('flags an unused prop unless unused items are allowed', () => {
    const p: Puzzle = { ...chain, items: [...chain.items, prop('old_photo', 'dresser.drawer1')] };
    const strict = verify(p, { allowUnused: false });
    expect(codes(strict)).toEqual(['UNUSED_ITEM']);
    expect(strict.issues[0]!.ids).toEqual(['old_photo']);
    expect(strict.solvable).toBe(false);

    const lenient = verify(p, { allowUnused: true });
    expect(lenient.solvable).toBe(true);
    expect(lenient.warnings.map((w) => w.code)).toEqual(['UNUSED_ITEM']);
  });

  it('flags a room shorter than the difficulty floor', () => {
    const v = verify(chain, { minSteps: 8 });
    expect(codes(v)).toEqual(['TOO_SHORT']);
    expect(v.solvable).toBe(false);
    expect(v.minSteps).toBe(5);
    expect(verify(chain, { minSteps: 5 }).solvable).toBe(true);
  });

  it('checks that clue texts spell the code', () => {
    const room = (texts: string[]): Puzzle => ({
      containers: [box('dresser.drawer1'), box('desk.drawer1'), box('safe.door', codeLock('0412', 'note_a', 'note_b'))],
      items: [
        clue('note_a', 'dresser.drawer1', texts[0]!),
        clue('note_b', 'desk.drawer1', texts[1]!),
        key('door_key', 'safe.door'),
      ],
      exit: { lock: keyLock('door_key') },
    });
    expect(verify(room(['The clock stopped at 04:', 'twelve past is wrong, try 12'])).solvable).toBe(true);
    const swapped = verify(room(['Try 12', 'Start with 04']));
    expect(codes(swapped)).toEqual(['CLUE_MISSING_CODE']);
    expect(swapped.issues[0]!.detail).toContain('"1204"');
    expect(codes(verify(room(['no digits here', 'none here either'])))).toEqual(['CLUE_MISSING_CODE']);
  });

  it('reports duplicate ids, dangling refs and wrong item kinds', () => {
    const p: Puzzle = {
      containers: [
        box('dresser.drawer1'),
        box('dresser.drawer1', keyLock('note_1')),
        { ...box('desk.drawer1'), inside: 'attic.hatch' },
      ],
      items: [clue('note_1', null, '42'), key('door_key', 'nowhere.box')],
      exit: { lock: keyLock('ghost_key') },
    };
    const v = verify(p);
    expect(codes(v)).toEqual(expect.arrayContaining(['DUPLICATE_ID', 'UNKNOWN_REF', 'MISSING_KEY', 'EXIT_UNREACHABLE']));
    const refs = v.issues.filter((i) => i.code === 'UNKNOWN_REF').flatMap((i) => i.ids);
    expect(refs).toEqual(expect.arrayContaining(['attic.hatch', 'nowhere.box']));
    expect(v.issues.find((i) => i.code === 'MISSING_KEY' && i.ids.includes('note_1'))?.detail).toContain('clue, not a key');
    expect(v.solvable).toBe(false);
  });

  it('rejects parts that the furniture cards do not list', () => {
    const cards: AffordanceCard[] = [
      { objectId: 'dresser', label: 'Dresser', sizeM: [1.2, 0.9, 0.5], parts: [{ part: 'drawer1', joint: 'prismatic', capacity: 'medium' }] },
      { objectId: 'nightstand', label: 'Nightstand', sizeM: [0.5, 0.6, 0.4], parts: [{ part: 'door', joint: 'revolute', capacity: 'medium' }] },
    ];
    const v = verify(chain, { cards });
    const bad = v.issues.filter((i) => i.code === 'UNKNOWN_REF');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.ids).toEqual(['nightstand.drawer1', 'nightstand']);
    expect(bad[0]!.detail).toContain('door');
    expect(v.solvable).toBe(false);
  });

  it('marks what the player can never reach', () => {
    const p: Puzzle = {
      containers: [box('dresser.drawer1', keyLock('lost_key')), box('jewelry_box.lid', none, 'dresser.drawer1')],
      items: [key('door_key', 'jewelry_box.lid')],
      exit: { lock: keyLock('door_key') },
    };
    const v = verify(p);
    expect(codes(v)).toEqual(['MISSING_KEY', 'UNREACHABLE_CONTAINER', 'UNREACHABLE_CONTAINER', 'UNREACHABLE_ITEM', 'EXIT_UNREACHABLE']);
    expect(v.proof).toEqual([]);
    expect(v.minSteps).toBe(0);
  });

  it('solves a 12-container, 12-item room in under 50 ms', () => {
    // A nine-key chain feeding a three-clue exit code, plus a fully parallel variant.
    const containers: PuzzleContainer[] = [box('c.p0')];
    const items: PuzzleItem[] = [key('k0', 'c.p0')];
    for (let i = 1; i <= 8; i++) {
      containers.push(box(`c.p${i}`, keyLock(`k${i - 1}`)));
      items.push(key(`k${i}`, `c.p${i}`));
    }
    containers.push(box('c.p9', keyLock('k8')), box('c.p10'), box('c.p11'));
    items.push(clue('n1', 'c.p9', '1'), clue('n2', 'c.p10', '2'), clue('n3', 'c.p11', '3'));
    const chained: Puzzle = { containers, items, exit: { lock: codeLock('123', 'n1', 'n2', 'n3') } };

    const wide: Puzzle = {
      containers: Array.from({ length: 12 }, (_, i) => box(`w.p${i}`)),
      items: Array.from({ length: 12 }, (_, i) => clue(`n${i}`, `w.p${i}`, i < 6 ? String(i) : 'blank')),
      exit: { lock: codeLock('012345', ...Array.from({ length: 12 }, (_, i) => `n${i}`)) },
    };

    for (const p of [chained, wide]) {
      const t0 = performance.now();
      const v = verify(p);
      const ms = performance.now() - t0;
      expect(v.issues).toEqual([]);
      expect(v.solvable).toBe(true);
      expect(v.minSteps).toBe(25);
      expect(ms).toBeLessThan(50);
    }
  });
});

describe('play state', () => {
  it('rejects a key-locked drawer until the key is taken', () => {
    let s: PlayState = initialState();
    expect(reduce(chain, s, { type: 'open', target: 'nightstand.drawer1' })).toEqual({ rejected: 'locked' });
    expect(reduce(chain, s, { type: 'take', item: 'brass_key' })).toEqual({ rejected: 'out-of-reach' });
    for (const a of verify(chain).proof.slice(0, 2)) {
      const next = reduce(chain, s, a);
      if ('rejected' in next) throw new Error(next.rejected);
      s = next;
    }
    const opened = reduce(chain, s, { type: 'open', target: 'nightstand.drawer1' });
    expect('rejected' in opened).toBe(false);
  });

  it('replays the proof to an escape', () => {
    let s: PlayState = initialState();
    for (const a of verify(chain).proof) {
      const next = reduce(chain, s, a);
      if ('rejected' in next) throw new Error(next.rejected);
      s = next;
    }
    expect(s.escaped).toBe(true);
    expect(reduce(chain, s, { type: 'exit' })).toEqual({ rejected: 'escaped' });
  });

  it('re-solves from a mid-game state for hints', () => {
    const s: PlayState = { opened: ['dresser.drawer1'], inventory: [], escaped: false };
    expect(solve(chain, s)?.[0]).toEqual({ type: 'take', item: 'brass_key' });
    expect(solve(chain, { ...s, inventory: ['brass_key'] })).toHaveLength(3);
    expect(solve(chain, { opened: [], inventory: [], escaped: true })).toEqual([]);
  });
});
