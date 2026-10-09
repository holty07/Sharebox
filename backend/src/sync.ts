/**
 * Row-level last-write-wins sync.
 *
 * Every write (REST or /api/sync/push) is a full-row put carrying an HLC
 * string. HLCs are fixed-width ("<13-digit ms>-<4-digit counter>-<node>") so
 * plain string comparison orders them. A put is accepted only if its HLC is
 * newer than the stored row's; accepted puts are appended to sync_op.
 */
import type { Env } from './env';

export type Entity = 'collections' | 'items';
export type ItemKind = 'link' | 'text' | 'image';

export interface Collection {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  hlc: string;
}

export interface Item {
  id: string;
  collection_id: string;
  subject: string;
  kind: ItemKind;
  content: string;
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  hlc: string;
}

export type Row = Collection | Item;

export interface PushOp {
  entity: Entity;
  row: Row;
}

export interface PullOp {
  seq: number;
  entity: Entity;
  row: Row;
}

export const UNCATEGORIZED_ID = 'uncategorized';
const MAX_CONTENT = 1_500_000; // keeps a downscaled image data URL under D1's row limit

let serverCounter = 0;
export function serverHlc(): string {
  serverCounter = (serverCounter + 1) % 10_000;
  return `${String(Date.now()).padStart(13, '0')}-${String(serverCounter).padStart(4, '0')}-server`;
}

const HLC_RE = /^\d{13}-\d{4}-[\w-]{1,40}$/;

function str(v: unknown, field: string, max = 2000): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  if (v.length > max) throw new Error(`${field} too long`);
  return v;
}

function optStr(v: unknown, field: string): string | null {
  return v === null || v === undefined ? null : str(v, field);
}

/** Validate an untrusted row and return a clean copy with only known fields. */
export function cleanRow(entity: Entity, raw: unknown): Row {
  if (!raw || typeof raw !== 'object') throw new Error('row must be an object');
  const r = raw as Record<string, unknown>;
  const hlc = str(r.hlc, 'hlc');
  if (!HLC_RE.test(hlc)) throw new Error('bad hlc');
  const base = {
    id: str(r.id, 'id', 100),
    created_at: str(r.created_at, 'created_at'),
    updated_at: str(r.updated_at, 'updated_at'),
    deleted_at: optStr(r.deleted_at, 'deleted_at'),
    hlc,
  };
  if (entity === 'collections') {
    return { ...base, name: str(r.name, 'name', 200).trim() || 'Untitled' };
  }
  const kind = r.kind;
  if (kind !== 'link' && kind !== 'text' && kind !== 'image') throw new Error('bad kind');
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string').slice(0, 50) : [];
  return {
    ...base,
    collection_id: str(r.collection_id, 'collection_id', 100) || UNCATEGORIZED_ID,
    subject: str(r.subject, 'subject', 5000),
    kind,
    content: str(r.content, 'content', MAX_CONTENT),
    tags,
    notes: typeof r.notes === 'string' ? str(r.notes, 'notes', 10_000) : '',
  };
}

function upsertStmt(db: D1Database, entity: Entity, row: Row): D1PreparedStatement {
  if (entity === 'collections') {
    const c = row as Collection;
    return db
      .prepare(
        `INSERT INTO collections (id, name, created_at, updated_at, deleted_at, hlc) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at, hlc = excluded.hlc`,
      )
      .bind(c.id, c.name, c.created_at, c.updated_at, c.deleted_at, c.hlc);
  }
  const i = row as Item;
  return db
    .prepare(
      `INSERT INTO items (id, collection_id, subject, kind, content, tags, notes, created_at, updated_at, deleted_at, hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id, subject = excluded.subject,
         kind = excluded.kind, content = excluded.content, tags = excluded.tags, notes = excluded.notes,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, hlc = excluded.hlc`,
    )
    .bind(i.id, i.collection_id, i.subject, i.kind, i.content, JSON.stringify(i.tags), i.notes,
      i.created_at, i.updated_at, i.deleted_at, i.hlc);
}

/** Apply one put with LWW. Returns true if it was newer and got stored. */
export async function applyOp(env: Env, entity: Entity, row: Row, actor: string): Promise<boolean> {
  const current = await env.DB.prepare(`SELECT hlc FROM ${entity} WHERE id = ?`).bind(row.id).first<{ hlc: string }>();
  if (current && current.hlc >= row.hlc) return false;
  await env.DB.batch([
    upsertStmt(env.DB, entity, row),
    env.DB
      .prepare('INSERT INTO sync_op (entity, entity_id, payload, actor, hlc, received_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(entity, row.id, JSON.stringify(row), actor, row.hlc, new Date().toISOString()),
  ]);
  return true;
}

export async function maxSeq(env: Env): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_op').first<{ m: number }>();
  return Number(r?.m ?? 0);
}

export async function pullOps(env: Env, since: number, limit = 500): Promise<{ ops: PullOp[]; serverMaxSeq: number; more: boolean }> {
  const res = await env.DB
    .prepare('SELECT seq, entity, payload FROM sync_op WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .bind(since, limit + 1)
    .all<{ seq: number; entity: Entity; payload: string }>();
  const rows = res.results ?? [];
  const more = rows.length > limit;
  const ops = rows.slice(0, limit).map((r) => ({ seq: Number(r.seq), entity: r.entity, row: JSON.parse(r.payload) as Row }));
  return { ops, serverMaxSeq: await maxSeq(env), more };
}

export function itemFromDb(r: Record<string, unknown>): Item {
  return { ...(r as unknown as Item), tags: JSON.parse(String(r.tags ?? '[]')) as string[] };
}
