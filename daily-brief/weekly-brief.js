'use strict';

// ─────────────────────────────────────────────────────────────────
//  Personal Log — Weekly Contact Report
//  Runs every Friday at 5PM Melbourne via GitHub Actions.
// ─────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const ws               = require('ws');
const nodemailer       = require('nodemailer');
const puppeteer        = require('puppeteer');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON     = process.env.SUPABASE_ANON;
const SUPABASE_EMAIL    = process.env.SUPABASE_EMAIL;
const SUPABASE_PASSWORD = process.env.SUPABASE_PASSWORD;
const SMTP_USER         = process.env.SMTP_USER;
const SMTP_PASSWORD     = process.env.SMTP_PASSWORD;
const RECIPIENT         = process.env.RECIPIENT_EMAIL;

const TYPE_LABELS = {
  'call':'Call','1-on-1':'1-on-1','small-group':'Small group',
  'large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'
};
const EXCLUDED = new Set(['message','birthday-acknowledgment']);

// ── Date helpers ──────────────────────────────────────────────────
function melbourneNow() {
  const now = new Date();
  const tz  = 'Australia/Melbourne';
  const year  = +new Intl.DateTimeFormat('en-AU',{timeZone:tz,year:'numeric'}).format(now);
  const month = +new Intl.DateTimeFormat('en-AU',{timeZone:tz,month:'numeric'}).format(now);
  const day   = +new Intl.DateTimeFormat('en-AU',{timeZone:tz,day:'numeric'}).format(now);
  return { year, month, day, date: new Date(year, month-1, day) };
}
function addDays(date, n) { const d=new Date(date); d.setDate(d.getDate()+n); return d; }
function toISO(date) {
  const p=n=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
}
function formatShort(date) {
  return date.toLocaleDateString('en-AU',{day:'numeric',month:'long'});
}
function formatMed(date) {
  return date.toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'});
}
function formatDow(date) {
  return date.toLocaleDateString('en-AU',{weekday:'long'});
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Supabase ──────────────────────────────────────────────────────
async function fetchData() {
  // Small delay to avoid 'JWT issued at future' clock skew errors
  await new Promise(r => setTimeout(r, 3000));
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, { realtime:{ transport:ws } });
  const { error:authErr } = await supabase.auth.signInWithPassword({
    email:SUPABASE_EMAIL, password:SUPABASE_PASSWORD
  });
  if (authErr) throw new Error('Auth failed: '+authErr.message);

  const [
    {data:people,   error:e1},
    {data:encounters,error:e2},
    {data:participants,error:e3},
  ] = await Promise.all([
    supabase.from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays,firstmet,notes'),
    supabase.from('encounters').select('id,date,type,description').order('date',{ascending:false}),
    supabase.from('encounter_participants').select('encounterid,personid'),
  ]);
  if (e1||e2||e3) throw new Error('Data fetch failed: '+((e1||e2||e3).message));
  return { people, encounters, participants };
}

// ── Core data preparation ─────────────────────────────────────────
function prepareData(people, encounters, participants, today) {
  const todayDate  = today.date;
  const weekStart  = addDays(todayDate, -6); // Mon–Sun ending today (Friday)
  const weekStartISO = toISO(weekStart);
  const todayISO   = toISO(todayDate);

  const personMap  = Object.fromEntries(people.map(p=>[p.id,p]));

  // Build participant index
  const encPartsMap = {}; // encounterid -> [personid]
  const personEncsMap = {}; // personid -> [encounterid]
  participants.forEach(({encounterid,personid})=>{
    if (!encPartsMap[encounterid]) encPartsMap[encounterid]=[];
    encPartsMap[encounterid].push(personid);
    if (!personEncsMap[personid]) personEncsMap[personid]=[];
    personEncsMap[personid].push(encounterid);
  });

  // This week's encounters
  const weekEncs = encounters.filter(e=>e.date>=weekStartISO && e.date<=todayISO);
  const weekQualEncs = weekEncs.filter(e=>!EXCLUDED.has(e.type));

  // All qualifying encounters (for history)
  const allQualEncs = encounters.filter(e=>!EXCLUDED.has(e.type));
  const allQualMap  = Object.fromEntries(allQualEncs.map(e=>[e.id,e]));

  // 12-week window for comparisons
  const twelveWeekStart = toISO(addDays(todayDate,-84));
  const prevWeekStart   = toISO(addDays(todayDate,-13));
  const prevWeekEnd     = toISO(addDays(todayDate,-7));
  const twelveWeekEncs  = allQualEncs.filter(e=>e.date>=twelveWeekStart && e.date<weekStartISO);

  return {
    todayDate, weekStart, weekStartISO, todayISO,
    personMap, encPartsMap, personEncsMap,
    weekEncs, weekQualEncs, allQualEncs, allQualMap,
    twelveWeekEncs, prevWeekStart, prevWeekEnd,
    prevWeekEncs: allQualEncs.filter(e=>e.date>=prevWeekStart && e.date<=prevWeekEnd),
  };
}

