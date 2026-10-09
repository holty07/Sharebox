import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteCollection, listCollections, newCollection, saveCollection, saveItem } from '../db';
import { UNCATEGORIZED_ID, type Collection } from '../lib/schema';

export default function CollectionsManager() {
  const collections = useLiveQuery(listCollections, []) ?? [];
  const counts = useLiveQuery(async () => {
    const m = new Map<string, number>();
    await db.items.each((it) => { if (!it.deleted_at) m.set(it.collection_id, (m.get(it.collection_id) ?? 0) + 1); });
    return m;
  }, []) ?? new Map<string, number>();
  const [name, setName] = useState('');

  async function add() {
    if (!name.trim()) return;
    await newCollection(name);
    setName('');
  }

  return (
    <section>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input placeholder="New collection name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary small" disabled={!name.trim()}>Add</button>
      </form>
      <ul className="collections">
        {collections.map((c) => <CollectionRow key={c.id} collection={c} count={counts.get(c.id) ?? 0} />)}
      </ul>
      <p className="muted small">Deleting a collection moves its items to Uncategorized.</p>
    </section>
  );
}

function CollectionRow({ collection, count }: { collection: Collection; count: number }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(collection.name);
  const isUncategorized = collection.id === UNCATEGORIZED_ID;

  async function rename() {
    if (name.trim() && name.trim() !== collection.name) await saveCollection({ ...collection, name: name.trim() });
    setEditing(false);
  }

  async function remove() {
    if (!confirm(`Delete “${collection.name}”? Its ${count} item(s) move to Uncategorized.`)) return;
    await db.transaction('rw', db.items, db.collections, db.outbox, async () => {
      // Re-home items explicitly so every device agrees, not just this one's display rule.
      const items = await db.items.where('collection_id').equals(collection.id).toArray();
      for (const it of items) if (!it.deleted_at) await saveItem({ ...it, collection_id: UNCATEGORIZED_ID });
      await deleteCollection(collection);
    });
  }

  return (
    <li className="card collection">
      {editing ? (
        <form className="inline-form grow" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus onBlur={() => void rename()} />
        </form>
      ) : (
        <button className="collection-name" onClick={() => setEditing(true)} title="Rename">{collection.name}</button>
      )}
      <span className="muted">{count}</span>
      {!isUncategorized && <button className="btn ghost small" onClick={remove}>Delete</button>}
    </li>
  );
}
