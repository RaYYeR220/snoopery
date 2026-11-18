// Renders the headline numbers in README.md from the result files, so no figure is typed by hand.
// Usage: tsx scripts/numbers.ts            (rewrites the block between the numbers markers)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

interface Arm {
  ok: boolean;
  rounds: number;
  codes: string[];
  usd: number;
}
interface Room {
  difficulty: number;
  baseline?: Arm;
  ours: Arm;
}

const base = JSON.parse(read('packages/puzzle/results/eval-qwen-3-8-flash.json')) as { model: string; seed: number; rooms: Room[] };
const esc = JSON.parse(read('packages/puzzle/results/eval-qwen-3-8-flash-escalated.json')) as { escalateTo: string; maxRounds: number; rooms: Room[] };
const mjcf = read('packages/export/results/mjcf-check.txt');

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}% (${n}/${d})`;
const solved = (rooms: Room[], arm: 'baseline' | 'ours', difficulty?: number) => {
  const rs = rooms.filter((r) => difficulty === undefined || r.difficulty === difficulty);
  return pct(rs.filter((r) => r[arm]?.ok).length, rs.length);
};
const has = (rooms: Room[], arm: 'baseline' | 'ours', code: string) => pct(rooms.filter((r) => r[arm]?.codes.includes(code)).length, rooms.length);
const meanUsd = (rooms: Room[]) => (rooms.reduce((s, r) => s + r.ours.usd, 0) / rooms.length).toFixed(4);
const mjcfLine = mjcf.split('\n').find((l) => l.startsWith('RESULT')) ?? 'RESULT: not run';

const block = `<!-- numbers:start -->
| Room designer, ${base.rooms.length} rooms (seed ${base.seed}) | One-shot model | Snoopery (verifier loop) |
|---|---|---|
| **Rooms proven solvable** | **${solved(base.rooms, 'baseline')}** | **${solved(esc.rooms, 'ours')}** |
| Hard rooms (≥ 10 steps) proven solvable | ${solved(base.rooms, 'baseline', 3)} | ${solved(esc.rooms, 'ours', 3)} |
| Key locked inside what it opens (circular) | ${has(base.rooms, 'baseline', 'CIRCULAR')} | ${has(esc.rooms, 'ours', 'CIRCULAR')} |
| Clue text doesn't contain its code | ${has(base.rooms, 'baseline', 'CLUE_MISSING_CODE')} | ${has(esc.rooms, 'ours', 'CLUE_MISSING_CODE')} |

Model \`${base.model}\` (repair rounds after the third go to \`${esc.escalateTo}\`, at most ${esc.maxRounds} rounds), mean cost $${meanUsd(esc.rooms)} per room. Full table: [packages/puzzle/results/EVAL.md](packages/puzzle/results/EVAL.md).

Robot export, demo room in MuJoCo: \`${mjcfLine}\` ([packages/export/results/mjcf-check.txt](packages/export/results/mjcf-check.txt)).
<!-- numbers:end -->`;

// Published content: real Lux3D objects and rooms (results/content.json, written by scripts/content.ts).
interface Obj {
  objectId: string;
  label: string;
  sizeM: { w: number; h: number; d: number };
  sizeErrorPct: { w: number | null; h: number | null; d: number | null } | null;
  joints: { part: string; type: string }[];
  seconds: { preview: number | null; mesh: number | null; articulate: number | null };
}
const content = JSON.parse(read('results/content.json')) as { objects: Obj[]; rooms: { id: string; title: string; space: { source: string } | null; objects: string[]; minSteps: number }[] };
const signed = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v}%`);
const minutes = (s: number | null) => (s === null ? '–' : `${(s / 60).toFixed(1)}`);
const heights = content.objects.flatMap((o) => (o.sizeErrorPct?.h !== null && o.sizeErrorPct?.h !== undefined ? [Math.abs(o.sizeErrorPct.h)] : [])).sort((a, b) => a - b);
const median = heights.length ? (heights.length % 2 ? heights[(heights.length - 1) / 2]! : (heights[heights.length / 2 - 1]! + heights[heights.length / 2]!) / 2) : null;
const jointsTotal = content.objects.reduce((n, o) => n + o.joints.length, 0);

const realChecks = ['uto4YH9awv', '2XB7Xjzh2-', 'yo9TXltcd9'].map((id) => read(`packages/export/results/real-rooms/${id}.txt`));
const tally = realChecks.map((t) => /RESULT: \w+ \((\d+)\/(\d+) checks, (\d+) joints\)/.exec(t)!).map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
const [passed, total, joints] = tally.reduce((a, t) => [a[0]! + t[0]!, a[1]! + t[1]!, a[2]! + t[2]!], [0, 0, 0]);
const failingJoints = [...new Set(realChecks.flatMap((t) => t.split(/\n(?=\[)/).filter((sec) => /^\s+FAIL /m.test(sec)).map((sec) => /^\[\w+\] (\S+)/.exec(sec)?.[1] ?? '?')))];

const contentBlock = `<!-- content:start -->
**${content.objects.length} pieces of furniture, each from one photo** (museum open-access CC0 and Pexels), ${jointsTotal} joints read from Lux3D's URDF:

| Object | Size from one photo (W × H × D) | vs catalogue (W / H / D) | Moving parts | G1 mesh, min | Articulation, min |
|---|---|---|---|---|---|
${content.objects
  .map((o) => `| [${o.label}](https://snoopery.vercel.app/objects/${o.objectId}) | ${o.sizeM.w.toFixed(2)} × ${o.sizeM.h.toFixed(2)} × ${o.sizeM.d.toFixed(2)} m | ${o.sizeErrorPct ? `${signed(o.sizeErrorPct.w)} / ${signed(o.sizeErrorPct.h)} / ${signed(o.sizeErrorPct.d)}` : 'no catalogue size'} | ${o.joints.map((j) => j.part.replace(/_/g, ' ')).join(', ')} | ${minutes(o.seconds.mesh)} | ${minutes(o.seconds.articulate)} |`)
  .join('\n')}

Median height error against the museum catalogue: **${median}%** (${heights.length} pieces).

**Published rooms:** ${content.rooms.map((r) => `[${r.title}](https://snoopery.vercel.app/play/${r.id}) (${r.space?.source === 'reconstruction' ? 'filmed, Aholo Reality' : 'Aholo SpatialGen'}, ${r.objects.length} objects, shortest way out ${r.minSteps} steps)`).join(' · ')}.

Robot export of those rooms in MuJoCo: **${passed}/${total} checks pass over ${joints} joints** ([packages/export/results/real-rooms](packages/export/results/real-rooms)). Every failure is one part: ${failingJoints.map((j) => { const [id, part] = j.split('__'); const label = content.objects.find((o) => o.objectId === id)?.label ?? id; return `the ${label.toLowerCase()} ${part} (\`${j}\`)`; }).join(', ')}; see the limits below.
<!-- content:end -->`;

let readme = read('README.md');
for (const [name, text] of [['numbers', block], ['content', contentBlock]] as const) {
  const re = new RegExp(`<!-- ${name}:start -->[\\s\\S]*<!-- ${name}:end -->`);
  if (!re.test(readme)) throw new Error(`README has no ${name} block`);
  readme = readme.replace(re, text);
}
writeFileSync(join(root, 'README.md'), readme);
console.log(block);
console.log(contentBlock);
