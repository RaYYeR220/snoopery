import { useCallback, useEffect, useRef, useState } from 'react';
import { createRuntime, type Runtime } from '@snoopery/runtime';
import type { Vec3 } from '@snoopery/schema';
import { api } from '../lib/api';
import { JobCard } from './JobCard';
import { uploadFile } from './upload';
import { IDENTITY, Z_UP_TO_Y_UP, type DesignResult, type DraftLocal, type Library, type ObjectDoc, type Placement, type SpaceDoc } from './types';

type Step = 'space' | 'furniture' | 'place' | 'puzzle';
const STEPS: { id: Step; label: string }[] = [
  { id: 'space', label: 'Room' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'place', label: 'Arrange' },
  { id: 'puzzle', label: 'Hide & publish' },
];
const STORE = 'snoopery.draft.v1';

interface PendingJob {
  jobId: string;
  token: string;
  title: string;
  kind: 'object' | 'space';
}

function useLibrary() {
  const [lib, setLib] = useState<Library | null>(null);
  const [paused, setPaused] = useState(false);
  const refresh = useCallback(async () => {
    setLib(await api<Library>('/library'));
    setPaused((await api<{ generation: string }>('/status')).generation === 'paused');
  }, []);
  useEffect(() => void refresh().catch(() => setLib({ objects: [], spaces: [], characters: [] })), [refresh]);
  return { lib, refresh, paused };
}

