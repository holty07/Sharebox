/**
 * Background sync: push the outbox, then pull every op since our last seq and
 * apply it with row-level last-write-wins (higher HLC wins). Runs on an
 * interval, when the browser comes online, and shortly after any local write.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, getSession, pullOps, pushOps } from './api';
import { clientId, db, getMeta, observeHlc, onLocalWrite, pendingCount, type OutboxEntry } from './db';

export interface SyncState {
  status: 'idle' | 'syncing' | 'offline' | 'error';
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
}

let state: SyncState = { status: 'idle', pending: 0, lastSyncedAt: null, error: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => state,
  );
}

const PUSH_BATCH = 20; // image rows can be ~200KB each
const INTERVAL_MS = 15_000;
let running: Promise<void> | null = null;
let again = false;

async function push(): Promise<void> {
  for (;;) {
    const batch = await db.outbox.limit(PUSH_BATCH).toArray();
    if (!batch.length) return;
    const res = await pushOps(clientId, batch.map(({ entity, row }) => ({ entity, row })));
    res.results.forEach((r) => { if (r.error) console.warn('sync: server rejected', r.id, r.error); });
    // Drop what we sent, unless the row was edited again while the push was in flight.
    await db.transaction('rw', db.outbox, async () => {
      for (const sent of batch) {
        const current = await db.outbox.get(sent.key);
        if (current && current.row.hlc === sent.row.hlc) await db.outbox.delete(sent.key);
      }
    });
  }
}

async function pull(): Promise<void> {
  for (;;) {
    const since = await getMeta('lastSeq');
    const res = await pullOps(since);
    await db.transaction('rw', [db.collections, db.items, db.meta], async () => {
      for (const op of res.ops) {
        observeHlc(op.row.hlc);
        const table = db.table(op.entity);
        const local = (await table.get(op.row.id)) as OutboxEntry['row'] | undefined;
        if (!local || local.hlc < op.row.hlc) await table.put(op.row);
      }
      if (res.ops.length) await db.meta.put({ key: 'lastSeq', value: res.ops[res.ops.length - 1].seq });
    });
    if (!res.more) return;
  }
}

async function syncOnce(): Promise<void> {
  if (!getSession()) return;
  if (!navigator.onLine) { setState({ status: 'offline', pending: await pendingCount() }); return; }
  setState({ status: 'syncing' });
  try {
    await push();
    await pull();
    setState({ status: 'idle', error: null, lastSyncedAt: new Date().toISOString(), pending: await pendingCount() });
  } catch (err) {
    const offline = !navigator.onLine || err instanceof TypeError; // fetch network failure
    setState({
      status: offline ? 'offline' : 'error',
      error: err instanceof ApiError || err instanceof Error ? err.message : String(err),
      pending: await pendingCount(),
    });
  }
}

/** Run a sync now; if one is in flight, queue exactly one more after it. */
export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    do { again = false; await syncOnce(); } while (again);
  })().finally(() => { running = null; });
  return running;
}

let started = false;
export function startSync(): void {
  if (started) return;
  started = true;
  let debounce: number | undefined;
  onLocalWrite(() => {
    void pendingCount().then((pending) => setState({ pending }));
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void syncNow(), 800);
  });
  window.addEventListener('online', () => void syncNow());
  window.addEventListener('offline', () => setState({ status: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(); });
  window.setInterval(() => void syncNow(), INTERVAL_MS);
  void syncNow();
}
