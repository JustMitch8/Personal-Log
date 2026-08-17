'use strict';

// ─────────────────────────────────────────────────────────────────
//  Personal Log — Daily Contact Brief
//  Runs in GitHub Actions, sends PDF report via Gmail SMTP.
// ─────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const nodemailer       = require('nodemailer');
const puppeteer        = require('puppeteer');

// ── Config ────────────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON     = process.env.SUPABASE_ANON;
const SUPABASE_EMAIL    = process.env.SUPABASE_EMAIL;
const SUPABASE_PASSWORD = process.env.SUPABASE_PASSWORD;
const SMTP_USER         = process.env.SMTP_USER;
const SMTP_PASSWORD     = process.env.SMTP_PASSWORD;
const RECIPIENT         = process.env.RECIPIENT_EMAIL;

// ── Melbourne "now" ───────────────────────────────────────────────
// Node's Intl handles AEDT/AEST automatically via the timezone name.
function melbourneNow() {
  const now    = new Date();
  const locale = 'en-AU';
  const tz     = 'Australia/Melbourne';

  const year  = +new Intl.DateTimeFormat(locale,{timeZone:tz,year:'numeric'}).format(now);
  const month = +new Intl.DateTimeFormat(locale,{timeZone:tz,month:'numeric'}).format(now);
  const day   = +new Intl.DateTimeFormat(locale,{timeZone:tz,day:'numeric'}).format(now);

  // Return a plain local-date object — no UTC confusion
  return { year, month, day, date: new Date(year, month-1, day) };
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toISO(date) {
  const p = n => String(n).padStart(2,'0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
}

function dayName(date) {
  return date.toLocaleDateString('en-AU', { weekday:'long' });
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-AU', {
    weekday:'long', day:'numeric', month:'long', year:'numeric'
  });
}

function formatDateShort(date) {
  return date.toLocaleDateString('en-AU', { day:'numeric', month:'long' });
}

// ── Supabase auth + query ─────────────────────────────────────────
async function fetchData() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

  const { error: authError } = await supabase.auth.signInWithPassword({
    email: SUPABASE_EMAIL, password: SUPABASE_PASSWORD
  });
  if (authError) throw new Error('Supabase auth failed: ' + authError.message);

  const [
    { data: people,       error: e1 },
    { data: encounters,   error: e2 },
    { data: participants, error: e3 },
  ] = await Promise.all([
    supabase.from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays,firstmet'),
    supabase.from('encounters').select('id,date,type,description').order('date', { ascending: false }),
    supabase.from('encounter_participants').select('encounterid,personid'),
  ]);

  if (e1||e2||e3) throw new Error(`Data fetch failed: ${(e1||e2||e3).message}`);

  return { people, encounters, participants };
}

// ── Birthday logic ────────────────────────────────────────────────
function birthdaySection(people, today) {
  const { year: todayYear, month: todayMonth, day: todayDay, date: todayDate } = today;

  // For each person with at least month+day, compute next occurrence this year or next
  const withBirthday = people
    .filter(p => p.birthday_month && p.birthday_day)
    .map(p => {
      let nextDate = new Date(todayYear, p.birthday_month - 1, p.birthday_day);
      // If already passed this year, use next year
      if (nextDate < todayDate) nextDate = new Date(todayYear + 1, p.birthday_month - 1, p.birthday_day);

      const daysUntil = Math.round((nextDate - todayDate) / 86400000);

      let ageStr = '';
      if (p.birthday_year) {
        const turningAge = nextDate.getFullYear() - p.birthday_year;
        ageStr = `turning ${turningAge}`;
      } else {
        ageStr = 'age unknown';
      }

      return { ...p, nextDate, daysUntil, ageStr };
    })
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const todayGroup   = withBirthday.filter(p => p.daysUntil === 0);
  const weekGroup    = withBirthday.filter(p => p.daysUntil > 0 && p.daysUntil <= 7);
  const remaining    = withBirthday.filter(p => p.daysUntil > 7);
  const nextGroup    = remaining.slice(0, 3);

  return { todayGroup, weekGroup, nextGroup, hasAny: withBirthday.length > 0 };
}