// ── 1. Hero stats ─────────────────────────────────────────────────
function heroStats(data) {
  const { weekQualEncs, encPartsMap, twelveWeekEncs, prevWeekEncs, weekStartISO, todayISO } = data;

  const weekPeople = new Set();
  weekQualEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>weekPeople.add(pid)));

  const activeDays = new Set(weekQualEncs.map(e=>e.date)).size;

  // 12-week average (11 prior weeks, not counting this week)
  const priorWeeks = 11;
  const avgEncs    = twelveWeekEncs.length / priorWeeks;
  const vsAvg      = avgEncs > 0 ? Math.round(((weekQualEncs.length - avgEncs) / avgEncs) * 100) : null;
  const vsLast     = weekQualEncs.length - prevWeekEncs.length;

  return {
    encounters:  weekQualEncs.length,
    uniquePeople:weekPeople.size,
    activeDays,
    vsAvg,
    vsLast,
  };
}

// ── 2. Encounter mix ──────────────────────────────────────────────
function encounterMix(data) {
  const { weekQualEncs, twelveWeekEncs } = data;

  const weekCounts = {};
  weekQualEncs.forEach(e=>{ weekCounts[e.type]=(weekCounts[e.type]||0)+1; });

  const histCounts = {};
  twelveWeekEncs.forEach(e=>{ histCounts[e.type]=(histCounts[e.type]||0)+1; });

  const total = weekQualEncs.length || 1;
  const histTotal = twelveWeekEncs.length || 1;

  const types = Object.keys(TYPE_LABELS).map(type=>({
    type,
    label:    TYPE_LABELS[type],
    count:    weekCounts[type]||0,
    pct:      Math.round(((weekCounts[type]||0)/total)*100),
    histPct:  Math.round(((histCounts[type]||0)/histTotal)*100),
  })).filter(t=>t.count>0).sort((a,b)=>b.count-a.count);

  return types;
}

// ── 3. People of the week ─────────────────────────────────────────
function peopleOfWeek(data, personMap) {
  const { weekQualEncs, encPartsMap, twelveWeekEncs } = data;

  const counts = {};
  weekQualEncs.forEach(e=>{
    (encPartsMap[e.id]||[]).forEach(pid=>{
      counts[pid]=(counts[pid]||0)+1;
    });
  });

  // 12-week unique people average
  const histPeople = new Set();
  twelveWeekEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>histPeople.add(pid)));
  const histAvgPeople = Math.round(histPeople.size / 11);

  const top = Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([pid,count])=>({ person:personMap[pid], count }))
    .filter(x=>x.person);

  const weekUnique = Object.keys(counts).length;
  const diff = weekUnique - histAvgPeople;

  return { top, weekUnique, histAvgPeople, diff };
}

// ── 4. New connections ────────────────────────────────────────────
function newConnections(data, people, personMap) {
  const { weekQualEncs, encPartsMap, allQualMap, personEncsMap, weekStartISO, todayISO } = data;

  // People whose FIRST ever qualifying encounter was this week
  const newPeople = [];
  people.forEach(person=>{
    const allEncIds = (personEncsMap[person.id]||[]).filter(id=>allQualMap[id]);
    if (!allEncIds.length) return;
    const dates = allEncIds.map(id=>allQualMap[id].date).sort();
    const firstDate = dates[0];
    if (firstDate>=weekStartISO && firstDate<=todayISO) {
      const totalEncs = dates.filter(d=>d>=weekStartISO && d<=todayISO).length;
      newPeople.push({
        person,
        firstDate,
        hadSecond: totalEncs > 1,
      });
    }
  });

  newPeople.sort((a,b)=>a.firstDate.localeCompare(b.firstDate));
  const secondCount = newPeople.filter(p=>p.hadSecond).length;

  return { newPeople, secondCount };
}

// ── 5. Relationship rhythm ────────────────────────────────────────
function relationshipRhythm(people, data) {
  const { allQualMap, personEncsMap, todayDate } = data;

  const scored = people.map(person=>{
    const encIds = (personEncsMap[person.id]||[]).filter(id=>allQualMap[id]);
    const dates  = encIds.map(id=>allQualMap[id].date).sort().reverse();
    if (!dates.length) return null;

    const daysSince = Math.round((todayDate - new Date(dates[0]+'T00:00:00'))/86400000);

    let expectedDays=null, isInferred=false;
    if (person.contactintervaldays) {
      expectedDays=person.contactintervaldays;
    } else if (dates.length>=2) {
      const recent=dates.slice(0,10);
      let gap=0,cnt=0;
      for(let i=0;i<recent.length-1;i++){
        const g=Math.round((new Date(recent[i]+'T00:00:00')-new Date(recent[i+1]+'T00:00:00'))/86400000);
        if(g>0){gap+=g;cnt++;}
      }
      if(cnt>0){expectedDays=Math.round(gap/cnt);isInferred=true;}
    }

    if (!expectedDays) return null;
    const ratio = daysSince/expectedDays;

    return { person, daysSince, expectedDays, isInferred, ratio };
  }).filter(Boolean).sort((a,b)=>b.ratio-a.ratio);

  const overdue50 = scored.filter(s=>s.ratio>1.5).length;
  // Show top 5 by ratio (mix of ahead and behind)
  const display = scored.slice(0,5);

  return { display, overdue50, total: scored.length };
}

