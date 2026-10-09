/**
 * Sharebox — ItemDetail
 *
 * Full item view: subject, kind, content (rendered as a link / preview /
 * image), tags, notes, current collection + status.  Actions:
 *   - Re-classify (POST /classify server-side → applies tags + changes
 *     the item's collection)
 *   - Change collection (move item into a different collection)
 *   - Delete
 *
 * The UI edits the Dexie store locally first; the background sync loop
 * pushes the resulting outbox ops to the worker and merges the server's
 * truth back in.
 */
import { useState, useEffect } from 'react';
import { updateItem, deleteItem, dbReady, collectionQuery, db, $collections } from '../db';
import { classifyServer, listCollections } from '../api';
import type { Item, Collection } from './lib/schema';

interface Props {
  item: Item;
  onClose: () => void;
}

const KINDS: Record<Item['kind'], { label: string; emoji: string }> = {
  link: { label: 'Link', emoji: '🔗' },
  text: { label: 'Text', emoji: '📝' },
  image: { label: 'Image', emoji: '🖼️' },
};

export default function ItemDetail({ item, onClose }: Props) {
  // Form state (local, edits the Dexie store on save).
  const [subject, setSubject] = useState(item.subject ?? '');
  const [kind, setKind] = useState<Item['kind']>(item.kind);
  const [content, setContent] = useState(item.content ?? '');
  const [tagsText, setTagsText] = useState(tagsToString(item.tags));
  const [notes, setNotes] = useState(item.notes ?? '');
  const [status, setStatus] = useState<Item['status']>(item.status);
  const [collId, setCollId] = useState<string | null>(item.collection_id ?? null);
  const [showDelete, setShowDelete] = useState(false);

  // Refresh the collection list whenever the detail sheet opens.
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collLoading, setCollLoading] = useState(true);
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const [loadingClassify, setLoadingClassify] = useState(false);

  useEffect(() => {
    dbReady().catch(() => {});
    // Live query of collections, refreshed on any collection change.
    const run = () => {
      const rows = collectionQuery();
      setCollections(rows as Collection[]);
      setCollLoading(false);
    };
    run();
    // Subscribe to collection changes.
    const unsub = $collections.subscribe(() => {
      run();
    });
    return unsub;
  }, []);

  function tagsToString(tags: Record<string, string[]> | undefined): string {
    const obj = tags ?? {};
    return Object.entries(obj).map(([t, v]) => {
      const uniq = [...new Set(v)];
      return uniq.length === 1 ? t : `${t} (${uniq.join(', ')})`;
    }).join('\n');
  }

  function parseTags(text: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const rawLine of text.split('\n')) {
      const t = rawLine.trim();
      if (!t) continue;
      // Allow "#tag (value, value)" or just "#tag"
      const m = t.match(/^#?([^()]+?)\s*(?:\((.*)\))?/);
      if (!m) continue;
      const name = m[1].trim().replace(/^#/, '').toLowerCase();
      if (!name) continue;
      const vals = m[2]?.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) ?? [];
      if (!out[name]) out[name] = [];
      for (const v of vals) {
        if (!out[name].includes(v)) out[name].push(v);
      }
    }
    return out;
  }

  function handleTagsChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setTagsText(e.target.value);
  }

  async function handleSave() {
    const tags = parseTags(tagsText);
    try {
      const updated = await updateItem(item.id, {
        subject: subject.trim() || item.subject,
        kind,
        content,
        tags,
        notes: notes.trim(),
        status,
        collection_id: collId ?? undefined,
      });
      // Keep form in sync with the store result.
      setSubject(updated.subject);
      setKind(updated.kind);
      setContent(updated.content);
      setNotes(updated.notes);
      setStatus(updated.status);
      setCollId(updated.collection_id ?? null);
      onClose();
    } catch (e) {
      alert((e as Error).message ?? 'Failed to save');
    }
  }

  async function handleReclassify() {
    if (loadingClassify) return;
    setClassifyError(null);
    setLoadingClassify(true);
    try {
      const collections = await listCollections();
      const collectionIds = collections.map((c) => c.id);
      const unc = collectionQuery().first() as Collection | undefined;
      if (unc?.id) collectionIds.push(unc.id);
      const result = await classifyServer({
        subject: subject.trim() || item.subject,
        subjectType: kind,
        collectionIds,
      });
      const tags = (result.tags ?? []).reduce<Record<string, string[]>>((acc, t) => {
        acc[t] = [t.toLowerCase()];
        return acc;
      }, {});
      const newSubject = result.collection !== 'UNCLASSIFIED' ? result.collection : subject.trim() || item.subject;
      await updateItem(item.id, {
        subject: newSubject,
        tags,
        notes: result.notes,
        status: 'uncategorised' as const,
        collection_id: result.collection !== 'UNCLASSIFIED' ? undefined : collId ?? undefined,
      });
      // Update form so the user sees the result immediately.
      setSubject(newSubject);
      setTagsText(Object.entries(tags).map(([t, v]) => {
        const uniq = [...new Set(v)];
        return uniq.length === 1 ? t : `${t} (${uniq.join(', ')})`;
      }).join('\n'));
      setNotes(result.notes);
      setStatus('uncategorised');
      // Persist so the sync loop pushes it.
      await updateItem(item.id, {
        subject: newSubject,
        tags,
        notes: result.notes,
        status: 'uncategorised' as const,
        collection_id: result.collection !== 'UNCLASSIFIED' ? undefined : collId ?? undefined,
      });
      alert(`Classified as "${result.collection}". Tags: ${result.tags.join(', ') || 'none'}.`);
    } catch (e) {
      setClassifyError((e as Error).message);
      alert((e as Error).message ?? 'Classification failed');
    } finally {
      setLoadingClassify(false);
    }
  }

  async function handleDelete() {
    try {
      await db.transaction('rw', db.items, async () => {
        await deleteItem(item.id);
        // Drop the corresponding outbox op for this item so a stale op can't
        // resurrect it.
        const op = await db.outbox.get(item.id);
        if (op) await db.outbox.delete(op.id);
      });
      // Push the delete; the worker mirrors it to other devices.
      onClose();
    } catch (e) {
      alert((e as Error).message ?? 'Failed to delete');
    }
  }

  return (
    <div className="sheet item-detail">
      <header className="sheet-bar">
        <h3>Item</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="item-detail-body">
        <div className="item-detail-head">
          <span className={`kind-badge kind-${kind}`}>
            {KINDS[kind]?.emoji ?? ''} {KINDS[kind]?.label ?? kind}
          </span>
          <span className="item-status-badge">{status}</span>
          <button
            className="icon-btn small"
            onClick={() => setShowDelete(true)}
            aria-label="Delete item"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>

        <div className="detail-cells">
          <label className="field-label">Subject</label>
          <input
            className="field-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Item subject"
          />

          <label className="field-label">Content</label>
          <textarea
            className="field-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Pasted text, link preview, or image description"
            rows={6}
          />

          <label className="field-label">Notes</label>
          <textarea
            className="field-textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional note (e.g. where you found this)"
            rows={3}
          />

          <label className="field-label">Tags</label>
          <textarea
            className="field-textarea"
            value={tagsText}
            onChange={handleTagsChange}
            placeholder={'# tag per line'}
            rows={3}
          />

          <label className="field-label">Collection</label>
          <select
            className="field-select"
            value={collId ?? ''}
            onChange={(e) => setCollId(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">Uncategorized (default)</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <label className="field-label">Status</label>
          <select
            className="field-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as Item['status'])}
          >
            <option value="uncategorised">Uncategorised</option>
            <option value="queued">Queued</option>
            <option value="synced">Synced</option>
            <option value="error">Error</option>
          </select>
        </div>

        <div className="item-detail-actions">
          <button className="btn primary" onClick={handleSave}>Save</button>
          <button
            className="btn ghost"
            onClick={handleReclassify}
            disabled={loadingClassify}
            title="Ask the server to classify this item into a collection"
          >
            {loadingClassify ? 'Classifying\u2026' : 'Re-classify'}
          </button>
        </div>
      </div>

      {classifyError && <div className="sheet-msg">{classifyError}</div>}

      {showDelete && (
        <div className="delete-confirm">
          <p>Delete this item permanently?</p>
          <div className="delete-actions">
            <button className="btn ghost" onClick={() => setShowDelete(false)}>Cancel</button>
            <button className="btn danger" onClick={handleDelete}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}
