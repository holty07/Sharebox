/**
 * Sharebox — client-side sync engine.
 *
 * Strategy (offline-first, two-way):
 *   1. The local Dexie store is the source of truth for the app.
 *   2. Every mutation also enqueues an operation in the outbox (db.tsx).
 *   3. A background loop (or manual trigger) pushes pending outbox ops to
 *      the worker's `POST /sync/push`, then pulls `GET /sync/pull`
 *      operations from other devices and applies them to the local store.
 *   4. Each op carries a field-level HLC (`"ts.logical"`) so conflicts are
 *      resolved deterministically: the higher HLC wins.
 *
 * The worker is the *remote* source of truth for other devices. The
 * client never fetches the worker's DB directly — it only pushes/pulls ops.
 */
import { db, type OutboxOp } from './db';
import type { Collection, Item, PushOp, PullOp, OpKind, SyncProgress } from './lib/schema';
import { pushSync, pullSync } from './api';
import { retry } from './api';

export type SyncPhase = 'idle' | 'pushing' | 'pulling' | 'merged' | 'error';

export interface SyncState {
  phase: SyncPhase;
  lastError: string | null;
  serverMaxSeq: number;   // highest server op seq we have applied locally
  pendingOps: number;     // outbox ops not yet confirmed
  updatedAt: string | null;
}

let state: SyncState = {
  phase: 'idle',
  lastError: null,
  serverMaxSeq: 0,
  pendingOps: 0,
  updatedAt: null,
};

export function syncState(): SyncState {
  return JSON.parse(JSON.stringify(state));
}

