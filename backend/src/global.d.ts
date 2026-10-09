/**
 * src/global.d.ts
 *
 * Ambient types for the Cloudflare Worker runtime that the tsconfig `lib`
 * does not cover: the WebCrypto `crypto` global used for salts/uuids, plus
 * a Node-style `process.env` fallback so the GEMINI_API_KEY can also be read
 * from the environment when running outside a bounded Worker (e.g. in tests).
 */
interface Crypto {
  getRandomValues<T extends Uint8Array>(buffer: T): T;
  randomUUID(): string;
}

declare const crypto: Crypto;

declare var process: {
  env: Record<string, string | undefined>;
};
