import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { classify } from '../api';
import { db, deleteItem, listCollections, saveItem } from '../db';
import { syncNow } from '../sync';
import type { Item } from '../lib/schema';
import Sheet from './Sheet';

export default function ItemDetail({ item: initial, onClose }: { item: Item; onClose: () => void }) {
  // Follow the live row so a sync landing while the sheet is open is reflected in the preview.
  const item = useLiveQuery(() => db.items.get(initial.id), [initial.id]) ?? initial;
  const collections = useLiveQuery(listCollections, []) ?? [];
  const [subject, setSubject] = useState(initial.subject);
  const [notes, setNotes] = useState(initial.notes);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [collectionId, setCollectionId] = useState(initial.collection_id);
  const [suggesting, setSuggesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    await saveItem({
      ...item,
      subject: subject.trim() || item.subject,
      notes: notes.trim(),
      tags: [...new Set(tags.split(',').map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))],
      collection_id: collectionId,
    });
    onClose();
  }

  async function remove() {
    if (!confirm('Delete this item?')) return;
    await deleteItem(item);
    onClose();
  }

  async function suggest() {
    setSuggesting(true);
    setMessage(null);
    try {
      await syncNow(); // the Worker classifies its own copy, so make sure it has one
      const res = await classify(item.id);
      if (res.collectionId) setCollectionId(res.collectionId);
      if (res.tags.length) setTags((prev) => [...new Set([...prev.split(',').map((t) => t.trim()).filter(Boolean), ...res.tags])].join(', '));
      if (res.notes && !notes.trim()) setNotes(res.notes);
      const name = collections.find((c) => c.id === res.collectionId)?.name;
      setMessage(name ? `Suggested “${name}”. Review and save.` : 'No collection fits well; tags and notes filled in.');
    } catch (err) {
      setMessage(`Suggestion failed: ${(err as Error).message}`);
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <Sheet title="Item" onClose={onClose}>
      {item.kind === 'image' && <img src={item.content} alt="" className="preview-img" />}
      {item.kind === 'link' && <a href={item.content} target="_blank" rel="noreferrer" className="preview-link">{item.content}</a>}
      {item.kind === 'text' && <p className="preview-text">{item.content}</p>}

      <label className="field">
        <span>Subject</span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="field">
        <span>Collection</span>
        <div className="row">
          <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
            {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="button" className="btn small" onClick={suggest} disabled={suggesting || !navigator.onLine}>
            {suggesting ? 'Thinking…' : 'Suggest'}
          </button>
        </div>
      </label>
      {message && <p className="muted small">{message}</p>}
      <label className="field">
        <span>Tags (comma separated)</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <label className="field">
        <span>Notes</span>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <p className="muted small">Added {new Date(item.created_at).toLocaleString()}</p>

      <div className="actions">
        <button className="btn danger" onClick={remove}>Delete</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}
