// Offline reading + the 8:00 push.
const VERSION = 'servo-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Editions: try the network first so the newest paper wins, fall back to the cached copy offline.
  if (url.pathname.includes('/editions/')) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // Everything else (app files, fonts): cache first, refresh in the background.
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let data = { title: 'The Morning Servo', body: "Today's edition is ready", url: './' };
  try { data = { ...data, ...e.data.json() }; } catch { /* plain text push */ }
  e.waitUntil(Promise.all([
    self.registration.showNotification(data.title, { body: data.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: data.url } }),
    // Warm the cache so the paper opens instantly, even on a weak connection.
    fetch('editions/index.json').then((r) => r.json()).then((idx) => idx[0] && caches.open(VERSION).then((c) => c.add(`editions/${idx[0].date}.json`))).catch(() => {}),
  ]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => 'focus' in c);
    if (open) { open.navigate('./#/'); return open.focus(); }
    return self.clients.openWindow(e.notification.data?.url || './');
  }));
});
