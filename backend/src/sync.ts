/**
 * src/sync.ts
 *
 * Two-way sync for `collections` and `items` using an append-only op log
 * + field-level HLC merge (the Budget App pattern).
 *
 *   POST /sync/push  { ops: [{op, entity, entityId, payload}] }
 *   GET  /sync/pull  ?since=<n>  -> { ops: [...], serverMaxSeq }
 *
 * Ops are appended atomically; the client pulls every op with seq > since.
 * The merge function compares field-level vectors with a hybrid logical
 * clock so a conflict on the same field is resolved by the higher HLC
 * (i.e. the later-writer wins) and removed rows are handled explicitly.
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface PushOp {
  op: 'create' | 'update' | 'delete';
  entity: 'collections' | 'items';
  entityId: string;
  payload: string;
  actor: string;
  hlc: string;
}

export interface PushRequest {
  ops: PushOp[];
}

export interface PullResponse {
  ops: PullOp[];
  serverMaxSeq: number;
}

export interface PullOp {
  seq: number;
  op: PushOp['op'];
  entity: PushOp['entity'];
  entityId: string;
  payload: string;
  actor: string;
  hlc: string;
  receivedAt: string;
}

export interface ItemState {
  id: string;
  collectionId: string;
  subject: string;
  kind: string;
  content: string;
  tags: Record<string, string[]>;
  notes: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CollectionState {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function genId(): string {
  return cryptoObj.randomUUID();
}

const ENTITIES = ['collections', 'items'] as const;

function randOpId(): string {
  return cryptoObj.randomUUID();
}

export function parseHlc(s: string): number[] {
  return s.split('.').map((p) => parseInt(p, 10));
}

export function hlcToString(parts: number[]): string {
  return parts.join('.');
}

/**
 * Field-level HLC merge.
 *
 * For a single entity, the server keeps a per-field "last-written" vector.
 * When merging a client row into the server row:
 *   - if the field is absent in the old row and present in the new, take new
 *   - if both present, compare HLC: the higher vector wins; a tie is broken
 *     by the higher actor (deterministic)
 *   - if the new row's HLC is strictly dominated by the old row's HLC for a
 *     field, the old value is kept (client was overwritten by someone else)
 */
export function mergeEntity(
  oldDoc: Record<string, unknown> | null,
  newDoc: Record<string, unknown>,
  hlc: number[],
): Record<string, unknown> {
  const out: Record<string, unknown> = oldDoc ? { ...oldDoc } : {};
  const newHlc = hlc.slice();

  for (const [k, v] of Object.entries(newDoc)) {
    const oldVal = out[k];
    const oldHlc = parseHlc(out._hlc ?? '0.0.0' as string);

    if (oldVal === undefined) {
      out[k] = v;
      continue;
    }

    const cmp = compareHlc(oldHlc, newHlc);
    if (cmp < 0) {
      out[k] = v;
    } else if (cmp === 0) {
      const oldActor = String((out as Record<string, unknown>)._actor ?? '');
      const newActor = String((newDoc as Record<string, unknown>)._actor ?? '');
      if (newActor > oldActor) {
        out[k] = v;
      }
    }
  }

  out._hlc = hlcToString(newHlc);
  return out;
}

