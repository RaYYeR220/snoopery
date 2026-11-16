import type { Action, AffordanceCard, Puzzle } from '@snoopery/schema';
import {
  MISSING,
  ROOM,
  canExit,
  canOpen,
  canTake,
  compile,
  initialState,
  lockIds,
  progressOf,
  type Model,
  type PlayState,
  type Progress,
} from './state';

export type IssueCode =
  | 'DUPLICATE_ID'
  | 'UNKNOWN_REF'
  | 'MISSING_KEY'
  | 'MISSING_CLUE'
  | 'CLUE_MISSING_CODE'
  | 'CIRCULAR'
  | 'EXIT_UNREACHABLE'
  | 'UNREACHABLE_ITEM'
  | 'UNREACHABLE_CONTAINER'
  | 'UNUSED_ITEM'
  | 'TOO_SHORT'
  /** The designer could not parse the model's reply into a puzzle at all. */
  | 'MALFORMED';

export interface Issue {
  code: IssueCode;
  detail: string;
  ids: string[];
}

export interface Verdict {
  /** Exit reachable and no blocking issue. */
  solvable: boolean;
  /** Length of the shortest proof (0 when the exit is unreachable). */
  minSteps: number;
  proof: Action[];
  /** Blocking problems. */
  issues: Issue[];
  /** Non-blocking findings (unused items when `allowUnused`). */
  warnings: Issue[];
}

export interface VerifyOptions {
  /** Difficulty floor: a shorter shortest proof is a blocking TOO_SHORT. */
  minSteps?: number;
  /** Downgrade UNUSED_ITEM to a warning. Default false. */
  allowUnused?: boolean;
  /** When given, every container must be an openable part listed on these cards. */
  cards?: AffordanceCard[];
}

export function verify(p: Puzzle, opts: VerifyOptions = {}): Verdict {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  const m = compile(p);

  checkIds(p, issues);
  checkRefs(p, m, issues);
  if (opts.cards) checkCards(p, opts.cards, issues);
  checkCodes(p, m, issues);
  for (const cycle of findCycles(m)) issues.push(cycle);

  const reach = reachableFromStart(m);
  m.containers.forEach((c, k) => {
    if (!reach.opened(k)) {
      issues.push({ code: 'UNREACHABLE_CONTAINER', detail: `container ${c.id} can never be opened: ${whyClosed(m, k, reach)}`, ids: [c.id] });
    }
  });
  m.items.forEach((it, k) => {
    if (!reach.holds(k)) {
      issues.push({ code: 'UNREACHABLE_ITEM', detail: `item ${it.id} can never be taken: ${whyOutOfReach(m, k, reach)}`, ids: [it.id] });
    }
  });

  const exitOk = canExit(m, reach);
  if (!exitOk) {
    const blocked = lockIds(p.exit.lock).filter((_, k) => m.exitNeeds[k] === MISSING || !reach.holds(m.exitNeeds[k]!));
    const reasons = blocked.map((id) => (m.itemAt.has(id) ? `${id} can never be taken` : `${id} does not exist`));
    issues.push({ code: 'EXIT_UNREACHABLE', detail: `the exit can never be opened: ${reasons.join('; ')}`, ids: blocked });
  }

  const used = new Set([...p.containers.flatMap((c) => lockIds(c.lock)), ...lockIds(p.exit.lock)]);
  for (const it of m.items) {
    if (used.has(it.id)) continue;
    const issue: Issue = { code: 'UNUSED_ITEM', detail: `item ${it.id} (${it.kind}) is not needed by any lock`, ids: [it.id] };
    (opts.allowUnused ? warnings : issues).push(issue);
  }

  const proof = exitOk ? shortestProof(m, progressOf(m, initialState())) : null;
  const minSteps = proof?.length ?? 0;
  if (proof && opts.minSteps !== undefined && minSteps < opts.minSteps) {
    issues.push({ code: 'TOO_SHORT', detail: `the shortest solution is ${minSteps} steps; this room needs at least ${opts.minSteps}`, ids: [] });
  }

  return { solvable: proof !== null && issues.length === 0, minSteps, proof: proof ?? [], issues, warnings };
}

