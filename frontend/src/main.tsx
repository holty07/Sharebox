/**
 * Sharebox — main.tsx
 *
 * Entry point.  Boots the Dexie store (which seeds "Uncategorized"),
 * wires the React 19 root, and hands the root to the service worker
 * (vite-plugin-pwa) to register as an installable PWA.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { dbReady } from './db';

// Wait for IndexedDB to be open (and "Uncategorized" seeded) before
// rendering, so the first paint already has the local store ready.
dbReady().then(() => {
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}).catch(() => {
  // IndexedDB unavailable (e.g. strong privacy mode on some desktops):
  // fail open — render without the database and have the app still boot.
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
