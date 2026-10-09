/** Password hashing (PBKDF2 via WebCrypto) and HS256 access tokens. */
import { SignJWT, jwtVerify } from 'jose';
import type { Env } from './env';

const PBKDF2_ITERATIONS = 100_000; // Workers' WebCrypto maximum
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const ISSUER = 'sharebox';

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await pbkdf2(password, salt), salt: toHex(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const candidate = await pbkdf2(password, fromHex(salt));
  // Constant-time compare.
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i += 1) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

function secret(env: Env): Uint8Array {
  const raw = env.SHAREBOX_JWT_SECRET ?? '';
  if (raw.length < 32) throw new Error('SHAREBOX_JWT_SECRET must be at least 32 characters');
  return new TextEncoder().encode(raw);
}

export async function signToken(userId: string, env: Env): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(secret(env));
}

/** Returns the user id, or null if the token is missing/invalid/expired. */
export async function verifyToken(token: string, env: Env): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret(env), { issuer: ISSUER, algorithms: ['HS256'] });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
