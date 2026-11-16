import { describe, expect, it } from 'vitest';
import type { AffordanceCard } from '@snoopery/schema';
import { designRoom, parseDesign, MIN_STEPS } from '../src/design';
import type { ChatMessage, LLM } from '../src/llm';

const cards: AffordanceCard[] = [
  {
    objectId: 'dresser',
    label: 'Oak dresser',
    sizeM: [1.2, 0.9, 0.5],
    parts: [
      { part: 'drawer1', joint: 'prismatic', capacity: 'medium' },
      { part: 'drawer2', joint: 'prismatic', capacity: 'medium' },
    ],
  },
  { objectId: 'jewelry_box', label: 'Jewelry box', sizeM: [0.25, 0.12, 0.18], parts: [{ part: 'lid', joint: 'revolute', capacity: 'small' }] },
  { objectId: 'nightstand', label: 'Nightstand', sizeM: [0.5, 0.6, 0.4], parts: [{ part: 'drawer1', joint: 'prismatic', capacity: 'small' }] },
  { objectId: 'lamp', label: 'Floor lamp', sizeM: [0.4, 1.6, 0.4], parts: [] },
];

// 7 steps: open drawer, take note, open lid (code), take key, open nightstand, take door key, exit.
function room(over: { brassKeyIn?: string; firstPart?: string } = {}) {
  return {
    title: 'The Stopped Clock',
    intro: 'Someone stopped every clock in the house.',
    puzzle: {
      containers: [
        { id: `dresser.${over.firstPart ?? 'drawer1'}`, objectId: 'dresser', part: over.firstPart ?? 'drawer1', lock: { kind: 'none' }, inside: null },
        { id: 'jewelry_box.lid', objectId: 'jewelry_box', part: 'lid', lock: { kind: 'code', code: '0412', clueIds: ['note_1'] }, inside: null },
        { id: 'nightstand.drawer1', objectId: 'nightstand', part: 'drawer1', lock: { kind: 'key', keyId: 'brass_key' }, inside: null },
      ],
      items: [
        { id: 'note_1', kind: 'clue', label: 'Torn diary page', inside: `dresser.${over.firstPart ?? 'drawer1'}`, text: 'The hall clock stopped at 04:12.' },
        { id: 'brass_key', kind: 'key', label: 'Brass key', inside: over.brassKeyIn ?? 'jewelry_box.lid', text: '' },
        { id: 'door_key', kind: 'key', label: 'Door key', inside: 'nightstand.drawer1', text: '' },
      ],
      exit: { lock: { kind: 'key', keyId: 'door_key' } },
    },
  };
}

function scripted(replies: (string | Error)[]) {
  const calls: { messages: ChatMessage[]; opts: { maxTokens: number; json: boolean } }[] = [];
  const llm: LLM = {
    async complete(messages, opts) {
      calls.push({ messages: structuredClone(messages), opts });
      const next = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { llm, calls };
}

const input = { cards, theme: 'a detective noir', difficulty: 2 as const };

describe('designRoom', () => {
  it('repairs a circular room using the verifier issues', async () => {
    const circular = JSON.stringify(room({ brassKeyIn: 'nightstand.drawer1' }));
    const { llm, calls } = scripted([circular, JSON.stringify(room())]);
    const r = await designRoom(input, llm);

    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(2);
    expect(r.transcript[0]!.issues.map((i) => i.code)).toContain('CIRCULAR');
    expect(r.transcript[1]!.issues).toEqual([]);
    expect(r.verdict?.minSteps).toBe(7);
    expect(r.title).toBe('The Stopped Clock');
    expect(r.puzzle?.containers).toHaveLength(3);

    const repair = calls[1]!.messages;
    expect(repair.at(-2)).toEqual({ role: 'assistant', content: circular });
    expect(repair.at(-1)!.role).toBe('user');
    expect(repair.at(-1)!.content).toContain('[CIRCULAR] brass_key is inside nightstand.drawer1');
    expect(calls.every((c) => c.opts.json && c.opts.maxTokens > 0)).toBe(true);
  });

  it('gives up after max rounds of garbage without throwing', async () => {
    const { llm, calls } = scripted(['sure! here is your room', '{"puzzle": {"containers": 3}}', '{', '']);
    const r = await designRoom(input, llm);
    expect(r.ok).toBe(false);
    expect(r.rounds).toBe(4);
    expect(calls).toHaveLength(4);
    expect(r.puzzle).toBeUndefined();
    expect(r.transcript.map((t) => t.issues[0]!.code)).toEqual(['MALFORMED', 'MALFORMED', 'MALFORMED', 'MALFORMED']);
    expect(calls[1]!.messages.at(-1)!.content).toContain('not valid JSON');
    expect(calls[2]!.messages.at(-1)!.content).toContain('puzzle.containers');
  });

  it('treats a part missing from the cards as UNKNOWN_REF and repairs it', async () => {
    const { llm } = scripted([JSON.stringify(room({ firstPart: 'drawer9' })), JSON.stringify(room())]);
    const r = await designRoom(input, llm);
    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(2);
    const issue = r.transcript[0]!.issues.find((i) => i.code === 'UNKNOWN_REF');
    expect(issue?.detail).toContain('drawer9');
  });

  it('runs the baseline as a single attempt with no feedback', async () => {
    const { llm, calls } = scripted([JSON.stringify(room({ brassKeyIn: 'nightstand.drawer1' })), JSON.stringify(room())]);
    const r = await designRoom(input, llm, { repair: false });
    expect(r.ok).toBe(false);
    expect(r.rounds).toBe(1);
    expect(calls).toHaveLength(1);
    expect(r.verdict?.issues.map((i) => i.code)).toContain('CIRCULAR');
    expect(r.puzzle).toBeUndefined();
  });

  it('enforces the difficulty floor', async () => {
    const { llm } = scripted([JSON.stringify(room())]);
    const r = await designRoom({ ...input, difficulty: 3 }, llm, { maxRounds: 1 });
    expect(r.ok).toBe(false);
    expect(r.transcript[0]!.issues.map((i) => i.code)).toEqual(['TOO_SHORT']);
  });

  it('reports a transport failure instead of throwing', async () => {
    const { llm } = scripted([new Error('venice 503: overloaded')]);
    const r = await designRoom(input, llm);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('503');
    expect(r.rounds).toBe(0);
  });

  it('shows the model only openable parts, the theme and the step floor', async () => {
    const { llm, calls } = scripted([JSON.stringify(room())]);
    await designRoom(input, llm);
    const prompt = calls[0]!.messages.map((m) => m.content).join('\n');
    expect(calls[0]!.messages[0]!.role).toBe('system');
    expect(prompt).toContain('a detective noir');
    expect(prompt).toContain(`at least ${MIN_STEPS[2]} steps`);
    expect(prompt).toContain('"objectId":"jewelry_box"');
    expect(prompt).not.toContain('lamp');
  });
});

describe('parseDesign', () => {
  it('accepts fenced JSON and drops reasoning blocks', () => {
    const raw = '<think>maybe {"x":1}</think>\n```json\n' + JSON.stringify(room()) + '\n```';
    const r = parseDesign(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.puzzle.items).toHaveLength(3);
  });

  it('explains schema errors with paths', () => {
    const bad = room();
    (bad.puzzle.containers[1]!.lock as { kind: string }).kind = 'laser';
    const r = parseDesign(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('puzzle.containers.1.lock');
  });
});
