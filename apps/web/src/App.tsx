import { Route, Switch } from 'wouter';
import { Player } from './play/Player';
import { Studio } from './studio/Studio';
import { Docs } from './pages/Docs';
import { Rooms } from './pages/Rooms';

export function App() {
  return (
    <Switch>
      <Route path="/studio" component={Studio} />
      <Route path="/docs" component={Docs} />
      <Route path="/rooms" component={Rooms} />
      <Route path="/play/:id">{(p) => <Player id={decodeURIComponent(p.id)} />}</Route>
      <Route>
        <main className="sn-fullmsg">
          <h1>Snoopery</h1>
          <p>Film your room. Every drawer opens.</p>
          <a href="/play/dev:demo">Open the test room</a>
        </main>
      </Route>
    </Switch>
  );
}
