import { useCallback, useEffect, useRef, useState } from 'react';
import { createRuntime, type PartRef, type Runtime } from '@snoopery/runtime';
import type { PuzzleItem, RoomDoc } from '@snoopery/schema';
import { api, API_URL, loadRoom, type LeaderRow } from '../lib/api';
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
          if (outcome.found.length === 0) toast('Empty.');
          for (const it of outcome.found) {
            toast(`Found: ${it.label}`, 'good');
            if (it.kind === 'clue' && it.text) setModal({ kind: 'clue', item: it });
          }
          break;
        case 'locked':
          sfx.rattle();
          await runtime.animateJoint(ref.objectId, ref.part, 0.06, 140);
          await runtime.animateJoint(ref.objectId, ref.part, 0, 180);
          if (outcome.needs === 'code') setModal({ kind: 'keypad', ref, label: labelOf(r, ref) });
          else toast(`Locked. It needs a key${outcome.missing[0] ? '' : ''}.`, 'warn');
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
      if (it) toast(`Something is lying in plain sight: ${it.label}.`);
      return;
    }
    if (next.type === 'exit') {
      toast('You have what you need. Try the door.', 'good');
      return;
    }
    if (next.type === 'open') {
      const c = room.puzzle.containers.find((x) => x.id === next.target)!;
      const at = rt.current.partPosition(c.objectId, c.part);
      if (at) rt.current.controls.lookAt(at[0], at[1], at[2]);
      rt.current.highlight({ objectId: c.objectId, part: c.part });
      toast(`Look at the ${c.part.replace(/_/g, ' ')}.`);
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
    else if (outcome.kind === 'exit-locked') toast('The door is locked.', 'warn');
  };

  const replay = async () => {
    if (!room || !rt.current || replaying) return;
    setReplaying(true);
    const runtime = rt.current;
    for (const p of runtime.parts()) runtime.setJoint(p.objectId, p.part, 0);
    for (const a of room.proof) {
      if (a.type === 'open') {
        const c = room.puzzle.containers.find((x) => x.id === a.target)!;
        const at = runtime.partPosition(c.objectId, c.part);
        if (at) runtime.controls.lookAt(at[0], at[1], at[2], 700);
        runtime.highlight({ objectId: c.objectId, part: c.part });
        await new Promise((r) => setTimeout(r, 750));
        await runtime.animateJoint(c.objectId, c.part, 1, 900);
      } else if (a.type === 'take') {
        const it = room.puzzle.items.find((x) => x.id === a.item);
        if (it) toast(`Takes: ${it.label}`, 'good');
        await new Promise((r) => setTimeout(r, 650));
      } else {
        toast('Out the door.', 'good');
      }
    }
    runtime.highlight(null);
    setReplaying(false);
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
          <span>Loading the room… {Math.round(progress * 100)}%</span>
        </div>
      )}
      {room && (
        <>
          <header className="sn-hud-top">
            <div>
              <div className="sn-room-title">{room.title}</div>
              <div className="sn-room-meta">
                {formatTime(elapsed)} · {game.steps} steps · shortest {room.verdict.minSteps}
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
                {muted ? 'Sound off' : 'Sound on'}
              </button>
              <button onClick={onHint} disabled={replaying}>Hint</button>
              <button onClick={replay} disabled={replaying}>Watch the solution</button>
              <button className="sn-primary" onClick={onExit} disabled={replaying}>Try the door</button>
            </div>
          </header>
          {hover && <div className="sn-hover-label">{hover.part.replace(/_/g, ' ')}</div>}
          {looseItems(room, game).length > 0 && (
            <div className="sn-loose">
              <span>In plain sight</span>
              {looseItems(room, game).map((it) => (
                <button
                  key={it.id}
                  onClick={() => {
                    const next = takeLoose(room, game, it.id);
                    setGame(next);
                    gameRef.current = next;
                    toast(`Picked up: ${it.label}`, 'good');
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
              <span className="sn-tray-empty">Your pockets are empty. Open things.</span>
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
            <div className="sn-card-kicker">{room.author ? `${room.author}'s room` : 'Someone’s room'}</div>
            <h2>{room.title}</h2>
            {room.intro && <p>{room.intro}</p>}
            <ul className="sn-howto">
              <li>Drag to look around · click the floor (or WASD) to walk</li>
              <li>Click drawers, lids and doors — they really open</li>
              <li>Find what you need, then try the door</li>
            </ul>
            <p className="sn-muted">The way out is proven: the shortest escape takes {room.verdict.minSteps} steps.</p>
            <button className="sn-primary" onClick={startPlay}>
              Start snooping
            </button>
          </div>
        </div>
      )}
      {modal?.kind === 'keypad' && <Keypad label={modal.label} onClose={() => setModal(null)} onSubmit={(code) => void interact(modal.ref, code).then(() => undefined)} />}
      {modal?.kind === 'clue' && (
        <div className="sn-modal" onClick={() => setModal(null)}>
          <div className="sn-card" onClick={(e) => e.stopPropagation()}>
            <div className="sn-card-kicker">{modal.item.label}</div>
            <p className="sn-clue">{modal.item.text}</p>
            <button onClick={() => setModal(null)}>Put it in my pocket</button>
          </div>
        </div>
      )}
      {modal?.kind === 'win' && room && <Win room={room} game={game} />}
    </div>
  );
}

function Keypad({ label, onSubmit, onClose }: { label: string; onSubmit: (code: string) => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  return (
    <div className="sn-modal" onClick={onClose}>
      <div className="sn-card sn-keypad" onClick={(e) => e.stopPropagation()}>
        <div className="sn-card-kicker">The {label} has a code lock</div>
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

function Win({ room, game }: { room: RoomDoc; game: Game }) {
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
        <div className="sn-card-kicker">You got out</div>
        <div className="sn-win-time">{formatTime(ms)}</div>
        <p>
          {game.steps} steps (the shortest way out is {room.verdict.minSteps}) · {game.hints} hints
        </p>
        {!local && state !== 'saved' && (
          <div className="sn-row">
            <input placeholder="Your name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="sn-primary" onClick={save} disabled={state === 'saving'}>
              Save my time
            </button>
          </div>
        )}
        {state === 'error' && <p className="sn-warn">Could not save right now.</p>}
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
        <button onClick={() => navigator.clipboard?.writeText(location.href)}>Copy the link for a friend</button>
        {!local && (
          <div className="sn-export">
            <span>Same room as a robot task:</span>
            <a href={`${API_URL}/rooms/${encodeURIComponent(room.id)}/export?format=mjcf`}>MuJoCo</a>
            <a href={`${API_URL}/rooms/${encodeURIComponent(room.id)}/export?format=usda`}>USD</a>
            <a href={`${API_URL}/rooms/${encodeURIComponent(room.id)}/export?format=task`}>Task JSON</a>
          </div>
        )}
      </div>
    </div>
  );
}
