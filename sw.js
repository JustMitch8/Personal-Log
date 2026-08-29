// sw.js — Personal Log Service Worker
// Handles Web Push notifications delivered by GitHub Actions

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

// Handle incoming push from server
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'Personal Log';
  const options = {
    body:    data.body || 'Tap to log today\'s encounters.',
    icon:    data.icon || './icon-192.png',
    badge:   data.badge || './icon-192.png',
    tag:     'pl-daily-reminder',
    data:    { url: self.registration.scope },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Tapping notification opens the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
