/**
 * Sharebox — client/server shared types.
 *
 * These mirror the worker's D1 schema exactly. The client owns them for
 * its Dexie store; the worker uses them via its own src/db.ts (INITIAL_SQL).
 */
export type ItemKind = 'link' | 'text' | 'image';

export interface Collection {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Item {
  id: string;
  collection_id: string;
  subject: string;
  kind: ItemKind;
  content: string;
  tags: Record<string, string[]>;
  notes: string;
  status: 'uncategorised' | 'queued' | 'synced' | 'error';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type OpKind = 'create' | 'update' | 'delete';

export interface PushOp {
  op: OpKind;
  entity: 'collections' | 'items';
  entityId: string;
  payload: string; // JSON-encoded entity
  actor: string;
  hlc: string; // "ts.logical" hybrid logical clock
}

export interface PullOp {
  seq: number;
  op: OpKind;
  entity: 'collections' | 'items';
  entityId: string;
  payload: string;
  actor: string;
  hlc: string;
  receivedAt: string;
}

export interface SyncProgress {
  pendingOps: number;
  lastPushSeq: number;
  serverMaxSeq: number;
  phase: 'idle' | 'pushing' | 'pulling' | 'merged' | 'error';
  error: string | null;
}
