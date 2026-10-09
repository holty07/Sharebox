/**
 * src/db.ts
 *
 * D1 wiring + schema + migration runner for Sharebox.
 *
 * The full SQL is embedded here as INITIAL_SQL so the Cloudflare Worker
 * (which has no Node `fs` at runtime) can apply the entire schema to the
 * D1 binding on startup.  The `migrations/` folder in the repo is the
 * canonical source of truth; INITIAL_SQL is a copy for the Worker.
 */
import type { D1Database } from '@cloudflare/workers-types';

export const INITIAL_SQL = `
-- 0001_init.sql
-- Users: personal workspaces (one user == one workspace in v1).
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Collections are fully user-defined; nothing is pre-seeded.
CREATE TABLE IF NOT EXISTS collections (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

-- Items hold captured content (link / text / image).
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  subject      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '{}',
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

-- Append-only operation log drives two-way sync (push/pull) with
-- field-level HLC merge.
CREATE TABLE IF NOT EXISTS sync_op (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id    TEXT NOT NULL,
  entity   TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload  TEXT NOT NULL,
  actor    TEXT NOT NULL,
  hlc      TEXT NOT NULL DEFAULT '0.0.0',
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_op_entity ON sync_op(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_op_received ON sync_op(received_at);

-- One auto-created "Uncategorized" collection per workspace (renamable).
CREATE TABLE IF NOT EXISTS misc (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Apply the bundled schema in a single transaction (idempotent).
 * D1 executes one statement per call, so we split on ';' and run each
 * inside its own transaction for atomicity.
 */
export function runMigrations(db: D1Database): void {
  const normalized = 'BEGIN;\n' + INITIAL_SQL.replace(/\r/g, '') + '\nCOMMIT;';
  const stmts = normalized
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of stmts) {
    db.prepare(stmt).bind().run();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function genId(): string {
  return crypto.randomUUID();
}

export function jsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
