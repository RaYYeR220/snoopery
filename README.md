# Snoopery

**Film your room. Every drawer opens.**

Your friend opens a link and lands inside your room. The chest at the foot of the bed lifts its lid, the desk drawer slides out on its runners, and somewhere in there is the key to get out. Snoopery turns a phone video of a real room and one photo of each piece of furniture into a 3D escape room where drawers, lids and doors genuinely open. An AI hides keys and clues inside them, a solver proves there is a way out before anything is published, and every room also exports as a robot task with the same hinges and slides.

**Try it:** [snoopery.vercel.app](https://snoopery.vercel.app) · rooms: [The attic study](https://snoopery.vercel.app/play/uto4YH9awv) · [Grandmother's bedroom](https://snoopery.vercel.app/play/2XB7Xjzh2-) · [The living room, filmed](https://snoopery.vercel.app/play/yo9TXltcd9) · one object end to end: [blanket chest](https://snoopery.vercel.app/objects/IvFhxMBVoB). No sign-in, no install. Reviewers: [JUDGES.md](JUDGES.md) walks every claim in five minutes.

<!-- numbers:start -->
| Room designer, 40 rooms (seed 20261116) | One-shot model | Snoopery (verifier loop) |
|---|---|---|
| **Rooms proven solvable** | **15% (6/40)** | **100% (40/40)** |
| Hard rooms (≥ 10 steps) proven solvable | 5% (1/20) | 100% (20/20) |
| Key locked inside what it opens (circular) | 15% (6/40) | 0% (0/40) |
| Clue text doesn't contain its code | 63% (25/40) | 0% (0/40) |

Model `qwen-3-8-flash` (repair rounds after the third go to `z-ai-glm-5-3-flash`, at most 6 rounds), mean cost $0.0017 per room. Full table: [packages/puzzle/results/EVAL.md](packages/puzzle/results/EVAL.md).

Robot export, demo room in MuJoCo: `RESULT: PASS (24/24 checks, 2 joints)` ([packages/export/results/mjcf-check.txt](packages/export/results/mjcf-check.txt)).
<!-- numbers:end -->

<!-- content:start -->
**9 pieces of furniture, each from one photo** (museum open-access CC0 and Pexels), 23 joints read from Lux3D's URDF:

| Object | Size from one photo (W × H × D) | vs catalogue (W / H / D) | Moving parts | G1 mesh, min | Articulation, min |
|---|---|---|---|---|---|
| [Pale blue painted wooden chest with drawer](https://snoopery.vercel.app/objects/IvFhxMBVoB) | 0.90 × 0.70 × 0.50 m | -9% / -5% / +3% | lid, drawer | 7.0 | 3.9 |
| [Ornate carved wooden box](https://snoopery.vercel.app/objects/AFBzGii6wW) | 0.32 × 0.13 × 0.23 m | +10% / +15% / +1% | lid | 5.8 | 2.9 |
| [White six-drawer dresser](https://snoopery.vercel.app/objects/oGLP0cak87) | 1.30 × 2.55 × 0.87 m | no catalogue size | drawer top, drawer second, drawer third, drawer bottom | 6.5 | 5.7 |
| [Walnut two-door cabinet with drawers](https://snoopery.vercel.app/objects/mWlggo9rv5) | 1.65 × 1.90 × 0.71 m | -11% / -3% / +2% | door left, door right, drawer left, drawer right | 11.0 | 3.9 |
| [Mahogany cylinder-top desk](https://snoopery.vercel.app/objects/oHy3zYKy9Y) | 1.25 × 1.35 × 0.59 m | +30% / +28% / +18% | cylinder top, drawer top, drawer bottom | 9.8 | 3.8 |
| [Vintage canvas and leather suitcase](https://snoopery.vercel.app/objects/AK-d_6jsND) | 0.60 × 0.45 × 0.26 m | no catalogue size | lid | 7.9 | 3.9 |
| [Mahogany three-drawer chest with marble top](https://snoopery.vercel.app/objects/Sm_9Y1KRzF) | 1.45 × 1.11 × 0.76 m | +10% / +22% / +27% | drawer top left, drawer top center, drawer top right, drawer middle, drawer bottom | 12.8 | 4.8 |
| [Rosewood two-door cabinet](https://snoopery.vercel.app/objects/9LD7tv8bEH) | 0.90 × 0.79 × 0.41 m | +108% / -6% / – | door left, door right | 8.7 | 2.7 |
| [Oak chest with carved panels](https://snoopery.vercel.app/objects/0jaiuUv120) | 1.50 × 0.92 × 0.64 m | +18% / +32% / +56% | lid | 16.0 | 3.0 |

Median height error against the museum catalogue: **15%** (7 pieces).

**Published rooms:** [The attic study](https://snoopery.vercel.app/play/uto4YH9awv) (Aholo SpatialGen, 4 objects, shortest way out 12 steps) · [Grandmother's bedroom](https://snoopery.vercel.app/play/2XB7Xjzh2-) (Aholo SpatialGen, 4 objects, shortest way out 11 steps) · [The living room, filmed](https://snoopery.vercel.app/play/yo9TXltcd9) (filmed, Aholo Reality, 4 objects, shortest way out 5 steps).

Robot export of those rooms in MuJoCo: **236/242 checks pass over 22 joints** ([packages/export/results/real-rooms](packages/export/results/real-rooms)). Every failure is one part: the vintage canvas and leather suitcase lid (`AK-d_6jsND__lid`); see the limits below.
<!-- content:end -->

## What you can do with it

- **Play a room.** Walk through a room in the browser. Click a drawer and it slides out; click a lid and it swings on its hinge. Pick up the note, work out the code, find the key, get out. Hints come from the solver, re-planned from wherever you are, and *Watch the solution* has a Lux3D-rigged figure walk the shortest way out.
- **Make a room.** Film the room (or describe one), photograph the things that open, drop them into the room at true scale, and press *Hide the key*. Nothing is published until the solver has proven the room can be escaped.
- **Use the parts elsewhere.** Every published room exports as a robot-learning task: a MuJoCo scene and a USD stage with real slide and hinge joints, plus the solver's step list as the task. Each object also keeps the URDF that Lux3D articulation returned. An MCP server gives coding agents the same tools.

## How a room is made

```
phone video ─► Aholo Reality ─┐
a sentence  ─► Aholo SpatialGen ┴► 3D Gaussian room ─► upright (gravity +Y, floor 0) ─► voxel collision (splat-transform)
furniture photo ─► Lux3D G1-Turbo (splat preview, ~2 min)
                ─► Lux3D G1 (true-scale PBR mesh, aiPredictSize) ─► Lux3D articulation (motion prompt)
                                                                        │  URDF: one mesh per link + joints
                                       one GLB whose node tree is the kinematic tree · joints: type, axis, pivot, limits
                                                                        │
                       AI room designer ⇄ solver (counterexamples go back to the model until it verifies)
                                                                        │
                    published room ─► browser player (Aholo Viewer) · MuJoCo / USD / task export · MCP
```

| Manycore / Aholo tool | What Snoopery uses it for |
|---|---|
| **Aholo Lux3D** image→3D (G1, `aiPredictSize`) | a true-scale model of each piece of furniture from one photo |
| **Lux3D** G1-Turbo | a Gaussian splat preview of the object while the full model builds |
| **Lux3D** articulation | splits drawers, lids and doors from the body and returns their joints as URDF; Snoopery assembles the links into one model and reads the joints straight from it |
| **Lux3D** text→3D, auto-rig, motion retarget | the key and note that rise out of drawers; the character that walks the shortest solution (idle, walk, open, pick up, cheer) |
| **Aholo Reality** | rebuilds a filmed room as a Gaussian splat |
| **Aholo SpatialGen** | generates a room from a sentence when there is nothing to film |
| **Aholo Viewer** | renders the splat room and the articulated furniture in one scene, outlines what can be opened, drives the joints |
| **Aholo splat-transform** | voxel collision so you can't walk through walls; compresses the object previews to SPZ for the web |
| **Aholo asset storage** | every file a task consumes is uploaded there first, so Aholo's workers never fetch from outside |

## Repository

| Path | What it is |
|---|---|
| `apps/web` | player, studio and object pages (Vite, React, Aholo Viewer); `build:static` bakes rooms into a self-contained folder |
| `apps/api` | generation pipeline and REST API (Fastify on Cloud Run, assets in Cloud Storage) |
| `packages/joints` | joint recovery from articulation animations, part inference, affordance cards |
| `packages/puzzle` | room rules, solver with shortest proof and counterexamples, the AI room designer and its eval |
| `packages/runtime` | the in-browser room: splat + articulated objects, picking, walking with collision, the figure |
| `packages/export` | MuJoCo MJCF, USD physics and task export, with a simulator check |
| `packages/mcp` | MCP server: `verify_room`, `solve_room`, `export_robot_task`, `make_openable` |
| `packages/aholo` | typed client over the official Aholo SDKs with a call log |
| `results/` | snapshot of the published objects and rooms with their catalogue sizes and timings |

## Run it

```bash
pnpm install
pnpm test                                   # every package
# API: needs a Cloud Storage bucket, an Aholo key and a Venice key
ASSET_BUCKET=... AHOLO_API_KEY=... VENICE_API_KEY=... TICK_TOKEN=... SELF_TICK=1 pnpm --filter @snoopery/api dev
# web
VITE_API_URL=http://localhost:8080 pnpm --filter @snoopery/web dev
# reproduce the designer eval, the content snapshot and the robot check
pnpm --filter @snoopery/puzzle eval
pnpm content                                # results/content.json from the public bucket
python packages/export/scripts/check-mjcf.py <export.zip> --room <room.json>
pnpm numbers                                # re-render the numbers above from the result files
```

## Honest limits

- **Drawer fronts, not drawer boxes.** Lux3D articulation segments a drawer as its front panel, and often returns about 1 cm of travel. Snoopery slides a drawer out by 30% of its carcass depth and records that correction on the object (shown on its page). What a drawer holds rises out of it into your pocket; there is no modelled cavity.
- **Directions and swings.** Lux3D often writes a door or lid as opening towards −90°; Snoopery rests every part at 0 and opens it towards the farther limit. Swings over 110° (the suitcase lid came back as 180°) are capped at 110° and noted.
- **Scale is predicted, not measured.** Most pieces land within about a quarter of their catalogue size; the Pexels dresser came back 2.55 m tall and is used in no room.
- **A phone video is not a scanner.** The filmed living room is recognisable but full of floaters; generated rooms look much cleaner. Walk collision comes from voxelizing the splat, so floaters can leave invisible bumps.
- **One part fails in simulation.** The suitcase lid is hinged at its bottom edge; once open, joint friction alone can't hold it in MuJoCo, so its passive and return checks fail. Every other joint passes every check.
- The room designer is checked by the solver, not by taste: a proven room can still be a dull one.

## Credits

Room video: two Pexels clips of one living room by Curtis Adams (Pexels License). Furniture photos: The Metropolitan Museum of Art and the Cleveland Museum of Art open access (CC0), and Pexels (dresser by Max Vakhtbovych, suitcase by Mr. Mockup); every source is listed in [results/sources.json](results/sources.json). The sample apartment is Aholo's open demo scene. Voxel collision queries are adapted from the Aholo Viewer walk example (MIT), which derives from SuperSplat Viewer (MIT).

## License

MIT
