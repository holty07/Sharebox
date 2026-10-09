import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSession, setSession, subscribeSession } from './api';
import { clearLocalData, pendingCount } from './db';
import { syncNow } from './sync';
import { takeSharedPayload } from './lib/share';
import type { SharePayload } from './lib/subject';
import type { Item } from './lib/schema';
import AuthView from './components/AuthView';
import CaptureView from './components/CaptureView';
import CollectionsManager from './components/CollectionsManager';
import ItemDetail from './components/ItemDetail';
import ItemsView from './components/ItemsView';
import SyncStatus from './components/SyncStatus';

type Capture = { share: SharePayload | null } | null;

export default function App() {
  const session = useSyncExternalStore(subscribeSession, getSession);
  const [tab, setTab] = useState<'items' | 'collections'>('items');
  const [capture, setCapture] = useState<Capture>(null);
  const [openItem, setOpenItem] = useState<Item | null>(null);

  // Arrived from the Android share sheet: pick up what the service worker stashed.
  useEffect(() => {
    if (new URLSearchParams(location.search).get('share') !== '1') return;
    history.replaceState(null, '', '/');
    void takeSharedPayload().then((share) => { if (share) setCapture({ share }); });
  }, []);

  useEffect(() => { if (session) void syncNow(); }, [session]);

  if (!session) return <AuthView />;

  async function signOut() {
    const pending = await pendingCount();
    if (pending && !confirm(`${pending} change(s) haven't synced yet and will be lost. Sign out anyway?`)) return;
    await clearLocalData();
    setSession(null);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Sharebox</div>
        <nav className="tabs" aria-label="Sections">
          <button className={tab === 'items' ? 'tab active' : 'tab'} onClick={() => setTab('items')}>Items</button>
          <button className={tab === 'collections' ? 'tab active' : 'tab'} onClick={() => setTab('collections')}>Collections</button>
        </nav>
        <div className="topbar-end">
          <SyncStatus />
          <button className="btn ghost small" onClick={signOut} title={session.user.email}>Sign out</button>
        </div>
      </header>

      <main className="main">
        {tab === 'items' ? <ItemsView onOpen={setOpenItem} /> : <CollectionsManager />}
      </main>

      <button className="fab" onClick={() => setCapture({ share: null })} aria-label="Add item">+</button>

      {capture && <CaptureView share={capture.share} onDone={() => setCapture(null)} />}
      {openItem && <ItemDetail item={openItem} onClose={() => setOpenItem(null)} />}
    </div>
  );
}
