# Claims and how far each one goes

Every public statement about Snoopery, tagged by the kind of evidence behind it.

- **REPRODUCIBLE**: a script in this repository regenerates the number.
- **VERIFIED-LIVE**: you can see it happen at the live URL.
- **MEASURED-ONCE**: observed on our runs and logged, but depends on a hosted service's timing.
- **NOT CLAIMED**: things we deliberately do not claim.

| Statement | Tier | Where |
|---|---|---|
| One-shot room design is escapable 15% of the time (6/40); with solver counterexamples 100% (40/40); hard rooms 5% → 100% | REPRODUCIBLE | `packages/puzzle/results/EVAL.md` |
| A published room's shortest way out is proven (attic 12, bedroom 11, living room 5 steps) | REPRODUCIBLE, VERIFIED-LIVE | room documents; the player's step counter |
| Nine objects from nine photos; 23 joints read from Lux3D URDFs | REPRODUCIBLE | `results/content.json` via `pnpm content` |
| Median height error 15% against museum catalogues (7 pieces); blanket chest within 9% on every axis | REPRODUCIBLE | `results/content.json`, `results/sources.json` |
| Drawer travel is raised to 30% of carcass depth; swings capped at 110° | REPRODUCIBLE | `jointNotes` on each object; `apps/api/src/pipeline/urdf.ts` |
| 236 of 242 MuJoCo checks pass over 22 joints in the three published rooms; every failure is the suitcase lid | REPRODUCIBLE | `packages/export/results/real-rooms/` |
| G1 mesh 6–16 min, articulation 3–6 min, Reality 19.5 min for a 51 s video, SpatialGen 34–81 min | MEASURED-ONCE | job step timings in `results/content.json` |
| Doors, lids and drawers open in the browser; the figure walks the solution | VERIFIED-LIVE | https://snoopery.vercel.app |

## Not claimed

- That a phone video gives a clean room: the filmed living room has visible floaters.
- That drawers have insides: articulation segments drawer fronts; items rise out of them instead.
- That predicted scale is exact: the dresser came back 2.55 m tall and is not used in any room.
- That rooms are fun because they are proven: the solver guarantees a way out, not a good puzzle.
- That every exported part is stable in simulation: the suitcase lid is not.
