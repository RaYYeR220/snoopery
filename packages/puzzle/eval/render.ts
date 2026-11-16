// Renders results/EVAL.md from every results/eval-*.json. Usage: tsx eval/render.ts
// Files with the same primary model and seed share one table: the baseline column comes from the file that ran
// the baseline arm, and every file that ran the repair arm adds its own column.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssueCode } from '../src/index';
import type { ArmResult, EvalFile, RoomResult } from './run';

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

interface Outcome {
  ok: boolean;
  codes: IssueCode[];
}

interface Column {
  title: string;
  /** Rooms whose arm finished without a transport error. */
  rooms: RoomResult[];
  /** Rooms the source file attempted, for the transport-failure note. */
  attempted: number;
  outcome: (r: RoomResult) => Outcome;
  /** Arm used for rounds/tokens/cost rows; absent for the round-1-only view. */
  arm?: (r: RoomResult) => ArmResult;
}

const any =
  (...codes: IssueCode[]) =>
  (a: Outcome) =>
    a.codes.some((c) => codes.includes(c));

const METRICS: [string, (a: Outcome) => boolean][] = [
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
const armsOf = (f: EvalFile) => f.arms ?? ['baseline', 'ours'];
const oursTitle = (f: EvalFile) =>
  `Ours: ≤ ${f.maxRounds} rounds${f.escalateTo ? `, ${f.escalateTo} from round ${(f.escalateAfter ?? 0) + 1}` : ''}`;

function columnsFor(files: EvalFile[]): Column[] {
  const cols: Column[] = [];
  const withBaseline = files.find((f) => armsOf(f).includes('baseline'));
  if (withBaseline) {
    cols.push({
      title: 'Baseline (one-shot)',
      rooms: withBaseline.rooms.filter((r) => r.baseline && !r.baseline.error),
      attempted: withBaseline.rooms.length,
      outcome: (r) => ({ ok: r.baseline!.ok, codes: r.baseline!.codes }),
      arm: (r) => r.baseline!,
    });
  }
  files
    .filter((f) => armsOf(f).includes('ours'))
    .forEach((f, k) => {
      const rooms = f.rooms.filter((r) => r.ours && !r.ours.error);
      const attempted = f.rooms.length;
      if (k === 0) {
        cols.push({
          title: 'Ours, round 1 only',
          rooms,
          attempted,
          outcome: (r) => ({ ok: r.ours!.firstCodes.length === 0, codes: r.ours!.firstCodes }),
        });
      }
      cols.push({ title: oursTitle(f), rooms, attempted, outcome: (r) => ({ ok: r.ours!.ok, codes: r.ours!.codes }), arm: (r) => r.ours! });
    });
  return cols;
}

function section(files: EvalFile[]): string {
  const cols = columnsFor(files);
  const scored = cols.filter((c) => c.arm);
  const lines: string[] = [`## ${files[0]!.model}`, ''];

  for (const f of files) {
    const what = armsOf(f).length === 2 ? 'baseline and repair arms' : `${armsOf(f).join(' and ')} arm only`;
    const escalation = f.escalateTo ? `, escalating to ${f.escalateTo} after round ${f.escalateAfter}` : '';
    lines.push(
      `- Run ${f.createdAt.slice(0, 10)}, ${what}, ≤ ${f.maxRounds} rounds${escalation}: ${f.rooms.length} rooms (seed ${f.seed}), ` +
        `${f.totals.calls} model calls, ${usd(f.totals.usd)}${f.stopped ? `, stopped early: ${f.stopped}` : ''}.`,
    );
  }
  lines.push('', 'Rooms use 3–5 furniture archetypes each; difficulty 2 (≥ 7 steps) and 3 (≥ 10 steps) alternate.', '');

  const armRow = (label: string, f: (arms: ArmResult[]) => string, fallback = '—') =>
    `| ${label} | ${cols.map((c) => (c.arm && c.rooms.length > 0 ? f(c.rooms.map(c.arm)) : fallback)).join(' | ')} |`;

  lines.push(`| Metric | ${cols.map((c) => c.title).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  for (const [label, test] of METRICS) {
    lines.push(`| ${label} | ${cols.map((c) => pct(c.rooms.filter((r) => test(c.outcome(r))).length, c.rooms.length)).join(' | ')} |`);
  }
  lines.push(armRow('Mean rounds', (a) => mean(a.map((x) => x.rounds)).toFixed(2), '1.00'));
  lines.push(armRow('Mean shortest solution (verified rooms)', (a) => mean(a.filter((x) => x.ok).map((x) => x.minSteps ?? 0)).toFixed(1)));
  lines.push(armRow('Mean tokens per room', (a) => String(Math.round(mean(a.map((x) => x.promptTokens + x.completionTokens))))));
  lines.push(armRow('Mean cost per room', (a) => usd(mean(a.map((x) => x.usd)))));
  lines.push(armRow('Mean wall time per room', (a) => `${mean(a.map((x) => x.ms / 1000)).toFixed(1)} s`));
  lines.push('');

  lines.push('**By difficulty (solvable)**', '', `| Difficulty | ${scored.map((c) => c.title).join(' | ')} |`, `|---|${scored.map(() => '---').join('|')}|`);
  for (const d of [2, 3] as const) {
    const cells = scored.map((c) => {
      const sub = c.rooms.filter((r) => r.difficulty === d);
      return pct(sub.filter((r) => c.outcome(r).ok).length, sub.length);
    });
    lines.push(`| ${d} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  const repairs = files.filter((f) => armsOf(f).includes('ours'));
  if (repairs.length > 0) {
    const rounds = Array.from({ length: Math.max(...repairs.map((f) => f.maxRounds)) }, (_, k) => k + 1);
    lines.push(
      '**Round that produced a verified room**',
      '',
      `| Configuration | ${rounds.map((k) => `Round ${k}`).join(' | ')} | Not repaired |`,
      `|---|${rounds.map(() => '---').join('|')}|---|`,
    );
    for (const f of repairs) {
      const done = f.rooms.filter((r) => r.ours && !r.ours.error).map((r) => r.ours!);
      const at = (k: number) => (k > f.maxRounds ? '—' : String(done.filter((a) => a.ok && a.rounds === k).length));
      lines.push(`| ${oursTitle(f)} | ${rounds.map(at).join(' | ')} | ${done.filter((a) => !a.ok).length} |`);
    }
    lines.push('');
    for (const f of repairs.filter((f) => f.escalateTo)) {
      const done = f.rooms.filter((r) => r.ours && !r.ours.error).map((r) => r.ours!);
      const verified = done.filter((a) => a.ok);
      lines.push(`With escalation, ${verified.filter((a) => a.solvedBy === f.escalateTo).length} of ${verified.length} verified rooms came from ${f.escalateTo}.`, '');
    }
  }

  const baseline = cols.find((c) => c.title.startsWith('Baseline'));
  const failures = baseline ? baseline.rooms.filter((r) => !r.baseline!.ok).slice(0, 3) : [];
  if (failures.length > 0) {
    lines.push('**Sample baseline failures (verifier output, verbatim)**', '');
    for (const r of failures) {
      const issue = r.baseline!.issues[0]!;
      lines.push(`- Room ${r.index} (${r.objects.join(', ')}; ${r.theme}): \`${issue.code}\` ${issue.detail}`);
    }
    lines.push('');
  }
  for (const c of scored) {
    if (c.attempted > c.rooms.length) {
      lines.push(`${c.title}: ${c.attempted - c.rooms.length} room(s) excluded after a transport failure (network/HTTP/timeout).`, '');
    }
  }
  return lines.join('\n');
}

const names = readdirSync(resultsDir)
  .filter((name) => /^eval-.+\.json$/.test(name))
  .sort();
const evals = names
  .map((name) => JSON.parse(readFileSync(join(resultsDir, name), 'utf8')) as EvalFile)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const groups = new Map<string, EvalFile[]>();
for (const f of evals) {
  const key = `${f.model}|${f.seed}`;
  groups.set(key, [...(groups.get(key) ?? []), f]);
}

const md = [
  '# Room designer eval',
  '',
  'Same prompt, same rooms, same primary model. **Baseline** asks the model once. **Ours** sends every rejected design back',
  "with the verifier's counterexamples (and parse errors) until it verifies or runs out of rounds; a configuration may hand",
  'its later rounds to a second model, named in its column. A room counts as solvable only when the verifier proves it: exit',
  'reachable, no circular dependency, every reference valid, clue texts spell their codes, every item used, and the shortest',
  'solution meets the difficulty floor. Rates are over rooms; a room can have several defects.',
  '',
  ...[...groups.values()].map(section),
  `_Rendered by \`eval/render.ts\` from ${names.map((f) => `\`results/${f}\``).join(', ')}._`,
  '',
].join('\n');

writeFileSync(join(resultsDir, 'EVAL.md'), md);
console.log(`wrote ${join(resultsDir, 'EVAL.md')} from ${names.length} file(s)`);
