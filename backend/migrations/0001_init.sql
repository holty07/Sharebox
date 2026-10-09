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
