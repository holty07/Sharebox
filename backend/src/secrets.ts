/**
 * src/secrets.ts
 *
 * Safe access to the Cloudflare secret bindings.  The GEMINI_API_KEY is
 * stored as a Cloudflare secret and injected at deploy time — never
 * committed to the repository and never exposed to the client bundle.
 *
 * Aborts the request with 500 + a clear message if the secret is missing,
 * so a misconfigured deployment fails fast instead of 502ing.
 */
import type { Env } from './env';

let cachedKey: string | null = null;

export function geminiApiKey(env?: Env): string {
  if (cachedKey !== null) return cachedKey;

  // Cloudflare bindings: env.GEMINI_API_KEY (secret binding)
  const fromBinding = env?.GEMINI_API_KEY?.toString?.().trim();
  if (fromBinding) {
    cachedKey = fromBinding;
    return cachedKey;
  }

  // Fall back to a Node-style env var (local `wrangler dev` only)
  const fromEnv = (globalThis as { process?: { env?: { GEMINI_API_KEY?: string | undefined } } }).process
    ?.env?.GEMINI_API_KEY?.trim();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }

  throw new TypeError('GEMINI_API_KEY is not configured. Run: wrangler secret put GEMINI_API_KEY');
}

export function geminiApiKeyOrAbort(env?: Env): string {
  try {
    return geminiApiKey(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const body = `Gemini secret missing: ${msg}`;
    const resp = new Response(body, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
    throw new TypeError('Intentional abort: ' + msg + ' (status 500)');
  }
}