/** Shortest action sequence from a play state to the exit, or null if there is none (used for hints). */
export function solve(p: Puzzle, from: PlayState = initialState()): Action[] | null {
  if (from.escaped) return [];
  const m = compile(p);
  return shortestProof(m, progressOf(m, from));
}

function checkIds(p: Puzzle, issues: Issue[]): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const id of [...p.containers.map((c) => c.id), ...p.items.map((i) => i.id)]) {
    if (seen.has(id) && !reported.has(id)) {
      issues.push({ code: 'DUPLICATE_ID', detail: `id ${id} is used more than once`, ids: [id] });
      reported.add(id);
    }
    seen.add(id);
  }
  const byPart = new Map<string, string>();
  for (const c of p.containers) {
    const part = `${c.objectId}/${c.part}`;
    const other = byPart.get(part);
    if (other !== undefined && other !== c.id) {
      issues.push({ code: 'DUPLICATE_ID', detail: `containers ${other} and ${c.id} are the same part (${part})`, ids: [other, c.id] });
    } else if (other === undefined) {
      byPart.set(part, c.id);
    }
  }
}

function checkRefs(p: Puzzle, m: Model, issues: Issue[]): void {
  for (const c of p.containers) {
    if (c.inside !== null && !m.containerAt.has(c.inside)) {
      issues.push({ code: 'UNKNOWN_REF', detail: `container ${c.id} is inside "${c.inside}", which is not a container`, ids: [c.id, c.inside] });
    }
  }
  for (const it of p.items) {
    if (it.inside !== null && !m.containerAt.has(it.inside)) {
      issues.push({ code: 'UNKNOWN_REF', detail: `item ${it.id} is inside "${it.inside}", which is not a container`, ids: [it.id, it.inside] });
    }
  }
  const locks = [...p.containers.map((c) => ({ owner: c.id, what: `container ${c.id}`, lock: c.lock })), { owner: 'exit', what: 'the exit', lock: p.exit.lock }];
  for (const { owner, what, lock } of locks) {
    if (lock.kind === 'key') {
      const k = m.itemAt.get(lock.keyId);
      const item = k === undefined ? undefined : m.items[k];
      if (!item) {
        issues.push({ code: 'MISSING_KEY', detail: `${what} is locked by key "${lock.keyId}", which does not exist`, ids: [owner, lock.keyId] });
      } else if (item.kind !== 'key') {
        issues.push({ code: 'MISSING_KEY', detail: `${what} is locked by "${lock.keyId}", which is a ${item.kind}, not a key`, ids: [owner, lock.keyId] });
      }
    } else if (lock.kind === 'code') {
      for (const clueId of lock.clueIds) {
        const k = m.itemAt.get(clueId);
        const item = k === undefined ? undefined : m.items[k];
        if (!item) {
          issues.push({ code: 'MISSING_CLUE', detail: `${what} needs clue "${clueId}", which does not exist`, ids: [owner, clueId] });
        } else if (item.kind !== 'clue') {
          issues.push({ code: 'MISSING_CLUE', detail: `${what} needs "${clueId}", which is a ${item.kind}, not a clue`, ids: [owner, clueId] });
        }
      }
    }
  }
}

function checkCards(p: Puzzle, cards: AffordanceCard[], issues: Issue[]): void {
  const byObject = new Map(cards.map((card) => [card.objectId, card]));
  for (const c of p.containers) {
    const card = byObject.get(c.objectId);
    if (!card) {
      issues.push({ code: 'UNKNOWN_REF', detail: `container ${c.id} uses object "${c.objectId}", which is not in the room`, ids: [c.id, c.objectId] });
    } else if (!card.parts.some((part) => part.part === c.part)) {
      const openable = card.parts.map((part) => part.part).join(', ') || 'none';
      issues.push({
        code: 'UNKNOWN_REF',
        detail: `container ${c.id} uses part "${c.part}" of ${c.objectId}, which has no such openable part (openable: ${openable})`,
        ids: [c.id, c.objectId],
      });
    }
  }
}

