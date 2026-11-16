# Snoopery

**Film your room. Every drawer opens.**

Snoopery turns a phone video of a real room and a few photos of your furniture into a 3D escape room where the drawers, lids and doors genuinely open. An AI hides keys and clues inside them, a solver proves there is a way out, and a friend opens the link and snoops through your room until they find it.

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

## What you can do with it

- **Play a room.** Walk through a scanned room in the browser. Click a drawer and it slides out on its own runners; click a jewellery box and the lid swings on its hinge. Pick up the note, work out the code, find the key, get out. Hints come from the solver, re-planned from wherever you are, and *Watch the solution* replays the shortest way out.
- **Make a room.** Film the room (or describe one), photograph the things that open, drop them into the scan at true scale, and press *Hide the key*. Nothing is published until the solver has proven the room can be escaped.
- **Use the parts elsewhere.** Every published room exports as a robot-learning task: a MuJoCo scene and a USD stage with real slide and hinge joints, plus the solver's step list as the task. An MCP server gives coding agents the same tools.

## How a room is made

```
phone video ──► Aholo Reality ─────────► 3D Gaussian splat of the room ──► voxel collision (splat-transform)
furniture photo ──► Aholo Lux3D image→3D (true scale) ──► part split ──► articulation (motion prompt)
                                                                              │
                                     recovered joints: type · axis · pivot · limits
                                                                              │
              AI room designer ⇄ solver (counterexamples back to the model until it verifies)
                                                                              │
                     published room ──► browser player (Aholo Viewer) · robot export · MCP
```

| Manycore / Aholo tool | What Snoopery uses it for |
|---|---|
| **Aholo Lux3D** image→3D (G1, `aiPredictSize`) | a true-scale model of each piece of furniture from one photo |
| **Lux3D** Turbo splat preview | the 20-second preview while the full model builds |
| **Lux3D** part split + articulation | separates drawers, lids and doors and animates them from a motion prompt; Snoopery recovers each joint from that animation |
| **Lux3D** text→3D, auto-rig, motion retarget | keys and props; the character that walks the shortest solution |
| **Aholo Reality** | rebuilds the filmed room as a Gaussian splat |
| **Aholo SpatialGen** | generates a room from a sentence when there is nothing to film |
| **Aholo Viewer** | renders the splat room and the articulated furniture in one scene, outlines what can be opened, drives the joints |
| **@manycore/aholo-splat-transform** | voxel collision, so you can't walk through walls |

## Repository

| Path | What it is |
|---|---|
| `apps/web` | player and studio (Vite, React, Aholo Viewer) |
| `apps/api` | generation pipeline and REST API (Fastify on Cloud Run, assets in Cloud Storage) |
| `packages/joints` | recovers joint type, axis, pivot and limits from an articulation animation |
| `packages/puzzle` | room rules, solver with shortest proof and counterexamples, the AI room designer and its eval |
| `packages/runtime` | the in-browser room: splat + articulated objects, picking, walking with collision |
| `packages/export` | MuJoCo MJCF, USD physics and task export, with a simulator check |
| `packages/mcp` | MCP server: `verify_room`, `solve_room`, `export_robot_task`, `make_openable` |
| `packages/aholo` | typed client over the official Aholo SDKs with a call log |

## Run it

```bash
pnpm install
pnpm test                                   # every package
# API: needs a Cloud Storage bucket, an Aholo key and a Venice key
ASSET_BUCKET=... AHOLO_API_KEY=... VENICE_API_KEY=... TICK_TOKEN=... SELF_TICK=1 pnpm --filter @snoopery/api dev
# web
VITE_API_URL=http://localhost:8080 pnpm --filter @snoopery/web dev
# reproduce the designer eval and the robot check
pnpm --filter @snoopery/puzzle eval
pnpm --filter @snoopery/export export:demo && pnpm --filter @snoopery/export check:mjcf
pnpm numbers                                # re-render the numbers above from the result files
```

## Honest limits

- AI-generated furniture has no hollow insides: when a drawer opens, what it holds goes into your pocket rather than lying in a modelled cavity.
- Joints come from Lux3D's articulation animation. When an animation is missing, Snoopery infers the joint from the part's geometry and marks the object (`jointSource: inferred`).
- Walk collision comes from voxelizing the splat; scans with floaters can leave invisible bumps.
- The room designer is checked by the solver, not by taste: a proven room can still be a dull one.

## Credits

The sample apartment is Aholo's open demo scene. Voxel collision queries are adapted from the Aholo Viewer walk example (MIT), which derives from SuperSplat Viewer (MIT).

## License

MIT
