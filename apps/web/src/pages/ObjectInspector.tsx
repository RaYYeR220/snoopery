import { useEffect, useRef, useState } from 'react';
import { createRuntime, type Runtime } from '@snoopery/runtime';
import type { Joint } from '@snoopery/schema';
import { ASSET_BASE } from '../lib/api';
import type { ObjectDoc } from '../studio/types';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** One stage of the object's life, shown in its own small 3D view. */
function Stage({ title, note, glb, joints, splat }: { title: string; note: string; glb?: string; joints?: Joint[]; splat?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [rt, setRt] = useState<Runtime | null>(null);
  useEffect(() => {
    if (!host.current || (!glb && !splat)) return;
    let alive = true;
    const runtime = createRuntime(host.current);
    void (async () => {
      if (splat) {
        await runtime.loadSpace({ url: splat, format: 'ply', transform: IDENTITY }, { pos: [0, 0.35, 1.4], yaw: 0, pitch: -0.2 });
      } else {
        runtime.controls.pose = { pos: [0, 0.55, 1.6], yaw: 0, pitch: -0.25 };
      }
      if (glb && alive) await runtime.addObject({ objectId: 'o', glbUrl: glb, joints: joints ?? [], position: [0, 0, 0], rotationY: 0.5, scale: 1 });
      if (alive) setRt(runtime);
    })();
    return () => {
      alive = false;
      runtime.dispose();
    };
  }, [glb, splat, joints]);
  return (
    <figure className="sn-stage">
      <div ref={host} className="sn-stage-view">{!glb && !splat && <span className="sn-muted">not produced</span>}</div>
      <figcaption>
        <strong>{title}</strong>
        <span>{note}</span>
      </figcaption>
      {rt && joints && joints.length > 0 && (
        <div className="sn-scrubs">
          {joints.map((j) => (
            <label key={j.part}>
              {j.part.replace(/_/g, ' ')} · {j.type === 'prismatic' ? `${Math.round(j.max * 1000)} mm slide` : `${Math.round((j.max * 180) / Math.PI)}° hinge`}
              <input type="range" min={0} max={1} step={0.01} defaultValue={0} onChange={(e) => rt.setJoint('o', j.part, Number(e.target.value))} />
            </label>
          ))}
        </div>
      )}
    </figure>
  );
}

export function ObjectInspector({ id }: { id: string }) {
  const [doc, setDoc] = useState<ObjectDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(id)) return setError('Not a valid object id.');
    fetch(`${ASSET_BASE}/docs/objects/${encodeURIComponent(id)}.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDoc, (e) => setError(String(e.message)));
  }, [id]);
  if (error) return <div className="sn-fullmsg">{error}</div>;
  if (!doc) return <div className="sn-fullmsg">Loading…</div>;
  const joints = doc.joints ?? [];
  return (
    <main className="sn-inspect">
      <nav className="sn-doc-nav">
        <a href="/" className="sn-logo">Snoopery</a>
        <a href="/rooms">Rooms</a>
        <a href="/studio">Make a room</a>
      </nav>
      <h1>{doc.label}</h1>
      <p className="sn-muted">
        From one photo to a piece of furniture whose parts really move. {joints.length} recovered joint{joints.length === 1 ? '' : 's'}
        {doc.jointSource === 'inferred' ? ' (inferred from geometry)' : ' (from the articulation animation)'}.
        {doc.motionPrompt && <> Motion prompt: “{doc.motionPrompt}”</>}
      </p>
      <div className="sn-stages">
        <figure className="sn-stage">
          <div className="sn-stage-view">{doc.photo ? <img src={doc.photo} alt="" /> : <span className="sn-muted">no photo</span>}</div>
          <figcaption>
            <strong>Photo</strong>
            <span>the only input</span>
          </figcaption>
        </figure>
        <Stage title="Splat preview" note="Lux3D Turbo, ~20 s" splat={doc.previewPly} />
        <Stage title="True-scale mesh" note="Lux3D G1, size predicted" glb={doc.meshGlb} />
        <Stage title="Parts" note="Lux3D part split" glb={doc.partsGlb} />
        <Stage title="Openable" note="Lux3D articulation → recovered joints" glb={doc.webGlb} joints={joints} />
      </div>
    </main>
  );
}
