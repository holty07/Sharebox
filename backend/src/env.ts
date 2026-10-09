/**
 * src/env.ts — shared `Env` type for the Sharebox worker.
 *
 * A single source of truth so every module imports the same shape and the
 * typechecker can catch a misspelled binding at compile time.
 */
export interface Env {
  /** Google AI Studio free-tier key, injected via `wrangler secret put` */
  GEMINI_API_KEY?: string;
  /** D1 database binding */
  DB: D1Database;
  /** HS256 JWT secret, injected via `wrangler secret put` */
  SHAREBOX_JWT_SECRET: string;
  /** Worker name used as token issuer/audience */
  CLOUDFLARE_WORKER_NAME: string;
}