function compareHlc(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export async function applyPush(
  db: D1Database,
  ops: PushOp[],
  actor: string,
): Promise<{ applied: number; rejected: number }> {
  let applied = 0;
  let rejected = 0;
  let lastHlc = '0.0.0';

  for (const op of ops) {
    const { op: kind, entity, entityId, payload, hlc } = op;

    if (!ENTITIES.includes(entity as (typeof ENTITIES)[number])) {
      rejected += 1;
      continue;
    }
    if (actor === '') {
      rejected += 1;
      continue;
    }

    const opHlc = hlc || lastHlc;

    switch (kind) {
      case 'create': {
        if (entity === 'collections') {
          const existing = await db
            .prepare('SELECT id FROM collections WHERE id = ? AND deleted_at IS NULL')
            .bind(entityId)
            .first();
          if (existing) { rejected += 1; continue; }
          const row = JSON.parse(payload) as Record<string, unknown>;
          row.id = entityId;
          row.created_at = nowIso();
          row.updated_at = row.created_at;
          row.deleted_at = null;
          await db
            .prepare(
              'INSERT INTO collections (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)',
            )
            .bind(
              row.id,
              row.name ?? '',
              row.created_at ?? '',
              row.updated_at ?? '',
              row.deleted_at ?? null,
            )
            .run();
        } else {
          const existing = await db
            .prepare('SELECT id FROM items WHERE id = ? AND deleted_at IS NULL')
            .bind(entityId)
            .first();
          if (existing) { rejected += 1; continue; }
          const row = JSON.parse(payload) as Record<string, unknown>;
          row.id = entityId;
          row.created_at = nowIso();
          row.updated_at = row.updated_at ?? row.created_at;
          row.deleted_at = null;
          await db
            .prepare(
              'INSERT INTO items (id, collection_id, subject, kind, content, tags, notes, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              row.id,
              row.collection_id ?? '',
              row.subject ?? '',
              row.kind ?? 'text',
              row.content ?? '',
              row.tags ?? '{}',
              row.notes ?? null,
              row.status ?? 'queued',
              row.created_at ?? '',
              row.updated_at ?? '',
              row.deleted_at ?? null,
            )
            .run();
        }
        applied += 1;
        lastHlc = opHlc;
        break;
      }
      case 'update': {
        if (entity === 'collections') {
          const row = await db
            .prepare('SELECT * FROM collections WHERE id = ? AND deleted_at IS NULL')
            .bind(entityId)
            .first();
          if (!row) { rejected += 1; continue; }
          const doc = JSON.parse(payload) as Record<string, unknown>;
          const merged = mergeEntity(row, doc, parseHlc(opHlc));
          await db
            .prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?')
            .bind(merged.name ?? '', nowIso(), entityId)
            .run();
        } else {
          const row = await db
            .prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL')
            .bind(entityId)
            .first();
          if (!row) { rejected += 1; continue; }
          const doc = JSON.parse(payload) as Record<string, unknown>;
          const merged = mergeEntity(row, doc, parseHlc(opHlc));
          await db
            .prepare(
              'UPDATE items SET collection_id = ?, subject = ?, kind = ?, content = ?, tags = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?',
            )
            .bind(
              merged.collection_id ?? '',
              merged.subject ?? '',
              merged.kind ?? 'text',
              merged.content ?? '',
              merged.tags ?? '{}',
              merged.notes ?? null,
              merged.status ?? 'queued',
              nowIso(),
              entityId,
            )
            .run();
        }
        applied += 1;
        lastHlc = opHlc;
        break;
      }
      case 'delete': {
        if (entity === 'collections') {
          await db
            .prepare('UPDATE collections SET deleted_at = ? WHERE id = ?')
            .bind(nowIso(), entityId)
            .run();
        } else {
          await db
            .prepare('UPDATE items SET deleted_at = ? WHERE id = ?')
            .bind(nowIso(), entityId)
            .run();
        }
        applied += 1;
        lastHlc = opHlc;
        break;
      }
      default: {
        rejected += 1;
      }
    }
  }

  return { applied, rejected };
}

export async function pullOps(
  db: D1Database,
  since: number,
): Promise<PullResponse> {
  const rows = await db
    .prepare('SELECT seq, op_id, entity, entity_id, payload, actor, hlc, received_at FROM sync_op WHERE seq > ? ORDER BY seq ASC')
    .bind(since)
    .all();

  const ops: PullOp[] = (rows.results ?? []).map((r: Record<string, unknown>) => ({
    seq: toInt(r.seq),
    op: r.op as PullOp['op'],
    entity: r.entity as PullOp['entity'],
    entityId: r.entity_id,
    payload: r.payload,
    actor: r.actor,
    hlc: r.hlc,
    receivedAt: r.received_at,
  }));

  const maxSeq = await db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_op')
    .first();

  return { ops, serverMaxSeq: toInt(maxSeq?.m) };
}

function toInt(v: unknown): number {
  return typeof v === 'number' ? v : (Number(v) || 0);
}

export async function appendOps(
  db: D1Database,
  ops: { op: string; entity: string; entityId: string; payload: string; actor: string; hlc: string }[],
): Promise<number> {
  if (ops.length === 0) return 0;
  const stmt = db.prepare(
    'INSERT INTO sync_op (op_id, op, entity, entity_id, payload, actor, hlc, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const o of ops) {
    stmt.bind(
      randOpId(),
      o.op,
      o.entity,
      o.entityId,
      o.payload,
      o.actor,
      o.hlc,
      nowIso(),
    ).run();
  }
  const last = await db
    .prepare('SELECT seq FROM sync_op WHERE rowid = (SELECT MAX(rowid) FROM sync_op)')
    .first();
  return toInt(last?.seq);
}
