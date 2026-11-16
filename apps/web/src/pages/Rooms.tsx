import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface RoomRow {
  id: string;
  title: string;
  author: string;
  minSteps: number;
  objects: number;
}

export function Rooms() {
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<RoomRow[]>('/rooms').then(setRooms, (e) => setError(String(e.message)));
  }, []);
  return (
    <main className="sn-doc">
      <nav className="sn-doc-nav">
        <a href="/" className="sn-logo">Snoopery</a>
        <a href="/studio">Make a room</a>
        <a href="/docs">Developers</a>
      </nav>
      <h1>Rooms to snoop through</h1>
      {error && <p className="sn-warn">{error}</p>}
      {!rooms && !error && <p className="sn-muted">Loading…</p>}
      <ul className="sn-room-list">
        {rooms?.map((r) => (
          <li key={r.id}>
            <a href={`/play/${encodeURIComponent(r.id)}`}>
              <strong>{r.title}</strong>
              <span>
                {r.author ? `${r.author} · ` : ''}
                {r.objects} things that open · shortest way out {r.minSteps} steps
              </span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
