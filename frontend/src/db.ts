/**
 * Local IndexedDB store (Dexie). The UI reads and writes only here; sync.ts
 * moves changes to and from the Worker.
 *
 * Every local change goes through `saveCollection` / `saveItem`, which stamp
 * a fresh HLC and record the row in the outbox in the same transaction. The
 * outbox is keyed by entity+id, so repeated edits to one row collapse into a
 * single pending push carrying the latest version.
 */
import Dexie, { type Table } from 'dexie';
import { UNCATEGORIZED_ID, type Collection, type Entity, type Item, type Row } from './lib/schema';

export interface OutboxEntry {
  key: string; // `${entity}:${id}`
  entity: Entity;
  row: Row;
}

interface Meta {
  key: string;
  value: number;
}

class ShareboxDB extends Dexie {
  collections!: Table<Collection, string>;
  items!: Table<Item, string>;
  outbox!: Table<OutboxEntry, string>;
  meta!: Table<Meta, string>;

  constructor() {
    // Fresh name: the scaffold's 'sharebox' DB used incompatible primary keys.
    super('sharebox-v2');
    this.version(1).stores({
      collections: 'id, name',
      items: 'id, collection_id, created_at',
      outbox: 'key',
      meta: 'key',
    });
  }
}

export const db = new ShareboxDB();

// ---------------------------------------------------------------------------
// Hybrid logical clock: "<13-digit ms>-<4-digit counter>-<node>", string-comparable.
// ---------------------------------------------------------------------------

function loadClientId(): string {
  try {
    const existing = localStorage.getItem('sharebox_client_id');
    if (existing) return existing;
    const id = crypto.randomUUID().slice(0, 8);
    localStorage.setItem('sharebox_client_id', id);
    return id;
  } catch {
    return crypto.randomUUID().slice(0, 8);
  }
}

export const clientId = loadClientId();
let hlcMs = 0;
let hlcCounter = 0;

export function nextHlc(): string {
  const now = Date.now();
  if (now > hlcMs) { hlcMs = now; hlcCounter = 0; } else { hlcCounter += 1; }
  return `${String(hlcMs).padStart(13, '0')}-${String(hlcCounter % 10_000).padStart(4, '0')}-${clientId}`;
}

/** Keep our clock ahead of anything we've seen so local edits always win over older remote ones. */
export function observeHlc(remote: string): void {
  const ms = Number(remote.slice(0, 13));
  if (ms > hlcMs) { hlcMs = ms; hlcCounter = 0; }
}

// ---------------------------------------------------------------------------
// Local writes
// ---------------------------------------------------------------------------

type Listener = () => void;
const writeListeners = new Set<Listener>();
export function onLocalWrite(fn: Listener): () => void {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

async function save<T extends Row>(entity: Entity, row: T): Promise<T> {
  const stamped = { ...row, updated_at: new Date().toISOString(), hlc: nextHlc() };
  await db.transaction('rw', db.table(entity), db.outbox, async () => {
    await db.table(entity).put(stamped);
    await db.outbox.put({ key: `${entity}:${row.id}`, entity, row: stamped });
  });
  writeListeners.forEach((fn) => fn());
  return stamped;
}

export const saveCollection = (c: Collection) => save('collections', c);
export const saveItem = (i: Item) => save('items', i);

export function newCollection(name: string): Promise<Collection> {
  const now = new Date().toISOString();
  return saveCollection({ id: crypto.randomUUID(), name: name.trim(), created_at: now, updated_at: now, deleted_at: null, hlc: '' });
}

export function newItem(fields: Pick<Item, 'kind' | 'subject' | 'content'> & Partial<Item>): Promise<Item> {
  const now = new Date().toISOString();
  return saveItem({
    collection_id: UNCATEGORIZED_ID, tags: [], notes: '', ...fields,
    id: crypto.randomUUID(), created_at: now, updated_at: now, deleted_at: null, hlc: '',
  });
}

export const deleteCollection = (c: Collection) => saveCollection({ ...c, deleted_at: new Date().toISOString() });
export const deleteItem = (i: Item) => saveItem({ ...i, deleted_at: new Date().toISOString() });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Live collections, Uncategorized first, then by name. Synthesises Uncategorized before the first pull. */
export async function listCollections(): Promise<Collection[]> {
  const rows = (await db.collections.toArray()).filter((c) => !c.deleted_at);
  if (!rows.some((c) => c.id === UNCATEGORIZED_ID)) {
    rows.push({ id: UNCATEGORIZED_ID, name: 'Uncategorized', created_at: '', updated_at: '', deleted_at: null, hlc: '' });
  }
  return rows.sort((a, b) =>
    a.id === UNCATEGORIZED_ID ? -1 : b.id === UNCATEGORIZED_ID ? 1 : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Items, newest first. Items whose collection was deleted count as Uncategorized.
 * `collectionId` undefined = all items.
 */
export async function listItems(collectionId: string | undefined, query: string): Promise<Item[]> {
  const live = new Set((await db.collections.toArray()).filter((c) => !c.deleted_at).map((c) => c.id));
  const q = query.trim().toLowerCase();
  const rows = await db.items.orderBy('created_at').reverse().filter((it) => {
    if (it.deleted_at) return false;
    const effective = live.has(it.collection_id) ? it.collection_id : UNCATEGORIZED_ID;
    if (collectionId && effective !== collectionId) return false;
    if (!q) return true;
    const haystack = [it.subject, it.notes, it.tags.join(' '), it.kind === 'image' ? '' : it.content].join('\n').toLowerCase();
    return haystack.includes(q);
  }).toArray();
  return rows;
}

export function pendingCount(): Promise<number> {
  return db.outbox.count();
}

export async function getMeta(key: string): Promise<number> {
  return (await db.meta.get(key))?.value ?? 0;
}

/** Wipe local data (used on sign-out so the next account starts clean). */
export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', [db.collections, db.items, db.outbox, db.meta], async () => {
    await Promise.all([db.collections.clear(), db.items.clear(), db.outbox.clear(), db.meta.clear()]);
  });
}