/** The digits of a code lock's clue texts, read in clueIds order, must spell the code. */
function checkCodes(p: Puzzle, m: Model, issues: Issue[]): void {
  const locks = [...p.containers.map((c) => ({ owner: c.id, what: `container ${c.id}`, lock: c.lock })), { owner: 'exit', what: 'the exit', lock: p.exit.lock }];
  for (const { owner, what, lock } of locks) {
    if (lock.kind !== 'code') continue;
    const clues = lock.clueIds.map((id) => m.items[m.itemAt.get(id) ?? -1]);
    if (clues.some((c) => !c || c.kind !== 'clue')) continue;
    const spelled = clues.map((c) => (c!.text ?? '').replace(/\D/g, '')).join('');
    if (spelled === lock.code) continue;
    const said = spelled === '' ? 'contain no digits' : `spell "${spelled}"`;
    issues.push({
      code: 'CLUE_MISSING_CODE',
      detail: `${what} has code ${lock.code} but the digits in its clues (${lock.clueIds.join(', ')}) ${said}`,
      ids: [owner, ...lock.clueIds],
    });
  }
}

/**
 * Cycles in the requirement graph: an item needs the container it is in; a container needs the
 * container it sits in and every item its lock asks for. Any cycle is a deadlock.
 */
function findCycles(m: Model): Issue[] {
  const nC = m.containers.length;
  const node = { item: (i: number) => nC + i, isItem: (n: number) => n >= nC };
  const edges = (n: number): number[] => {
    if (node.isItem(n)) {
      const loc = m.location[n - nC]!;
      return loc >= 0 ? [loc] : [];
    }
    const out: number[] = [];
    if (m.parent[n]! >= 0) out.push(m.parent[n]!);
    for (const i of m.needs[n]!) if (i >= 0) out.push(node.item(i));
    return out;
  };
  const name = (n: number) => (node.isItem(n) ? m.items[n - nC]!.id : m.containers[n]!.id);
  const describe = (a: number, b: number) => {
    if (node.isItem(a)) return `${name(a)} is inside ${name(b)}`;
    if (!node.isItem(b)) return `${name(a)} sits inside ${name(b)}`;
    return m.containers[a]!.lock.kind === 'key' ? `${name(a)} is locked by ${name(b)}` : `${name(a)} needs clue ${name(b)}`;
  };

  const total = nC + m.items.length;
  const state = new Uint8Array(total); // 0 new, 1 on stack, 2 done
  const stack: number[] = [];
  const found = new Map<string, number[]>();
  const visit = (n: number) => {
    state[n] = 1;
    stack.push(n);
    for (const next of edges(n)) {
      if (state[next] === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort((a, b) => a - b).join(',');
        if (!found.has(key)) found.set(key, cycle);
      } else if (state[next] === 0) {
        visit(next);
      }
    }
    stack.pop();
    state[n] = 2;
  };
  // Items first so a cycle is reported from the key or clue that is trapped.
  for (let i = 0; i < m.items.length; i++) if (state[node.item(i)] === 0) visit(node.item(i));
  for (let c = 0; c < nC; c++) if (state[c] === 0) visit(c);

  return [...found.values()].map((cycle) => {
    const firstItem = cycle.reduce((best, n, k) => (node.isItem(n) && (best < 0 || n < cycle[best]!) ? k : best), -1);
    const start = firstItem >= 0 ? firstItem : cycle.indexOf(Math.min(...cycle));
    const ordered = [...cycle.slice(start), ...cycle.slice(0, start)];
    const steps = ordered.map((n, k) => describe(n, ordered[(k + 1) % ordered.length]!));
    return { code: 'CIRCULAR' as const, detail: steps.join('; '), ids: ordered.map(name) };
  });
}

/** Everything the player can ever open or take, ignoring step counts. */
function reachableFromStart(m: Model): Progress {
  const opened = new Array<boolean>(m.containers.length).fill(false);
  const held = new Array<boolean>(m.items.length).fill(false);
  const s: Progress = { opened: (c) => opened[c]!, holds: (i) => held[i]! };
  for (let changed = true; changed; ) {
    changed = false;
    for (let c = 0; c < opened.length; c++) {
      if (canOpen(m, c, s)) {
        opened[c] = true;
        changed = true;
      }
    }
    for (let i = 0; i < held.length; i++) {
      if (canTake(m, i, s)) {
        held[i] = true;
        changed = true;
      }
    }
  }
  return s;
}

