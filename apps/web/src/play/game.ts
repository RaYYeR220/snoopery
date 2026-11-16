import { initialState, reduce, solve, type PlayState } from '@snoopery/puzzle';
import type { Action, Puzzle, PuzzleContainer, PuzzleItem, RoomDoc } from '@snoopery/schema';

export type Outcome =
  | { kind: 'opened'; container: PuzzleContainer; found: PuzzleItem[] }
  | { kind: 'locked'; container: PuzzleContainer; needs: 'key' | 'code'; missing: PuzzleItem[] }
  | { kind: 'blocked'; container: PuzzleContainer; reason: string }
  | { kind: 'toggle' }
  | { kind: 'escaped' }
  | { kind: 'exit-locked'; missing: PuzzleItem[] };

export interface Game {
  state: PlayState;
  steps: number;
  hints: number;
  startedAt: number;
  finishedAt: number | null;
}

export const newGame = (): Game => ({ state: initialState(), steps: 0, hints: 0, startedAt: Date.now(), finishedAt: null });

export const containerFor = (p: Puzzle, objectId: string, part: string) => p.containers.find((c) => c.objectId === objectId && c.part === part);
export const itemsIn = (p: Puzzle, containerId: string) => p.items.filter((i) => i.inside === containerId);
const byId = (p: Puzzle, id: string) => p.items.find((i) => i.id === id);

/** Opening a part: the puzzle reducer decides; items inside are collected automatically. */
export function openPart(room: RoomDoc, g: Game, objectId: string, part: string, typedCode?: string): { game: Game; outcome: Outcome } {
  const p = room.puzzle;
  const c = containerFor(p, objectId, part);
  if (!c) return { game: g, outcome: { kind: 'toggle' } };
  if (g.state.opened.includes(c.id)) return { game: g, outcome: { kind: 'toggle' } };
  let state = g.state;
  let steps = g.steps;
  // In play, a code lock always wants the code typed in; the solver treats "holds the clue" as knowing it.
  if (c.lock.kind === 'code' && typedCode !== c.lock.code) {
    const missing = c.lock.clueIds.filter((id) => !state.inventory.includes(id)).map((id) => byId(p, id)!).filter(Boolean);
    return { game: g, outcome: { kind: 'locked', container: c, needs: 'code', missing } };
  }
  let next = reduce(p, state, { type: 'open', target: c.id });
  if ('rejected' in next) {
    if (next.rejected === 'locked') {
      const lock = c.lock;
      // A correct code opens the lock even if the clue was never picked up: knowing the code is what counts.
      if (lock.kind === 'code' && typedCode === lock.code) {
        next = { ...state, opened: [...state.opened, c.id] };
      } else {
        const ids = lock.kind === 'key' ? [lock.keyId] : lock.kind === 'code' ? lock.clueIds : [];
        const missing = ids.filter((id) => !state.inventory.includes(id)).map((id) => byId(p, id)!).filter(Boolean);
        return { game: g, outcome: { kind: 'locked', container: c, needs: lock.kind === 'code' ? 'code' : 'key', missing } };
      }
    } else {
      return { game: g, outcome: { kind: 'blocked', container: c, reason: next.rejected === 'inside-closed' ? 'It sits inside something that is still closed.' : 'Nothing happens.' } };
    }
  }
  state = next;
  steps++;
  const found: PuzzleItem[] = [];
  for (const it of itemsIn(p, c.id)) {
    const taken = reduce(p, state, { type: 'take', item: it.id });
    if (!('rejected' in taken)) {
      state = taken;
      steps++;
      found.push(it);
    }
  }
  return { game: { ...g, state, steps }, outcome: { kind: 'opened', container: c, found } };
}

export function tryExit(room: RoomDoc, g: Game): { game: Game; outcome: Outcome } {
  const r = reduce(room.puzzle, g.state, { type: 'exit' });
  if ('rejected' in r) {
    const lock = room.puzzle.exit.lock;
    const ids = lock.kind === 'key' ? [lock.keyId] : lock.kind === 'code' ? lock.clueIds : [];
    return { game: g, outcome: { kind: 'exit-locked', missing: ids.filter((id) => !g.state.inventory.includes(id)).map((id) => byId(room.puzzle, id)!).filter(Boolean) } };
  }
  return { game: { ...g, state: r, steps: g.steps + 1, finishedAt: Date.now() }, outcome: { kind: 'escaped' } };
}

/** Next useful action from the current state, re-solved live (never the stored proof). */
export function hint(room: RoomDoc, g: Game): Action | null {
  const plan = solve(room.puzzle, g.state);
  return plan?.find((a) => a.type !== 'take') ?? plan?.[0] ?? null;
}

export function lockedCodeFor(room: RoomDoc, objectId: string, part: string): string | null {
  const c = containerFor(room.puzzle, objectId, part);
  return c && c.lock.kind === 'code' ? c.lock.code : null;
}

export const formatTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
