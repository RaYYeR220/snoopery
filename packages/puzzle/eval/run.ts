// Baseline (one-shot designer) vs ours (designer + verifier repair loop) on seeded rooms.
// Usage: VENICE_API_KEY=... tsx eval/run.ts --model <id> [--rooms 40] [--max-usd 2] [--out path] [--concurrency 4]
//   [--arms baseline,ours] [--max-rounds 6] [--escalate <model> [--escalate-after 3]] [--thinking on]
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costUsd, designRoom, DESIGN_MODEL, LLMHttpError, VENICE_PRICES, veniceLLM, type ChatMessage, type IssueCode, type LLM, type LLMUsage } from '../src/index';
import { EVAL_SEED, sampleRooms, type EvalRoom } from './rooms';

export type Arm = 'baseline' | 'ours';

export interface ArmResult {
  ok: boolean;
  rounds: number;
  /** Issue codes of the final attempt (empty when verified). */
  codes: IssueCode[];
  /** Issue codes of the first attempt. */
  firstCodes: IssueCode[];
  issues: { code: IssueCode; detail: string }[];
  minSteps: number | null;
  /** Model whose attempt verified (differs from the primary when escalation kicked in). */
  solvedBy?: string;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  ms: number;
  error?: string;
}

export interface RoomResult {
  index: number;
  theme: string;
  difficulty: 2 | 3;
  objects: string[];
  parts: number;
  baseline?: ArmResult;
  ours?: ArmResult;
}

export interface EvalFile {
  model: string;
  seed: number;
  roomsRequested: number;
  /** Absent in files written before arms could be run separately: both. */
  arms?: Arm[];
  maxRounds: number;
  escalateTo?: string | null;
  escalateAfter?: number | null;
  maxTokens: number;
  thinking: boolean;
  timeoutMs: number;
  price: { input: number; output: number };
  createdAt: string;
  stopped: string | null;
  totals: { usd: number; promptTokens: number; completionTokens: number; calls: number };
  rooms: RoomResult[];
}

const MAX_TOKENS = 4000;

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, '..', 'results');

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const model = arg('model') ?? DESIGN_MODEL;
const roomCount = Number(arg('rooms') ?? 40);
const capUsd = Number(arg('max-usd') ?? process.env.EVAL_MAX_USD ?? 2);
const concurrency = Number(arg('concurrency') ?? 4);
const timeoutMs = Number(arg('timeout-ms') ?? 30_000);
const thinking = arg('thinking') === 'on';
const armNames = (arg('arms') ?? 'baseline,ours').split(',');
const arms = armNames.filter((a): a is Arm => a === 'baseline' || a === 'ours');
const maxRounds = Number(arg('max-rounds') ?? 6);
const escalateTo = arg('escalate') ?? null;
const escalateAfter = escalateTo ? Number(arg('escalate-after') ?? 3) : null;
const out = arg('out') ?? join(resultsDir, `eval-${model}.json`);
const rawDir = join(resultsDir, 'raw', basename(out, '.json'));

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === '') throw new Error(message);
  return value;
}
const apiKey = required(process.env.VENICE_API_KEY, 'VENICE_API_KEY is not set');
const price = required(VENICE_PRICES[model], `no price for model ${model}; add it to src/models.ts`);
if (escalateTo) required(VENICE_PRICES[escalateTo], `no price for model ${escalateTo}; add it to src/models.ts`);
if (arms.length !== armNames.length) throw new Error(`unknown arm in ${armNames.join(',')}`);

const budget = { spent: 0, reserved: 0, calls: 0, promptTokens: 0, completionTokens: 0 };
let stopped: string | null = null;

interface Tally {
  promptTokens: number;
  completionTokens: number;
  usd: number;
}

interface CallLog {
  model: string;
  messages: ChatMessage[];
  reply?: string;
  error?: string;
  usage?: LLMUsage;
}

