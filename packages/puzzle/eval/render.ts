// Renders results/EVAL.md from every results/eval-<model>.json. Usage: tsx eval/render.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssueCode } from '../src/index';
import type { ArmResult, EvalFile, RoomResult } from './run';

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

type Pick = (r: RoomResult) => { ok: boolean; codes: IssueCode[] };
const baseline: Pick = (r) => ({ ok: r.baseline.ok, codes: r.baseline.codes });
const firstRound: Pick = (r) => ({ ok: r.ours.firstCodes.length === 0, codes: r.ours.firstCodes });
const ours: Pick = (r) => ({ ok: r.ours.ok, codes: r.ours.codes });

const any =
  (...codes: IssueCode[]) =>
  (a: { codes: IssueCode[] }) =>
    a.codes.some((c) => codes.includes(c));

const METRICS: [string, (a: { ok: boolean; codes: IssueCode[] }) => boolean][] = [
  ['**Solvable (verified)**', (a) => a.ok],
  ['Circular dependency', any('CIRCULAR')],
  ['Soft-lock (exit, item or container unreachable)', any('EXIT_UNREACHABLE', 'UNREACHABLE_ITEM', 'UNREACHABLE_CONTAINER')],
  ['Invalid reference (unknown part or id, missing key/clue)', any('UNKNOWN_REF', 'DUPLICATE_ID', 'MISSING_KEY', 'MISSING_CLUE')],
  ['Clue text does not spell the code', any('CLUE_MISSING_CODE')],
  ['Unused item', any('UNUSED_ITEM')],
  ['Shorter than the difficulty floor', any('TOO_SHORT')],
  ['Unparseable reply', any('MALFORMED')],
];

const pct = (k: number, n: number) => (n === 0 ? '—' : `${Math.round((100 * k) / n)}% (${k}/${n})`);
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const usd = (x: number) => `$${x.toFixed(4)}`;

function section(f: EvalFile): string {
  const done = f.rooms.filter((r) => !r.baseline.error && !r.ours.error);
  const n = done.length;
  const count = (pick: Pick, test: (a: { ok: boolean; codes: IssueCode[] }) => boolean) => done.filter((r) => test(pick(r))).length;
  const arms = (xs: ArmResult[]) => ({
    tokens: mean(xs.map((a) => a.promptTokens + a.completionTokens)),
    usd: mean(xs.map((a) => a.usd)),
    seconds: mean(xs.map((a) => a.ms / 1000)),
  });
  const b = arms(done.map((r) => r.baseline));
  const o = arms(done.map((r) => r.ours));
  const verifiedSteps = (xs: ArmResult[]) => mean(xs.filter((a) => a.ok).map((a) => a.minSteps ?? 0));

  const lines: string[] = [];
  lines.push(`## ${f.model}`, '');
  lines.push(
    `${n} rooms (seed ${f.seed}, ${f.roomsRequested} requested${f.stopped ? `, stopped early: ${f.stopped}` : ''}), ` +
      `3–5 furniture archetypes each, difficulty 2 (≥ 7 steps) and 3 (≥ 10 steps) alternating. ` +
      `Run ${f.createdAt.slice(0, 10)}, ${f.totals.calls} model calls, ${usd(f.totals.usd)} total.`,
    '',
  );
  lines.push('| Metric | Baseline (one-shot) | Ours, round 1 only | Ours (verifier repair, ≤ ' + f.maxRounds + ' rounds) |');
  lines.push('|---|---|---|---|');
  for (const [label, test] of METRICS) {
    lines.push(`| ${label} | ${pct(count(baseline, test), n)} | ${pct(count(firstRound, test), n)} | ${pct(count(ours, test), n)} |`);
  }
  lines.push(`| Mean rounds | 1.00 | 1.00 | ${mean(done.map((r) => r.ours.rounds)).toFixed(2)} |`);
  lines.push(
    `| Mean shortest solution (verified rooms) | ${verifiedSteps(done.map((r) => r.baseline)).toFixed(1)} | — | ${verifiedSteps(done.map((r) => r.ours)).toFixed(1)} |`,
  );
  lines.push(`| Mean tokens per room | ${Math.round(b.tokens)} | — | ${Math.round(o.tokens)} |`);
  lines.push(`| Mean cost per room | ${usd(b.usd)} | — | ${usd(o.usd)} |`);
  lines.push(`| Mean wall time per room | ${b.seconds.toFixed(1)} s | — | ${o.seconds.toFixed(1)} s |`);
  lines.push('');

  lines.push('**By difficulty (solvable)**', '', '| Difficulty | Baseline | Ours |', '|---|---|---|');
  for (const d of [2, 3] as const) {
    const sub = done.filter((r) => r.difficulty === d);
    lines.push(`| ${d} | ${pct(sub.filter((r) => r.baseline.ok).length, sub.length)} | ${pct(sub.filter((r) => r.ours.ok).length, sub.length)} |`);
  }
  lines.push('');

  lines.push('**Ours: round that produced a verified room**', '', '| Round 1 | Round 2 | Round 3 | Round 4 | Not repaired |', '|---|---|---|---|---|');
  const at = (k: number) => done.filter((r) => r.ours.ok && r.ours.rounds === k).length;
  lines.push(`| ${at(1)} | ${at(2)} | ${at(3)} | ${at(4)} | ${done.filter((r) => !r.ours.ok).length} |`, '');

  const failures = done.filter((r) => !r.baseline.ok).slice(0, 3);
  if (failures.length > 0) {
    lines.push('**Sample baseline failures (verifier output, verbatim)**', '');
    for (const r of failures) {
      const issue = r.baseline.issues[0]!;
      lines.push(`- Room ${r.index} (${r.objects.join(', ')}; ${r.theme}): \`${issue.code}\` ${issue.detail}`);
    }
    lines.push('');
  }
  const errors = f.rooms.length - n;
  if (errors > 0) lines.push(`${errors} room(s) excluded because a model call failed in transport (network/HTTP/timeout).`, '');
  return lines.join('\n');
}

const files = readdirSync(resultsDir)
  .filter((name) => /^eval-.+\.json$/.test(name))
  .sort();
const evals = files.map((name) => JSON.parse(readFileSync(join(resultsDir, name), 'utf8')) as EvalFile);

const md = [
  '# Room designer eval',
  '',
  'Same prompt, same model, same rooms. **Baseline** asks the model once. **Ours** sends every rejected design back with the',
  "verifier's counterexamples (and parse errors) until it verifies or runs out of rounds. A room counts as solvable only when",
  'the verifier proves it: exit reachable, no circular dependency, every reference valid, clue texts spell their codes, every',
  'item used, and the shortest solution meets the difficulty floor. Rates are over rooms; a room can have several defects.',
  '',
  ...evals.map(section),
  `_Rendered by \`eval/render.ts\` from ${files.map((f) => `\`results/${f}\``).join(', ')}._`,
  '',
].join('\n');

writeFileSync(join(resultsDir, 'EVAL.md'), md);
console.log(`wrote ${join(resultsDir, 'EVAL.md')} from ${files.length} file(s)`);
