# Room designer eval

Same prompt, same rooms, same primary model. **Baseline** asks the model once. **Ours** sends every rejected design back
with the verifier's counterexamples (and parse errors) until it verifies or runs out of rounds; a configuration may hand
its later rounds to a second model, named in its column. A room counts as solvable only when the verifier proves it: exit
reachable, no circular dependency, every reference valid, clue texts spell their codes, every item used, and the shortest
solution meets the difficulty floor. Rates are over rooms; a room can have several defects.

## qwen-3-8-flash

- Run 2026-11-16, baseline and repair arms, ≤ 4 rounds: 40 rooms (seed 20261116), 156 model calls, $0.0864.
- Run 2026-11-16, ours arm only, ≤ 6 rounds, escalating to z-ai-glm-5-3-flash after round 3: 40 rooms (seed 20261116), 112 model calls, $0.0677.

Rooms use 3–5 furniture archetypes each; difficulty 2 (≥ 7 steps) and 3 (≥ 10 steps) alternate.

| Metric | Baseline (one-shot) | Ours, round 1 only | Ours: ≤ 4 rounds | Ours: ≤ 6 rounds, z-ai-glm-5-3-flash from round 4 |
|---|---|---|---|---|
| **Solvable (verified)** | 15% (6/40) | 10% (4/40) | 73% (29/40) | 100% (40/40) |
| Circular dependency | 15% (6/40) | 25% (10/40) | 5% (2/40) | 0% (0/40) |
| Soft-lock (exit, item or container unreachable) | 30% (12/40) | 35% (14/40) | 5% (2/40) | 0% (0/40) |
| Invalid reference (unknown part or id, missing key/clue) | 18% (7/40) | 25% (10/40) | 0% (0/40) | 0% (0/40) |
| Clue text does not spell the code | 63% (25/40) | 50% (20/40) | 8% (3/40) | 0% (0/40) |
| Unused item | 8% (3/40) | 0% (0/40) | 5% (2/40) | 0% (0/40) |
| Shorter than the difficulty floor | 20% (8/40) | 30% (12/40) | 18% (7/40) | 0% (0/40) |
| Unparseable reply | 8% (3/40) | 15% (6/40) | 0% (0/40) | 0% (0/40) |
| Mean rounds | 1.00 | 1.00 | 2.90 | 2.80 |
| Mean shortest solution (verified rooms) | 8.8 | — | 10.6 | 10.1 |
| Mean tokens per room | 1678 | — | 6680 | 6592 |
| Mean cost per room | $0.0005 | — | $0.0017 | $0.0017 |
| Mean wall time per room | 11.5 s | — | 31.4 s | 33.6 s |

**By difficulty (solvable)**

| Difficulty | Baseline (one-shot) | Ours: ≤ 4 rounds | Ours: ≤ 6 rounds, z-ai-glm-5-3-flash from round 4 |
|---|---|---|---|
| 2 | 25% (5/20) | 90% (18/20) | 100% (20/20) |
| 3 | 5% (1/20) | 55% (11/20) | 100% (20/20) |

**Round that produced a verified room**

| Configuration | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 | Round 6 | Not repaired |
|---|---|---|---|---|---|---|---|
| Ours: ≤ 4 rounds | 4 | 10 | 12 | 3 | — | — | 11 |
| Ours: ≤ 6 rounds, z-ai-glm-5-3-flash from round 4 | 6 | 16 | 5 | 9 | 1 | 3 | 0 |

With escalation, 13 of 40 verified rooms came from z-ai-glm-5-3-flash.

**Sample baseline failures (verifier output, verbatim)**

- Room 0 (wardrobe, mailbox, bread_bin; a snowed-in mountain cabin): `CLUE_MISSING_CODE` container wardrobe.door_right has code 0412 but the digits in its clues (note_1) contain no digits
- Room 1 (nightstand, piano, suitcase, sideboard, filing_cabinet; a pirate captain's quarters): `CLUE_MISSING_CODE` container piano.top_lid has code 8095 but the digits in its clues (clue_suitcase) contain no digits
- Room 3 (wardrobe, laptop, jewelry_box, cookie_tin, mailbox; a pirate captain's quarters): `CLUE_MISSING_CODE` container wardrobe.door_right has code 1729 but the digits in its clues (laptop.lid_clue, mailbox.flap_clue) spell "17294561729"

_Rendered by `eval/render.ts` from `results/eval-qwen-3-8-flash-escalated.json`, `results/eval-qwen-3-8-flash.json`._
