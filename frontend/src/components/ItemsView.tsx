/**
 * Sharebox — ItemsView (review list)
 *
 * Displays captured items filtered by the selected collection (or all)
 * plus a live full-text search.  Tapping an item opens ItemDetail.
 *
 * The list is driven by a reactive liveQuery on the Dexie store:
 *   - itemsLiveObservable(collectionId, q) re-runs whenever any indexed
 *     table (items / collections / outbox) emits a change,
 *   - local edits (re-classify, delete, collection move) are reflected
 *     immediately after a background sync merges.
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import { dbReady, itemsLiveObservable, db } from '../db';
import { deleteItemServer } from '../api';
import type { Item } from './lib/schema';
import ItemDetail from './ItemDetail';

interface Props {
  collectionId: string | null;
  placeholder: string;
  title: string;
}

export default function ItemsView({ collectionId, placeholder, title }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [count, setCount] = useState(0);

  // Ensure the store is ready + seed "Uncategorized" on first run.
  useEffect(() => {
    dbReady().catch(() => {});
  }, []);

  // Build the review query only from (collectionId, q).  This is what the
  // liveQuery wraps; re-run on every store change.
  const liveQuery = useMemo(() => itemsLiveObservable(collectionId ?? undefined, q), [collectionId, q]);

  // Reactive subscription: liveQuery emits a new snapshot on every change.
  useEffect(() => {
    const unsub = liveQuery.subscribe((rows) => {
      setItems(rows as Item[]);
      setCount(rows.length);
      setLoading(false);
      setError(null);
    });
    // Initial load.
    // (subscribe fires immediately with the current snapshot)

    return unsub;
  }, [liveQuery]);

  const onSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQ(e.target.value);
  }, []);

  async function handleDelete(id: string, subject: string) {
    if (!window.confirm(`Delete item "${subject}"?`)) return;
    try {
      await db.transaction('rw', db.items, async () => {
        await deleteItem(id);
        // Drop the outbox op for this item so a stale op can't resurrect it.
        const op = await db.outbox.get(id);
        if (op) await db.outbox.delete(op.id);
      });
      // Push the delete; the server mirrors it.
      await refreshServer();
    } catch (e) {
      alert((e as Error).message ?? 'Failed to delete');
    }
  }

  async function refreshServer() {
    try {
      const { listItems } = await import('../api');
      const fetched = await listItems({ collectionId: collectionId ?? undefined, q });
      setItems(fetched as Item[]);
      setCount(fetched.length);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="sheet">
      <header className="sheet-bar">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="items-toolbar">
        <div className="search-wrap">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="search-icon" />
          <input
            className="search-input"
            placeholder="Search items\u2026"
            value={q}
            onChange={onSearch}
          />
          {q && (
            <button className="search-clear" onClick={() => setQ('')} aria-label="Clear search">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          )}
        </div>
        <SyncBadge />
      </div>

      {error && <div className="sheet-msg">{error}</div>}

      {loading && !items.length && (
        <div className="sheet-empty">Loading&hellip;</div>
      )}

      {!loading && items.length === 0 && (
        <div className="sheet-empty">
          {q ? 'No items match your search.' : 'No items yet.'}
        </div>
      )}

      {!loading && items.length > 0 && (
        <ul className="items-list">
          {items.map((it) => (
            <li key={it.id} className="item-card">
              <button className="item-main" onClick={() => setSelected(it)}>
                <div className="item-subject">{it.subject || '<no subject>'}</div>
                <div className="item-meta">
                  <span className={`item-kind ${it.kind}`}>{it.kind}</span>
                  <span className="item-status">{it.status}</span>
                </div>
              </button>
              <button
                className="item-delete"
                title="Delete"
                onClick={() => handleDelete(it.id, it.subject)}
                aria-label={`Delete ${it.subject}`}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <ItemDetail item={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
