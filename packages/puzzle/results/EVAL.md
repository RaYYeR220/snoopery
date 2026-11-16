# Room designer eval

Same prompt, same model, same rooms. **Baseline** asks the model once. **Ours** sends every rejected design back with the
verifier's counterexamples (and parse errors) until it verifies or runs out of rounds. A room counts as solvable only when
the verifier proves it: exit reachable, no circular dependency, every reference valid, clue texts spell their codes, every
item used, and the shortest solution meets the difficulty floor. Rates are over rooms; a room can have several defects.

## qwen-3-8-flash

40 rooms (seed 20261116, 40 requested), 3–5 furniture archetypes each, difficulty 2 (≥ 7 steps) and 3 (≥ 10 steps) alternating. Run 2026-11-16, 156 model calls, $0.0864 total.

| Metric | Baseline (one-shot) | Ours, round 1 only | Ours (verifier repair, ≤ 4 rounds) |
|---|---|---|---|
| **Solvable (verified)** | 15% (6/40) | 10% (4/40) | 73% (29/40) |
| Circular dependency | 15% (6/40) | 25% (10/40) | 5% (2/40) |
| Soft-lock (exit, item or container unreachable) | 30% (12/40) | 35% (14/40) | 5% (2/40) |
| Invalid reference (unknown part or id, missing key/clue) | 18% (7/40) | 25% (10/40) | 0% (0/40) |
| Clue text does not spell the code | 63% (25/40) | 50% (20/40) | 8% (3/40) |
| Unused item | 8% (3/40) | 0% (0/40) | 5% (2/40) |
| Shorter than the difficulty floor | 20% (8/40) | 30% (12/40) | 18% (7/40) |
| Unparseable reply | 8% (3/40) | 15% (6/40) | 0% (0/40) |
| Mean rounds | 1.00 | 1.00 | 2.90 |
| Mean shortest solution (verified rooms) | 8.8 | — | 10.6 |
| Mean tokens per room | 1678 | — | 6680 |
| Mean cost per room | $0.0005 | — | $0.0017 |
| Mean wall time per room | 11.5 s | — | 31.4 s |

**By difficulty (solvable)**

| Difficulty | Baseline | Ours |
|---|---|---|
| 2 | 25% (5/20) | 90% (18/20) |
| 3 | 5% (1/20) | 55% (11/20) |

**Ours: round that produced a verified room**

| Round 1 | Round 2 | Round 3 | Round 4 | Not repaired |
|---|---|---|---|---|
| 4 | 10 | 12 | 3 | 11 |

**Sample baseline failures (verifier output, verbatim)**

- Room 0 (wardrobe, mailbox, bread_bin; a snowed-in mountain cabin): `CLUE_MISSING_CODE` container wardrobe.door_right has code 0412 but the digits in its clues (note_1) contain no digits
- Room 1 (nightstand, piano, suitcase, sideboard, filing_cabinet; a pirate captain's quarters): `CLUE_MISSING_CODE` container piano.top_lid has code 8095 but the digits in its clues (clue_suitcase) contain no digits
- Room 3 (wardrobe, laptop, jewelry_box, cookie_tin, mailbox; a pirate captain's quarters): `CLUE_MISSING_CODE` container wardrobe.door_right has code 1729 but the digits in its clues (laptop.lid_clue, mailbox.flap_clue) spell "17294561729"

_Rendered by `eval/render.ts` from `results/eval-qwen-3-8-flash.json`._
