/**
 * Sharebox — fetch helpers for the worker API.
 *
 * The frontend talks to ONE place only: the worker.
 * It never calls Google Gemini directly.
 *
 * Auth: worker returns `{ access_token, refresh_token, user }` at
 * `/auth/login` / `/auth/register`; the client keeps the access token
 * (short-lived) in memory + `localStorage` (per-tab) so reloads survive.
 */
import type { Collection, Item, PushOp, PullOp, ClassifyRequest, ClassifyResult, AuthTokens, AuthUser } from './lib/schema';

export const API_BASE = '';
const TOKEN_KEY = 'sharebox_access_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(overrideToken?: string | null): Record<string, string> {
  const t = overrideToken ?? getToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}

async function get<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, { headers: { ...authHeaders(), ...headers } });
  return handle(res);
}

async function post<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { ...authHeaders(), ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handle(res);
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handle(res);
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, { method: 'DELETE', headers: authHeaders() });
  return handle(res);
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as unknown as T;
  if (res.status === 401) {
    setToken(null); // Expired token: clear and let UI force a login.
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const err = JSON.parse(text) as { error?: string };
      if (err.error) msg = err.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (text === '' || text === 'null') return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/*****************************************************************************
 * Auth
 *****************************************************************************/

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

export async function register(email: string, password: string, displayName: string): Promise<AuthTokens> {
  return post('/auth/register', { email, password, displayName });
}

export async function login(email: string, password: string): Promise<AuthTokens> {
  return post('/auth/login', { email, password });
}

/*****************************************************************************
 * Collections
 *****************************************************************************/

export async function listCollections(): Promise<Collection[]> {
  return get('/collections');
}

export async function createCollectionOnServer(name: string): Promise<Collection> {
  return post('/collections', { name });
}

export async function updateCollectionServer(id: string, name: string): Promise<Collection> {
  return patch(`/collections/${id}`, { name });
}

export async function deleteCollectionServer(id: string): Promise<void> {
  await del(`/collections/${id}`);
}

/*****************************************************************************
 * Items
 *****************************************************************************/

export type ItemKind = 'link' | 'text' | 'image';

export async function listItems(opts: { collectionId?: string; q?: string }): Promise<Item[]> {
  const params = new URLSearchParams();
  if (opts.collectionId) params.set('collection', opts.collectionId);
  if (opts.q) params.set('q', opts.q);
  const qs = params.toString();
  return get(`/items${qs ? `?${qs}` : ''}`);
}

export async function getItem(id: string): Promise<Item> {
  return get(`/items/${id}`);
}

export async function createItemOnServer(item: Omit<Item, 'id' | 'created_at' | 'updated_at'>): Promise<Item> {
  return post('/items', item);
}

export async function updateItemServer(id: string, patch: Partial<Item>): Promise<Item> {
  return patch(`/items/${id}`, patch);
}

export async function deleteItemServer(id: string): Promise<void> {
  await del(`/items/${id}`);
}

/*****************************************************************************
 * Classification (server-side only — triggered from ItemDetail)
 *****************************************************************************/

export async function classifyServer(req: ClassifyRequest): Promise<ClassifyResult> {
  return post('/classify', req);
}

/*****************************************************************************
 * Sync
 *****************************************************************************/

export async function pushSync(ops: PushOp[]): Promise<{ applied: number; rejected: number; serverMaxSeq: number }> {
  return post('/sync/push', { ops });
}

export interface PullResponse {
  ops: PullOp[];
  serverMaxSeq: number;
}

export async function pullSync(since: number): Promise<PullResponse> {
  return get(`/sync/pull?since=${since}`);
}

/*****************************************************************************
 * Helpers
 *****************************************************************************/

export function retry<T>(fn: () => Promise<T>, max = 3, delay = 600): Promise<T> {
  return fn().catch((err) => {
    if (max <= 1) throw err;
    return new Promise((resolve, reject) => {
      setTimeout(() => retry(fn, max - 1, delay * 2).then(resolve).catch(reject), delay);
    });
  });
}