// ── 6. Interesting observations ───────────────────────────────────
function interestingObservations(hero, mix, peopleStats, newConns, rhythm, data, people) {
  const insights = [];
  const { weekQualEncs, twelveWeekEncs, encPartsMap } = data;

  // Most social week in N weeks?
  const priorWeekCounts = [];
  for (let w=1;w<=11;w++) {
    const ws2 = toISO(addDays(data.todayDate, -(w*7+6)));
    const we2 = toISO(addDays(data.todayDate, -(w*7)));
    const c = twelveWeekEncs.filter(e=>e.date>=ws2&&e.date<=we2).length;
    priorWeekCounts.push(c);
  }
  const maxPrior = Math.max(...priorWeekCounts,0);
  if (hero.encounters > maxPrior && priorWeekCounts.length>0) {
    insights.push(`Most encounters in the past 12 weeks — ${hero.encounters} this week, ahead of the previous high of ${maxPrior}.`);
  }

  // Unusually high 1-on-1?
  const oneOnOne = mix.find(t=>t.type==='1-on-1');
  if (oneOnOne && oneOnOne.histPct>0 && oneOnOne.pct>oneOnOne.histPct+15) {
    insights.push(`More 1-on-1 time than usual — ${oneOnOne.count} this week (${oneOnOne.pct}%) vs ${oneOnOne.histPct}% over the prior 12 weeks.`);
  }

  // New connection had a second encounter this week
  const stickyNew = newConns.newPeople.filter(p=>p.hadSecond);
  if (stickyNew.length) {
    const names = stickyNew.map(p=>p.person.name).join(' and ');
    insights.push(`A new connection is sticking — ${names} was met for the first time this week and already had a second encounter.`);
  }

  // More unique people than usual
  if (peopleStats.diff>=5) {
    insights.push(`An unusually wide social week — ${hero.uniquePeople} unique people, ${peopleStats.diff} more than the 12-week average.`);
  }

  // Several people significantly overdue
  if (rhythm.overdue50>=5) {
    insights.push(`${rhythm.overdue50} contacts are currently more than 50% beyond their expected contact interval.`);
  }

  return insights.slice(0,3); // cap at 3
}

// ── 7. Moments from the week ──────────────────────────────────────
function momentsFromWeek(data, personMap) {
  const { weekEncs, encPartsMap } = data;

  // Encounters with notes, prefer longer notes
  const withNotes = weekEncs
    .filter(e=>e.description && e.description.trim().length>10)
    .sort((a,b)=>(b.description||'').length-(a.description||'').length)
    .slice(0,3)
    .map(e=>{
      const names=(encPartsMap[e.id]||[])
        .map(pid=>personMap[pid]?.name).filter(Boolean).join(' & ');
      return { date:e.date, type:e.type, names, note:e.description.trim() };
    });

  return withNotes;
}

// ── 8. Week ahead ─────────────────────────────────────────────────
function weekAhead(people, data) {
  const { todayDate, allQualMap, personEncsMap } = data;
  const nextMonday  = addDays(todayDate, 3); // Friday + 3 = Monday
  const nextSunday  = addDays(todayDate, 9);

  // Birthdays next week
  const { year } = { year: nextMonday.getFullYear() };
  const birthdays = people
    .filter(p=>p.birthday_month&&p.birthday_day)
    .map(p=>{
      let next=new Date(nextMonday.getFullYear(),p.birthday_month-1,p.birthday_day);
      if(next<nextMonday) next=new Date(nextMonday.getFullYear()+1,p.birthday_month-1,p.birthday_day);
      const daysUntil=Math.round((next-nextMonday)/86400000);
      return {...p, nextDate:next, daysUntil};
    })
    .filter(p=>p.daysUntil>=0&&p.daysUntil<=6)
    .sort((a,b)=>a.daysUntil-b.daysUntil);

  // People approaching interval
  const approaching = people.map(person=>{
    const encIds=(personEncsMap[person.id]||[]).filter(id=>allQualMap[id]);
    const dates=encIds.map(id=>allQualMap[id].date).sort().reverse();
    if(!dates.length||!person.contactintervaldays) return null;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const daysUntilDue=person.contactintervaldays-daysSince;
    // Due within next 7 days (including already overdue)
    if(daysUntilDue>7) return null;
    return { person, daysUntilDue, daysSince, interval:person.contactintervaldays };
  }).filter(Boolean).sort((a,b)=>a.daysUntilDue-b.daysUntilDue);

  // No encounter despite having interval
  const noRecent = people.filter(person=>{
    if(!person.contactintervaldays) return false;
    const encIds=(personEncsMap[person.id]||[]).filter(id=>allQualMap[id]);
    return encIds.length===0;
  });

  return { birthdays, approaching, noRecent };
}