// ── Worth catching up with ────────────────────────────────────────
function catchupSection(people, encounters, participants, today) {
  const EXCLUDED = new Set(['message','birthday-acknowledgment']);
  const todayDate = today.date;

  // Build last-encounter date per person
  const partMap = {};
  participants.forEach(({ encounterid, personid }) => {
    if (!partMap[personid]) partMap[personid] = [];
    partMap[personid].push(encounterid);
  });

  const encDateMap = Object.fromEntries(
    encounters
      .filter(e => !EXCLUDED.has(e.type))
      .map(e => [e.id, e.date])
  );

  // Compute per-person stats
  const scored = people.map(person => {
    const encIds = (partMap[person.id] || []).filter(id => encDateMap[id]);
    const dates  = encIds.map(id => encDateMap[id]).sort().reverse(); // newest first

    const lastDateStr  = dates[0] || null;
    const lastDate     = lastDateStr ? new Date(lastDateStr) : null;
    const daysSince    = lastDate
      ? Math.round((todayDate - new Date(lastDateStr+'T00:00:00')) / 86400000)
      : null;

    // Expected interval
    let expectedDays  = null;
    let expectedLabel = null;
    let isInferred    = false;

    if (person.contactintervaldays) {
      expectedDays  = person.contactintervaldays;
      expectedLabel = `Expected ${expectedDays} days`;
      isInferred    = false;
    } else if (dates.length >= 2) {
      // Infer from average gap between last 10 encounters
      const recent = dates.slice(0, 10);
      let totalGap = 0, count = 0;
      for (let i = 0; i < recent.length - 1; i++) {
        const gap = Math.round(
          (new Date(recent[i]+'T00:00:00') - new Date(recent[i+1]+'T00:00:00')) / 86400000
        );
        if (gap > 0) { totalGap += gap; count++; }
      }
      if (count > 0) {
        expectedDays  = Math.round(totalGap / count);
        expectedLabel = `Expected ~${expectedDays} days`;
        isInferred    = true;
      }
    }

    // Score: ratio of days since last contact to expected interval
    // Higher = more overdue. People with no expected interval scored lower.
    let score = 0;
    if (daysSince !== null && expectedDays) {
      score = daysSince / expectedDays;
    } else if (daysSince !== null) {
      score = daysSince / 365; // normalise by year if no interval
    }

    return { person, daysSince, expectedLabel, expectedDays, score, lastDateStr };
  });

  // Sort by score descending, take top 3
  const top = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return top;
}

// ── Yesterday section ─────────────────────────────────────────────
function yesterdaySection(encounters, participants, people, today) {
  const yesterday     = toISO(addDays(today.date, -1));
  const yEncounters   = encounters.filter(e => e.date === yesterday);

  if (!yEncounters.length) return { hadEncounters: false };

  const personMap = Object.fromEntries(people.map(p => [p.id, p.name]));
  const yIds      = new Set(yEncounters.map(e => e.id));

  const yParts = participants.filter(p => yIds.has(p.encounterid));
  const peopleNames = [...new Set(yParts.map(p => personMap[p.personid]).filter(Boolean))].sort();

  // Count by type
  const typeCounts = {};
  yEncounters.forEach(e => {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  });

  const TYPE_LABELS = {
    'call':'Call','1-on-1':'1-on-1','small-group':'Small group',
    'large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'
  };

  const typeStr = Object.entries(typeCounts)
    .map(([type, count]) => `${count} × ${TYPE_LABELS[type] || type}`)
    .join(' · ');

  return {
    hadEncounters: true,
    count:         yEncounters.length,
    peopleCount:   peopleNames.length,
    typeStr,
    peopleNames,
  };
}

