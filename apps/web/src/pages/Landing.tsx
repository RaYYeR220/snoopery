import type { ReactNode } from 'react';

const STEPS = [
  { verb: 'Film', text: 'Walk your room with a phone for a minute. Aholo Reality rebuilds it as a 3D splat you can walk through.' },
  { verb: 'Photograph', text: 'Snap the things that open. Aholo Lux3D makes each one at true scale, then articulation makes its drawers slide and its lids swing.' },
  { verb: 'Hide', text: 'An AI tucks keys and clues into those parts. A solver searches every state of the room and only lets it out if there is a way to escape.' },
  { verb: 'Share', text: 'Send the link. Your friend snoops through your actual room, one drawer at a time.' },
];

/** The page below the hero. The hero itself is passed in so the art direction can change without touching the rest. */
export function Landing({ hero }: { hero?: ReactNode }) {
  return (
    <main className="sn-landing">
      {hero ?? (
        <header className="sn-hero-plain">
          <nav className="sn-doc-nav">
            <a href="/" className="sn-logo">Snoopery</a>
            <a href="/rooms">Rooms</a>
            <a href="/docs">Developers</a>
            <a href="/studio">Make a room</a>
          </nav>
          <h1>
            Film your room.
            <br />
            Every drawer opens.
          </h1>
          <p>Snoopery turns a phone video and a few photos of your furniture into a 3D escape room where drawers, lids and doors really open. An AI hides the key; a solver proves there's a way out.</p>
          <div className="sn-row">
            <a className="sn-cta" href="/rooms">Snoop a room</a>
            <a className="sn-cta-ghost" href="/studio">Make yours</a>
          </div>
        </header>
      )}

      <section className="sn-band">
        <ol className="sn-verbs">
          {STEPS.map((s, i) => (
            <li key={s.verb}>
              <span className="sn-verb-n">{String(i + 1).padStart(2, '0')}</span>
              <strong>{s.verb}</strong>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="sn-band sn-proof">
        <h2>Proven, not hoped.</h2>
        <p className="sn-muted">Ask a language model to design an escape room and it will happily lock the key inside the box it opens. We measured it on 40 rooms.</p>
        <div className="sn-figures">
          <div>
            <span className="sn-figure">15%</span>
            <span>of rooms a model designs in one go can actually be escaped</span>
          </div>
          <div>
            <span className="sn-figure sn-accent">40 / 40</span>
            <span>escapable after Snoopery's solver sends its counterexamples back to the model</span>
          </div>
        </div>
        <p className="sn-muted">Every published room carries its proof: the shortest way out, re-checked when you publish and used for hints while you play.</p>
      </section>

      <section className="sn-band">
        <h2>Your room is also a robot's homework.</h2>
        <p className="sn-muted">The joints Snoopery recovers are real slides and hinges with axes and limits. Every room exports as a MuJoCo scene and a USD stage, with the solver's steps as the task: open this drawer to 300 mm, take the note, enter 0412.</p>
        <a className="sn-cta-ghost" href="/docs">For developers and robots</a>
      </section>

      <section className="sn-band sn-built">
        <h2>Built on Manycore's Aholo</h2>
        <ul>
          <li><strong>Lux3D</strong> image→3D, part split, articulation, rigging</li>
          <li><strong>Reality</strong> room reconstruction from a phone video</li>
          <li><strong>SpatialGen</strong> rooms from a sentence</li>
          <li><strong>Aholo Viewer</strong> splats and furniture in one scene</li>
          <li><strong>splat-transform</strong> walk collision</li>
        </ul>
      </section>

      <footer className="sn-footer">
        <a href="/rooms">Rooms</a>
        <a href="/studio">Make a room</a>
        <a href="/docs">Developers</a>
      </footer>
    </main>
  );
}
