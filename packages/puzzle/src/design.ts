import { parsePuzzle, type AffordanceCard, type Puzzle } from '@snoopery/schema';
import type { ChatMessage, LLM } from './llm';
import { DESIGN_SYSTEM, designRequest, malformedRequest, repairRequest } from './prompts';
import { verify, type Issue, type Verdict } from './verify';

/** Shortest-solution floor per difficulty. */
export const MIN_STEPS = { 1: 4, 2: 7, 3: 10 } as const;

export interface DesignInput {
  cards: AffordanceCard[];
  theme: string;
  difficulty: 1 | 2 | 3;
}

export interface DesignOptions {
  /** Attempts including the first one. Default 6. */
  maxRounds?: number;
  /** false = one-shot baseline: same prompt, no verifier feedback. Default true. */
  repair?: boolean;
  maxTokens?: number;
  /** Hand the rounds after `afterRound` (default 3) to a second model; it sees the last attempt and its issues. */
  escalate?: { llm: LLM; afterRound?: number };
}

export interface DesignResult {
  ok: boolean;
  /** Only set when the room verified. */
  puzzle?: Puzzle;
  title?: string;
  intro?: string;
  /** Verdict of the last attempt that parsed. */
  verdict?: Verdict;
  rounds: number;
  transcript: { round: number; issues: Issue[] }[];
  /** Transport failure (network, HTTP, timeout); the model's output is never the cause. */
  error?: string;
}

export type ParsedDesign = { ok: true; puzzle: Puzzle; title: string; intro: string } | { ok: false; error: string };

export async function designRoom(input: DesignInput, llm: LLM, opts: DesignOptions = {}): Promise<DesignResult> {
  const repair = opts.repair ?? true;
  const maxRounds = repair ? Math.max(1, opts.maxRounds ?? 6) : 1;
  const escalation = repair ? opts.escalate : undefined;
  const escalateAfter = escalation?.afterRound ?? 3;
  const maxTokens = opts.maxTokens ?? 4000;
  const minSteps = MIN_STEPS[input.difficulty];
  const cards = input.cards.filter((card) => card.parts.length > 0);

  const opening: ChatMessage[] = [
    { role: 'system', content: DESIGN_SYSTEM },
    { role: 'user', content: designRequest({ cards, theme: input.theme, difficulty: input.difficulty, minSteps }) },
  ];
  const transcript: DesignResult['transcript'] = [];
  let messages = opening;
  let verdict: Verdict | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    let raw: string;
    try {
      const model = escalation && round > escalateAfter ? escalation.llm : llm;
      raw = await model.complete(messages, { maxTokens, json: true });
    } catch (err) {
      return { ok: false, verdict, rounds: round - 1, transcript, error: err instanceof Error ? err.message : String(err) };
    }

    const parsed = parseDesign(raw);
    let feedback: string;
    if (!parsed.ok) {
      transcript.push({ round, issues: [{ code: 'MALFORMED', detail: parsed.error, ids: [] }] });
      feedback = malformedRequest(parsed.error);
    } else {
      verdict = verify(parsed.puzzle, { minSteps, cards });
      transcript.push({ round, issues: verdict.issues });
      if (verdict.solvable) {
        return { ok: true, puzzle: parsed.puzzle, title: parsed.title, intro: parsed.intro, verdict, rounds: round, transcript };
      }
      feedback = repairRequest(verdict.issues, {
        shortest: verdict.proof.length > 0 ? verdict.minSteps : null,
        floor: minSteps,
        cards,
        puzzle: parsed.puzzle,
        proof: verdict.proof,
      });
    }
    // Only the latest attempt goes back to the model, so repair prompts stay the same size.
    messages = [...opening, { role: 'assistant', content: raw }, { role: 'user', content: feedback }];
  }
  return { ok: false, verdict, rounds: transcript.length, transcript };
}

/** Lenient on wrapping (fences, reasoning blocks, prose around the object), strict on the puzzle itself. */
export function parseDesign(raw: string): ParsedDesign {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'the reply is not valid JSON (no JSON object found)' };

  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `the reply is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, error: 'the reply must be a JSON object' };

  const obj = data as Record<string, unknown>;
  const nested = 'puzzle' in obj;
  try {
    const puzzle = parsePuzzle(nested ? obj.puzzle : obj);
    return {
      ok: true,
      puzzle,
      title: typeof obj.title === 'string' ? obj.title : '',
      intro: typeof obj.intro === 'string' ? obj.intro : '',
    };
  } catch (err) {
    return { ok: false, error: `the JSON does not match the required shape: ${schemaErrors(err, nested ? 'puzzle' : '')}` };
  }
}

function schemaErrors(err: unknown, prefix: string): string {
  const list = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (!Array.isArray(list)) return err instanceof Error ? err.message : String(err);
  return list
    .slice(0, 8)
    .map((i) => `${[prefix, ...i.path.map(String)].filter(Boolean).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
