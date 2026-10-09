/**
 * Sharebox Worker. Static assets (the PWA) are served by Workers assets;
 * everything under /api/* lands here.
 *
 *   GET    /api/health
 *   POST   /api/auth/register      (only while no user exists — single owner)
 *   POST   /api/auth/login
 *   GET    /api/me
 *   GET    /api/collections        POST /api/collections
 *   PATCH  /api/collections/:id    DELETE /api/collections/:id
 *   GET    /api/items?collection=&q=   POST /api/items
 *   GET    /api/items/:id   PATCH /api/items/:id   DELETE /api/items/:id
 *   POST   /api/classify           { itemId } -> { collectionId, tags, notes }
 *   POST   /api/sync/push          { actor, ops: [{ entity, row }] }
 *   GET    /api/sync/pull?since=N
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './env';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth';
import { classifyItem } from './classify';
import {
  applyOp, cleanRow, itemFromDb, maxSeq, pullOps, serverHlc, UNCATEGORIZED_ID,
  type Collection, type Entity, type Item, type PushOp,
} from './sync';

interface User {
  id: string;
  email: string;
  display_name: string;
}

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>().basePath('/api');

const now = () => new Date().toISOString();

function fail(status: 400 | 401 | 403 | 404 | 409, message: string): never {
  throw new HTTPException(status, { message });
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') fail(400, 'invalid JSON body');
  return body as Record<string, unknown>;
}

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
});

app.notFound((c) => c.json({ error: 'not found' }, 404));

app.get('/health', (c) => c.json({ ok: true, now: now() }));

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

app.post('/auth/register', async (c) => {
  const body = await readJson(c);
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const displayName = String(body.displayName ?? '').trim() || email.split('@')[0];
  if (!email.includes('@')) fail(400, 'valid email required');
  if (password.length < 8) fail(400, 'password must be at least 8 characters');

  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if (Number(existing?.n ?? 0) > 0) fail(403, 'Sharebox already has an owner; sign in instead');

  const { hash, salt } = await hashPassword(password);
  const user: User = { id: crypto.randomUUID(), email, display_name: displayName };
  const ts = now();
  await c.env.DB
    .prepare('INSERT INTO users (id, email, password_hash, password_salt, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, email, hash, salt, displayName, ts, ts)
    .run();
  const uncategorized: Collection = {
    id: UNCATEGORIZED_ID, name: 'Uncategorized', created_at: ts, updated_at: ts, deleted_at: null, hlc: serverHlc(),
  };
  await applyOp(c.env, 'collections', uncategorized, 'server');
  return c.json({ token: await signToken(user.id, c.env), user }, 201);
});

app.post('/auth/login', async (c) => {
  const body = await readJson(c);
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const row = await c.env.DB
    .prepare('SELECT id, email, display_name, password_hash, password_salt FROM users WHERE email = ?')
    .bind(email)
    .first<User & { password_hash: string; password_salt: string }>();
  if (!row || !(await verifyPassword(password, row.password_hash, row.password_salt))) fail(401, 'invalid credentials');
  const user: User = { id: row.id, email: row.email, display_name: row.display_name };
  return c.json({ token: await signToken(user.id, c.env), user });
});

// Everything below requires a bearer token.
app.use('*', async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const userId = header.startsWith('Bearer ') ? await verifyToken(header.slice(7), c.env) : null;
  if (!userId) fail(401, 'missing or invalid token');
  const user = await c.env.DB.prepare('SELECT id, email, display_name FROM users WHERE id = ?').bind(userId).first<User>();
  if (!user) fail(401, 'user not found');
  c.set('user', user);
  await next();
});

app.get('/me', (c) => c.json(c.get('user')));

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

async function getRow<T>(env: Env, entity: Entity, id: string): Promise<T> {
  const row = await env.DB.prepare(`SELECT * FROM ${entity} WHERE id = ? AND deleted_at IS NULL`).bind(id).first<Record<string, unknown>>();
  if (!row) fail(404, `${entity === 'items' ? 'item' : 'collection'} not found`);
  return (entity === 'items' ? itemFromDb(row) : row) as T;
}

/** Stamp a REST write and push it through the same LWW path as sync. */
async function write<T extends Collection | Item>(env: Env, entity: Entity, row: T, actor: string): Promise<T> {
  const stamped = { ...row, updated_at: now(), hlc: serverHlc() };
  const clean = cleanRow(entity, stamped) as T;
  await applyOp(env, entity, clean, actor);
  return clean;
}

app.get('/collections', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM collections WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE').all();
  return c.json(res.results ?? []);
});

