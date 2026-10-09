-- Sharebox schema. Single owner: one row in users, no per-row user_id.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- User-defined collections. Only "uncategorized" is created (at register).
CREATE TABLE IF NOT EXISTS collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  hlc        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  subject       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  hlc           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_collection ON items(collection_id);

-- Append-only log of accepted writes. Every op is a full-row put; deletes are
-- rows with deleted_at set. Clients pull seq > since.
CREATE TABLE IF NOT EXISTS sync_op (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  hlc         TEXT NOT NULL,
  received_at TEXT NOT NULL
);
