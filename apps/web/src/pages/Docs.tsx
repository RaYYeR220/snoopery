import { API_URL } from '../lib/api';

const MCP_CONFIG = `{
  "mcpServers": {
    "snoopery": {
      "command": "npx",
      "args": ["-y", "tsx", "packages/mcp/bin/snoopery-mcp.mjs"],
      "env": { "AHOLO_API_KEY": "<your Aholo key>" }
    }
  }
}`;

const JOINT = `{
  "part": "top_drawer",
  "node": "top_drawer",
  "type": "prismatic",          // or "revolute"
  "axis": [0, 0, 1],            // unit vector, parent frame
  "pivot": [0, 0.51, 0.04],     // a point on the hinge line (revolute)
  "min": 0, "max": 0.3,         // metres (prismatic) or radians (revolute)
  "clip": "open"                // the articulation clip it was recovered from
}`;

const RUNTIME = `import { createRuntime } from '@snoopery/runtime';

const room = await (await fetch(roomUrl)).json();
const rt = createRuntime(document.getElementById('view')!, {
  onTap: (part) => part && rt.animateJoint(part.objectId, part.part, 1),
});
await rt.loadRoom(room);
rt.setJoint('nightstand', 'top_drawer', 0.5); // half open`;

export function Docs() {
  return (
    <main className="sn-doc">
      <nav className="sn-doc-nav">
        <a href="/" className="sn-logo">Snoopery</a>
        <a href="/rooms">Rooms</a>
        <a href="/studio">Make a room</a>
      </nav>
      <h1>For developers and robots</h1>
      <p className="sn-muted">Everything a room is made of is open: the joints recovered from Aholo Lux3D articulation, the solver that proves a room, and the same room as a simulator task.</p>

      <section>
        <h2>Joints</h2>
        <p>Lux3D's articulation turns a motion prompt into an animation. Snoopery samples that animation and recovers the joint behind it: a slide (prismatic) or a hinge (revolute), its axis, a point on the hinge line, and its limits. Opening a part to a fraction <code>t</code> is <code>local(t) = jointMatrix(joint, t) · restLocal</code>.</p>
        <pre>{JOINT}</pre>
      </section>

      <section>
        <h2>Robot export</h2>
        <p>Every published room exports with real joints and the solver's shortest solution as the task:</p>
        <ul>
          <li><code>GET {API_URL}/rooms/&lt;id&gt;/export?format=mjcf</code> — MuJoCo scene (Z-up), one body per part with <code>slide</code>/<code>hinge</code> joints and ranges, meshes as OBJ, <code>task.json</code></li>
          <li><code>…?format=usda</code> — USD stage with <code>UsdPhysics</code> revolute/prismatic joints and limits</li>
          <li><code>…?format=task</code> — just the task: which part to open to which joint target, what to take, the code for each code lock</li>
        </ul>
        <p>The repository ships a check that loads the MuJoCo export, drives every joint to its limit with actuator force, and confirms the parts move exactly as the room says.</p>
      </section>

      <section>
        <h2>MCP server</h2>
        <p>Tools: <code>verify_room</code> (is this puzzle escapable? why not?), <code>solve_room</code> (shortest way out), <code>export_robot_task</code>, <code>make_openable</code> (photo → Lux3D model → articulation → recovered joints; uses your Aholo key).</p>
        <pre>{MCP_CONFIG}</pre>
      </section>

      <section>
        <h2>In your own page</h2>
        <p><code>@snoopery/runtime</code> renders a room with Aholo Viewer: the splat, the furniture, outlines on what can be opened, and the joints.</p>
        <pre>{RUNTIME}</pre>
      </section>

      <section>
        <h2>Room rules</h2>
        <p>A container opens when the container it sits in is open and its lock is satisfied (a key in your pocket, or the code from its clues). An item can be taken when its container is open. The solver searches every reachable state for the shortest way out and rejects rooms with a key locked inside what it opens, unreachable items, clue texts that don't contain their code, and anything shorter than the chosen difficulty.</p>
      </section>
    </main>
  );
}