function whyClosed(m: Model, c: number, reach: Progress): string {
  const parent = m.parent[c]!;
  if (parent === MISSING) return `it is inside "${m.containers[c]!.inside}", which is not a container`;
  if (parent !== ROOM && !reach.opened(parent)) return `it is inside ${m.containers[parent]!.id}, which can never be opened`;
  const ids = lockIds(m.containers[c]!.lock);
  const k = m.needs[c]!.findIndex((i) => i === MISSING || !reach.holds(i));
  const i = m.needs[c]![k]!;
  return i === MISSING ? `it needs ${ids[k]}, which does not exist` : `it needs ${ids[k]}, which can never be taken`;
}

function whyOutOfReach(m: Model, i: number, reach: Progress): string {
  const loc = m.location[i]!;
  if (loc === MISSING) return `it is inside "${m.items[i]!.inside}", which is not a container`;
  return `it is inside ${m.containers[loc]!.id}, which can never be opened`;
}

/**
 * BFS over the containers the exit actually depends on. Taking a needed item as soon as it is
 * reachable never hurts (state only grows), so takes are folded into the open that exposes them
 * and the search state is just the set of opened containers.
 */
function shortestProof(m: Model, start: Progress): Action[] | null {
  const needC = new Set<number>();
  const needI = new Set<number>();
  let possible = true;
  const needItem = (i: number) => {
    if (i === MISSING) return void (possible = false);
    if (start.holds(i) || needI.has(i)) return;
    needI.add(i);
    const loc = m.location[i]!;
    if (loc === MISSING) possible = false;
    else if (loc !== ROOM && !start.opened(loc)) needContainer(loc);
  };
  const needContainer = (c: number) => {
    if (needC.has(c)) return;
    needC.add(c);
    const parent = m.parent[c]!;
    if (parent === MISSING) possible = false;
    else if (parent !== ROOM && !start.opened(parent)) needContainer(parent);
    for (const i of m.needs[c]!) needItem(i);
  };
  for (const i of m.exitNeeds) needItem(i);
  if (!possible) return null;

  const order = [...needC].sort((a, b) => a - b);
  const bit = new Map(order.map((c, k) => [c, 1n << BigInt(k)]));
  const items = [...needI].sort((a, b) => a - b);
  const progress = (s: bigint): Progress => {
    const opened = (c: number) => start.opened(c) || (s & (bit.get(c) ?? 0n)) !== 0n;
    return {
      opened,
      holds: (i) => start.holds(i) || (needI.has(i) && (m.location[i] === ROOM || opened(m.location[i]!))),
    };
  };
  const takesIn = (c: number): Action[] => items.filter((i) => m.location[i] === c).map((i) => ({ type: 'take', item: m.items[i]!.id }));
  const firstTakes: Action[] = items
    .filter((i) => m.location[i] === ROOM || start.opened(m.location[i]!))
    .map((i) => ({ type: 'take', item: m.items[i]!.id }));

  const states: bigint[] = [0n];
  const prev: number[] = [-1];
  const via: number[] = [-1];
  const seen = new Set<bigint>(states);
  for (let head = 0; head < states.length; head++) {
    const s = states[head]!;
    const here = progress(s);
    if (canExit(m, here)) {
      const opens: number[] = [];
      for (let k = head; prev[k]! >= 0; k = prev[k]!) opens.push(via[k]!);
      opens.reverse();
      return [...firstTakes, ...opens.flatMap((c) => [{ type: 'open', target: m.containers[c]!.id } as Action, ...takesIn(c)]), { type: 'exit' }];
    }
    for (const c of order) {
      if (!canOpen(m, c, here)) continue;
      const next = s | bit.get(c)!;
      if (seen.has(next)) continue;
      seen.add(next);
      states.push(next);
      prev.push(head);
      via.push(c);
    }
  }
  return null;
}
