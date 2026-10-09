/// <reference lib="webworker" />
/**
 * Service worker: precaches the app shell and receives Android share-sheet
 * POSTs (manifest share_target -> POST /share). The form is stashed in the
 * Cache API and the page is opened at /?share=1 to pick it up.
 */
import { createHandlerBoundToURL, precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { SHARE_CACHE, SHARE_META_URL, shareFileUrl } from './lib/share';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/share/] }));

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share') return;
  event.respondWith((async () => {
    const form = await event.request.formData();
    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(SHARE_META_URL, Response.json({
      title: String(form.get('title') ?? ''),
      text: String(form.get('text') ?? ''),
      url: String(form.get('url') ?? ''),
      files: files.map((f) => ({ name: f.name, type: f.type })),
    }));
    await Promise.all(files.map((f, i) => cache.put(shareFileUrl(i), new Response(f, { headers: { 'Content-Type': f.type } }))));
    return Response.redirect('/?share=1', 303);
  })());
});