app.post('/collections', async (c) => {
  const body = await readJson(c);
  const name = String(body.name ?? '').trim();
  if (!name) fail(400, 'name is required');
  const ts = now();
  const row: Collection = { id: crypto.randomUUID(), name, created_at: ts, updated_at: ts, deleted_at: null, hlc: '' };
  return c.json(await write(c.env, 'collections', row, c.get('user').id), 201);
});

app.patch('/collections/:id', async (c) => {
  const body = await readJson(c);
  const existing = await getRow<Collection>(c.env, 'collections', c.req.param('id'));
  const name = String(body.name ?? '').trim();
  if (!name) fail(400, 'name is required');
  return c.json(await write(c.env, 'collections', { ...existing, name }, c.get('user').id));
});

app.delete('/collections/:id', async (c) => {
  const id = c.req.param('id');
  if (id === UNCATEGORIZED_ID) fail(409, 'the Uncategorized collection cannot be deleted');
  const existing = await getRow<Collection>(c.env, 'collections', id);
  await write(c.env, 'collections', { ...existing, deleted_at: now() }, c.get('user').id);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

app.get('/items', async (c) => {
  const collection = c.req.query('collection');
  const q = c.req.query('q');
  const where = ['deleted_at IS NULL'];
  const args: string[] = [];
  if (collection) { where.push('collection_id = ?'); args.push(collection); }
  if (q) { where.push('(subject LIKE ? OR notes LIKE ? OR (kind != \'image\' AND content LIKE ?))'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const res = await c.env.DB
    .prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`)
    .bind(...args)
    .all<Record<string, unknown>>();
  return c.json((res.results ?? []).map(itemFromDb));
});

app.post('/items', async (c) => {
  const body = await readJson(c);
  const ts = now();
  const row = {
    collection_id: UNCATEGORIZED_ID, tags: [], notes: '', ...body,
    id: crypto.randomUUID(), created_at: ts, updated_at: ts, deleted_at: null, hlc: serverHlc(),
  };
  return c.json(await write(c.env, 'items', cleanRow('items', row) as Item, c.get('user').id), 201);
});

app.get('/items/:id', async (c) => c.json(await getRow<Item>(c.env, 'items', c.req.param('id'))));

app.patch('/items/:id', async (c) => {
  const body = await readJson(c);
  const existing = await getRow<Item>(c.env, 'items', c.req.param('id'));
  const { id: _i, created_at: _c, hlc: _h, ...patch } = body;
  return c.json(await write(c.env, 'items', { ...existing, ...patch } as Item, c.get('user').id));
});

app.delete('/items/:id', async (c) => {
  const existing = await getRow<Item>(c.env, 'items', c.req.param('id'));
  await write(c.env, 'items', { ...existing, deleted_at: now() }, c.get('user').id);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// classify (Gemini, server-side only)
// ---------------------------------------------------------------------------

app.post('/classify', async (c) => {
  const body = await readJson(c);
  const item = await getRow<Item>(c.env, 'items', String(body.itemId ?? ''));
  const res = await c.env.DB
    .prepare('SELECT * FROM collections WHERE deleted_at IS NULL AND id != ?')
    .bind(UNCATEGORIZED_ID)
    .all<Collection>();
  const collections = res.results ?? [];
  if (!collections.length) fail(409, 'create a collection first');
  return c.json(await classifyItem(item, collections, c.env));
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

app.post('/sync/push', async (c) => {
  const body = await readJson(c);
  const ops = Array.isArray(body.ops) ? (body.ops as PushOp[]) : [];
  if (ops.length > 500) fail(400, 'too many ops in one push (max 500)');
  const actor = typeof body.actor === 'string' ? body.actor.slice(0, 64) : c.get('user').id;
  const results: { id: string; accepted: boolean; error?: string }[] = [];
  for (const op of ops) {
    const id = String((op?.row as { id?: unknown } | undefined)?.id ?? '');
    try {
      if (op.entity !== 'collections' && op.entity !== 'items') throw new Error('bad entity');
      const row = cleanRow(op.entity, op.row);
      if (op.entity === 'collections' && row.id === UNCATEGORIZED_ID && row.deleted_at) throw new Error('cannot delete Uncategorized');
      results.push({ id, accepted: await applyOp(c.env, op.entity, row, actor) });
    } catch (err) {
      results.push({ id, accepted: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return c.json({ results, serverMaxSeq: await maxSeq(c.env) });
});

app.get('/sync/pull', async (c) => {
  const since = Number(c.req.query('since') ?? '0');
  if (!Number.isInteger(since) || since < 0) fail(400, 'since must be a non-negative integer');
  return c.json(await pullOps(c.env, since));
});

export default app;