export function Studio() {
  const { lib, refresh, paused } = useLibrary();
  const [step, setStep] = useState<Step>('space');
  const [draft, setDraft] = useState<DraftLocal | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORE) ?? 'null');
    } catch {
      return null;
    }
  });
  const [chosen, setChosen] = useState<string[]>(() => draft?.placements.map((p) => p.objectId) ?? []);
  const [jobs, setJobs] = useState<PendingJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      if (draft) localStorage.setItem(STORE, JSON.stringify(draft));
    } catch {
      /* storage unavailable: the draft still lives on the server */
    }
  }, [draft]);

  const space = lib?.spaces.find((s) => s.id === draft?.spaceId) ?? null;
  const objects = new Map((lib?.objects ?? []).map((o) => [o.id, o]));

  const saveDraft = useCallback(async (d: DraftLocal) => {
    setDraft(d);
    await api(`/rooms/${encodeURIComponent(d.id)}`, {
      method: 'PUT',
      token: d.token,
      body: JSON.stringify({ title: d.title, author: '', spaceId: d.spaceId, spawn: d.spawn, objects: d.placements, splatTransform: d.splatTransform }),
    });
  }, []);

  const pickSpace = async (s: SpaceDoc) => {
    setError(null);
    const spawn = s.spawn ?? { pos: [0, 1.55, 0] as Vec3, yaw: 0, pitch: 0 };
    const splatTransform = s.transform ?? IDENTITY;
    const body = { title: draft?.title ?? 'My room', author: '', spaceId: s.id, spawn, objects: [], splatTransform };
    try {
      const created = await api<{ id: string; editToken: string }>('/rooms', { method: 'POST', body: JSON.stringify(body) });
      setDraft({ id: created.id, token: created.editToken, title: body.title, spaceId: s.id, spawn, splatTransform, placements: [] });
      setStep('furniture');
    } catch (e) {
      setError(`Could not start a room: ${(e as Error).message}`);
    }
  };

  const submitUpload = async (files: FileList | null, kind: 'object' | 'space', extra: { title?: string } = {}) => {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files)) {
      try {
        const url = await uploadFile(file);
        const r =
          kind === 'object'
            ? await api<{ jobId: string; jobToken: string }>('/objects', { method: 'POST', body: JSON.stringify({ photoUrl: url }) })
            : await api<{ jobId: string; jobToken: string }>('/spaces', { method: 'POST', body: JSON.stringify({ title: extra.title || 'My room', videoUrl: url }) });
        setJobs((j) => [...j, { jobId: r.jobId, token: r.jobToken, title: file.name, kind }]);
      } catch (e) {
        setError(String((e as Error).message));
      }
    }
  };

  const describeSpace = async (prompt: string) => {
    setError(null);
    try {
      const r = await api<{ jobId: string; jobToken: string }>('/spaces', { method: 'POST', body: JSON.stringify({ title: prompt.slice(0, 60), prompt }) });
      setJobs((j) => [...j, { jobId: r.jobId, token: r.jobToken, title: prompt.slice(0, 60), kind: 'space' }]);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="sn-studio">
      <nav className="sn-studio-nav">
        <a href="/" className="sn-logo">Snoopery</a>
        <ol>
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button className={step === s.id ? 'is-on' : ''} disabled={i > 0 && !draft} onClick={() => setStep(s.id)}>
                {i + 1}. {s.label}
              </button>
            </li>
          ))}
        </ol>
        {draft && (
          <button
            onClick={() => {
              localStorage.removeItem(STORE);
              setDraft(null);
              setChosen([]);
              setStep('space');
            }}
          >
            New room
          </button>
        )}
      </nav>
      {paused && <div className="sn-banner">New 3D generation is paused right now. Everything already generated is available below.</div>}
      {error && <div className="sn-banner sn-warn">{error}</div>}

      {step === 'space' && (
        <section className="sn-studio-body">
          <h2>Which room?</h2>
          <div className="sn-grid">
            <label className="sn-tile sn-upload">
              <strong>Film your room</strong>
              <span>60–90 s, walk slowly around the room, phone at chest height. Aholo Reality rebuilds it as a 3D splat.</span>
              <input type="file" accept="video/mp4,video/quicktime,.insv" disabled={paused} onChange={(e) => submitUpload(e.target.files, 'space', { title: 'My room' })} />
            </label>
            <DescribeTile disabled={paused} onSubmit={describeSpace} />
            {(lib?.spaces ?? []).map((s) => (
              <button key={s.id} className={`sn-tile ${draft?.spaceId === s.id ? 'is-on' : ''}`} onClick={() => pickSpace(s)}>
                {s.panoUrl && <img src={s.panoUrl} alt="" />}
                <strong>{s.title}</strong>
                <span>{s.source === 'reconstruction' ? 'Filmed' : s.source === 'generation' ? 'Generated' : 'Sample'}</span>
              </button>
            ))}
          </div>
          <div className="sn-jobs">
            {jobs.filter((j) => j.kind === 'space').map((j) => (
              <JobCard key={j.jobId} jobId={j.jobId} token={j.token} title={j.title} onDone={() => void refresh()} />
            ))}
          </div>
        </section>
      )}

      {step === 'furniture' && (
        <section className="sn-studio-body">
          <h2>What can be opened?</h2>
          <p className="sn-muted">Photograph a drawer unit, a box, a cabinet — whole object in frame, straight on. Lux3D builds a true-scale model and works out how its parts move.</p>
          <label className="sn-tile sn-upload">
            <strong>Add photos</strong>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={paused} onChange={(e) => submitUpload(e.target.files, 'object')} />
          </label>
          <div className="sn-jobs">
            {jobs.filter((j) => j.kind === 'object').map((j) => (
              <JobCard key={j.jobId} jobId={j.jobId} token={j.token} title={j.title} onDone={() => void refresh()} />
            ))}
          </div>
          <h3>Ready to use</h3>
          <div className="sn-grid">
            {(lib?.objects ?? []).map((o) => (
              <button
                key={o.id}
                className={`sn-tile sn-object ${chosen.includes(o.id) ? 'is-on' : ''}`}
                onClick={() => setChosen((c) => (c.includes(o.id) ? c.filter((x) => x !== o.id) : [...c, o.id]))}
              >
                <img src={o.photo} alt="" />
                <strong>{o.label}</strong>
                <span>
                  {(o.joints ?? []).length} moving part{(o.joints ?? []).length === 1 ? '' : 's'} · {o.card?.sizeM.map((v) => Math.round(v * 100)).join('×')} cm
                </span>
              </button>
            ))}
          </div>
          <div className="sn-actions">
            <button className="sn-primary" disabled={chosen.length === 0} onClick={() => setStep('place')}>
              Arrange {chosen.length} in the room
            </button>
          </div>
        </section>
      )}

      {step === 'place' && draft && space && <PlaceStep draft={draft} space={space} chosen={chosen} objects={objects} onSave={saveDraft} onNext={() => setStep('puzzle')} />}
      {step === 'puzzle' && draft && <PuzzleStep draft={draft} objects={objects} onSave={saveDraft} />}
    </div>
  );
}

function DescribeTile({ onSubmit, disabled }: { onSubmit: (p: string) => void; disabled: boolean }) {
  const [text, setText] = useState('');
  return (
    <div className="sn-tile">
      <strong>Describe a room</strong>
      <textarea rows={3} placeholder="A cluttered study in an old flat, bookshelves, a writing desk, warm lamp light" value={text} onChange={(e) => setText(e.target.value)} />
      <button disabled={disabled || text.trim().length < 8} onClick={() => onSubmit(text.trim())}>
        Generate with SpatialGen
      </button>
    </div>
  );
}

