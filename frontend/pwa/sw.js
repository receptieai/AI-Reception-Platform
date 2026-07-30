const CACHE = 'recepai-v3';
const STATIC = ['/dashboard.html','/login.html','/register.html','/onboarding.html','/pwa/manifest.json','/pwa/icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const c = r.clone(); caches.open(CACHE).then(ca=>ca.put(e.request,c)); return r; })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', e => {
  const d = e.data?.json() || {};
  e.waitUntil(self.registration.showNotification(d.title||'🔴 Lead nou — RecepAI', {
    body: d.body||'Un client nou te așteaptă în dashboard.',
    icon: '/pwa/icon.svg',
    badge: '/pwa/icon.svg',
    tag: 'lead',
    vibrate: [200,100,200],
    data: { url: '/dashboard.html' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/dashboard.html'));
});
