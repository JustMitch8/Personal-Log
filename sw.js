// sw.js — Personal Log Service Worker
// Handles background sync and scheduled daily notifications

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

// Receive notification payload from the app
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SCHEDULE_NOTIFICATION') {
    scheduleNotification(e.data.payload);
  }
});

function scheduleNotification(payload) {
  const { msUntil, title, body, tag } = payload;
  setTimeout(() => {
    self.registration.showNotification(title, {
      body,
      tag,          // prevents duplicate notifications with same tag
      icon: '/Personal-Log/icon-192.png',
      badge: '/Personal-Log/icon-192.png',
      data: { url: self.registration.scope },
      actions: [{ action: 'open', title: 'Log encounters' }],
    });
  }, msUntil);
}

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
