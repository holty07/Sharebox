/**
 * Save something into Sharebox. Opened by the share sheet (with a payload) or
 * the + button (empty, for pasting a link/text or picking an image). Tapping a
 * collection saves the item there immediately.
 */
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { listCollections, newCollection, newItem } from '../db';
import { draftFromShare, type Draft, type SharePayload } from '../lib/subject';
import Sheet from './Sheet';

export default function CaptureView({ share, onDone }: { share: SharePayload | null; onDone: () => void }) {
  const collections = useLiveQuery(listCollections, []) ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [subject, setSubject] = useState('');
  const [manualText, setManualText] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load(payload: SharePayload) {
    try {
      const d = await draftFromShare(payload);
      setDraft(d);
      setSubject(d.subject);
    } catch (err) {
      setError(`Couldn't read that: ${(err as Error).message}`);
    }
  }

  useEffect(() => { if (share) void load(share); }, [share]);

  async function saveTo(collectionId: string) {
    let d = draft;
    if (!d && manualText.trim()) d = await draftFromShare({ title: '', text: manualText, url: '', files: [] });
    if (!d) { setError('Paste a link or some text, or choose an image first.'); return; }
    await newItem({ ...d, subject: subject.trim() || d.subject, collection_id: collectionId });
    onDone();
  }

  async function createAndSave() {
    if (!newName.trim()) return;
    const c = await newCollection(newName);
    await saveTo(c.id);
  }

  return (
    <Sheet title="Add to Sharebox" onClose={onDone}>
      {draft ? (
        <div className="capture-preview">
          {draft.kind === 'image' && <img src={draft.content} alt="" className="preview-img" />}
          {draft.kind === 'link' && <a href={draft.content} target="_blank" rel="noreferrer" className="preview-link">{draft.content}</a>}
          {draft.kind === 'text' && <p className="preview-text">{draft.content}</p>}
          <label className="field">
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
        </div>
      ) : !share && (
        <div className="capture-manual">
          <label className="field">
            <span>Link or text</span>
            <textarea rows={3} value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="Paste a URL or a note" autoFocus />
          </label>
          <label className="btn ghost small file-btn">
            Or choose an image
            <input
              type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void load({ title: '', text: '', url: '', files: [f] }); }}
            />
          </label>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <h3 className="section-title">Save to</h3>
      <div className="pick-grid">
        {collections.map((c) => (
          <button key={c.id} className="pick" onClick={() => void saveTo(c.id)}>{c.name}</button>
        ))}
      </div>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void createAndSave(); }}>
        <input placeholder="New collection…" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="btn small" disabled={!newName.trim()}>Create &amp; save</button>
      </form>
    </Sheet>
  );
}
