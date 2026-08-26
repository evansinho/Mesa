// Minimal service worker.
//
// Deliberately network-first for everything, with cache only as an offline
// fallback. A cache-first shell is the usual PWA recipe and the usual PWA bug:
// it keeps serving last week's JS bundle against this week's API until someone
// clears storage. Sales reps work on patchy mobile data, so offline reads
// matter — but stale reads that silently disagree with the server matter more.
//
// Bump CACHE_VERSION to evict everything on the next activation.
const CACHE_VERSION = 'mesa-sales-v1'

self.addEventListener('install', (event) => {
  // Take over immediately rather than waiting for every tab to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Never cache anything authenticated. A cached /staff/* response would sit
  // in storage after logout and could be served to whoever holds the phone
  // next.
  if (request.method !== 'GET' || new URL(request.url).pathname.startsWith('/staff/')) {
    return
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        // A navigation with nothing cached still needs to render something.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/')
          if (shell) return shell
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' })
      }),
  )
})
