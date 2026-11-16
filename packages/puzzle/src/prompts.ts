import type { AffordanceCard } from '@snoopery/schema';
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

export function repairRequest(issues: Issue[], minSteps: number | null): string {
  const lines = issues.map((i) => `- [${i.code}] ${i.detail}`);
  const shortest = minSteps ? `\nThe shortest way out of your room currently takes ${minSteps} steps.` : '';
  return `A solver played your room and rejected it:
${lines.join('\n')}${shortest}

Fix every problem and reply with the complete corrected room as one JSON object in the same shape. Keep the parts of the design that already work.`;
}

export function malformedRequest(error: string): string {
  return `Your reply could not be used: ${error}

Reply with the complete room as one JSON object in the required shape and nothing else.`;
}
