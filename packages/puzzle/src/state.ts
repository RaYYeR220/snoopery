import type { Action, LockSpec, Puzzle, PuzzleContainer, PuzzleItem } from '@snoopery/schema';

/** Location / parent marker: loose in the room, or not nested in anything. */
export const ROOM = -1;
/** Reference to an id that does not exist; such a requirement can never be met. */
export const MISSING = -2;

/** Index-based view of a puzzle shared by the solver and the game reducer. Duplicate ids: first wins. */
export interface Model {
  containers: PuzzleContainer[];
  items: PuzzleItem[];
  containerAt: Map<string, number>;
  itemAt: Map<string, number>;
  /** Container each container sits in: index, ROOM or MISSING. */
  parent: number[];
  /** Items each container's lock needs in the inventory (MISSING for dangling ids). */
  needs: number[][];
  /** Container each item is hidden in: index, ROOM or MISSING. */
  location: number[];
  exitNeeds: number[];
}

export interface Progress {
  opened(c: number): boolean;
  holds(i: number): boolean;
}

export function lockIds(lock: LockSpec): string[] {
  if (lock.kind === 'key') return [lock.keyId];
  if (lock.kind === 'code') return lock.clueIds;
  return [];
}

export function compile(p: Puzzle): Model {
  const containers: PuzzleContainer[] = [];
  const items: PuzzleItem[] = [];
  const containerAt = new Map<string, number>();
  const itemAt = new Map<string, number>();
  for (const c of p.containers) {
    if (containerAt.has(c.id)) continue;
    containerAt.set(c.id, containers.length);
    containers.push(c);
  }
  for (const it of p.items) {
    if (itemAt.has(it.id)) continue;
    itemAt.set(it.id, items.length);
    items.push(it);
  }
  const place = (id: string | null) => (id === null ? ROOM : (containerAt.get(id) ?? MISSING));
  const needsOf = (lock: LockSpec) => lockIds(lock).map((id) => itemAt.get(id) ?? MISSING);
  return {
    containers,
    items,
    containerAt,
    itemAt,
    parent: containers.map((c) => place(c.inside)),
    needs: containers.map((c) => needsOf(c.lock)),
    location: items.map((it) => place(it.inside)),
    exitNeeds: needsOf(p.exit.lock),
  };
}

export type OpenBlocker = 'already-open' | 'inside-closed' | 'locked';
export type TakeBlocker = 'already-taken' | 'out-of-reach';

export function openBlocker(m: Model, c: number, s: Progress): OpenBlocker | null {
  if (s.opened(c)) return 'already-open';
  const parent = m.parent[c]!;
  if (parent === MISSING || (parent !== ROOM && !s.opened(parent))) return 'inside-closed';
  if (!m.needs[c]!.every((i) => i !== MISSING && s.holds(i))) return 'locked';
  return null;
}

export function takeBlocker(m: Model, i: number, s: Progress): TakeBlocker | null {
  if (s.holds(i)) return 'already-taken';
  const loc = m.location[i]!;
  if (loc === ROOM || (loc !== MISSING && s.opened(loc))) return null;
  return 'out-of-reach';
}

export const canOpen = (m: Model, c: number, s: Progress) => openBlocker(m, c, s) === null;
export const canTake = (m: Model, i: number, s: Progress) => takeBlocker(m, i, s) === null;
export const canExit = (m: Model, s: Progress) => m.exitNeeds.every((i) => i !== MISSING && s.holds(i));

/** What a player has done so far. Plain arrays so it serialises and diffs cleanly in UI state. */
export interface PlayState {
  opened: string[];
  inventory: string[];
  escaped: boolean;
}

export type Rejection = 'unknown' | 'escaped' | OpenBlocker | TakeBlocker | 'exit-locked';

export const initialState = (): PlayState => ({ opened: [], inventory: [], escaped: false });

export function progressOf(m: Model, s: PlayState): Progress {
  const opened = new Set(s.opened.map((id) => m.containerAt.get(id)));
  const held = new Set(s.inventory.map((id) => m.itemAt.get(id)));
  return { opened: (c) => opened.has(c), holds: (i) => held.has(i) };
}

export function reduce(p: Puzzle, s: PlayState, a: Action): PlayState | { rejected: Rejection } {
  if (s.escaped) return { rejected: 'escaped' };
  const m = compile(p);
  const progress = progressOf(m, s);
  switch (a.type) {
    case 'open': {
      const c = m.containerAt.get(a.target);
      if (c === undefined) return { rejected: 'unknown' };
      const blocker = openBlocker(m, c, progress);
      return blocker ? { rejected: blocker } : { ...s, opened: [...s.opened, a.target] };
    }
    case 'take': {
      const i = m.itemAt.get(a.item);
      if (i === undefined) return { rejected: 'unknown' };
      const blocker = takeBlocker(m, i, progress);
      return blocker ? { rejected: blocker } : { ...s, inventory: [...s.inventory, a.item] };
    }
    case 'exit':
      return canExit(m, progress) ? { ...s, escaped: true } : { rejected: 'exit-locked' };
  }
}
