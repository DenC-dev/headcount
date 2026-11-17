// Keeps the app shell available offline and on flaky capitol Wi-Fi. Pages and
// scripts come from the network when it answers, so updates apply at once;
// the API and other sites are never cached.
const CACHE = 'headcount-shell-v1';
const SHELL = ['/app', '/styles.css', '/app.js', '/cloud.js', '/intel.js', '/rosters.json', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = url.pathname === '/app' || url.pathname.startsWith('/join/') || url.pathname.startsWith('/invite/') ? '/app' : url.pathname;
  if (!SHELL.includes(key)) return;
  e.respondWith(fetch(e.request).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); } return res; }).catch(() => caches.match(key)));
});
