/**
 * Sharebox — CaptureView (the share destination screen)
 *
 * Flat list of the user's collections plus the built-in "Uncategorized".
 * Tapping a collection returns it via onPick; tapping "Uncategorized"
 * returns the special id "uncategorized" (which points at the built-in
 * collection seeded on first run).
 *
 * The App layer owns nothing here — this is a pure destination picker:
 * onPick(col) closes the sheet, and the caller renders the review list
 * filtered by that collection id.
 */
import { useEffect, useState, useCallback } from 'react';
import { collectionQuery, getUncategorized, updateCollectionName, deleteCollection, $collections } from '../db';
import { createCollectionOnServer, deleteCollectionServer, listCollections } from '../api';
import type { Collection as Coll } from './lib/schema';
import SyncBadge from './SyncStatus';

interface Props {
  /** Called when the user picks a destination. `null` => Uncategorized. */
  onPick: (col: Coll | null) => void;
  placeholder: string;
  onClose: () => void;
}

export default function CaptureView({ onPick, placeholder, onClose }: Props) {
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
      // Also reflect locally (then the sync engine pushes it).
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
        <h2>Capture</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      {error && <div className="sheet-msg">{error}</div>}

      <main className="capture-body">
        <p className="capture-sub">Where should this go?</p>

        <section className="pick-list">
          <h3 className="pick-section-title">Collections</h3>
          {loading ? (
            <div className="pick-empty">Loading&hellip;</div>
          ) : collections.length === 0 ? (
            <div className="pick-empty">No collections yet &mdash; create one below.</div>
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
          <p className="pick-section-sub">
            Items shared without a collection land here and can be classified
            into a collection later.
          </p>
          <label className="pick-radio">
            <input
              type="radio"
              name="destination"
              value="uncategorized"
              checked
              readOnly
            />
            <span className="pick-radio-label">
              Uncategorized
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
