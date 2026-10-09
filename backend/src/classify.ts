/**
 * src/classify.ts
 *
 * Server-side Gemini classification with:
 *  - a local memoizer keyed on (contentHash, collection) so an item is sent
 *    to the model at most once per collection,
 *  - exponential-backoff retry on HTTP 429 (free-tier rate limits),
 *  - no thinking/JSON-mode extras so calls stay cheap and single-turn.
 */
import { geminiApiKeyOrAbort } from './secrets';
import type { Env } from './env';

export interface ClassifyRequest {
  subject: string;
  subjectType: 'link' | 'text' | 'image';
  collectionIds: string[];
}

export interface ClassifyResult {
  collection: string;
  tags: string[];
  notes: string;
}

export interface GeminiPart {
  text?: string;
  inlineData?: { data: string; mimeType: string };
}

export interface GeminiGenerateParams {
  model: string;
  contents: { role: string; parts: GeminiPart[] }[];
  systemInstruction?: string;
}

const GEMINI_MODEL = 'gemini-3.5-flash';
const TEXT_MODEL = 'gemini-3.5-flash'; // free tier; supports image input too
const SYSTEM_PROMPT = [
  'You are a personal content classifier for a private capture app.',
  'Decide whether the incoming item belongs in each of the provided collections.',
  'Respond with ONLY a JSON object:',
  '  { "collection": "<collection name>", "tags": ["...", "..."], "notes": "..." }',
  'Rules:',
  '  1. "collection" must exactly match an existing collection name, or "UNCLASSIFIED" if none fits.',
  '  2. "tags" is a short array of lowercase, comma-free labels.',
  '  3. "notes" summarises the item in one short sentence.',
  '  4. Output no markdown fences, no commentary, no apologies.',
].join(' ');

// ---- memoizer: one classification per (hash, collection) ----

interface CacheEntry {
  hash: string;
  collection: string;
  tags: string[];
  notes: string;
  ts: number;
}

const memo = new Map<string, CacheEntry>();
const MAX_MEMO = 2048;

function cacheKey(hash: string, collection: string): string {
  return `${hash}:${collection}`;
}

export function memoHit(key: string): boolean {
  return memo.has(key);
}

export function memoPut(hash: string, collection: string, entry: CacheEntry): void {
  const k = cacheKey(hash, collection);
  memo.set(k, entry);
  if (memo.size > MAX_MEMO) {
    // evict least-recently-used-ish (FIFO is fine for this scale)
    const first = memo.keys().next().value;
    if (first !== undefined) memo.delete(first);
  }
}

export function memoGet(hash: string, collection: string): CacheEntry | undefined {
  const k = cacheKey(hash, collection);
  return memo.get(k);
}

// ---- Gemini call ----

function buildContents(req: ClassifyRequest): { role: string; parts: GeminiPart[] }[] {
  const { subject, subjectType, collectionIds } = req;

  if (subjectType === 'image') {
    // Content is the raw image bytes (base64) passed in as a second field;
    // the caller attaches it via the `parts` below.
    return [
      {
        role: 'user',
        parts: [
          { text: buildUserText(subject, subjectType, collectionIds) },
          { inlineData: { data: subject, mimeType: 'image/jpeg' } },
        ],
      },
    ];
  }

  // link / text: subject already contains title + extracted text for links
  return [
    {
      role: 'user',
      parts: [{ text: buildUserText(subject, subjectType, collectionIds) }],
    },
  ];
}

function buildUserText(subject: string, subjectType: 'link' | 'text' | 'image', collectionIds: string[]): string {
  const items = collectionIds.map((id) => `# ${id}`).join('\n');
  return [
    SYSTEM_PROMPT,
    '',
    'Target collections (ids):',
    items,
    '',
    'Item content:',
    subject,
  ].join('\n');
}

export async function classify(
  req: ClassifyRequest,
  env?: Env,
): Promise<ClassifyResult> {
  // 1. memoize: skip if this (hash, collection) already classified
  const hash = await contentHash(req.subject, req.subjectType);
  for (const collectionId of req.collectionIds) {
    const hit = memoGet(hash, collectionId);
    if (hit) return { collection: hit.collection, tags: hit.tags, notes: hit.notes };
  }

  // 2. call Gemini with exponential backoff on 429
  const apiKey = geminiApiKeyOrAbort(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload: GeminiGenerateParams = {
    model: GEMINI_MODEL,
    contents: buildContents(req),
    systemInstruction: SYSTEM_PROMPT,
  };

  let lastErr: unknown;
  let lastStatus = 0;
  const maxBackoff = 2 ** 8; // 256s ceiling
  let backoff = 1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        lastErr = new Error(`Gemini 429 (rate limited), attempt ${attempt + 1}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        error?: { message?: string };
      };
      const text = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
      if (!text) {
        throw new Error('Empty Gemini response');
      }
      const entry = parseJsonResult(text, req.collectionIds);
      // memoize the successful result
      for (const collectionId of req.collectionIds) {
        memoPut(hash, collectionId, entry);
      }
      return entry;
    } catch (err) {
      lastErr = err;
      // 429 already handled above (continue); re-throw non-429 after final attempt
      if (res && res.status !== 429) break;
    }
  }
  throw lastErr ?? new Error('Unknown classify failure');
}

function parseJsonResult(
  raw: string,
  collectionIds: string[],
): CacheEntry {
  // Strip any surrounding whitespace / stray characters
  const cleaned = raw.replace(/^```(?:json|JSON)?\s*|\s*```$/g, '').trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error(`Unparseable Gemini JSON: ${cleaned.slice(0, 200)}`);
  }
  const collection = String(obj.collection ?? 'UNCLASSIFIED').trim();
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase().trim()).filter(Boolean)
    : [];
  const notes = typeof obj.notes === 'string' ? obj.notes.trim() : '';
  return { hash: '', collection, tags, notes, ts: Date.now() };
}

// ---- helpers ----

async function contentHash(subject: string, subjectType: 'link' | 'text' | 'image'): Promise<string> {
  const input = subjectType === 'image' ? subject : subject;
  const buf = new TextEncoder().encode(input);
  let h = 0;
  for (const b of buf) {
    h = (h * 31 + b) >>> 0;
  }
  // Fold into a 64-bit hex for readability
  return `sha1-${h.toString(16).padStart(16, '0')}-${buf.length}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapEntry(entry: CacheEntry): ClassifyResult {
  return {
    collection: entry.collection,
    tags: entry.tags,
    notes: entry.notes,
  };
}

export function resetMemo(): void {
  memo.clear();
}
