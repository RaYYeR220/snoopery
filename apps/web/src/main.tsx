import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { App } from './App';
import { HASH_ROUTING } from './lib/nav';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import './hero/hero.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {HASH_ROUTING ? (
      <Router hook={useHashLocation}>
        <App />
      </Router>
    ) : (
      <App />
    )}
  </StrictMode>,
);
