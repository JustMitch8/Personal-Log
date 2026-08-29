'use strict';

// daily-notification.js
// Runs at 7PM Melbourne via GitHub Actions.
// Fetches push subscriptions from Supabase and sends Web Push notifications.

const { createClient } = require('@supabase/supabase-js');
const ws               = require('ws');
const webpush          = require('web-push');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON     = process.env.SUPABASE_ANON;
const SUPABASE_EMAIL    = process.env.SUPABASE_EMAIL;
const SUPABASE_PASSWORD = process.env.SUPABASE_PASSWORD;
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL       = 'mailto:justin.mitchell.assist@gmail.com';

const EXCLUDED = new Set(['message', 'birthday-acknowledgment']);

// ── Helpers ────────────────────────────────────────────────────────
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function toISO(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
}
function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names.slice(0,-1).join(', ') + ' and ' + names[names.length-1];
}
function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  return function() {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

// ── Melbourne today ────────────────────────────────────────────────
function melbourneToday() {
  const now  = new Date();
  const tz   = 'Australia/Melbourne';
  const year  = +new Intl.DateTimeFormat('en-AU', { timeZone: tz, year:  'numeric' }).format(now);
  const month = +new Intl.DateTimeFormat('en-AU', { timeZone: tz, month: 'numeric' }).format(now);
  const day   = +new Intl.DateTimeFormat('en-AU', { timeZone: tz, day:   'numeric' }).format(now);
  return new Date(year, month - 1, day);
}

// ── Supabase ───────────────────────────────────────────────────────
async function fetchData() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, { realtime: { transport: ws } });

  let authErr;
  for (const delay of [2000, 5000, 10000]) {
    await new Promise(r => setTimeout(r, delay));
    const result = await supabase.auth.signInWithPassword({
      email: SUPABASE_EMAIL, password: SUPABASE_PASSWORD,
    });
    if (!result.error) { authErr = null; break; }
    authErr = result.error;
    console.log(`Auth retry: ${authErr.message}`);
  }
  if (authErr) throw new Error('Auth failed: ' + authErr.message);

  const [
    { data: people,        error: e1 },
    { data: encounters,    error: e2 },
    { data: participants,  error: e3 },
    { data: subscriptions, error: e4 },
  ] = await Promise.all([
    supabase.from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays'),
    supabase.from('encounters').select('id,date,type').order('date', { ascending: false }),
    supabase.from('encounter_participants').select('encounterid,personid'),
    supabase.from('push_subscriptions').select('endpoint,p256dh,auth'),
  ]);

  if (e1||e2||e3||e4) throw new Error('Fetch failed: ' + (e1||e2||e3||e4).message);
  return { people, encounters, participants, subscriptions };
}

