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
    // Always re-subscribe on load to ensure Supabase has the current endpoint
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
  const btn = document.getElementById('notif-enable-btn');

  // Wait up to 10s for Supabase client to be ready
  let db = null;
  for (let i = 0; i < 20; i++) {
    if (window._plSupabase) { db = window._plSupabase; break; }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!db) {
    console.warn('Push: Supabase not ready after 10s');
    alert('Could not connect to database. Please try again after logging in.');
    return;
  }

  try {
    // Get or create push subscription
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      console.log('Push: creating new subscription...');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    console.log('Push: subscription endpoint:', sub.endpoint.slice(0, 60) + '...');

    const subJson = sub.toJSON();

    // Upsert into Supabase push_subscriptions table
    const { error } = await db.from('push_subscriptions').upsert({
      endpoint:   subJson.endpoint,
      p256dh:     subJson.keys.p256dh,
      auth:       subJson.keys.auth,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });

    if (error) {
      console.error('Push: Supabase upsert failed:', error.message);
      alert('Notification registered but failed to save: ' + error.message);
    } else {
      console.log('Push: subscription saved to Supabase successfully');
      alert('Daily notifications enabled! You'll receive your first reminder at 6:43PM.');
    }

  } catch(e) {
    console.error('Push subscription error:', e.message);
    alert('Notification setup failed: ' + e.message);
  }
}
