# @snoopery/mcp

MCP server (stdio) for Snoopery rooms: verify and solve escape-room puzzles, export a room as a
robot-learning task, and turn a furniture photo into an openable 3D model.

| Tool | Input | Result |
| --- | --- | --- |
| `verify_room` | `puzzle` (object or JSON text), optional `min_steps`, `allow_unused` | verdict: `solvable`, `minSteps`, shortest `proof`, `issues` (e.g. `CIRCULAR`), `warnings` |
| `solve_room` | `room_url_or_json` | shortest solution as readable steps and as actions |
| `export_robot_task` | `room_url_or_json`, `format` (`mjcf` \| `usda` \| `task`), `out_path` | writes the zip, returns its path and file list |
| `make_openable` | `photo_url`, optional `motion` | Lux3D model and articulation URLs plus recovered joints |

`room_url_or_json` takes an http(s) URL (such as the API's `GET /rooms/:id`), a path to a room
JSON file, or the room JSON itself. `out_path` is a zip path or an existing directory.

`make_openable` calls Aholo Lux3D (image-to-3D G1 with predicted real-world size, then
articulation) and needs `AHOLO_API_KEY` in the server environment; without it the tool returns an
error and generates nothing. A run takes several minutes and uses Aholo credits; progress is
reported when the client sends a progress token. Result URLs expire about 2 hours after
generation.

## Add it to an MCP client

Install the workspace once (`pnpm install` at the repo root), then point the client at the bin
script with an absolute path. Example for a client configured with an `mcpServers` map (the shape
most desktop clients and editors use):

```json
{
  "mcpServers": {
    "snoopery": {
      "command": "node",
      "args": ["/absolute/path/to/snoopery/packages/mcp/bin/snoopery-mcp.mjs"],
      "env": { "AHOLO_API_KEY": "your-aholo-key" }
    }
  }
}
```

Leave out `env` if you only need `verify_room`, `solve_room` and `export_robot_task`.

From a terminal: `pnpm --filter @snoopery/mcp start` runs the same server on stdio.

## Robot task bundles

`export_robot_task` uses `@snoopery/export`. The `mjcf` bundle loads in MuJoCo as-is
(`python -m mujoco.viewer --mjcf=scene.xml`); `packages/export/scripts/check-mjcf.py` loads a
bundle, drives every joint to its limits and checks the parts move by the exported distance or
angle.
