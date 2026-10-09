/**
 * Build a stable "subject" string (and hash) from a share payload.
 *
 * Classification is keyed on content, so the subject must be
 * deterministic for the same shared item.
 */
import type { ItemKind } from './schema';

export interface SharePayload {
  title: string;
  text: string;
  url: string;
  files: File[];
  subjectType: ItemKind;
}

/** From a share target entry (`title`, `text`, `url`, `files`). */
export function buildPayload(share: ShareData): SharePayload {
  const files = (share.files ?? []).filter((f): f is File => f !== null && f.size > 0);
  const text = (share.text ?? '').trim();
  const url = (share.url ?? '').trim();
  const title = (share.title ?? '').trim();

  const subjectType: ItemKind =
    files.length > 0 ? 'image' : url && url.startsWith('http') ? 'link' : text ? 'text' : 'text';

  return { title, text, url, files, subjectType };
}

export function buildSubject(payload: SharePayload): string {
  const { title, text, url } = payload;
  const parts = [title, text, url].filter(Boolean);
  return parts.join('\n');
}

/** FNV-1a 64-bit style hash used to dedupe identical shares. */
export function contentHash(subject: string): string {
  const buf = new TextEncoder().encode(subject);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < buf.length; i += 1) {
    h1 = (h1 ^ buf[i]) * 0x01000193 >>> 0;
    h2 = (h2 + buf[i] + (h1 >>> 0)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}-${h2.toString(16).padStart(8, '0')}-${buf.length}`;
}

/** Strip newlines / control chars for use as a DB column / log field. */
export function sanitizeSubject(s: string): string {
  return s.replace(/[\n\r\t]+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 2000);
}
