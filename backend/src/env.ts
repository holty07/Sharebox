/** Worker bindings. Secrets are set with `wrangler secret put` (or .dev.vars locally). */
export interface Env {
  DB: D1Database;
  SHAREBOX_JWT_SECRET: string;
  GEMINI_API_KEY?: string;
}
