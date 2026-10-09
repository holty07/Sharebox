/**
 * Hand-off between the service worker's share-target handler (sw.ts) and the
 * page: the SW stashes the POSTed form in this cache and redirects to /?share=1.
 */
import type { SharePayload } from './subject';

export const SHARE_CACHE = 'sharebox-share-target';
export const SHARE_META_URL = '/__share/meta';
export const shareFileUrl = (i: number) => `/__share/file/${i}`;

export async function takeSharedPayload(): Promise<SharePayload | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const metaRes = await cache.match(SHARE_META_URL);
  if (!metaRes) return null;
  const meta = (await metaRes.json()) as { title: string; text: string; url: string; files: { name: string; type: string }[] };
  const files: File[] = [];
  for (let i = 0; i < meta.files.length; i += 1) {
    const res = await cache.match(shareFileUrl(i));
    if (res) files.push(new File([await res.blob()], meta.files[i].name, { type: meta.files[i].type }));
  }
  await caches.delete(SHARE_CACHE);
  return { title: meta.title, text: meta.text, url: meta.url, files };
}
