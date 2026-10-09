/** Fetch helpers for the Worker API (same origin, under /api) plus the stored session. */
import type { ClassifyResult, PullOp, PushOp, User } from './lib/schema';

const SESSION_KEY = 'sharebox_session';

export interface Session {
  token: string;
  user: User;
}

let session: Session | null = readSession();
const listeners = new Set<() => void>();

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  return session;
}

export function setSession(next: Session | null): void {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage unavailable: session lives for this tab only */ }
  listeners.forEach((fn) => fn());
}

export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && session) setSession(null);
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export async function register(email: string, password: string, displayName: string): Promise<void> {
  setSession(await request<Session>('POST', '/auth/register', { email, password, displayName }));
}

export async function login(email: string, password: string): Promise<void> {
  setSession(await request<Session>('POST', '/auth/login', { email, password }));
}

export function pushOps(actor: string, ops: PushOp[]) {
  return request<{ results: { id: string; accepted: boolean; error?: string }[]; serverMaxSeq: number }>(
    'POST', '/sync/push', { actor, ops },
  );
}

export function pullOps(since: number) {
  return request<{ ops: PullOp[]; serverMaxSeq: number; more: boolean }>('GET', `/sync/pull?since=${since}`);
}

export function classify(itemId: string) {
  return request<ClassifyResult>('POST', '/classify', { itemId });
}
