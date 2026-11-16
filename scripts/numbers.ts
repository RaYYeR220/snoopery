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

const readme = read('README.md');
const next = readme.replace(/<!-- numbers:start -->[\s\S]*<!-- numbers:end -->/, block);
if (next === readme && !readme.includes('<!-- numbers:start -->')) throw new Error('README has no numbers block');
writeFileSync(join(root, 'README.md'), next);
console.log(block);
