import type { Action, AffordanceCard, AffordancePart, Puzzle } from '@snoopery/schema';
import type { Issue } from './verify';

export const DESIGN_SYSTEM = `You design escape rooms built from real furniture. The player walks around a scanned room, opens drawers, doors and lids, picks up keys and notes, and escapes through the exit door.

Reply with exactly one JSON object and nothing else, in this shape:
{
  "title": string,   // 2 to 5 words
  "intro": string,   // 1 or 2 sentences read to the player at the start
  "puzzle": {
    "containers": [ { "id": string, "objectId": string, "part": string, "lock": Lock, "inside": string | null } ],
    "items": [ { "id": string, "kind": "key" | "clue", "label": string, "inside": string | null, "text": string } ],
    "exit": { "lock": Lock }
  }
}
Lock is one of:
  { "kind": "none" }
  { "kind": "key", "keyId": "<id of a key item>" }
  { "kind": "code", "code": "<3 to 6 digits>", "clueIds": ["<id of a clue item>", ...] }

How the room plays:
- A container is one openable part of one piece of furniture. Opening it is one step.
- Taking an item is one step. An item with "inside": null lies loose in the room; otherwise it is hidden in that container and can be taken once that container is open.
- A container can be opened only when the container it sits in ("inside") is open and its lock is satisfied: a "key" lock needs that key in the player's hands, a "code" lock needs every listed clue in the player's hands.
- Escaping is the last step and needs the exit lock satisfied.

Rules:
1. Containers may only use the furniture parts listed by the user, each part at most once. Copy "objectId" and "part" exactly and set "id" to "<objectId>.<part>".
2. A container's "inside" is null unless that whole piece of furniture is small enough to sit inside another container (for example a jewelry box inside a wardrobe).
3. Every item is a key or a clue and must be needed by at least one lock. No decoys.
4. Never lock something behind itself: a key or clue must not be hidden in the container it opens, nor in any container that can only be reached through it.
5. A clue's "text" is a short in-world sentence that hides digits of a code. The digits of the clue texts, read in "clueIds" order, must spell the code exactly, so a clue must contain no other digits (spell other numbers out in words). Example: code "0412" with one clue, text "The hall clock stopped at 04:12." Keys use "text": "".
6. The shortest way out must take at least the number of steps the user asks for, counting every open, every take and the final exit.
7. Labels and clue texts fit the theme.`;

/** Compact one-line-per-object listing; only parts with a recovered joint can be opened. */
export function furnitureList(cards: AffordanceCard[]): string {
  return cards
    .filter((card) => card.parts.length > 0)
    .map((card) => JSON.stringify({ objectId: card.objectId, label: card.label, sizeM: card.sizeM, parts: card.parts }))
    .join('\n');
}

export function designRequest(o: { cards: AffordanceCard[]; theme: string; difficulty: number; minSteps: number }): string {
  return `Theme: ${o.theme}
Difficulty: ${o.difficulty} of 3. The shortest way out must take at least ${o.minSteps} steps.
Furniture in the room, one JSON object per piece. Only the listed parts open ("prismatic" slides, "revolute" swings on a hinge; capacity is how much fits inside):
${furnitureList(o.cards)}

Design the room.`;
}

export interface RepairContext {
  /** Length of the current shortest way out, or null when there is none. */
  shortest: number | null;
  /** Difficulty floor for the shortest way out. */
  floor: number;
  cards: AffordanceCard[];
  puzzle: Puzzle;
  /** Current shortest way out, shown so the model can see which containers the player skips. */
  proof?: Action[];
}

export function repairRequest(issues: Issue[], ctx: RepairContext): string {
  const lines = issues.map((i) => `- [${i.code}] ${i.detail}`);
  const shortest = ctx.shortest ? `\nThe shortest way out of your room currently takes ${ctx.shortest} steps.` : '';
  const hint = ctx.shortest !== null && issues.some((i) => i.code === 'TOO_SHORT') ? `\n\n${lengthenHint(ctx.shortest, ctx)}` : '';
  return `A solver played your room and rejected it:
${lines.join('\n')}${shortest}${hint}

Fix every problem and reply with the complete corrected room as one JSON object in the same shape. Keep the parts of the design that already work.`;
}

// Upper bound in m³ of what fits inside a part, by its capacity class.
const FITS: Record<AffordancePart['capacity'], number> = { small: 0.002, medium: 0.03, large: Infinity };

function lengthenHint(shortest: number, ctx: RepairContext): string {
  const missing = ctx.floor - shortest;
  const cards = ctx.cards.filter((card) => card.parts.length > 0);
  const used = new Set(ctx.puzzle.containers.map((c) => `${c.objectId}.${c.part}`));
  const free = cards.flatMap((card) => card.parts.map((part) => `${card.objectId}.${part.part}`)).filter((id) => !used.has(id));

  const volume = (card: AffordanceCard) => card.sizeM[0] * card.sizeM[1] * card.sizeM[2];
  const nests: string[] = [];
  for (const small of [...cards].sort((a, b) => volume(a) - volume(b))) {
    for (const host of cards) {
      if (host === small) continue;
      for (const part of host.parts) if (volume(small) < FITS[part.capacity]) nests.push(`${small.objectId} inside ${host.objectId}.${part.part}`);
    }
  }

  const tips = [
    `How to lengthen it: the shortest way out takes ${shortest} ${shortest === 1 ? 'step' : 'steps'} and must take at least ${ctx.floor}, so add at least ${missing} more ${missing === 1 ? 'step' : 'steps'} to the path the player is forced to take. Containers and items off that path do not count.`,
    `- Add one more locked container to the chain: hide the key or clue the next lock needs inside a part that is itself locked, so the player has to open that part first (+2 steps: open it, take what is inside). ${
      free.length > 0 ? `Unused parts you can lock: ${free.join(', ')}.` : 'Every listed part is already used, so move keys deeper into the existing chain instead.'
    }`,
  ];
  if (ctx.proof && ctx.proof.length > 0) {
    tips.splice(1, 0, `Current shortest way out: ${ctx.proof.map(describe).join(' → ')}.`);
  }
  if (ctx.puzzle.exit.lock.kind === 'none') {
    tips.splice(1, 0, 'The exit has no lock, so the player can leave at once: lock it with a key or code that sits at the end of the chain.');
  }
  if (nests.length > 0) {
    tips.push(
      `- Or nest a small piece inside a locked part: set the small piece's container "inside" to that part's id so it can only be opened afterwards. Pieces that fit: ${nests.slice(0, 4).join('; ')}.`,
    );
  }
  tips.push('- Or make a code lock need more clues, each hidden in a different container on the path (+1 step per extra clue).');
  tips.push('Use only parts from the furniture list.');
  return tips.join('\n');
}

function describe(a: Action): string {
  if (a.type === 'open') return `open ${a.target}`;
  if (a.type === 'take') return `take ${a.item}`;
  return 'exit';
}

export function malformedRequest(error: string): string {
  return `Your reply could not be used: ${error}

Reply with the complete room as one JSON object in the required shape and nothing else.`;
}
