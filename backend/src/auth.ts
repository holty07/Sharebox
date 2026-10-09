/**
 * src/auth.ts
 *
 * JWT (HS256) helpers used by both login/register and the sync merge.
 * A single long-lived secret is held as a Cloudflare Worker secret binding.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { Env } from './env';

const SECRET_ENCODED = 'SHAREBOX_JWT_SECRET';

/** Signature: HS256, payload, optional expiresIn */
export async function signToken(
  payload: Record<string, string | number | boolean>,
  env?: Env,
  expiresIn: number = 60 * 60 * 24 * 7,
): Promise<string> {
  const secret = secretBytes(env);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload, iat: now, exp: now + expiresIn })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(env?.CLOUDFLARE_WORKER_NAME ?? 'sharebox')
    .setAudience(env?.CLOUDFLARE_WORKER_NAME ?? 'sharebox')
    .sign(secret);
}

/**
 * Verify an incoming Bearer token.  Returns the decoded payload or throws.
 * Throws a typed error with a stable `.status` so the router can map it to
 * 401 without importing workers-types into this module.
 */
export async function verifyToken(
  token: string,
  env?: Env,
): Promise<Record<string, unknown>> {
  const secret = secretBytes(env);
  const verified = await jwtVerify(token, secret, {
    issuer: env?.CLOUDFLARE_WORKER_NAME ?? 'sharebox',
    audience: env?.CLOUDFLARE_WORKER_NAME ?? 'sharebox',
    algorithms: ['HS256'],
  });
  return verified.payload as Record<string, unknown>;
}

function secretBytes(env?: Env): Uint8Array {
  const raw = env?.SHAREBOX_JWT_SECRET?.toString?.() ?? '';
  const b = new TextEncoder().encode(raw);
  if (b.length < 32) {
    throw new Error(
      'SHAREBOX_JWT_SECRET must be at least 32 characters (got ' + b.length + ')',
    );
  }
  return b;
}

export { SignJWT, jwtVerify };