// ── HTML template ─────────────────────────────────────────────────
function buildHTML(today, birthdays, catchup, yesterday) {
  const dateStr = formatDateLong(today.date);

  // ── Birthday HTML
  let bdHTML = '';

  if (birthdays.todayGroup.length) {
    bdHTML += `<div class="subhead">Today</div>`;
    birthdays.todayGroup.forEach(p => {
      bdHTML += `<div class="row"><span class="name">${esc(p.name)}</span><span class="detail">${p.ageStr}</span></div>`;
    });
  }

  if (birthdays.weekGroup.length) {
    bdHTML += `<div class="subhead">This week</div>`;
    birthdays.weekGroup.forEach(p => {
      const dow = dayName(p.nextDate);
      bdHTML += `<div class="row"><span class="name">${esc(p.name)}</span><span class="detail">${dow} · ${p.ageStr}</span></div>`;
    });
  } else if (!birthdays.todayGroup.length) {
    bdHTML += `<div class="empty-note">No birthdays in the next 7 days.</div>`;
  }

  if (birthdays.nextGroup.length) {
    bdHTML += `<div class="subhead">Next birthdays</div>`;
    birthdays.nextGroup.forEach(p => {
      const dateShort = formatDateShort(p.nextDate);
      bdHTML += `<div class="row"><span class="name">${esc(p.name)}</span><span class="detail">${dateShort} · ${p.ageStr}</span></div>`;
    });
  }

  if (!birthdays.hasAny) {
    bdHTML = `<div class="empty-note">No birthday information recorded for any contacts.</div>`;
  }

  // ── Catchup HTML
  let cuHTML = '';
  if (!catchup.length) {
    cuHTML = `<div class="empty-note">No contact frequency data available yet.</div>`;
  } else {
    catchup.forEach(({ person, daysSince, expectedLabel }) => {
      const lastStr = daysSince === null
        ? 'Never recorded'
        : daysSince === 0 ? 'Seen today'
        : daysSince === 1 ? 'Last seen yesterday'
        : `Last seen ${daysSince} days ago`;
      cuHTML += `
        <div class="person-row">
          <div class="person-name">${esc(person.name)}</div>
          <div class="person-detail">${lastStr}${expectedLabel ? ' · ' + expectedLabel : ''}</div>
        </div>`;
    });
  }

  // ── Yesterday HTML
  let ydHTML = '';
  if (!yesterday.hadEncounters) {
    ydHTML = `<div class="empty-note">No encounters recorded yesterday.</div>`;
  } else {
    ydHTML = `
      <div class="yesterday-stat">${yesterday.count} encounter${yesterday.count!==1?'s':''} · ${yesterday.peopleCount} ${yesterday.peopleCount!==1?'people':'person'}</div>
      <div class="yesterday-types">${yesterday.typeStr}</div>
      <div class="yesterday-people">${yesterday.peopleNames.map(n=>esc(n)).join(', ')}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
    padding: 48px 52px;
    font-size: 13px;
    line-height: 1.6;
  }

  /* Header */
  .header {
    margin-bottom: 36px;
    padding-bottom: 20px;
    border-bottom: 2px solid #0D1B2A;
  }
  .header-brand {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #8A9BAC;
    margin-bottom: 6px;
  }
  .header-date {
    font-size: 22px;
    font-weight: 700;
    color: #0D1B2A;
    letter-spacing: -0.02em;
  }

  /* Section */
  .section {
    margin-bottom: 32px;
  }
  .section-title {
    font-size: 15px;
    font-weight: 700;
    color: #0D1B2A;
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .section-title .emoji {
    font-size: 16px;
  }

  /* Subheadings inside sections */
  .subhead {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #8A9BAC;
    margin: 12px 0 6px;
  }
  .subhead:first-child { margin-top: 0; }

  /* Birthday rows */
  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 4px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .row:last-child { border-bottom: none; }
  .name   { font-weight: 600; color: #0D1B2A; }
  .detail { color: #4A5B6E; font-size: 12px; }

  /* Catchup rows */
  .person-row {
    padding: 8px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .person-row:last-child { border-bottom: none; }
  .person-name   { font-weight: 700; color: #0D1B2A; margin-bottom: 2px; }
  .person-detail { color: #4A5B6E; font-size: 12px; }

  /* Yesterday */
  .yesterday-stat   { font-weight: 700; color: #0D1B2A; margin-bottom: 3px; }
  .yesterday-types  { color: #4A5B6E; font-size: 12px; margin-bottom: 3px; }
  .yesterday-people { color: #8A9BAC; font-size: 11px; font-style: italic; }

  /* Empty state */
  .empty-note {
    color: #8A9BAC;
    font-style: italic;
    font-size: 12px;
    padding: 4px 0;
  }

  /* Divider between sections */
  .section + .section {
    padding-top: 4px;
  }

  /* Footer */
  .footer {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid #e8e8e8;
    font-size: 10px;
    color: #c0c0c0;
    text-align: center;
  }
</style>
</head>
<body>

  <div class="header">
    <div class="header-brand">Personal Log · Daily Brief</div>
    <div class="header-date">${dateStr}</div>
  </div>

  <div class="section">
    <div class="section-title"><span class="emoji">🎂</span> Birthdays</div>
    ${bdHTML}
  </div>

  <div class="section">
    <div class="section-title"><span class="emoji">👋</span> Worth Catching Up With</div>
    ${cuHTML}
  </div>

  <div class="section">
    <div class="section-title"><span class="emoji">📊</span> Yesterday</div>
    ${ydHTML}
  </div>

  <div class="footer">
    Generated by Personal Log · ${new Date().toISOString().split('T')[0]}
  </div>

</body>
</html>`;
}

function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Generate PDF via Puppeteer ────────────────────────────────────
async function generatePDF(html) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdf = await page.pdf({
    format:            'A4',
    printBackground:   true,
    margin: { top:'0', right:'0', bottom:'0', left:'0' },
  });

  await browser.close();
  return pdf;
}

// ── Send email ────────────────────────────────────────────────────
async function sendEmail(pdfBuffer, dateStr) {
  const transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from:        '"Personal Log" <justin.mitchell.assist@gmail.com>',
    to:          RECIPIENT,
    subject:     `Daily Brief · ${dateStr}`,
    text:        `Your Personal Log daily brief for ${dateStr} is attached.`,
    attachments: [{
      filename:    `brief-${dateStr}.pdf`,
      content:     pdfBuffer,
      contentType: 'application/pdf',
    }],
  });
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching data from Supabase...');
  const { people, encounters, participants } = await fetchData();

  const today     = melbourneNow();
  const dateStr   = toISO(today.date);
  console.log(`Generating brief for Melbourne date: ${dateStr}`);

  const birthdays  = birthdaySection(people, today);
  const catchup    = catchupSection(people, encounters, participants, today);
  const yesterday  = yesterdaySection(encounters, participants, people, today);

  const html = buildHTML(today, birthdays, catchup, yesterday);

  console.log('Generating PDF...');
  const pdf = await generatePDF(html);

  console.log('Sending email...');
  await sendEmail(pdf, dateStr);

  console.log('Daily brief sent successfully.');
}

main().catch(err => {
  console.error('Daily brief failed:', err.message);
  process.exit(1);
});
