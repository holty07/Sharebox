/**
 * src/index.ts
 *
 * Sharebox backend. Cloudflare Worker with D1 + free Gemini classify + HLC sync.
 *
 * Routes:
 *   GET    /health
 *   POST   /auth/register
 *   POST   /auth/login
 *   GET    /collections
 *   POST   /collections
 *   PATCH  /collections/:id
 *   DELETE /collections/:id
 *   GET    /items
 *   POST   /items
 *   GET    /items/:id
 *   PATCH  /items/:id
 *   DELETE /items/:id
 *   POST   /classify          (server-side only)
 *   POST   /sync/push
 *   GET    /sync/pull?since=N
 */
import { Hono, Context } from 'hono';
import { verifyToken, signToken } from './auth';
import { geminiApiKeyOrAbort } from './secrets';
import type { Env } from './env';
import { runMigrations, nowIso, genId, jsonParse } from './db';
import { classify, memoGet, memoPut, resetMemo, type ClassifyRequest, type ClassifyResult } from './classify';
import {
  pullOps,
  applyPush,
  appendOps,
  nowIso as syncNowIso,
  genId as syncGenId,
  mergeEntity,
  parseHlc,
  hlcToString,
} from './sync';
import bcrypt from 'bcryptjs';
const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json<T>(data: T, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function empty(status = 204) {
  return new Response(null, { status });
}

function unauthorized(msg = 'Unauthorized') {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function forbidden(msg = 'Forbidden') {
  return new Response(JSON.stringify({ error: msg }), {
    status: 403,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function badRequest(msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function methodNotAllowed() {
  return new Response(null, { status: 405 });
}

function notFound(msg = 'Not found') {
  return new Response(JSON.stringify({ error: msg }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

interface User {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// D1 + migrations (set once per worker instance)
// ---------------------------------------------------------------------------

let db: D1Database | null = null;

function getDb(env: Env): D1Database {
  if (!db) {
    db = env.DB;
  }
  return db;
}

// Called once at worker startup (exported so `wrangler dev` / deploy runs it).
export async function initBindings(env: Env): Promise<void> {
  const d1 = env.DB;
  if (!d1) throw new Error('D1 binding missing from worker environment');
  getDb(env);
  runMigrations(d1);
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

async function requireUser(ctx: Context): Promise<{ userId: string }> {
  if (!h.startsWith('Bearer ')) throw unauthorized('Missing or malformed Bearer token');
  const token = h.slice(7);
  const payload = await verifyToken(token, ctx.env);
  const userId = String(payload.sub ?? payload.id ?? '');
  if (!userId) throw unauthorized('Token missing subject');
  return { userId };
}

async function getUser(env: Env, userId: string): Promise<User | null> {
  const row = await env.DB.prepare(
    'SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?',
  ).bind(userId).first<User>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

app.get('/health', (c) => json({ ok: true, now: nowIso() }));

// ---------------------------------------------------------------------------
// auth: register / login
// ---------------------------------------------------------------------------

app.post('/auth/register', async (c) => {
  try {
    const body = await c.req.json();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const displayName = String(body.displayName ?? '').trim();

    if (!email || !password || !displayName) {
      return badRequest('email, password and displayName are required');
    }
    if (password.length < 8) {
      return badRequest('password must be at least 8 characters');
    }
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
      return badRequest('invalid email');
    }

    const env = c.env;
    const salt = crypto.randomUUID();
    const hash = await bcryptJ(password, 12);

    const user = {
      id: genId(),
      email,
      password_hash: hash,
      password_salt: salt,
      display_name: displayName,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, password_salt, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(user.id, user.email, user.password_hash, user.password_salt, user.display_name, user.created_at, user.updated_at)
      .run();

    // Grant the workspace its auto-created "Uncategorized" collection.
    const coll = {
      id: genId(),
      name: 'Uncategorized',
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    };
    await env.DB.prepare(
      'INSERT INTO collections (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(coll.id, coll.name, coll.created_at, coll.updated_at, coll.deleted_at)
      .run();

    return json({
      access_token: signToken({ sub: user.id, email: user.email, type: 'access' }, env),
      refresh_token: signToken({ sub: user.id, type: 'refresh' }, env, 60 * 60 * 24 * 30),
      user: { id: user.id, email: user.email, display_name: user.display_name },
    });
  } catch (err) {
    if (err instanceof SyntaxError) return badRequest('invalid JSON body');
    console.error('register', err);
    return json({ error: 'internal error' }, 500);
  }
});

app.post('/auth/login', async (c) => {
  try {
    const body = await c.req.json();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');

    if (!email || !password) return badRequest('email and password are required');

    const row = await c.env.DB.prepare(
      'SELECT id, email, password_hash, password_salt, display_name, created_at, updated_at FROM users WHERE email = ?',
    ).bind(email).first<User>();
    if (!row) return unauthorized('Invalid credentials');

    const env = c.env;
    const ok = await bcryptJ.compare(password, row.password_hash);
    if (!ok) return unauthorized('Invalid credentials');

    return json({
      access_token: signToken({ sub: row.id, email: row.email, type: 'access' }, env),
      refresh_token: signToken({ sub: row.id, type: 'refresh' }, env, 60 * 60 * 24 * 30),
      user: { id: row.id, email: row.email, display_name: row.display_name },
    });
  } catch (err) {
    if (err instanceof SyntaxError) return badRequest('invalid JSON body');
    console.error('login', err);
    return json({ error: 'internal error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// middleware: auth + attach user
// ---------------------------------------------------------------------------

const protectedRoutes = ['/collections', '/items', '/classify', '/sync/push', '/sync/pull'];

app.use('*', async (c, next) => {
  const path = c.req.path;
  const isProtected = protectedRoutes.some((r) => path === r || path.startsWith(r + '/'));
  if (!isProtected) return await next();

  try {
    const { userId } = await requireUser(c);
    const db = getDb(c.env);
    const row = await db.prepare('SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?')
      .bind(user.userId).first<User>();
    if (!row) return unauthorized('User not found');
    c.set('user', {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      password_hash: '',
      password_salt: '',
      created_at: row.created_at,
      updated_at: row.updated_at,
    } as User);
    return await next();
  } catch (e) {
    if (e instanceof Response) return e;
    return unauthorized('Missing or malformed Bearer token');
  }
});

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

app.get('/collections', async (c) => {
  const db = getDb(c.env);
  const rows = await db.prepare(
    'SELECT id, name, created_at, updated_at, deleted_at FROM collections WHERE deleted_at IS NULL ORDER BY updated_at DESC',
  ).all();
  return json((rows.results ?? []).map((r) => toCollection(r as unknown as Collection)));
});

app.post('/collections', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  if (!name) return badRequest('name is required');
  const coll = {
    id: genId(),
    name,
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  };
  await getDb(c.env).prepare(
    'INSERT INTO collections (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(coll.id, coll.name, coll.created_at, coll.updated_at, coll.deleted_at).run();
  return json(toCollection(coll), 201);
});

app.patch('/collections/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;

  const db = getDb(c.env);
  const existing = await db.prepare(
    'SELECT id, name FROM collections WHERE id = ? AND deleted_at IS NULL',
  ).bind(id).first();
  if (!existing) return notFound('Collection not found');

  if (name !== undefined) {
    if (!name) return badRequest('name must not be empty');
    await db.prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?')
      .bind(name, nowIso(), id).run();
  }

  const row = await db.prepare('SELECT id, name, created_at, updated_at, deleted_at FROM collections WHERE id = ? AND deleted_at IS NULL')
    .bind(id).first<Collection>();
  return json(toCollection(row));
});

app.delete('/collections/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const existing = await db.prepare(
    'SELECT id FROM collections WHERE id = ? AND deleted_at IS NULL',
  ).bind(id).first();
  if (!existing) return notFound('Collection not found');
  await db.prepare('UPDATE collections SET deleted_at = ? WHERE id = ?').bind(nowIso(), id).run();
  return empty(204);
});

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

app.get('/items', async (c) => {
  const collectionId = c.req.query('collection');
  const q = c.req.query('q')?.trim();
  const deletedOnly = c.req.query('deleted') === 'true';

  const db = getDb(c.env);
  let sql = `
    SELECT id, collection_id, subject, kind, content, tags, notes, status, created_at, updated_at, deleted_at
    FROM items
    WHERE deleted_at IS NULL
  `;
  const params: string[] = [];
  if (collectionId) {
    sql += ' AND collection_id = ?';
    params.push(collectionId);
  }
  if (q) {
    sql += ' AND (subject LIKE ? OR content LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like);
  }
  sql += ' ORDER BY updated_at DESC';
  const rows = await db.prepare(sql).bind(...params).all();
  return json((rows.results ?? []).map((r) => toItem(r as unknown as Item)));
});

app.post('/items', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const collectionId = String(body.collection_id ?? '').trim();
  if (!collectionId) return badRequest('collection_id is required');

  // Resolve to a live collection id (server trusts collector; re-check to be safe).
  const coll = await getDb(c.env).prepare(
    'SELECT id FROM collections WHERE id = ? AND deleted_at IS NULL',
  ).bind(collectionId).first();
  if (!coll) return badRequest('collection not found');

  const tags = typeof body.tags === 'object' && body.tags !== null
    ? body.tags as Record<string, string[]>
    : {};
  const item = {
    id: genId(),
    collection_id: collectionId,
    subject: String(body.subject ?? '').trim(),
    kind: String(body.kind ?? 'text'),
    content: String(body.content ?? ''),
    tags,
    notes: typeof body.notes === 'string' ? body.notes.trim() : '',
    status: String(body.status ?? 'queued'),
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  };

  // Validate kind.
  if (!['link', 'text', 'image'].includes(item.kind)) {
    return badRequest('kind must be one of: link, text, image');
  }

  await getDb(c.env).prepare(
    'INSERT INTO items (id, collection_id, subject, kind, content, tags, notes, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      item.id, item.collection_id, item.subject, item.kind, item.content,
      JSON.stringify(item.tags), item.notes, item.status,
      item.created_at, item.updated_at, item.deleted_at,
    )
    .run();

  return json(toItem(item), 201);
});

app.get('/items/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const row = await db.prepare(
    'SELECT id, collection_id, subject, kind, content, tags, notes, status, created_at, updated_at, deleted_at FROM items WHERE id = ?',
  ).bind(id).first<Item>();
  if (!row) return notFound('Item not found');
  return json(toItem(row));
});

app.patch('/items/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const db = getDb(c.env);

  // Fetch existing.
  const existing = await db.prepare(
    'SELECT id, collection_id, subject, kind, content, tags, notes, status, created_at, updated_at, deleted_at FROM items WHERE id = ?',
  ).bind(id).first<Item>();
  if (!existing) return notFound('Item not found');

  // Decide which fields may be patched.
  const patch: Partial<Item> = {};
  if (typeof body.collection_id === 'string' && body.collection_id.trim()) {
    const coll = await db.prepare(
      'SELECT id FROM collections WHERE id = ? AND deleted_at IS NULL',
    ).bind(body.collection_id.trim()).first();
    if (!coll) return badRequest('collection not found');
    patch.collection_id = body.collection_id.trim();
  }
  if (typeof body.subject === 'string') patch.subject = body.subject.trim();
  if (typeof body.kind === 'string' && ['link', 'text', 'image'].includes(body.kind)) patch.kind = body.kind;
  if (typeof body.content === 'string') patch.content = body.content;
  if (typeof body.tags === 'object' && body.tags !== null) patch.tags = body.tags as Record<string, string[]>;
  if (typeof body.notes === 'string') patch.notes = body.notes.trim();
  if (typeof body.status === 'string') patch.status = body.status;

  if (Object.keys(patch).length === 0) return json(existing);

  // Build merged row.
  const merged = {
    ...existing,
    ...patch,
    updated_at: nowIso(),
  };
  // tags stored as JSON text.
  await db.prepare(
    'UPDATE items SET collection_id = ?, subject = ?, kind = ?, content = ?, tags = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?',
  )
    .bind(
      merged.collection_id, merged.subject, merged.kind, merged.content,
      JSON.stringify(merged.tags), merged.notes, merged.status,
      merged.updated_at, id,
    )
    .run();

  const row = await db.prepare(
    'SELECT id, collection_id, subject, kind, content, tags, notes, status, created_at, updated_at, deleted_at FROM items WHERE id = ?',
  ).bind(id).first<Item>();
  return json(toItem(row));
});

app.delete('/items/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const existing = await db.prepare(
    'SELECT id FROM items WHERE id = ? AND deleted_at IS NULL',
  ).bind(id).first();
  if (!existing) return notFound('Item not found');
  await db.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').bind(nowIso(), id).run();
  return empty(204);
});

// ---------------------------------------------------------------------------
// classify (server-side only)
// ---------------------------------------------------------------------------

const CLASSIFY_FORBIDDEN = 'POST /classify is server-side only';

app.post('/classify', async (c) => {
  const ref = c.req.header('Referer') ?? '';
  const origin = c.req.header('Origin') ?? '';
  if (origin || ref) {
    return badRequest(CLASSIFY_FORBIDDEN);
  }

  try {
    const body = await c.req.json();
    const req: ClassifyRequest = {
      subject: String(body.subject ?? ''),
      subjectType: body.subjectType === 'image' ? 'image' : body.subjectType === 'link' ? 'link' : 'text',
      collectionIds: Array.isArray(body.collectionIds) ? body.collectionIds.map(String) : [],
    };
    if (!req.subject) return badRequest('subject is required');
    if (!req.collectionIds.length) return badRequest('collectionIds is required');

    const apiKey = geminiApiKeyOrAbort(c.env);
    const result = await classify(req, c.env);

    // Tag collections with the classified result for a smoother client UX.
    return json({
      collection: result.collection,
      tags: result.tags,
      notes: result.notes,
      subject: req.subject,
    });
  } catch (err) {
    if (err instanceof SyntaxError) return badRequest('invalid JSON body');
    console.error('classify', err);
    return json({ error: 'classification failed' }, 500);
  }
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

app.post('/sync/push', async (c) => {
  // Only accept JSON bodies from trusted clients (no Referer/Origin).
  const ref = c.req.header('Referer') ?? '';
  const origin = c.req.header('Origin') ?? '';
  if (ref || origin) {
    return badRequest('sync/push is server-to-client only');
  }

  try {
    const body = await c.req.json();
    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (!ops.length) return json({ applied: 0, rejected: 0, serverMaxSeq: 0 });

    const db = getDb(c.env);
    const actor = c.get('user')?.id ?? 'unknown';
    const { applied, rejected } = await applyPush(db, ops as import('./sync').PushOp[], actor);
    const serverMaxSeq = await db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_op')
      .first<{ m: number }>();

    await appendOps(db, ops as import('./sync').PushOp[]);

    return json({ applied, rejected, serverMaxSeq: serverMaxSeq?.m ?? 0 });
  } catch (err) {
    if (err instanceof SyntaxError) return badRequest('invalid JSON body');
    console.error('sync/push', err);
    return json({ error: 'push failed' }, 500);
  }
});

app.get('/sync/pull', async (c) => {
  const since = Number(c.req.query('since') ?? '0');
  if (!Number.isInteger(since) || since < 0) return badRequest('since must be a non-negative integer');
  const db = getDb(c.env);
  const { ops, serverMaxSeq } = await pullOps(db, since);
  return json({ ops, serverMaxSeq });
});

// ---------------------------------------------------------------------------
// helpers: row → DTO
// ---------------------------------------------------------------------------

function toCollection(r: Collection | null): Collection {
  if (!r) throw new Error('missing collection row');
  return {
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

function toItem(r: Item | null): Item {
  if (!r) throw new Error('missing item row');
  return {
    id: r.id,
    collection_id: r.collection_id,
    subject: r.subject,
    kind: r.kind,
    content: r.content,
    tags: jsonParse(typeof r.tags === 'string' ? r.tags : '{}') ?? {},
    notes: r.notes,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

interface Collection {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface Item {
  id: string;
  collection_id: string;
  subject: string;
  kind: string;
  content: string;
  tags: Record<string, string[]>;
  notes: string;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void },
  ): Promise<Response> {
    try {
      initBindings(env);
    } catch (err) {
      console.error('initBindings', err);
      return new Response('Worker initialization failed', { status: 500 });
    }
    const ctxWithEnv = { ...ctx, env };
    const res = await app.fetch(req, ctxWithEnv);
    return res;
  },
};
