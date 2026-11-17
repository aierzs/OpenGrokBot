// Minimal service worker: makes the app installable on a phone (PWA). Network first; the
// app shell is cached so the icon opens even when the server is briefly unreachable.
const CACHE = 'opengrokbot-shell-v2'
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).catch(() => undefined))
  self.skipWaiting()
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('opengrokbot-shell-') && k !== CACHE).map((k) => caches.delete(k)))))
  self.clients.claim()
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin || e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return
  const navigation = e.request.mode === 'navigate'
  e.respondWith(
    fetch(e.request, navigation ? { cache: 'no-store' } : undefined)
      .then((res) => {
        const htmlForScript = e.request.destination === 'script' && res.headers.get('content-type')?.includes('text/html')
        if (res.ok && !htmlForScript) caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => undefined)
        return res
      })
      .catch(async () => (await caches.match(e.request)) ?? (navigation ? await caches.match('/') : undefined) ?? Response.error()),
  )
})
