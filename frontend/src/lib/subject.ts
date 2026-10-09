/** Turn a share-sheet payload (or manual input) into the fields of a new item. */
import type { ItemKind } from './schema';

export interface SharePayload {
  title: string;
  text: string;
  url: string;
  files: File[];
}

export interface Draft {
  kind: ItemKind;
  subject: string;
  content: string;
}

const URL_RE = /https?:\/\/[^\s<>"]+/i;

/**
 * Android often puts the shared link inside `text` rather than `url`, so a
 * URL found anywhere makes it a link. Images win over everything else.
 */
export async function draftFromShare(p: SharePayload): Promise<Draft> {
  const title = p.title.trim();
  const text = p.text.trim();
  const image = p.files.find((f) => f.type.startsWith('image/'));
  if (image) {
    return { kind: 'image', subject: title || text || image.name || 'Image', content: await downscaleImage(image) };
  }
  const url = p.url.trim() || text.match(URL_RE)?.[0] || '';
  if (url) {
    const rest = text.replace(url, '').trim();
    return { kind: 'link', subject: title || rest || hostOf(url), content: url };
  }
  return { kind: 'text', subject: title || firstLine(text), content: text };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** Re-encode as a JPEG no larger than `max` px so it fits in a D1 row. */
export async function downscaleImage(file: File, max = 1024, quality = 0.8): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
}
