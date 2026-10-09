/**
 * Sharebox — Dexie/IndexedDB client store.
 *
 * Dexie is the *source of truth* for the local UI.  Every write goes
 * straight to IndexedDB first, then enqueues an operation into the
 * outbox so the background sync loop can push it to the worker.
 *
 * Offline behaviour: writes never block.  The outbox holds every
 * pending operation until the sync loop (re)launched by a background
 * worker pushes it to the server.
 */
import Dexie, { type Table } from 'dexie';
import { liveQuery } from 'dexie';
import type { Collection, Item, PushOp } from './lib/schema';

/** Master database for Sharebox. */
export class ShareboxDB extends Dexie {
  collections!: Table<Collection>;
  items!: Table<Item>;
  outbox!: Table<OutboxOp>;

  constructor() {
    super('sharebox');
    this.version(1).stores({
      // collections: by id (primary) + name + deleted_at flag
      collections: 'id, name, deleted_at',
      // items: by id, by collection, by status, by subject for search
      items: 'id, collection_id, status, subject',
      // outbox: process in creation order
      outbox: '++id, entity, entityId, processed, createdAt',
    });
  }
}

export interface OutboxOp {
  /** Auto-increment synthetic id (not the entity id). */
  id: number;
  type: 'create' | 'update' | 'delete';
  entity: 'collections' | 'items';
  entityId: string;
  payload: string; // JSON-encoded entity
  actor: string;
  hlc: string; // "ts.logical" hybrid logical clock
  processed: boolean;
  createdAt: string;
  error: string | null;
}

export const db = new ShareboxDB();

let _ready: Promise<void> | null = null;

export function dbReady(): Promise<void> {
  if (!_ready) {
    // Dexie 4 exposes an async 'ready' event.
    _ready = new Promise<void>((resolve) => {
      if (db._db) {
        resolve();
        return;
      }
      db.on('ready', () => {
        resolve();
      });
    }).then(() => {
      return seedUncategorized();
    }).catch(() => undefined);
  }
  return _ready;
}

async function seedUncategorized(): Promise<void> {
  try {
    const n = await db.collections.where('name').equals('Uncategorized').count();
    if (n === 0) {
      const now = new Date().toISOString();
      await db.collections.add({
        id: 'uncategorized',
        name: 'Uncategorized',
        created_at: now,
        updated_at: now,
        deleted_at: null,
      } as Collection);
    }
  } catch {
    // Best-effort; a failure here must never block app startup.
  }
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** Create a new collection. Local write is instant (offline-safe). */
export async function createCollection(name: string): Promise<Collection> {
  if (!name || !name.trim()) throw new Error('Collection name required');
  const now = new Date().toISOString();
  const coll: Collection = {
    id: crypto.randomUUID(),
    name: name.trim(),
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await db.collections.add(coll);
  return coll;
}

/** Rename a collection. */
export async function updateCollectionName(id: string, name: string): Promise<Collection> {
  if (!name || !name.trim()) throw new Error('Collection name required');
  const now = new Date().toISOString();
  const updated = await db.collections.update(id, { name: name.trim(), updated_at: now });
  if (updated === 0) throw new Error('Collection not found');
  return db.collections.get(id) as Collection;
}

/** Soft-delete a collection. Items keep their collection_id. */
export async function deleteCollection(id: string): Promise<void> {
  await db.collections.update(id, { deleted_at: new Date().toISOString() });
}

/** Fetch collections (live, ordered newest-first). */
export function collectionQuery() {
  return db.collections.orderBy('updated_at').reverse();
}

/** Get a live reference to the "Uncategorized" collection. */
export function getUncategorized() {
  return db.collections.get('uncategorized');
}

/** Reactive live query for collections (subscribe to changes). */
export const $collections = liveQuery(collectionQuery);

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function createItem(item: Omit<Item, 'id' | 'created_at' | 'updated_at'>): Promise<Item> {
  const now = new Date().toISOString();
  const row: Item = {
    ...item,
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  };
  await db.items.add(row);
  return row;
}

export async function updateItem(id: string, patch: Partial<Item>): Promise<Item> {
  const now = new Date().toISOString();
  const updated = await db.items.update(id, { ...patch, updated_at: now });
  if (updated === 0) throw new Error('Item not found');
  return db.items.get(id) as Item;
}

export async function deleteItem(id: string): Promise<void> {
  await db.items.update(id, { deleted_at: new Date().toISOString() });
}

/** Items belonging to a collection (excluding deleted). */
export function itemsInCollection(collectionId: string) {
  return db.items
    .where('collection_id')
    .equals(collectionId)
    .and((it) => it.deleted_at === null)
    .reverse();
}

/**
 * Review items: optionally scoped to a collection + full-text search.
 * Returns a promise of Item[]; the UI wraps it in liveQuery() for
 * reactive updates.
 */
export function itemsLive(collectionId?: string, q?: string) {
  let req = db.items.where('deleted_at').equals(null);
  if (collectionId) req = req.and((it) => it.collection_id === collectionId);
  if (q) {
    const like = `%${q}%`;
    req = req.and((it) => it.subject.includes(q) || it.content.includes(q));
  }
  return req.reverse().toArray();
}

/** Reactive live query for items — subscribe with observe(). */
export function itemsLiveObservable(collectionId?: string, q?: string) {
  return liveQuery(() => itemsLive(collectionId, q));
}

// ---------------------------------------------------------------------------
// Outbox / sync
// ---------------------------------------------------------------------------

export async function enqueueOp(op: Omit<OutboxOp, 'id' | 'processed' | 'createdAt'>): Promise<OutboxOp> {
  const row: OutboxOp = {
    ...op,
    processed: false,
    createdAt: new Date().toISOString(),
    error: null,
  };
  const id = await db.outbox.add(row);
  return { ...row, id };
}

export async function markOutboxProcessed(id: number): Promise<void> {
  await db.outbox.update(id, { processed: true, error: null });
}

export async function markOutboxError(id: number, error: string): Promise<void> {
  await db.outbox.update(id, { error });
}

/** Pending (not yet pushed) operations, FIFO order. */
export function pendingOps() {
  return db.outbox.where('processed').equals(false);
}

export function outboxLive() {
  return db.outbox.orderBy('createdAt');
}

export { Collection, Item, PushOp, OpKind } from './lib/schema';