// ── 9. One year ago ───────────────────────────────────────────────
function oneYearAgo(encounters, participants, personMap, todayDate) {
  const target     = toISO(addDays(todayDate,-365));
  const targetDate = new Date(target);

  // Find encounter closest to one year ago (within ±7 days)
  const candidates = encounters
    .filter(e=>e.description&&e.description.trim().length>10)
    .map(e=>({...e, diff:Math.abs(new Date(e.date)-targetDate)}))
    .filter(e=>e.diff<=7*86400000)
    .sort((a,b)=>a.diff-b.diff);

  if(!candidates.length) return null;

  const enc=candidates[0];
  const partIds=participants.filter(p=>p.encounterid===enc.id).map(p=>p.personid);
  const names=partIds.map(pid=>personMap[pid]?.name).filter(Boolean).join(' & ');
  return { date:enc.date, type:enc.type, names, note:enc.description.trim() };
}

// ── 10. Database health ───────────────────────────────────────────
function dbHealth(encounters, participants, people) {
  const issues=[];

  // Encounters with no participants
  const encIds=new Set(participants.map(p=>p.encounterid));
  const orphaned=encounters.filter(e=>!encIds.has(e.id)).length;
  if(orphaned>0) issues.push(`${orphaned} encounter${orphaned>1?'s':''} with no participants recorded.`);

  // People with interval but only one encounter
  const personEncCount={};
  participants.forEach(({personid})=>{ personEncCount[personid]=(personEncCount[personid]||0)+1; });
  const thinInterval=people.filter(p=>p.contactintervaldays&&(personEncCount[p.id]||0)<=1).length;
  if(thinInterval>0) issues.push(`${thinInterval} ${thinInterval>1?'people have':'person has'} a contact frequency set but only one recorded encounter.`);

  // People with invalid birthday (day without month or vice versa)
  const invalidBd=people.filter(p=>(p.birthday_day&&!p.birthday_month)||(!p.birthday_day&&p.birthday_month)).length;
  if(invalidBd>0) issues.push(`${invalidBd} ${invalidBd>1?'people have':'person has'} an incomplete birthday (day or month missing).`);

  return issues;
}

// ── 11. Closing summary ───────────────────────────────────────────
function closingSummary(hero, newConns, rhythm, mix) {
  const parts=[];

  if(hero.encounters===0) return 'No encounters were recorded this week.';

  // Activity level
  if(hero.vsAvg!==null&&hero.vsAvg>=15) parts.push(`a particularly active week with ${hero.encounters} encounters (${hero.vsAvg}% above average)`);
  else if(hero.vsAvg!==null&&hero.vsAvg<=-15) parts.push(`a quieter week than usual with ${hero.encounters} encounters`);
  else parts.push(`${hero.encounters} encounters across the week`);

  // New connections
  if(newConns.newPeople.length>0) parts.push(`${newConns.newPeople.length} new connection${newConns.newPeople.length>1?'s':''}`);

  // Overdue contacts
  if(rhythm.overdue50>0) parts.push(`${rhythm.overdue50} regular contact${rhythm.overdue50>1?'s':''} currently beyond their expected rhythm`);

  // 1-on-1 note
  const oo=mix.find(t=>t.type==='1-on-1');
  if(oo&&oo.pct>55) parts.push(`strong 1-on-1 focus at ${oo.pct}% of encounters`);

  if(parts.length===0) return `${hero.encounters} encounters recorded this week.`;
  return parts.join(', ').replace(/,([^,]*)$/,' and$1')+'.';
}