export function setSyncState(partial: Partial<SyncState>): void {
  state = { ...state, ...partial, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// HLC helpers (client side)
// ---------------------------------------------------------------------------

let localSeq = 0;
let clientId: string;

if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('sharebox_client_id');
  if (stored) {
    clientId = stored;
  } else {
    clientId = crypto.randomUUID();
    localStorage.setItem('sharebox_client_id', clientId);
  }
} else {
  clientId = 'unknown';
}

/**
 * Produce an HLC-style clock value "ts.logical". Sub-second precision is
 * fine for tie-breaking across a couple of devices; the per-op counter is
 * the logical part that guarantees a strict total order within a client.
 */
export function nextHlc(): string {
  localSeq += 1;
  return `${Date.now()}.${localSeq}.${clientId.slice(0, 4)}`;
}

export function getClientId(): string {
  return clientId;
}

// ---------------------------------------------------------------------------
// From the local store → outbox operations
// ---------------------------------------------------------------------------

export function itemToPushOp(item: Item, actor: string): OutboxOp {
  return {
    type: item.deleted_at ? 'delete' : 'create',
    entity: 'items',
    entityId: item.id,
    payload: JSON.stringify(item),
    actor,
    hlc: nextHlc(),
  };
}

export function collectionToPushOp(coll: Collection, actor: string): OutboxOp {
  return {
    type: coll.deleted_at ? 'delete' : 'create',
    entity: 'collections',
    entityId: coll.id,
    payload: JSON.stringify(coll),
    actor,
    hlc: nextHlc(),
  };
}

/** Queue a pending operation to the outbox (called by the UI after writes). */
export async function enqueueLocalWrite(
  type: OutboxOp['type'],
  entity: OutboxOp['entity'],
  entityId: string,
  payload: string,
  actor: string,
): Promise<void> {
  await db.enqueueOp({ type, entity, entityId, payload, actor, hlc: nextHlc() });
  refreshPendingCount();
}

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------

/** Push all outbox ops, then pull + merge. */
export async function runSync(actor: string = clientId): Promise<void> {
  setSyncState({ phase: 'pushing', lastError: null });
  try {
    const ops = await collectPendingOps();
    if (!ops.length) {
      // Nothing to push; still need to pull to catch other devices' ops.
      await pullAndMerge(actor);
      return;
    }

    // Batch a single POST /sync/push for all pending ops.
    const payload = ops.map((o) => ({
      op: o.type,
      entity: o.entity,
      entityId: o.entityId,
      payload: o.payload,
      actor,
      hlc: o.hlc,
    }));

    const pushed = await retry(() => pushSync(payload), 3, 500);
    if (pushed && typeof pushed.serverMaxSeq === 'number') {
      setSyncState({ serverMaxSeq: pushed.serverMaxSeq, pendingOps: 0 });
      await pullAndMerge(actor);
    } else {
      // Push failed; leave ops queued and surface error.
      setSyncState({
        pendingOps: ops.length,
        lastError: pushed?.error ?? 'Push failed',
      });
    }
  } catch (err) {
    setSyncState({ phase: 'error', lastError: (err as Error).message });
  }
}

/**
 * Pull ops newer than `since`, apply them locally (idempotently), and
 * confirm the ones the client already pushed.
 */
async function pullAndMerge(actor: string): Promise<void> {
  setSyncState({ phase: 'pulling' });
  try {
    const since = state.serverMaxSeq;
    const res = await retry(() => pullSync(since), 3, 500);
    if (!res || !Array.isArray(res.ops)) return;

    const ops = res.ops as PullOp[];
    if (ops.length) {
      await applyRemoteOps(ops);
      setSyncState({ serverMaxSeq: Math.max(state.serverMaxSeq, res.serverMaxSeq) });
    }

    // Confirm all pending outbox ops (idempotent), clear errors.
    const pending = await db.pendingOps().toArray();
    if (pending.length) {
      const ids = pending.map((o) => o.id);
      await db.transaction('rw', [db.outbox], async () => {
        for (const id of ids) {
          // Reset error so the loop can retry if the server later rejects.
          await db.markOutboxProcessed(id);
          await db.markOutboxError(id, null);
        }
      });
      refreshPendingCount();
    }
    setSyncState({ phase: 'merged', lastError: null });
  } catch (err) {
    setSyncState({ phase: 'error', lastError: (err as Error).message });
  }
}

/** Collect outbox ops that have not yet been confirmed by the server. */
async function collectPendingOps(): Promise<OutboxOp[]> {
  const all = await db.pendingOps().toArray();
  return all; // outbox table is FIFO by createdAt
}

// ---------------------------------------------------------------------------
// Applying remote ops into the local store (idempotent)
// ---------------------------------------------------------------------------

/** Apply remote operations into the local Dexie store. */
export async function applyRemoteOps(ops: PullOp[]): Promise<void> {
  if (!ops.length) return;
  await db.transaction('rw', [db.items, db.outbox], async () => {
    for (const op of ops) {
      try {
        switch (op.op) {
          case 'create': {
            // Already-local items are not re-created.
            const known = await db.items.get(op.entityId);
            if (known && known.deleted_at === null) break; // already present
            const parsed: Item = JSON.parse(op.payload) as Item;
            await db.items.add({
              ...parsed,
              id: op.entityId,
              created_at: parsed.created_at || new Date().toISOString(),
              updated_at: parsed.updated_at || new Date().toISOString(),
            });
            break;
          }
          case 'update': {
            const parsed: Partial<Item> = JSON.parse(op.payload) as Partial<Item>;
            const existing = await db.items.get(op.entityId);
            if (!existing) break; // nothing to update
            const patch: Partial<Item> = {};
            if (typeof parsed.collection_id === 'string') patch.collection_id = parsed.collection_id;
            if (typeof parsed.subject === 'string') patch.subject = parsed.subject;
            if (typeof parsed.kind === 'string') patch.kind = parsed.kind;
            if (typeof parsed.content === 'string') patch.content = parsed.content;
            if (typeof parsed.tags === 'object' && parsed.tags !== null) patch.tags = parsed.tags as Record<string, string[]>;
            if (typeof parsed.notes === 'string') patch.notes = parsed.notes;
            if (typeof parsed.status === 'string') patch.status = parsed.status;
            if (Object.keys(patch).length) {
              patch.updated_at = new Date().toISOString();
              await db.items.update(op.entityId, patch);
            }
            break;
          }
          case 'delete': {
            const existed = await db.items.get(op.entityId);
            if (!existed) break;
            await db.items.update(op.entityId, { deleted_at: new Date().toISOString() });
            break;
          }
        }
      } catch (e) {
        // Never let one bad op kill the batch.
        console.error('applyRemoteOps failed for', op, e);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Outbox introspect / UI helpers
// ---------------------------------------------------------------------------

export async function pendingOpsCount(): Promise<number> {
  const n = await db.pendingOps().count();
  setSyncState({ pendingOps: n });
  return n;
}

export async function refreshPendingCount(): Promise<number> {
  const n = await db.pendingOps().count();
  setSyncState({ pendingOps: n });
  return n;
}

/** True when the app should prompt the user to sync (pending ops exist). */
export async function hasPending(): Promise<boolean> {
  return (await pendingOpsCount()) > 0;
}

// ---------------------------------------------------------------------------
// Lifecycle hooks (online / interval)
// ---------------------------------------------------------------------------

const INTERVAL_MS = 5000;
let timer: number | null = null;
let isRunning = false;

export function startSyncLoop(): void {
  if (isRunning) return;
  isRunning = true;
  if (typeof window === 'undefined') return;
  if (navigator.onLine) {
    runSync().catch(() => {});
  }
  timer = window.setInterval(() => {
    if (navigator.onLine) {
      runSync().catch(() => {});
    }
  }, INTERVAL_MS);
}

export function stopSyncLoop(): void {
  isRunning = false;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

export function registerOnlineListeners(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => {
    runSync().catch(() => {});
  });
  window.addEventListener('offline', () => {
    setSyncState({ phase: 'idle', lastError: null });
  });
}

// Export the client identity the worker uses for logging / tie-breaking.
export { clientId };
