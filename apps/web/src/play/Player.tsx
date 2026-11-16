import { useCallback, useEffect, useRef, useState } from 'react';
import { createRuntime, type PartRef, type Runtime } from '@snoopery/runtime';

/** Aholo's open demo robot (idle / walk); rooms can name their own Lux3D-rigged figure instead. */
const DEFAULT_CHARACTER = { modelUrl: 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/misc/robot.0765006a.glb' };
import type { PuzzleItem, RoomDoc } from '@snoopery/schema';
import { api, API_URL, loadRoom, type LeaderRow } from '../lib/api';
import { dict, useLang, type Dict } from '../lib/i18n';
import * as sfx from './sound';
import { formatTime, hint, looseItems, newGame, openPart, takeLoose, tryExit, type Game } from './game';

type Toast = { id: number; text: string; tone?: 'info' | 'warn' | 'good' };
type Modal = { kind: 'keypad'; ref: PartRef; label: string } | { kind: 'clue'; item: PuzzleItem } | { kind: 'win' } | null;

export function Player({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  const rt = useRef<Runtime | null>(null);
  const [room, setRoom] = useState<RoomDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [game, setGame] = useState<Game>(newGame);
  const gameRef = useRef(game);
  gameRef.current = game;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [hover, setHover] = useState<PartRef | null>(null);
  const [now, setNow] = useState(Date.now());
  const [replaying, setReplaying] = useState(false);
  const [intro, setIntro] = useState(true);
  const [muted, setMutedState] = useState(false);
  const [lang, setLang] = useLang();
  const d = dict(lang);
  const dRef = useRef(d);
  dRef.current = d;

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const t = { id: Math.random(), text, tone };
    setToasts((x) => [...x.slice(-2), t]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== t.id)), 3600);
  }, []);

  const motionSound = (r: RoomDoc, ref: PartRef) => {
    const joint = r.objects.find((o) => o.objectId === ref.objectId)?.joints.find((j) => j.part === ref.part);
    if (joint?.type === 'prismatic') sfx.slide();
    else sfx.creak();
  };

  const labelOf = useCallback((r: RoomDoc, ref: PartRef) => {
    const c = r.puzzle.containers.find((x) => x.objectId === ref.objectId && x.part === ref.part);
    return c ? `${ref.part.replace(/_/g, ' ')}` : ref.part.replace(/_/g, ' ');
  }, []);

  const interact = useCallback(
    async (ref: PartRef, typedCode?: string) => {
      const r = room;
      const runtime = rt.current;
      if (!r || !runtime) return;
      const { game: next, outcome } = openPart(r, gameRef.current, ref.objectId, ref.part, typedCode);
      setGame(next);
      gameRef.current = next;
      switch (outcome.kind) {
        case 'toggle': {
          const open = runtime.getJoint(ref.objectId, ref.part) > 0.5;
          motionSound(r, ref);
          await runtime.animateJoint(ref.objectId, ref.part, open ? 0 : 1);
          break;
        }
        case 'opened':
          setModal(null);
          if (typedCode) sfx.unlock();
          motionSound(r, ref);
          await runtime.animateJoint(ref.objectId, ref.part, 1);
          if (outcome.found.length) sfx.pickup();
          if (outcome.found.length === 0) toast(dRef.current.empty);
          for (const it of outcome.found) {
            toast(`${dRef.current.found}: ${it.label}`, 'good');
            if (it.kind === 'clue' && it.text) setModal({ kind: 'clue', item: it });
          }
          break;
        case 'locked':
          sfx.rattle();
          await runtime.animateJoint(ref.objectId, ref.part, 0.06, 140);
          await runtime.animateJoint(ref.objectId, ref.part, 0, 180);
          if (outcome.needs === 'code') setModal({ kind: 'keypad', ref, label: labelOf(r, ref) });
          else toast(dRef.current.lockedKey, 'warn');
          break;
        case 'blocked':
          toast(outcome.reason, 'warn');
          break;
      }
    },
    [room, toast, labelOf],
  );

  // Boot the runtime once the room document is in.
  useEffect(() => {
    let cancelled = false;
    loadRoom(id)
      .then((doc) => !cancelled && setRoom(doc))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const interactRef = useRef(interact);
  interactRef.current = interact;

  useEffect(() => {
    if (!room || !host.current) return;
    let alive = true;
    const runtime = createRuntime(host.current, {
      onProgress: (f) => alive && setProgress(f),
      onHover: (ref) => {
        setHover(ref);
        runtime.highlight(ref);
        host.current!.style.cursor = ref ? 'pointer' : 'grab';
      },
      onTap: (ref, floor) => {
        if (!alive) return;
        if (ref) void interactRef.current(ref);
        else if (floor) runtime.controls.glideTo(floor[0], floor[2]);
      },
    });
    rt.current = runtime;
    runtime.loadRoom(room).catch((e) => alive && setError(`Could not load the 3D room: ${e.message ?? e}`));
    (window as unknown as { snoopery?: unknown }).snoopery = runtime;
    return () => {
      alive = false;
      runtime.dispose();
      rt.current = null;
    };
  }, [room]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // The clock starts when the player starts, not when the page loads.
  const startPlay = () => {
    setIntro(false);
    setGame((g) => (g.steps === 0 ? { ...g, startedAt: Date.now() } : g));
  };

  const onHint = () => {
    if (!room || !rt.current) return;
    const next = hint(room, game);
    if (!next) return;
    setGame((g) => ({ ...g, hints: g.hints + 1 }));
    if (next.type === 'take') {
      const it = room.puzzle.items.find((i) => i.id === next.item);
      if (it) toast(`${d.lyingAround}: ${it.label}.`);
      return;
    }
    if (next.type === 'exit') {
      toast(d.haveAll, 'good');
      return;
    }
    if (next.type === 'open') {
      const c = room.puzzle.containers.find((x) => x.id === next.target)!;
      const at = rt.current.partPosition(c.objectId, c.part);
      if (at) rt.current.controls.lookAt(at[0], at[1], at[2]);
      rt.current.highlight({ objectId: c.objectId, part: c.part });
      toast(`${d.lookAt} ${c.part.replace(/_/g, ' ')}.`);
    }
  };

  const onExit = () => {
    if (!room) return;
    const { game: next, outcome } = tryExit(room, game);
    setGame(next);
    if (outcome.kind === 'escaped') {
      sfx.unlock();
      setModal({ kind: 'win' });
    }
    else if (outcome.kind === 'exit-locked') toast(d.doorLocked, 'warn');
  };

  const replay = async () => {
    if (!room || !rt.current || replaying) return;
    setReplaying(true);
    const runtime = rt.current;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const p of runtime.parts()) runtime.setJoint(p.objectId, p.part, 0);
    let figure: Awaited<ReturnType<Runtime['character']>> | null = null;
    try {
      figure = await runtime.character(room.character ?? DEFAULT_CHARACTER);
    } catch {
      figure = null;
    }
    const [sx, , sz] = room.spawn.pos;
    // Start just ahead and to the right of the viewer, so the walk to each part is in view.
    const fx = sx - Math.sin(room.spawn.yaw) * 0.6 + Math.cos(room.spawn.yaw) * 0.5;
    const fz = sz - Math.cos(room.spawn.yaw) * 0.6 - Math.sin(room.spawn.yaw) * 0.5;
    figure?.place(fx, fz, room.spawn.yaw + Math.PI);
    figure?.show(true);
    const follow = setInterval(() => {
      if (!figure) return;
      const [x, y, z] = figure.position();
      runtime.controls.lookAt(x, y + 0.9, z, 280);
    }, 300);
    try {
      for (const a of room.proof) {
        if (a.type === 'open') {
          const c = room.puzzle.containers.find((x) => x.id === a.target)!;
          const at = runtime.partPosition(c.objectId, c.part);
          if (figure && at) {
            const [px, py, pz] = figure.position();
            const dx = px - at[0];
            const dz = pz - at[2];
            const d = Math.hypot(dx, dz) || 1;
            await figure.walkTo(at[0] + (dx / d) * 0.75, at[2] + (dz / d) * 0.75);
            figure.face(at[0], at[2]);
            figure.play(figure.has('open') ? 'open' : 'idle');
            void py;
          }
          runtime.highlight({ objectId: c.objectId, part: c.part });
          await wait(450);
          motionSound(room, { objectId: c.objectId, part: c.part });
          await runtime.animateJoint(c.objectId, c.part, 1, 900);
          figure?.play('idle');
        } else if (a.type === 'take') {
          const it = room.puzzle.items.find((x) => x.id === a.item);
          if (figure?.has('pickup')) figure.play('pickup');
          if (it) toast(`${d.takes}: ${it.label}`, 'good');
          sfx.pickup();
          await wait(800);
          figure?.play('idle');
        } else {
          if (figure) await figure.walkTo(fx, fz);
          figure?.play(figure.has('cheer') ? 'cheer' : 'idle');
          sfx.unlock();
          toast(d.outDoor, 'good');
          await wait(1200);
        }
      }
    } finally {
      clearInterval(follow);
      runtime.highlight(null);
      setReplaying(false);
    }
  };

  if (error) return <div className="sn-fullmsg">{error}</div>;

  const elapsed = (game.finishedAt ?? now) - game.startedAt;
  const inventory = room ? game.state.inventory.map((iid) => room.puzzle.items.find((x) => x.id === iid)!).filter(Boolean) : [];

  return (
    <div className="sn-player">
      <div ref={host} className="sn-viewport" />
      {progress < 1 && (
        <div className="sn-loading">
          <div className="sn-loading-bar" style={{ transform: `scaleX(${progress})` }} />
          <span>{d.loading} {Math.round(progress * 100)}%</span>
        </div>
      )}
      {room && (
        <>
          <header className="sn-hud-top">
            <div>
              <div className="sn-room-title">{room.title}</div>
              <div className="sn-room-meta">
                {formatTime(elapsed)} · {game.steps} {d.steps} · {d.shortest} {room.verdict.minSteps}
              </div>
            </div>
            <div className="sn-hud-actions">
              <button
                aria-label={muted ? 'Sound on' : 'Sound off'}
                onClick={() => {
                  sfx.setMuted(!muted);
                  setMutedState(!muted);
                }}
              >
                {muted ? d.soundOff : d.soundOn}
              </button>
              <button onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}>{lang === 'en' ? '中文' : 'EN'}</button>
              <button onClick={onHint} disabled={replaying}>{d.hint}</button>
              <button onClick={replay} disabled={replaying}>{d.watch}</button>
              <button className="sn-primary" onClick={onExit} disabled={replaying}>{d.door}</button>
            </div>
          </header>
          {hover && <div className="sn-hover-label">{hover.part.replace(/_/g, ' ')}</div>}
          {looseItems(room, game).length > 0 && (
            <div className="sn-loose">
              <span>{d.plainSight}</span>
              {looseItems(room, game).map((it) => (
                <button
                  key={it.id}
                  onClick={() => {
                    const next = takeLoose(room, game, it.id);
                    setGame(next);
                    gameRef.current = next;
                    toast(`${d.picked}: ${it.label}`, 'good');
                    sfx.pickup();
                    if (it.kind === 'clue' && it.text) setModal({ kind: 'clue', item: it });
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          )}
          <footer className="sn-tray">
            {inventory.length === 0 ? (
              <span className="sn-tray-empty">{d.pockets}</span>
            ) : (
              inventory.map((it) => (
                <button key={it.id} className={`sn-item sn-item-${it.kind}`} onClick={() => it.kind === 'clue' && setModal({ kind: 'clue', item: it })}>
                  {it.label}
                </button>
              ))
            )}
          </footer>
          <div className="sn-toasts">
            {toasts.map((t) => (
              <div key={t.id} className={`sn-toast sn-toast-${t.tone}`}>
                {t.text}
              </div>
            ))}
          </div>
        </>
      )}
      {room && intro && progress >= 1 && (
        <div className="sn-modal" onClick={startPlay}>
          <div className="sn-card sn-intro" onClick={(e) => e.stopPropagation()}>
            <div className="sn-card-kicker">{room.author ? d.whose(room.author) : d.someones}</div>
            <h2>{room.title}</h2>
            {room.intro && <p>{room.intro}</p>}
            <ul className="sn-howto">
              {d.howto.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="sn-muted">{d.proven(room.verdict.minSteps)}</p>
            <button className="sn-primary" onClick={startPlay}>
              {d.start}
            </button>
          </div>
        </div>
      )}
      {modal?.kind === 'keypad' && <Keypad d={d} label={modal.label} onClose={() => setModal(null)} onSubmit={(code) => void interact(modal.ref, code).then(() => undefined)} />}
      {modal?.kind === 'clue' && (
        <div className="sn-modal" onClick={() => setModal(null)}>
          <div className="sn-card" onClick={(e) => e.stopPropagation()}>
            <div className="sn-card-kicker">{modal.item.label}</div>
            <p className="sn-clue">{modal.item.text}</p>
            <button onClick={() => setModal(null)}>{d.pocket}</button>
          </div>
        </div>
      )}
      {modal?.kind === 'win' && room && <Win d={d} room={room} game={game} />}
    </div>
  );
}

function Keypad({ d, label, onSubmit, onClose }: { d: Dict; label: string; onSubmit: (code: string) => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  return (
    <div className="sn-modal" onClick={onClose}>
      <div className="sn-card sn-keypad" onClick={(e) => e.stopPropagation()}>
        <div className="sn-card-kicker">{d.codeLock(label)}</div>
        <div className="sn-code">{code.padEnd(4, '·')}</div>
        <div className="sn-keys">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '↵'].map((k) => (
            <button
              key={k}
              onClick={() => {
                if (k === '⌫') setCode((c) => c.slice(0, -1));
                else if (k === '↵') onSubmit(code);
                else setCode((c) => (c.length < 6 ? c + k : c));
              }}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Win({ d, room, game }: { d: Dict; room: RoomDoc; game: Game }) {
  const [name, setName] = useState('');
  const [board, setBoard] = useState<LeaderRow[] | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const ms = (game.finishedAt ?? Date.now()) - game.startedAt;
  const local = room.id.startsWith('dev:');
  useEffect(() => {
    if (!local) api<LeaderRow[]>(`/rooms/${encodeURIComponent(room.id)}/leaderboard`).then(setBoard).catch(() => setBoard([]));
  }, [room.id, local]);
  const save = async () => {
    setState('saving');
    try {
      await api('/plays', { method: 'POST', body: JSON.stringify({ roomId: room.id, name: name.trim() || 'anonymous', ms, steps: game.steps, hints: game.hints }) });
      setBoard(await api<LeaderRow[]>(`/rooms/${encodeURIComponent(room.id)}/leaderboard`));
      setState('saved');
    } catch {
      setState('error');
    }
  };
  return (
    <div className="sn-modal">
      <div className="sn-card sn-win">
        <div className="sn-card-kicker">{d.gotOut}</div>
        <div className="sn-win-time">{formatTime(ms)}</div>
        <p>{d.result(game.steps, room.verdict.minSteps, game.hints)}</p>
        {!local && state !== 'saved' && (
          <div className="sn-row">
            <input placeholder={d.name} maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="sn-primary" onClick={save} disabled={state === 'saving'}>
              {d.save}
            </button>
          </div>
        )}
        {state === 'error' && <p className="sn-warn">{d.saveFail}</p>}
        {board && board.length > 0 && (
          <ol className="sn-board">
            {board.map((b, i) => (
              <li key={i}>
                <span>{b.name}</span>
                <span>{formatTime(b.ms)}</span>
              </li>
            ))}
          </ol>
        )}
        <button onClick={() => navigator.clipboard?.writeText(location.href)}>{d.copy}</button>
        {!local && (
          <div className="sn-export">
            <span>{d.asRobot}</span>
            <a href={`${API_URL}/rooms/${encodeURIComponent(room.id)}/export?format=mjcf`}>MuJoCo</a>
            <a href={`${API_URL}/rooms/${encodeURIComponent(room.id)}/export?format=usda`}>USD</a>
            <a href={`${API_URL}/rooms/${encodeURIComponent(room.id)}/export?format=task`}>Task JSON</a>
          </div>
        )}
      </div>
    </div>
  );
}
