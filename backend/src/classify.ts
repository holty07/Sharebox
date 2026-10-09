/**
 * Server-side Gemini classification. The API key never leaves the Worker.
 *
 * - Collections are offered to the model by name; the answer is mapped back to an id.
 * - Links: the Worker fetches the page and sends title + visible text.
 * - Images: the stored data URL is sent as inline_data.
 * - Results are memoised per isolate on sha256(content + collection names).
 * - 429s are retried with exponential backoff.
 */
import type { Env } from './env';
import type { Collection, Item } from './sync';

const MODEL = 'gemini-3.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = [
  'You are a personal content classifier for a private capture app.',
  'Pick the single best collection for the item from the numbered list, or NONE if nothing fits.',
  'Respond with only JSON: {"collection": "<exact collection name or NONE>", "tags": ["..."], "notes": "..."}.',
  '"tags" is 1-5 short lowercase labels. "notes" is one short sentence summarising the item.',
].join(' ');

export interface ClassifyResult {
  collectionId: string | null;
  tags: string[];
  notes: string;
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

const memo = new Map<string, ClassifyResult>();
const MAX_MEMO = 500;

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Sharebox/1.0)', Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return '';
    const html = (await res.text()).slice(0, 500_000);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
    const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? '';
    const body = html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
    return [`Page title: ${title}`, desc && `Description: ${desc}`, `Page text: ${body}`].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

async function itemParts(item: Item): Promise<Part[]> {
  const header = `Item kind: ${item.kind}\nSubject: ${item.subject}`;
  if (item.kind === 'image') {
    const m = item.content.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return [{ text: header }];
    return [{ text: header }, { inline_data: { mime_type: m[1], data: m[2] } }];
  }
  if (item.kind === 'link') {
    const page = await fetchPageText(item.content);
    return [{ text: `${header}\nURL: ${item.content}\n${page}` }];
  }
  return [{ text: `${header}\nText: ${item.content.slice(0, 8000)}` }];
}

export async function classifyItem(item: Item, collections: Collection[], env: Env): Promise<ClassifyResult> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured (wrangler secret put GEMINI_API_KEY)');
  const names = collections.map((c) => c.name);
  const key = await sha256(`${item.kind}\n${item.content}\n${names.join('\n')}`);
  const cached = memo.get(key);
  if (cached) return cached;

  const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: `Collections:\n${list}` }, ...(await itemParts(item))] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };

  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  if (!res || !res.ok) {
    const detail = res ? (await res.text()).slice(0, 300) : '';
    throw new Error(`Gemini request failed (${res?.status ?? 'no response'}): ${detail}`);
  }

  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? '';
  const result = parseResult(text, collections);
  memo.set(key, result);
  if (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value as string);
  return result;
}

function parseResult(text: string, collections: Collection[]): ClassifyResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
  }
  const name = typeof obj.collection === 'string' ? obj.collection.trim().toLowerCase() : '';
  const match = collections.find((c) => c.name.trim().toLowerCase() === name);
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5)
    : [];
  return { collectionId: match?.id ?? null, tags, notes: typeof obj.notes === 'string' ? obj.notes.trim() : '' };
}