/** Wraps Venice with a hard spend cap: each call reserves its worst case before it is sent. */
function metered(model: string, tally: Tally, log: CallLog[]): LLM {
  return {
    async complete(messages, opts) {
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      const worst = costUsd(model, Math.ceil(chars / 2), opts.maxTokens);
      if (budget.spent + budget.reserved + worst > capUsd) {
        stopped = `budget cap $${capUsd} reached`;
        throw new Error(`budget: ${stopped}`);
      }
      budget.reserved += worst;
      const seen: { usage?: LLMUsage } = {};
      const llm = veniceLLM(model, apiKey, { timeoutMs, disableThinking: !thinking, onUsage: (u) => (seen.usage = u) });
      try {
        const reply = await withOverloadRetry(() => llm.complete(messages, opts));
        log.push({ model, messages, reply, usage: seen.usage });
        return reply;
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        // A timed-out call may still be billed; count it at its worst case.
        if (name === 'TimeoutError' || name === 'AbortError') budget.spent += worst;
        log.push({ model, messages, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
        throw err;
      } finally {
        budget.reserved -= worst;
        budget.calls += 1;
        if (seen.usage) {
          const usd = costUsd(model, seen.usage.promptTokens, seen.usage.completionTokens);
          budget.spent += usd;
          budget.promptTokens += seen.usage.promptTokens;
          budget.completionTokens += seen.usage.completionTokens;
          tally.usd += usd;
          tally.promptTokens += seen.usage.promptTokens;
          tally.completionTokens += seen.usage.completionTokens;
        }
      }
    },
  };
}

/** 429 means the provider turned the request away before running it, so waiting and resending is free. */
async function withOverloadRetry(call: () => Promise<string>): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof LLMHttpError && err.status === 429) || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10_000 * 2 ** attempt));
    }
  }
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

async function runArm(room: EvalRoom, arm: Arm): Promise<ArmResult> {
  const tally: Tally = { promptTokens: 0, completionTokens: 0, usd: 0 };
  const log: CallLog[] = [];
  const started = Date.now();
  const r = await designRoom({ cards: room.cards, theme: room.theme, difficulty: room.difficulty }, metered(model, tally, log), {
    repair: arm === 'ours',
    maxRounds,
    maxTokens: MAX_TOKENS,
    ...(escalateTo ? { escalate: { llm: metered(escalateTo, tally, log), afterRound: escalateAfter! } } : {}),
  });
  const ms = Date.now() - started;
  writeFileSync(join(rawDir, `room-${String(room.index).padStart(2, '0')}-${arm}.json`), JSON.stringify({ room, arm, result: r, calls: log }, null, 2));
  const last = r.transcript.at(-1)?.issues ?? [];
  return {
    ok: r.ok,
    rounds: r.rounds,
    codes: uniq(last.map((i) => i.code)),
    firstCodes: uniq((r.transcript[0]?.issues ?? []).map((i) => i.code)),
    issues: last.map((i) => ({ code: i.code, detail: i.detail })),
    minSteps: r.ok ? r.verdict!.minSteps : null,
    ...(r.ok ? { solvedBy: log.filter((c) => c.reply !== undefined).at(-1)!.model } : {}),
    ...tally,
    ms,
    ...(r.error ? { error: r.error } : {}),
  };
}

const mark = (a: ArmResult | undefined) => (!a ? '-' : a.error ? `error(${a.error.slice(0, 40)})` : a.ok ? `ok r${a.rounds}` : `FAIL [${a.codes.join(',')}]`);

async function main() {
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });
  const rooms = sampleRooms(EVAL_SEED, roomCount);
  const results: RoomResult[] = [];
  let next = 0;

  const worker = async () => {
    while (next < rooms.length && !stopped) {
      const room = rooms[next++]!;
      const baseline = arms.includes('baseline') ? await runArm(room, 'baseline') : undefined;
      const ours = arms.includes('ours') ? await runArm(room, 'ours') : undefined;
      results.push({
        index: room.index,
        theme: room.theme,
        difficulty: room.difficulty,
        objects: room.cards.map((c) => c.objectId),
        parts: room.cards.reduce((n, c) => n + c.parts.length, 0),
        ...(baseline ? { baseline } : {}),
        ...(ours ? { ours } : {}),
      });
      console.log(
        `room ${room.index} d${room.difficulty} | baseline ${mark(baseline)} | ours ${mark(ours)} | spent $${budget.spent.toFixed(4)}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const file: EvalFile = {
    model,
    seed: EVAL_SEED,
    roomsRequested: roomCount,
    arms,
    maxRounds,
    escalateTo,
    escalateAfter,
    maxTokens: MAX_TOKENS,
    thinking,
    timeoutMs,
    price,
    createdAt: new Date().toISOString(),
    stopped,
    totals: { usd: budget.spent, promptTokens: budget.promptTokens, completionTokens: budget.completionTokens, calls: budget.calls },
    rooms: results.sort((a, b) => a.index - b.index),
  };
  writeFileSync(out, JSON.stringify(file, null, 2) + '\n');
  console.log(`${results.length} rooms, ${budget.calls} calls, $${budget.spent.toFixed(4)}${stopped ? ` (stopped: ${stopped})` : ''} -> ${out}`);
}

await main();
