import { Route, Switch } from 'wouter';
import { Player } from './play/Player';
import { Studio } from './studio/Studio';

export function App() {
  return (
    <Switch>
      <Route path="/studio" component={Studio} />
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