// ── Build notification content ─────────────────────────────────────
function buildNotification(people, encounters, participants, today) {
  const todayISO = toISO(today);
  const suffix   = 'Tap to log today\'s encounters.';

  const encPartsMap  = {};
  const personEncsMap = {};
  const encMap       = Object.fromEntries(encounters.map(e => [e.id, e]));

  participants.forEach(({ encounterid, personid }) => {
    if (!encPartsMap[encounterid])  encPartsMap[encounterid]  = [];
    if (!personEncsMap[personid])   personEncsMap[personid]   = [];
    encPartsMap[encounterid].push(personid);
    personEncsMap[personid].push(encounterid);
  });

  // ── PRIORITY 1: Birthdays tomorrow
  const tomorrow = addDays(today, 1);
  const bdPeople = people.filter(p =>
    p.birthday_month && p.birthday_day &&
    p.birthday_month === (tomorrow.getMonth()+1) &&
    p.birthday_day   === tomorrow.getDate()
  );
  if (bdPeople.length) {
    const names = listNames(bdPeople.map(p => p.name));
    const verb  = bdPeople.length === 1 ? 'has' : 'have';
    return {
      title: '🎂 Birthday tomorrow',
      body:  `${names} ${verb} their birthday tomorrow. ${suffix}`,
    };
  }

  // ── Build stat pool
  const qualEncs = encounters.filter(e => !EXCLUDED.has(e.type));
  const stats    = [];

  const last7Start      = toISO(addDays(today, -7));
  const prev7Start      = toISO(addDays(today, -14));
  const prev7End        = toISO(addDays(today, -8));
  const monthStart      = toISO(new Date(today.getFullYear(), today.getMonth(), 1));
  const lastMonthStart  = toISO(new Date(today.getFullYear(), today.getMonth()-1, 1));
  const lastMonthSameDay= toISO(new Date(today.getFullYear(), today.getMonth()-1, today.getDate()));

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

  // 1. Overdue contact
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
    const rng2   = seededRandom(todayISO + 'overdue');
    const picked = overduePool[Math.floor(rng2() * overduePool.length)];
    stats.push(`It's been ${picked.daysSince} days since you saw ${picked.name}.`);
  }

  // 2–4. Last 7 vs prev 7
  const actLast7 = countAppearances(last7Start, todayISO);
  const actPrev7 = countAppearances(prev7Start, prev7End);
  if (actPrev7 > 0) {
    const pct = Math.round(((actLast7 - actPrev7) / actPrev7) * 100);
    stats.push(`Social activity is ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct)}% from last week.`);
  }

  const uqLast7 = countUnique(last7Start, todayISO);
  const uqPrev7 = countUnique(prev7Start, prev7End);
  if (uqPrev7 > 0) {
    const pct = Math.round(((uqLast7 - uqPrev7) / uqPrev7) * 100);
    stats.push(`Unique people seen is ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct)}% from last week.`);
  }

  const encLast7 = countEncs(last7Start, todayISO);
  const encPrev7 = countEncs(prev7Start, prev7End);
  if (encPrev7 > 0) {
    const pct = Math.round(((encLast7 - encPrev7) / encPrev7) * 100);
    stats.push(`Encounters are ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct)}% from last week.`);
  }

  // 5–7. Month-to-date vs same day last month
  const encThisMonth      = countEncs(monthStart, todayISO);
  const encLastMonthSame  = countEncs(lastMonthStart, lastMonthSameDay);
  if (encLastMonthSame > 0) {
    const diff = encThisMonth - encLastMonthSame;
    stats.push(`You're ${Math.abs(diff)} encounter${Math.abs(diff)!==1?'s':''} ${diff>=0?'ahead of':'behind'} where you were this time last month.`);
  }

  const uqThisMonth      = countUnique(monthStart, todayISO);
  const uqLastMonthSame  = countUnique(lastMonthStart, lastMonthSameDay);
  if (uqLastMonthSame > 0) {
    const diff = uqThisMonth - uqLastMonthSame;
    stats.push(`You've seen ${Math.abs(diff)} ${diff>=0?'more':'fewer'} unique people than this time last month.`);
  }

  const actThisMonth     = countAppearances(monthStart, todayISO);
  const actLastMonthSame = countAppearances(lastMonthStart, lastMonthSameDay);
  if (actLastMonthSame > 0) {
    const diff = actThisMonth - actLastMonthSame;
    stats.push(`Social activity is ${Math.abs(diff)} ${diff>=0?'ahead of':'behind'} where it was this time last month.`);
  }

  if (!stats.length) {
    return { title: 'Personal Log', body: `Time to log today's encounters. ${suffix}` };
  }

  const rng    = seededRandom(todayISO);
  const picked = stats[Math.floor(rng() * stats.length)];
  return { title: 'Personal Log 📊', body: `${picked} ${suffix}` };
}

// ── Send Web Push ──────────────────────────────────────────────────
async function sendPushNotifications(subscriptions, payload) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 3600 } // deliver within 1 hour or drop
      )
    )
  );

  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`Sent: ${sent}, Failed: ${failed}`);
  results.filter(r => r.status === 'rejected').forEach(r => console.warn('Push failed:', r.reason?.message));
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching data...');
  const { people, encounters, participants, subscriptions } = await fetchData();

  if (!subscriptions.length) {
    console.log('No push subscriptions found — nothing to send.');
    return;
  }

  const today   = melbourneToday();
  const payload = buildNotification(people, encounters, participants, today);
  console.log(`Notification: "${payload.title}" — "${payload.body}"`);

  await sendPushNotifications(subscriptions, payload);
  console.log('Done.');
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
