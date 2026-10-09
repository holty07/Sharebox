/**
 * Sharebox — CollectionsView
 *
 * Flat list of the user's collections + the "Uncategorized" option.
 * This is the destination picker in CaptureView.
 */
import { useEffect, useState, useMemo } from 'react';
import { collectionQuery, getUncategorized, $collections } from '../db';
import { createCollectionOnServer, deleteCollectionServer, listCollections } from '../api';
import type { Collection as Coll } from './lib/schema';
import SyncBadge from './SyncStatus';

interface Props {
  onPick: (col: Coll | null) => void;
  placeholder: string;
  onClose: () => void;
}

export default function CollectionsView({ onPick, placeholder, onClose }: Props) {
  const [collections, setCollections] = useState<Coll[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reactive live query of local collections.
  const $cols = useMemo(() => $collections, []);

  useEffect(() => {
    const unsub = $cols.subscribe((rows) => {
      setCollections(rows as Coll[]);
      setLoading(false);
      setError(null);
    });
    return unsub;
  }, [$cols]);

  const refresh = useCallback(async () => {
    try {
      const fetched = await listCollections();
      setCollections(fetched);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  async function handleAddCollection() {
    const name = prompt('New collection name:');
    if (!name || !name.trim()) return;
    try {
      const created = await createCollectionOnServer(name.trim());
      await updateCollectionName(created.id, created.name);
      await refresh();
    } catch (e) {
      alert((e as Error).message ?? 'Failed to create collection');
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"?`)) return;
    try {
      await deleteCollectionServer(id);
      await refresh();
    } catch (e) {
      alert((e as Error).message ?? 'Failed to delete');
    }
  }

  return (
    <div className="sheet">
      <header className="sheet-bar">
        <h2>Collections</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      {error && <div className="sheet-msg">{error}</div>}

      <main className="capture-body">
        <p className="capture-sub">Pick where this goes.</p>

        <section className="pick-list">
          <h3 className="pick-section-title">Collections</h3>
          {loading ? (
            <div className="pick-empty">Loading&hellip;</div>
          ) : collections.length === 0 ? (
            <div className="pick-empty">No collections yet &mdash; create one.</div>
          ) : (
            <ul className="pick-grid">
              {collections.map((c) => (
                <li key={c.id} className="pick-chip">
                  <button
                    className="pick-chip-btn"
                    onClick={() => {
                      onPick(c);
                      onClose();
                    }}
                  >
                    <span className="pick-chip-name">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pick-section">
          <h3 className="pick-section-title">Uncategorized</h3>
          <p className="pick-section-sub">Anything shared without a collection lands here, then you can classify it later.</p>
          <label className="pick-radio">
            <input type="radio" name="destination" value="uncategorized" checked readOnly />
            <span className="pick-radio-label">
              Uncategorized <em>(must pick a collection)</em>
            </span>
          </label>
        </section>
      </main>

      <footer className="sheet-foot">
        <span className="sheet-hint">
          {placeholder} &mdash; share anything into Sharebox
        </span>
      </footer>

      <SyncBadge />
    </div>
  );
}

async function listCollections(): Promise<Coll[]> {
  return (await import('../api')).listCollections();
}
