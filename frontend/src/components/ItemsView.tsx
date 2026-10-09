import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { listCollections, listItems } from '../db';
import type { Item } from '../lib/schema';
import ItemCard from './ItemCard';

export default function ItemsView({ onOpen }: { onOpen: (item: Item) => void }) {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const collections = useLiveQuery(listCollections, []) ?? [];
  const items = useLiveQuery(() => listItems(filter, query), [filter, query]);
  const names = new Map(collections.map((c) => [c.id, c.name]));

  return (
    <section>
      <div className="toolbar">
        <input
          className="search" type="search" placeholder="Search subject, notes, tags…"
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="chips" role="tablist" aria-label="Filter by collection">
        <button className={filter === undefined ? 'chip active' : 'chip'} onClick={() => setFilter(undefined)}>All</button>
        {collections.map((c) => (
          <button key={c.id} className={filter === c.id ? 'chip active' : 'chip'} onClick={() => setFilter(c.id)}>{c.name}</button>
        ))}
      </div>
      {items === undefined ? null : items.length === 0 ? (
        <p className="empty">{query ? 'Nothing matches that search.' : 'Nothing here yet. Share something to Sharebox, or tap + to add it.'}</p>
      ) : (
        <ul className="items">
          {items.map((it) => (
            <li key={it.id}>
              <ItemCard item={it} collectionName={names.get(it.collection_id) ?? 'Uncategorized'} onOpen={() => onOpen(it)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
