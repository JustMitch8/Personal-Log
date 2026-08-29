// notifications.js
// Registers the service worker and schedules a daily 7PM Melbourne notification.
// Loaded as a module from index.html.

const NOTIF_TAG = 'pl-daily-reminder';

// ── Register service worker ────────────────────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return false;
  try {
    await navigator.serviceWorker.register('./sw.js');
    return true;
  } catch(e) {
    console.warn('SW registration failed:', e);
    return false;
  }
}

// ── Request permission and show enable button ──────────────────────
export async function initNotifications() {
  const supported = await registerSW();
  if (!supported) return;

  // Show enable button if permission not yet granted
  const btn = document.getElementById('notif-enable-btn');
  if (!btn) return;

  if (Notification.permission === 'granted') {
    btn.style.display = 'none';
    scheduleDaily();
  } else if (Notification.permission === 'denied') {
    btn.style.display = 'none';
  } else {
    btn.style.display = 'block';
    btn.addEventListener('click', async () => {
      const result = await Notification.requestPermission();
      btn.style.display = 'none';
      if (result === 'granted') scheduleDaily();
    });
  }
}

// ── Schedule notification at next 7PM Melbourne ────────────────────
async function scheduleDaily() {
  const sw = await navigator.serviceWorker.ready;
  const msUntil = msUntil7PMMelbourne();
  if (msUntil <= 0) return; // already past 7PM today, skip until tomorrow

  const { title, body } = await buildNotification();

  sw.active.postMessage({
    type: 'SCHEDULE_NOTIFICATION',
    payload: { msUntil, title, body, tag: NOTIF_TAG },
  });
}

function msUntil7PMMelbourne() {
  // Compute ms until 7PM in Melbourne timezone
  const now = new Date();
  const melb = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const h = +melb.find(p=>p.type==='hour').value;
  const m = +melb.find(p=>p.type==='minute').value;
  const sc= +melb.find(p=>p.type==='second').value;

  const secondsNow  = h*3600 + m*60 + sc;
  const seconds7PM  = 19*3600;
  const diff        = seconds7PM - secondsNow;

  return diff > 0 ? diff * 1000 : -1;
}

// ── Build notification content ─────────────────────────────────────
async function buildNotification() {
  const suffix = 'Tap to log today\'s encounters.';

  // Need supabase — wait for it to be available
  const db = window._plSupabase;
  if (!db) return { title: 'Personal Log', body: `Time to log today\'s encounters. ${suffix}` };

  try {
    const [
      { data: people },
      { data: encounters },
      { data: participants },
    ] = await Promise.all([
      db.from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays'),
      db.from('encounters').select('id,date,type').order('date', { ascending: false }),
      db.from('encounter_participants').select('encounterid,personid'),
    ]);

    if (!people || !encounters || !participants) throw new Error('No data');

    const encPartsMap = {};
    const personEncsMap = {};
    participants.forEach(({ encounterid, personid }) => {
      if (!encPartsMap[encounterid]) encPartsMap[encounterid] = [];
      encPartsMap[encounterid].push(personid);
      if (!personEncsMap[personid]) personEncsMap[personid] = [];
      personEncsMap[personid].push(encounterid);
    });
    const encMap = Object.fromEntries(encounters.map(e => [e.id, e]));

    const today = new Date(); today.setHours(0,0,0,0);
    const todayISO = toISO(today);

    // ── PRIORITY 1: Birthdays tomorrow
    const tomorrow = addDays(today, 1);
    const birthdayPeople = people.filter(p => {
      if (!p.birthday_month || !p.birthday_day) return false;
      return p.birthday_month === (tomorrow.getMonth()+1) && p.birthday_day === tomorrow.getDate();
    });

    if (birthdayPeople.length) {
      const names = listNames(birthdayPeople.map(p => p.name));
      const verb  = birthdayPeople.length === 1 ? 'has' : 'have';
      return {
        title: '🎂 Birthday tomorrow',
        body:  `${names} ${verb} their birthday tomorrow. ${suffix}`,
      };
    }

    // ── Build stat pool and pick randomly based on today's date seed
    const stats = await buildStatPool(people, encounters, participants, encPartsMap, personEncsMap, encMap, today, todayISO);
    if (!stats.length) return { title: 'Personal Log', body: `Time to log today\'s encounters. ${suffix}` };

    // Seeded pick — different each day, consistent within day
    const rng = seededRandom(todayISO);
    const picked = stats[Math.floor(rng() * stats.length)];

    return { title: 'Personal Log 📊', body: `${picked} ${suffix}` };

  } catch(e) {
    return { title: 'Personal Log', body: `Time to log today\'s encounters. ${suffix}` };
  }
}

