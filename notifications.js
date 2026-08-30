// notifications.js — Personal Log push notifications
// Fully self-contained. Loaded as <script type="module"> from index.html.
// Never blocks login or any other app flow.

const VAPID_PUBLIC_KEY = 'BMQyZLpK24YSkTvXPucEgv7ao5KAG1DR7BnjhbgptutFTMlNd74TxslULNP0XPNB3DEPQ3WdlbzyinvzLPJdgHQ';
const STORAGE_KEY      = 'pl_notifications_enabled';

// ── Helpers ────────────────────────────────────────────────────────
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function isSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Wait for a SW registration to reach 'activated' state
function waitForActivation(reg) {
  return new Promise((resolve, reject) => {
    const sw = reg.installing || reg.waiting || reg.active;
    if (!sw) return reject(new Error('No SW found'));
    if (sw.state === 'activated') return resolve(reg);
    sw.addEventListener('statechange', function handler() {
      if (sw.state === 'activated') { sw.removeEventListener('statechange', handler); resolve(reg); }
      if (sw.state === 'redundant') { sw.removeEventListener('statechange', handler); reject(new Error('SW redundant')); }
    });
    setTimeout(() => reject(new Error('SW activation timeout')), 10000);
  });
}

// Wait for _plSupabase to be set (max 15s, checks every 250ms)
function waitForSupabase() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (window._plSupabase) { clearInterval(timer); resolve(window._plSupabase); return; }
      if (attempts >= 60) { clearInterval(timer); reject(new Error('Supabase not ready')); }
    }, 250);
  });
}

// ── Toggle state ───────────────────────────────────────────────────
function isEnabled() {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}
function setEnabled(val) {
  localStorage.setItem(STORAGE_KEY, val ? 'true' : 'false');
  updateToggleUI();
}

function updateToggleUI() {
  const toggle  = document.getElementById('notif-toggle');
  const label   = document.getElementById('notif-toggle-label');
  if (!toggle) return;
  const enabled = isEnabled();
  const denied  = Notification.permission === 'denied';
  toggle.checked = enabled && !denied;
  if (label) label.textContent = denied ? 'Blocked in settings' : enabled ? 'On' : 'Off';
  toggle.disabled = denied;
}

// ── Core: subscribe and save ───────────────────────────────────────
async function subscribe() {
  if (!isSupported()) throw new Error('Push notifications not supported on this device.');

  // 1. Register SW
  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js');
  } catch(e) {
    throw new Error('Service worker failed to register: ' + e.message);
  }

  // 2. Wait for activation
  try {
    reg = await waitForActivation(reg);
  } catch(e) {
    throw new Error('Service worker did not activate: ' + e.message);
  }

  // 3. Request permission if needed
  if (Notification.permission !== 'granted') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') throw new Error('Permission not granted.');
  }

  // 4. Create or retrieve push subscription
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  // 5. Save to Supabase
  const db = await waitForSupabase();
  const json = sub.toJSON();
  const { error } = await db.from('push_subscriptions').upsert({
    endpoint:   json.endpoint,
    p256dh:     json.keys.p256dh,
    auth:       json.keys.auth,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });

  if (error) throw new Error('Failed to save subscription: ' + error.message);
  return sub;
}

// ── Core: unsubscribe and delete ───────────────────────────────────
async function unsubscribe() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('./sw.js');
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        // Remove from Supabase
        try {
          const db = await waitForSupabase();
          await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
        } catch(e) { /* non-critical */ }
      }
    }
  } catch(e) {
    console.warn('Unsubscribe error:', e.message);
  }
}

// ── Silent re-subscribe on login (keeps Supabase up to date) ───────
async function silentResync() {
  if (!isEnabled() || !isSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    await subscribe();
  } catch(e) {
    console.warn('Silent resync failed:', e.message);
  }
}

// ── Toggle handler ─────────────────────────────────────────────────
async function handleToggle(checked) {
  const label = document.getElementById('notif-toggle-label');

  if (checked) {
    if (label) label.textContent = 'Enabling…';
    try {
      await subscribe();
      setEnabled(true);
      showNotifStatus('Notifications enabled. First reminder at 6:43PM.', false);
    } catch(e) {
      setEnabled(false);
      showNotifStatus('Could not enable: ' + e.message, true);
    }
  } else {
    if (label) label.textContent = 'Disabling…';
    await unsubscribe();
    setEnabled(false);
    showNotifStatus('Notifications disabled.', false);
  }
}

function showNotifStatus(msg, isError) {
  const el = document.getElementById('notif-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#e8a09a' : '#74c69d';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Init: called once DOM is ready ────────────────────────────────
async function init() {
  if (!isSupported()) {
    const row = document.getElementById('notif-settings-row');
    if (row) row.style.display = 'none';
    return;
  }

  updateToggleUI();

  const toggle = document.getElementById('notif-toggle');
  if (toggle) {
    toggle.addEventListener('change', e => handleToggle(e.target.checked));
  }

  // Silently resync subscription in background — doesn't block anything
  setTimeout(silentResync, 3000);
}

document.addEventListener('DOMContentLoaded', init);
