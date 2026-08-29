// notifications.js
// Registers SW, subscribes to Web Push, saves subscription to Supabase.

// ── Your VAPID public key ──────────────────────────────────────────
const VAPID_PUBLIC_KEY = 'PSO7S984xDoWCAEGFgbuw7qgaGVwtp-Md2fgGA1yXd5sA5ola9vL0Li9rlG0V1jbOxkhkbSc4Go8gN8pOwZBNw';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export async function initNotifications() {
  const btn = document.getElementById('notif-enable-btn');
  if (!btn) return;

  // Check support
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.style.display = 'none';
    return;
  }

  // Register SW
  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js');
  } catch(e) {
    console.warn('SW registration failed:', e);
    btn.style.display = 'none';
    return;
  }

  if (Notification.permission === 'granted') {
    btn.style.display = 'none';
    await ensureSubscribed(reg);
  } else if (Notification.permission === 'denied') {
    btn.style.display = 'none';
  } else {
    btn.style.display = 'block';
    btn.addEventListener('click', async () => {
      const result = await Notification.requestPermission();
      btn.style.display = 'none';
      if (result === 'granted') await ensureSubscribed(reg);
    });
  }
}

async function ensureSubscribed(reg) {
  const db = window._plSupabase;
  if (!db) return;

  try {
    // Get or create push subscription
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const subJson = sub.toJSON();

    // Upsert into Supabase push_subscriptions table
    // Use endpoint as unique key — one row per device
    await db.from('push_subscriptions').upsert({
      endpoint:   subJson.endpoint,
      p256dh:     subJson.keys.p256dh,
      auth:       subJson.keys.auth,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });

  } catch(e) {
    console.warn('Push subscription failed:', e);
  }
}