// ── HTML builder ──────────────────────────────────────────────────
function buildHTML(today, hero, mix, peopleStats, newConns, rhythm, insights,
                   moments, ahead, yearAgo, health, summary,
                   weekStart, weekEnd) {

  const weekLabel=`${formatShort(weekStart)} – ${formatMed(weekEnd)}`;
  const vsAvgStr = hero.vsAvg===null?'':
    hero.vsAvg>=0?`<span class="pill-up">&#8593; ${hero.vsAvg}% vs 12-week avg</span>`:
                  `<span class="pill-dn">&#8595; ${Math.abs(hero.vsAvg)}% vs 12-week avg</span>`;

  const vsLastStr = hero.vsLast>0?`+${hero.vsLast} vs last week`:
                    hero.vsLast<0?`${hero.vsLast} vs last week`:'Same as last week';

  // ── Mix bars
  const maxMix = Math.max(...mix.map(t=>t.count),1);
  const mixBars = mix.map(t=>{
    const w = Math.round((t.count/maxMix)*100);
    return `<div class="mix-row">
      <div class="mix-label">${esc(t.label)}</div>
      <div class="mix-bar-wrap"><div class="mix-bar" style="width:${w}%"></div></div>
      <div class="mix-count">${t.count}</div>
      <div class="mix-pct">${t.pct}%</div>
    </div>`;
  }).join('');

  // ── People bars
  const maxPeople = Math.max(...peopleStats.top.map(p=>p.count),1);
  const peopleBars = peopleStats.top.map(p=>{
    const w=Math.round((p.count/maxPeople)*100);
    return `<div class="mix-row">
      <div class="mix-label">${esc(p.person.name)}</div>
      <div class="mix-bar-wrap"><div class="mix-bar mix-bar-amber" style="width:${w}%"></div></div>
      <div class="mix-count">${p.count}</div>
    </div>`;
  }).join('');

  // ── Rhythm rows
  const rhythmRows = rhythm.display.map(r=>{
    const pct=Math.min(Math.round((r.daysSince/r.expectedDays)*100),300);
    const barW=Math.min(pct,100);
    const color=pct<=100?'#40916C':pct<=150?'#E07B2A':'#C0392B';
    const label=r.isInferred?`~${r.expectedDays}`:`${r.expectedDays}`;
    return `<div class="rhythm-row">
      <div class="rhythm-name">${esc(r.person.name)}</div>
      <div class="rhythm-bar-wrap">
        <div class="rhythm-bar" style="width:${barW}%;background:${color}"></div>
        ${pct>100?'<div class="rhythm-overmark"></div>':''}
      </div>
      <div class="rhythm-stat">${r.daysSince}d / ${label} expected</div>
    </div>`;
  }).join('');

  // ── Insights
  const insightHTML = insights.length
    ? insights.map(i=>`<div class="insight-item">${esc(i)}</div>`).join('')
    : `<div class="empty-note">Nothing particularly unusual this week.</div>`;

  // ── Moments
  const momentHTML = moments.length
    ? moments.map(m=>`
      <div class="moment-card">
        <div class="moment-meta">${formatShort(new Date(m.date))} · ${esc(m.names||'—')} · ${esc(TYPE_LABELS[m.type]||m.type)}</div>
        <div class="moment-quote">${esc(m.note.length>180?m.note.slice(0,177)+'…':m.note)}</div>
      </div>`).join('')
    : `<div class="empty-note">No notes recorded on encounters this week.</div>`;

  // ── Week ahead birthdays
  const aheadBdHTML = ahead.birthdays.length
    ? ahead.birthdays.map(p=>`<div class="ahead-row"><span class="ahead-name">${esc(p.name)}</span><span class="ahead-detail">${formatDow(p.nextDate)}</span></div>`).join('')
    : `<div class="empty-note">No birthdays next week.</div>`;

  // ── Week ahead catchup
  const aheadCuHTML = ahead.approaching.length
    ? ahead.approaching.slice(0,5).map(p=>{
        const label=p.daysUntilDue<=0?'Overdue now':`Due in ${p.daysUntilDue} day${p.daysUntilDue!==1?'s':''}`;
        return `<div class="ahead-row"><span class="ahead-name">${esc(p.person.name)}</span><span class="ahead-detail">${label}</span></div>`;
      }).join('')
    : `<div class="empty-note">No contacts due next week.</div>`;

  // ── One year ago
  const yearAgoHTML = yearAgo
    ? `<div class="moment-card moment-card-history">
        <div class="moment-meta">${formatMed(new Date(yearAgo.date))} · ${esc(yearAgo.names||'—')} · ${esc(TYPE_LABELS[yearAgo.type]||yearAgo.type)}</div>
        <div class="moment-quote">${esc(yearAgo.note.length>180?yearAgo.note.slice(0,177)+'…':yearAgo.note)}</div>
       </div>`
    : `<div class="empty-note">No encounters with notes found from around this time last year.</div>`;

  // ── DB health
  const healthHTML = health.length===0
    ? `<div class="health-ok">&#10003; Database health looks good this week.</div>`
    : `<div class="health-issues">${health.map(h=>`<div class="health-item">&#9679; ${esc(h)}</div>`).join('')}</div>`;

  // ── New connections
  const newHTML = newConns.newPeople.length
    ? `<div class="new-count">${newConns.newPeople.length} new connection${newConns.newPeople.length!==1?'s':''} this week</div>
       ${newConns.newPeople.map(p=>`<div class="ahead-row"><span class="ahead-name">${esc(p.person.name)}</span><span class="ahead-detail">First met ${formatShort(new Date(p.firstDate))}${p.hadSecond?' · already met again':''}</span></div>`).join('')}
       ${newConns.secondCount>0?`<div class="new-sticky">${newConns.secondCount} new connection${newConns.secondCount>1?'s have':' has'} already had a second encounter.</div>`:''}`
    : `<div class="empty-note">No new connections this week.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}

  :root{
    --navy:#0D1B2A;
    --blue:#1A2E42;
    --slate:#4A5B6E;
    --fog:#8A9BAC;
    --cream:#F5F0E8;
    --amber:#D4A855;
    --green:#2D6A4F;
    --red:#C0392B;
    --orange:#E07B2A;
  }

  body{
    font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;
    color:#1a1a1a;
    background:#fff;
    font-size:12.5px;
    line-height:1.6;
  }

  /* ── HERO ── */
  .hero{
    background:var(--navy);
    color:#fff;
    padding:44px 52px 40px;
    page-break-after:avoid;
  }
  .hero-brand{
    font-size:9px;font-weight:700;text-transform:uppercase;
    letter-spacing:0.18em;color:var(--fog);margin-bottom:8px;
  }
  .hero-week{
    font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:0.12em;color:var(--fog);margin-bottom:20px;
  }
  .hero-title{
    font-size:28px;font-weight:800;letter-spacing:-0.03em;
    color:#fff;margin-bottom:28px;line-height:1.1;
  }
  .hero-stats{
    display:flex;gap:40px;margin-bottom:20px;
  }
  .hero-stat-val{
    font-size:38px;font-weight:800;color:#fff;
    letter-spacing:-0.04em;line-height:1;margin-bottom:4px;
  }
  .hero-stat-lbl{
    font-size:9px;font-weight:700;text-transform:uppercase;
    letter-spacing:0.12em;color:var(--fog);
  }
  .hero-meta{
    font-size:11px;color:var(--fog);margin-top:4px;
  }
  .pill-up{
    display:inline-block;background:rgba(45,106,79,0.35);
    color:#74c69d;border-radius:20px;padding:3px 10px;
    font-size:10px;font-weight:700;letter-spacing:0.04em;
  }
  .pill-dn{
    display:inline-block;background:rgba(192,57,43,0.3);
    color:#e8a09a;border-radius:20px;padding:3px 10px;
    font-size:10px;font-weight:700;letter-spacing:0.04em;
  }

  /* ── BODY LAYOUT ── */
  .body-wrap{padding:40px 52px;}

  /* ── SECTION ── */
  .section{margin-bottom:36px;page-break-inside:avoid;}
  .section-label{
    font-size:9px;font-weight:700;text-transform:uppercase;
    letter-spacing:0.16em;color:var(--fog);
    margin-bottom:14px;padding-bottom:6px;
    border-bottom:1px solid #e8e8e8;
  }

  /* ── STAT CARDS ── */
  .stat-cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;}
  .stat-card{
    background:#f8f9fa;border-radius:8px;padding:14px 18px;
    min-width:100px;flex:1;
  }
  .stat-card-val{font-size:26px;font-weight:800;color:var(--navy);letter-spacing:-0.03em;line-height:1;}
  .stat-card-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--slate);margin-top:4px;}
  .stat-card-comp{font-size:10px;color:var(--fog);margin-top:3px;}

  /* ── MIX BARS ── */
  .mix-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
  .mix-label{width:100px;font-size:11px;color:var(--slate);flex-shrink:0;}
  .mix-bar-wrap{flex:1;background:#f0f0f0;border-radius:3px;height:10px;overflow:hidden;}
  .mix-bar{height:100%;background:var(--navy);border-radius:3px;transition:width 0s;}
  .mix-bar-amber{background:var(--amber);}
  .mix-count{width:20px;text-align:right;font-size:11px;font-weight:700;color:var(--navy);}
  .mix-pct{width:32px;text-align:right;font-size:10px;color:var(--fog);}

  /* ── RHYTHM ── */
  .rhythm-row{margin-bottom:12px;}
  .rhythm-name{font-size:12px;font-weight:700;color:var(--navy);margin-bottom:4px;}
  .rhythm-bar-wrap{position:relative;background:#f0f0f0;border-radius:3px;height:8px;margin-bottom:3px;}
  .rhythm-bar{height:100%;border-radius:3px;}
  .rhythm-overmark{
    position:absolute;right:0;top:-2px;height:12px;
    width:2px;background:var(--red);
  }
  .rhythm-stat{font-size:10px;color:var(--fog);}

  /* ── AHEAD ── */
  .ahead-row{
    display:flex;justify-content:space-between;align-items:baseline;
    padding:5px 0;border-bottom:1px solid #f4f4f4;
  }
  .ahead-row:last-child{border-bottom:none;}
  .ahead-name{font-weight:600;color:var(--navy);font-size:12px;}
  .ahead-detail{color:var(--slate);font-size:11px;}

  /* ── MOMENTS ── */
  .moment-card{
    background:#f8f9fa;border-left:3px solid var(--navy);
    border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:12px;
  }
  .moment-card-history{border-left-color:var(--amber);}
  .moment-meta{
    font-size:9px;font-weight:700;text-transform:uppercase;
    letter-spacing:0.1em;color:var(--fog);margin-bottom:6px;
  }
  .moment-quote{
    font-size:13px;color:var(--navy);line-height:1.5;
    font-style:italic;
  }

  /* ── INSIGHTS ── */
  .insight-item{
    padding:10px 14px;background:#fffbf2;border-left:3px solid var(--amber);
    border-radius:0 6px 6px 0;margin-bottom:8px;
    font-size:12px;color:var(--navy);line-height:1.5;
  }

  /* ── NEW CONNECTIONS ── */
  .new-count{font-size:13px;font-weight:700;color:var(--navy);margin-bottom:10px;}
  .new-sticky{font-size:11px;color:var(--slate);margin-top:8px;font-style:italic;}

  /* ── HEALTH ── */
  .health-ok{color:var(--green);font-weight:600;font-size:12px;}
  .health-item{font-size:12px;color:var(--slate);margin-bottom:4px;}

  /* ── CLOSING ── */
  .closing{
    background:var(--navy);color:#fff;padding:28px 52px;
    margin-top:8px;
  }
  .closing-label{
    font-size:9px;font-weight:700;text-transform:uppercase;
    letter-spacing:0.16em;color:var(--fog);margin-bottom:10px;
  }
  .closing-text{
    font-size:14px;color:#fff;line-height:1.6;font-style:italic;
  }

  /* ── FOOTER ── */
  .footer{
    padding:16px 52px;border-top:1px solid #e8e8e8;
    font-size:9px;color:#c0c0c0;
  }

  /* ── UTILITIES ── */
  .empty-note{color:var(--fog);font-style:italic;font-size:11px;padding:3px 0;}
  .two-col{display:flex;gap:32px;}
  .two-col>div{flex:1;}
  .section-gap{height:8px;}
</style>
</head>
<body>

<!-- HERO -->
<div class="hero">
  <div class="hero-brand">Personal Log</div>
  <div class="hero-week">${esc(weekLabel)}</div>
  <div class="hero-title">Your Week<br>in Review</div>
  <div class="hero-stats">
    <div>
      <div class="hero-stat-val">${hero.encounters}</div>
      <div class="hero-stat-lbl">Encounters</div>
    </div>
    <div>
      <div class="hero-stat-val">${hero.uniquePeople}</div>
      <div class="hero-stat-lbl">People</div>
    </div>
    <div>
      <div class="hero-stat-val">${hero.activeDays}</div>
      <div class="hero-stat-lbl">Active days</div>
    </div>
  </div>
  <div class="hero-meta">
    ${vsAvgStr}
    ${vsAvgStr&&vsLastStr?'&nbsp;&nbsp;':''}
    <span style="color:var(--fog);font-size:11px">${esc(vsLastStr)}</span>
  </div>
</div>

<div class="body-wrap">

<!-- WEEK AT A GLANCE -->
<div class="section">
  <div class="section-label">The week at a glance</div>
  <div class="stat-cards">
    <div class="stat-card">
      <div class="stat-card-val">${hero.encounters}</div>
      <div class="stat-card-lbl">Encounters</div>
      ${hero.vsAvg!==null?`<div class="stat-card-comp">${hero.vsAvg>=0?'+':''}${hero.vsAvg}% vs avg</div>`:''}
    </div>
    <div class="stat-card">
      <div class="stat-card-val">${hero.uniquePeople}</div>
      <div class="stat-card-lbl">People</div>
      ${peopleStats.diff!==0?`<div class="stat-card-comp">${peopleStats.diff>0?'+':''}${peopleStats.diff} vs avg</div>`:''}
    </div>
    <div class="stat-card">
      <div class="stat-card-val">${hero.activeDays}</div>
      <div class="stat-card-lbl">Active days</div>
    </div>
    ${mix.find(t=>t.type==='1-on-1')?`
    <div class="stat-card">
      <div class="stat-card-val">${mix.find(t=>t.type==='1-on-1').count}</div>
      <div class="stat-card-lbl">1-on-1</div>
    </div>`:''}
  </div>
</div>

<!-- ENCOUNTER MIX + PEOPLE — two column -->
<div class="two-col">
  <div class="section">
    <div class="section-label">How the week happened</div>
    ${mix.length?mixBars:`<div class="empty-note">No encounters this week.</div>`}
  </div>
  <div class="section">
    <div class="section-label">People of the week</div>
    ${peopleStats.top.length?peopleBars:`<div class="empty-note">No encounters this week.</div>`}
    ${peopleStats.diff!==0?`<div style="font-size:10px;color:var(--fog);margin-top:8px">${hero.uniquePeople} unique people — ${peopleStats.diff>0?peopleStats.diff+' more':''+Math.abs(peopleStats.diff)+' fewer'} than the 12-week average.</div>`:''}
  </div>
</div>

<!-- NEW CONNECTIONS -->
<div class="section">
  <div class="section-label">&#10022; New connections</div>
  ${newHTML}
</div>

<!-- RELATIONSHIP RHYTHM -->
<div class="section">
  <div class="section-label">Relationship rhythm</div>
  ${rhythm.display.length?rhythmRows:`<div class="empty-note">Not enough contact frequency data yet.</div>`}
  ${rhythm.overdue50>0?`<div style="font-size:10px;color:var(--fog);margin-top:10px">${rhythm.overdue50} contact${rhythm.overdue50>1?'s are':' is'} currently more than 50% beyond their expected interval.</div>`:''}
</div>

<!-- INTERESTING THIS WEEK -->
<div class="section">
  <div class="section-label">&#10022; Interesting this week</div>
  ${insightHTML}
</div>

<!-- MOMENTS FROM THE WEEK -->
<div class="section">
  <div class="section-label">Moments from the week</div>
  ${momentHTML}
</div>

<!-- NEXT WEEK — two column -->
<div class="two-col">
  <div class="section">
    <div class="section-label">Next week &mdash; Birthdays</div>
    ${aheadBdHTML}
  </div>
  <div class="section">
    <div class="section-label">Next week &mdash; Worth catching up</div>
    ${aheadCuHTML}
    ${ahead.noRecent.length?`<div style="font-size:10px;color:var(--fog);margin-top:8px">${ahead.noRecent.length} contact${ahead.noRecent.length>1?'s have':' has'} a frequency set but no encounters recorded.</div>`:''}
  </div>
</div>

<!-- ONE YEAR AGO -->
<div class="section">
  <div class="section-label">One year ago</div>
  ${yearAgoHTML}
</div>

<!-- DATABASE HEALTH -->
<div class="section">
  <div class="section-label">Database health</div>
  ${healthHTML}
</div>

</div><!-- /body-wrap -->

<!-- CLOSING -->
<div class="closing">
  <div class="closing-label">The week in one line</div>
  <div class="closing-text">${esc(summary)}</div>
</div>

<div class="footer">
  Generated by Personal Log &middot; ${toISO(today.date)}
</div>

</body>
</html>`;
}