function PlaceStep({ draft, space, chosen, objects, onSave, onNext }: { draft: DraftLocal; space: SpaceDoc; chosen: string[]; objects: Map<string, ObjectDoc>; onSave: (d: DraftLocal) => Promise<void>; onNext: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const rt = useRef<Runtime | null>(null);
  const [placements, setPlacements] = useState<Placement[]>(draft.placements);
  const [selected, setSelected] = useState<string | null>(chosen.find((id) => !draft.placements.some((p) => p.objectId === id)) ?? null);
  const [transform, setTransform] = useState(draft.splatTransform);
  const [ready, setReadyState] = useState(false);
  const readyRef = useRef(false);
  const setReady = (v: boolean) => {
    readyRef.current = v;
    setReadyState(v);
  };
  const stateRef = useRef({ placements, selected });
  stateRef.current = { placements, selected };

  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    const runtime = createRuntime(host.current, {
      onTap: (part, floor) => {
        if (!alive || !readyRef.current) return;
        const { placements: ps, selected: sel } = stateRef.current;
        if (part) {
          setSelected(part.objectId);
          return;
        }
        if (!floor || !sel) return;
        const o = objects.get(sel);
        if (!o?.webGlb) return;
        const existing = ps.find((p) => p.objectId === sel);
        const position: Vec3 = [floor[0], runtime.groundAt(floor[0], floor[2]), floor[2]];
        if (existing) {
          runtime.updateObject(sel, { position });
          setPlacements(ps.map((p) => (p.objectId === sel ? { ...p, position } : p)));
        } else {
          const p: Placement = { objectId: sel, position, rotationY: 0, scale: 1 };
          void runtime.addObject({ ...p, glbUrl: o.webGlb, joints: o.joints ?? [] });
          setPlacements([...ps, p]);
        }
      },
      onHover: (ref) => runtime.highlight(ref),
    });
    rt.current = runtime;
    (window as unknown as { snooperyStudio?: Runtime }).snooperyStudio = runtime;
    runtime
      .loadSpace({ url: space.splatUrl, format: space.format, transform: draft.splatTransform }, draft.spawn)
      .then(async () => {
        for (const p of draft.placements) {
          const o = objects.get(p.objectId);
          if (alive && o?.webGlb) await runtime.addObject({ ...p, glbUrl: o.webGlb, joints: o.joints ?? [] });
        }
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
      runtime.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (id: string, change: Partial<Placement>) => {
    setPlacements((ps) => ps.map((p) => (p.objectId === id ? { ...p, ...change } : p)));
    rt.current?.updateObject(id, change);
  };
  const sel = placements.find((p) => p.objectId === selected);

  const toggleCutout = () => {
    if (!sel || !rt.current) return;
    if (sel.cutout) return patch(sel.objectId, { cutout: undefined });
    const size = rt.current.objectSize(sel.objectId);
    if (!size) return;
    patch(sel.objectId, { cutout: { center: [sel.position[0], sel.position[1] + size[1] / 2, sel.position[2]], size: [size[0] * 1.1, size[1] * 1.05, size[2] * 1.1] } });
  };

  const [saveError, setSaveError] = useState<string | null>(null);
  const save = async () => {
    try {
      await onSave({ ...draft, placements, splatTransform: transform, spawn: draft.spawn ?? rt.current!.pose() });
      onNext();
    } catch (e) {
      setSaveError(`Could not save the room: ${(e as Error).message}`);
    }
  };

  return (
    <section className="sn-place">
      <div ref={host} className="sn-place-view" />
      {!ready && <div className="sn-loading">Loading the room…</div>}
      <aside className="sn-place-panel">
        <h3>Arrange</h3>
        <p className="sn-muted">Pick a piece, then click the floor to put it there. Walk with WASD or drag.</p>
        <ul className="sn-place-list">
          {chosen.map((id) => {
            const o = objects.get(id);
            const placed = placements.some((p) => p.objectId === id);
            return (
              <li key={id}>
                <button className={selected === id ? 'is-on' : ''} onClick={() => setSelected(id)}>
                  {o?.label ?? id} {placed ? '· placed' : ''}
                </button>
              </li>
            );
          })}
        </ul>
        {sel && (
          <div className="sn-place-tools">
            <button onClick={() => patch(sel.objectId, { rotationY: sel.rotationY - Math.PI / 12 })}>⟲ 15°</button>
            <button onClick={() => patch(sel.objectId, { rotationY: sel.rotationY + Math.PI / 12 })}>⟳ 15°</button>
            <button onClick={toggleCutout}>{sel.cutout ? 'Show the real one' : 'Replace the real one'}</button>
            <button
              onClick={() => {
                rt.current?.removeObject(sel.objectId);
                setPlacements((ps) => ps.filter((p) => p.objectId !== sel.objectId));
              }}
            >
              Remove
            </button>
          </div>
        )}
        <div className="sn-place-tools">
          <button
            onClick={() => {
              const next = transform.join() === IDENTITY.join() ? Z_UP_TO_Y_UP : IDENTITY;
              setTransform(next);
              rt.current?.setSplatTransform(next);
            }}
          >
            Room is sideways? Flip it
          </button>
          <button onClick={() => void onSave({ ...draft, placements, splatTransform: transform, spawn: rt.current!.pose() })}>Start the player here</button>
        </div>
        {saveError && <div className="sn-warn">{saveError}</div>}
        <button className="sn-primary" disabled={placements.length === 0} onClick={save}>
          Next: hide things
        </button>
      </aside>
    </section>
  );
}

function PuzzleStep({ draft, objects, onSave }: { draft: DraftLocal; objects: Map<string, ObjectDoc>; onSave: (d: DraftLocal) => Promise<void> }) {
  const [theme, setTheme] = useState('My flatmate hid the spare door key somewhere in my room');
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>(2);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DesignResult | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(draft.title);

  const design = async () => {
    setBusy(true);
    setError(null);
    setPublished(null);
    try {
      await onSave({ ...draft, title });
      setResult(await api<DesignResult>(`/rooms/${encodeURIComponent(draft.id)}/design`, { method: 'POST', token: draft.token, body: JSON.stringify({ theme, difficulty }) }));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    try {
      await api(`/rooms/${encodeURIComponent(draft.id)}/publish`, { method: 'POST', token: draft.token });
      setPublished(`${location.origin}/play/${draft.id}`);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const puzzle = result?.puzzle;
  const label = (objectId: string) => objects.get(objectId)?.label ?? objectId;

  return (
    <section className="sn-studio-body">
      <h2>Hide things</h2>
      <div className="sn-form">
        <label>
          Room name
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          The story
          <input value={theme} maxLength={200} onChange={(e) => setTheme(e.target.value)} />
        </label>
        <div className="sn-seg">
          {([1, 2, 3] as const).map((d) => (
            <button key={d} className={difficulty === d ? 'is-on' : ''} onClick={() => setDifficulty(d)}>
              {['Easy', 'Medium', 'Hard'][d - 1]}
            </button>
          ))}
        </div>
        <button className="sn-primary" disabled={busy} onClick={design}>
          {busy ? 'Designing and checking…' : result ? 'Hide again' : 'Hide the key'}
        </button>
      </div>
      {error && <div className="sn-warn">{error}</div>}
      {result && (
        <div className="sn-design">
          <ol className="sn-rounds">
            {result.transcript.map((t) => (
              <li key={t.round} className={t.issues.length ? 'is-bad' : 'is-good'}>
                Round {t.round}: {t.issues.length ? t.issues.map((i) => i.code.toLowerCase().replace(/_/g, ' ')).join(', ') : 'proven solvable'}
              </li>
            ))}
          </ol>
          {result.ok && puzzle && result.verdict ? (
            <>
              <div className="sn-badge">Proven solvable · shortest way out {result.verdict.minSteps} steps</div>
              {result.intro && <p>{result.intro}</p>}
              <ul className="sn-chain">
                {puzzle.containers.map((c) => (
                  <li key={c.id}>
                    <strong>{label(c.objectId)}</strong> {c.part.replace(/_/g, ' ')} — {c.lock.kind === 'none' ? 'unlocked' : c.lock.kind === 'key' ? `locked, needs ${c.lock.keyId.replace(/_/g, ' ')}` : `code ${c.lock.code}`} · holds{' '}
                    {puzzle.items.filter((i) => i.inside === c.id).map((i) => i.label).join(', ') || 'nothing'}
                  </li>
                ))}
              </ul>
              <button className="sn-primary" onClick={publish}>
                Publish
              </button>
            </>
          ) : (
            <p className="sn-warn">This attempt didn't produce a room the solver could prove. Try again or pick an easier level.</p>
          )}
          {published && (
            <div className="sn-published">
              <a href={published}>{published}</a>
              <button onClick={() => navigator.clipboard?.writeText(published)}>Copy link</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
