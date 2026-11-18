# Review Snoopery in five minutes

Everything below runs in a browser with no sign-in, install or wallet. Prefer to watch first? The [2½-minute demo video](https://storage.googleapis.com/snoopery-assets/media/snoopery-demo.mp4) covers the same path.

1. **Play a room (2 min).** Open [The attic study](https://snoopery.vercel.app/play/uto4YH9awv) and press *Start snooping*. Click the oak chest under the window: the lid swings up and a note and a key come out. The blue chest's drawer has a code lock; the two notes give 8 and 42. The shortest way out is 12 steps, proven before the room was published; the counter at the top left shows your steps against it. Stuck? *Hint* plans from wherever you are, and *Watch the solution* has a Lux3D-rigged detective walk the 12 steps.
2. **One photo, one openable object (1 min).** Open the [blanket chest](https://snoopery.vercel.app/objects/IvFhxMBVoB): the museum photo, the Lux3D G1-Turbo splat preview, the G1 mesh at predicted true scale (0.90 × 0.70 × 0.50 m against the catalogue's 0.98 × 0.74 × 0.48 m), and the articulated model. Drag the sliders: the lid hinges on its back edge, the drawer slides. The joints are read from the URDF that Lux3D articulation returned; the page links that URDF and lists the one correction applied (drawer travel).
3. **Make a room (1 min, optional).** Open the [studio](https://snoopery.vercel.app/studio), pick a room, pick two or three pieces, click the floor to place them, then *Hide the key*. The designer's rounds and the solver's verdict appear under the button; *Publish* only works once the room is proven escapable.
4. **The robot side (1 min).** After escaping a room, the result card links the same room as a MuJoCo scene, a USD stage and a task file. The simulator check over the three published rooms is in [packages/export/results/real-rooms](packages/export/results/real-rooms) (236 of 242 checks; the six failures are the suitcase lid, explained in the README's limits).

## Where each claim comes from

| Claim | Evidence | Reproduce |
|---|---|---|
| A model designing rooms alone makes an escapable room 15% of the time; with the solver's counterexamples, 40 of 40 | [packages/puzzle/results/EVAL.md](packages/puzzle/results/EVAL.md) and the raw JSON beside it | `pnpm --filter @snoopery/puzzle eval` |
| Nine pieces of furniture, each from one photo, sizes against museum catalogues | [results/content.json](results/content.json), [results/sources.json](results/sources.json) | `pnpm content` (reads the public bucket) |
| Joints come from Lux3D's URDF | each object's page links its `articulation-urdf.zip`; [apps/api/src/pipeline/urdf.ts](apps/api/src/pipeline/urdf.ts) | `pnpm test` (pipeline test with a URDF package) |
| Every published room is escapable | each room document stores the solver's proof; the player shows the proven minimum | `verify_room` in [packages/mcp](packages/mcp) |
| Rooms run as robot tasks | [packages/export/results/real-rooms](packages/export/results/real-rooms) | `python packages/export/scripts/check-mjcf.py <export.zip> --room <room.json>` |

All numbers in the README are rendered from these files by `pnpm numbers`; none are typed by hand.