// ── PDF ───────────────────────────────────────────────────────────
async function generatePDF(html) {
  const browser = await puppeteer.launch({
    headless:'new', args:['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html,{waitUntil:'networkidle0'});
  const pdf = await page.pdf({
    format:'A4', printBackground:true,
    margin:{top:'0',right:'0',bottom:'0',left:'0'},
  });
  await browser.close();
  return pdf;
}

// ── Email ─────────────────────────────────────────────────────────
async function sendEmail(pdf, weekLabel) {
  const transporter = nodemailer.createTransport({
    host:'smtp.gmail.com', port:587, secure:false,
    auth:{ user:SMTP_USER, pass:SMTP_PASSWORD }
  });
  await transporter.sendMail({
    from:  '"Personal Log" <justin.mitchell.assist@gmail.com>',
    to:    RECIPIENT,
    subject:`Weekly Report · ${weekLabel}`,
    text:  `Your Personal Log weekly report for ${weekLabel} is attached.`,
    attachments:[{
      filename:`weekly-${weekLabel.replace(/\s/g,'-')}.pdf`,
      content: pdf,
      contentType:'application/pdf',
    }],
  });
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching data...');
  const { people, encounters, participants } = await fetchData();

  const today    = melbourneNow();
  const weekEnd  = today.date;
  const weekStart= addDays(weekEnd,-6);
  const weekLabel= `${formatShort(weekStart)}–${formatShort(weekEnd)}`;

  console.log(`Generating weekly report for ${toISO(weekStart)} to ${toISO(weekEnd)}`);

  const data       = prepareData(people, encounters, participants, today);
  const personMap  = Object.fromEntries(people.map(p=>[p.id,p]));

  const hero       = heroStats(data);
  const mix        = encounterMix(data);
  const peopleStat = peopleOfWeek(data, personMap);
  const newConns   = newConnections(data, people, personMap);
  const rhythm     = relationshipRhythm(people, data);
  const insights   = interestingObservations(hero, mix, peopleStat, newConns, rhythm, data, people);
  const moments    = momentsFromWeek(data, personMap);
  const ahead      = weekAhead(people, data);
  const yearAgo    = oneYearAgo(encounters, participants, personMap, today.date);
  const health     = dbHealth(encounters, participants, people);
  const summary    = closingSummary(hero, newConns, rhythm, mix);

  const html = buildHTML(today, hero, mix, peopleStat, newConns, rhythm, insights,
                         moments, ahead, yearAgo, health, summary, weekStart, weekEnd);

  console.log('Generating PDF...');
  const pdf = await generatePDF(html);

  console.log('Sending email...');
  await sendEmail(pdf, weekLabel);

  console.log('Weekly report sent successfully.');
}

main().catch(err=>{
  console.error('Weekly report failed:', err.message);
  process.exit(1);
});
