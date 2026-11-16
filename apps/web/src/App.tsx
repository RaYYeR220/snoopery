import { Route, Switch } from 'wouter';
import { Player } from './play/Player';
import { Studio } from './studio/Studio';
import { Docs } from './pages/Docs';
import { Rooms } from './pages/Rooms';
import { ObjectInspector } from './pages/ObjectInspector';
import { Landing } from './pages/Landing';

export function App() {
  return (
    <Switch>
      <Route path="/studio" component={Studio} />
      <Route path="/docs" component={Docs} />
      <Route path="/rooms" component={Rooms} />
      <Route path="/objects/:id">{(p) => <ObjectInspector id={decodeURIComponent(p.id)} />}</Route>
      <Route path="/play/:id">{(p) => <Player id={decodeURIComponent(p.id)} />}</Route>
      <Route>{() => <Landing />}</Route>
    </Switch>
  );
}
