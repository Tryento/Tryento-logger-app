/* eslint-env serviceworker */
/**
 * sw.js — the offline shell.
 *
 * Without this the app is not offline-capable at all, no matter how good the
 * sync layer is: an operator in a shed with no signal would get a blank page.
 * The whole application — shell, runtime, data modules, fonts, icons — is
 * precached so a cold launch with the radio off renders exactly as it does
 * online.
 *
 * Strategies:
 *   precached assets  cache-first (they are content-hashed; a new build brings
 *                     a new cache and the old one is deleted)
 *   navigations       network-first with a cache fallback, so a reload in the
 *                     field always works
 *   Supabase traffic  never touched. Caching an API response would let the app
 *                     show stale production data as if it were current, and the
 *                     outbox already owns offline behaviour.
 */
importScripts('./sw-precache.js');   // defines self.__PRECACHE and self.__VERSION

const VERSION = self.__VERSION || 'dev';
const CACHE = `tryento-${VERSION}`;
const PRECACHE = self.__PRECACHE || [];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is atomic-ish but fails the whole install on one bad URL. Add
    // individually so a single missing optional asset cannot leave the app
    // with no offline shell at all.
    await Promise.all(PRECACHE.map(async url => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (e) {
        console.warn('[sw] no se pudo precachear', url, e);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('tryento-') && n !== CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'VERSION') {
    event.ports?.[0]?.postMessage({ version: VERSION });
  }
});

const isSupabase = url =>
  /\.supabase\.(co|in)$/i.test(url.hostname) ||
  url.pathname.startsWith('/rest/v1') ||
  url.pathname.startsWith('/auth/v1') ||
  url.pathname.startsWith('/storage/v1');

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API and auth traffic must always hit the network. A cached POST-ish read
  // would surface stale records as current, and the outbox is what handles
  // being offline.
  if (isSupabase(url)) return;
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html'))
            || (await cache.match('index.html'))
            || new Response('Sin conexión y sin copia local.', {
                 status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: false })
             || await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    try {
      const res = await fetch(req);
      // Opportunistically cache same-origin successes so anything missed by
      // the precache list still works on the next launch.
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