async function buildStatPool(people, encounters, participants, encPartsMap, personEncsMap, encMap, today, todayISO) {
  const stats = [];
  const EXCLUDED = new Set(['message','birthday-acknowledgment']);

  const qualEncs = encounters.filter(e => !EXCLUDED.has(e.type));
  const qualMap  = Object.fromEntries(qualEncs.map(e => [e.id, e]));

  // Date helpers
  const last7Start  = toISO(addDays(today, -7));
  const prev7Start  = toISO(addDays(today, -14));
  const prev7End    = toISO(addDays(today, -8));
  const monthStart  = toISO(new Date(today.getFullYear(), today.getMonth(), 1));
  const lastMonthStart = toISO(new Date(today.getFullYear(), today.getMonth()-1, 1));
  const lastMonthSameDay = toISO(new Date(today.getFullYear(), today.getMonth()-1, today.getDate()));

  function countEncs(from, to) {
    return qualEncs.filter(e => e.date >= from && e.date <= to).length;
  }
  function countUnique(from, to) {
    const s = new Set();
    qualEncs.filter(e => e.date >= from && e.date <= to)
      .forEach(e => (encPartsMap[e.id]||[]).forEach(pid => s.add(pid)));
    return s.size;
  }
  function countAppearances(from, to) {
    let n = 0;
    qualEncs.filter(e => e.date >= from && e.date <= to)
      .forEach(e => { n += (encPartsMap[e.id]||[]).length; });
    return n;
  }

  // 1. "It's been X days since you saw ____"
  // Pick randomly from significantly overdue people (ratio > 2x, has interval)
  const overduePool = people.filter(p => {
    if (!p.contactintervaldays) return false;
    const dates = (personEncsMap[p.id]||[]).map(id => encMap[id]?.date).filter(Boolean).sort().reverse();
    if (!dates.length) return false;
    const daysSince = Math.round((today - new Date(dates[0]+'T00:00:00')) / 86400000);
    return (daysSince / p.contactintervaldays) >= 2;
  }).map(p => {
    const dates = (personEncsMap[p.id]||[]).map(id => encMap[id]?.date).filter(Boolean).sort().reverse();
    const daysSince = Math.round((today - new Date(dates[0]+'T00:00:00')) / 86400000);
    return { name: p.name, daysSince };
  });

  if (overduePool.length) {
    const rng2 = seededRandom(todayISO + 'overdue');
    const picked = overduePool[Math.floor(rng2() * overduePool.length)];
    stats.push(`It's been ${picked.daysSince} days since you saw ${picked.name}.`);
  }

  // 2. Social activity up/down last 7 vs prev 7
  const actLast7 = countAppearances(last7Start, todayISO);
  const actPrev7 = countAppearances(prev7Start, prev7End);
  if (actPrev7 > 0) {
    const pct = Math.round(((actLast7 - actPrev7) / actPrev7) * 100);
    const dir = pct >= 0 ? 'up' : 'down';
    stats.push(`Social activity is ${dir} ${Math.abs(pct)}% from last week.`);
  }

  // 3. Unique people up/down last 7 vs prev 7
  const uqLast7 = countUnique(last7Start, todayISO);
  const uqPrev7 = countUnique(prev7Start, prev7End);
  if (uqPrev7 > 0) {
    const pct = Math.round(((uqLast7 - uqPrev7) / uqPrev7) * 100);
    const dir = pct >= 0 ? 'up' : 'down';
    stats.push(`Unique people seen is ${dir} ${Math.abs(pct)}% from last week.`);
  }

  // 4. Encounters up/down last 7 vs prev 7
  const encLast7 = countEncs(last7Start, todayISO);
  const encPrev7 = countEncs(prev7Start, prev7End);
  if (encPrev7 > 0) {
    const pct = Math.round(((encLast7 - encPrev7) / encPrev7) * 100);
    const dir = pct >= 0 ? 'up' : 'down';
    stats.push(`Encounters are ${dir} ${Math.abs(pct)}% from last week.`);
  }

  // 5. Cumulative encounters vs same point last month
  const encThisMonth     = countEncs(monthStart, todayISO);
  const encLastMonthSame = countEncs(lastMonthStart, lastMonthSameDay);
  if (encLastMonthSame > 0) {
    const diff = encThisMonth - encLastMonthSame;
    const dir  = diff >= 0 ? 'ahead' : 'behind';
    stats.push(`You're ${Math.abs(diff)} encounter${Math.abs(diff)!==1?'s':''} ${dir} of where you were this time last month.`);
  }

  // 6. Cumulative unique people vs same point last month
  const uqThisMonth     = countUnique(monthStart, todayISO);
  const uqLastMonthSame = countUnique(lastMonthStart, lastMonthSameDay);
  if (uqLastMonthSame > 0) {
    const diff = uqThisMonth - uqLastMonthSame;
    const dir  = diff >= 0 ? 'ahead' : 'behind';
    stats.push(`You've seen ${Math.abs(diff)} ${diff>=0?'more':'fewer'} unique people than this time last month.`);
  }

  // 7. Social activity vs same point last month
  const actThisMonth     = countAppearances(monthStart, todayISO);
  const actLastMonthSame = countAppearances(lastMonthStart, lastMonthSameDay);
  if (actLastMonthSame > 0) {
    const diff = actThisMonth - actLastMonthSame;
    const dir  = diff >= 0 ? 'ahead' : 'behind';
    stats.push(`Social activity is ${Math.abs(diff)} ${dir} of where it was this time last month.`);
  }

  return stats;
}

// ── Helpers ────────────────────────────────────────────────────────
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate()+n); return d; }
function toISO(date) {
  const p = n => String(n).padStart(2,'0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
}
function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names.slice(0,-1).join(', ') + ' and ' + names[names.length-1];
}
function seededRandom(seed) {
  let h = 0;
  for (let i=0;i<seed.length;i++) h = Math.imul(31,h)+seed.charCodeAt(i)|0;
  return function(){
    h = Math.imul(h^(h>>>16),0x45d9f3b)|0;
    h = Math.imul(h^(h>>>16),0x45d9f3b)|0;
    return ((h^(h>>>16))>>>0)/4294967296;
  };
}
