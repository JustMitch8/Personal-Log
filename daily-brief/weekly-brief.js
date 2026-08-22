'use strict';

// ─────────────────────────────────────────────────────────────────
//  Personal Log — Weekly Contact Report (v2)
//  3 sections: Recap / Trends / Next Week
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

const ALL_TYPES = ['call','1-on-1','small-group','large-group','message','birthday-acknowledgment'];
const TYPE_LABELS = {
  'call':'Call','1-on-1':'1-on-1','small-group':'Small group',
  'large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'
};
const TYPE_COLORS = {
  'call':'#2171A8','1-on-1':'#D4A855','small-group':'#40916C',
  'large-group':'#2D6A4F','message':'#4A5B6E','birthday-acknowledgment':'#E07B9A'
};

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

// Seeded random — deterministic per date string
function seededRandom(seed) {
  let h = 0;
  for (let i=0;i<seed.length;i++) { h = Math.imul(31,h)+seed.charCodeAt(i)|0; }
  return function() {
    h = Math.imul(h^(h>>>16), 0x45d9f3b)|0;
    h = Math.imul(h^(h>>>16), 0x45d9f3b)|0;
    return ((h^(h>>>16))>>>0)/4294967296;
  };
}
function seededShuffle(arr, seedStr) {
  const rng = seededRandom(seedStr);
  const a = [...arr];
  for (let i=a.length-1;i>0;i--) {
    const j = Math.floor(rng()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

// ── Supabase ──────────────────────────────────────────────────────
async function fetchData() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, { realtime:{ transport:ws } });
  let authErr;
  for (const delay of [2000,5000,10000]) {
    await new Promise(r=>setTimeout(r,delay));
    const result = await supabase.auth.signInWithPassword({
      email:SUPABASE_EMAIL, password:SUPABASE_PASSWORD
    });
    if (!result.error) { authErr=null; break; }
    authErr=result.error;
    console.log(`Auth attempt failed (${authErr.message}), retrying...`);
  }
  if (authErr) throw new Error('Auth failed after retries: '+authErr.message);

  const [
    {data:people,   error:e1},
    {data:encounters,error:e2},
    {data:participants,error:e3},
  ] = await Promise.all([
    supabase.from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays,firstmet'),
    supabase.from('encounters').select('id,date,type,description').order('date',{ascending:false}),
    supabase.from('encounter_participants').select('encounterid,personid'),
  ]);
  if (e1||e2||e3) throw new Error('Data fetch failed: '+((e1||e2||e3).message));
  return { people, encounters, participants };
}

// ── Core analytics (shared logic) ─────────────────────────────────
function computeAnalytics(people, encounters, participants, todayDate) {
  const todayISO    = toISO(todayDate);
  const weekStart   = addDays(todayDate,-6);
  const weekStartISO= toISO(weekStart);
  const twelveWkStart= toISO(addDays(todayDate,-84));

  // Indexes
  const encPartsMap  = {}; // encounterid -> [personid]
  const personEncsMap= {}; // personid -> [encounterid]
  participants.forEach(({encounterid,personid})=>{
    if(!encPartsMap[encounterid]) encPartsMap[encounterid]=[];
    encPartsMap[encounterid].push(personid);
    if(!personEncsMap[personid]) personEncsMap[personid]=[];
    personEncsMap[personid].push(encounterid);
  });

  const encMap = Object.fromEntries(encounters.map(e=>[e.id,e]));

  // ── SECTION 1: Recap ──────────────────────────────────────────

  // This week
  const weekEncs = encounters.filter(e=>e.date>=weekStartISO&&e.date<=todayISO);

  // Encounter type counts this week vs 12-wk avg
  const twelveWkEncs = encounters.filter(e=>e.date>=twelveWkStart&&e.date<weekStartISO);
  const priorWeeks   = 11;

  const weekTypeCounts={};
  ALL_TYPES.forEach(t=>{ weekTypeCounts[t]=weekEncs.filter(e=>e.type===t).length; });
  weekTypeCounts['total']=weekEncs.length;

  const avgTypeCounts={};
  ALL_TYPES.forEach(t=>{
    avgTypeCounts[t]=+(twelveWkEncs.filter(e=>e.type===t).length/priorWeeks).toFixed(1);
  });
  avgTypeCounts['total']=+(twelveWkEncs.length/priorWeeks).toFixed(1);

  // People chart: who appeared this week
  const weekPeopleCount={};
  weekEncs.forEach(e=>{
    (encPartsMap[e.id]||[]).forEach(pid=>{
      weekPeopleCount[pid]=(weekPeopleCount[pid]||0)+1;
    });
  });
  const weekUniquePeople=Object.keys(weekPeopleCount).length;

  // Per-person 12-wk avg appearances per week
  const personWeeklyAvg={};
  people.forEach(p=>{
    const cnt=twelveWkEncs.filter(e=>(encPartsMap[e.id]||[]).includes(p.id)).length;
    personWeeklyAvg[p.id]=+(cnt/priorWeeks).toFixed(1);
  });

  // Avg unique people per week over prior 12 weeks
  let totalUniquePeoplePerWeek=0;
  for(let w=1;w<=priorWeeks;w++){
    const ws=toISO(addDays(todayDate,-(w*7+6)));
    const we=toISO(addDays(todayDate,-(w*7)));
    const pSet=new Set();
    twelveWkEncs.filter(e=>e.date>=ws&&e.date<=we)
      .forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    totalUniquePeoplePerWeek+=pSet.size;
  }
  const avgUniquePeoplePerWeek=+(totalUniquePeoplePerWeek/priorWeeks).toFixed(1);

  // New people this week
  const newPeople=people.filter(p=>{
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort();
    return dates.length>0&&dates[0]>=weekStartISO&&dates[0]<=todayISO;
  });

  // Moments from week (for section 1 footer)
  const moments=weekEncs
    .filter(e=>e.description&&e.description.trim().length>10)
    .sort((a,b)=>(b.description||'').length-(a.description||'').length)
    .slice(0,2)
    .map(e=>({
      date:e.date,
      type:e.type,
      names:(encPartsMap[e.id]||[]).map(pid=>people.find(p=>p.id===pid)?.name).filter(Boolean).join(' & '),
      note:e.description.trim(),
    }));

  // ── SECTION 2: Trends ─────────────────────────────────────────

  // Stacked column: 12 weeks of data
  const weeklyStacks=[];
  for(let w=11;w>=0;w--){
    const ws=w===0?weekStartISO:toISO(addDays(todayDate,-(w*7+6)));
    const we=w===0?todayISO:toISO(addDays(todayDate,-(w*7)));
    const wEncs=encounters.filter(e=>e.date>=ws&&e.date<=we);
    const typeCounts={};
    ALL_TYPES.forEach(t=>{ typeCounts[t]=wEncs.filter(e=>e.type===t).length; });
    const pSet=new Set();
    wEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    weeklyStacks.push({
      label:formatShort(new Date(ws)),
      total:wEncs.length,
      typeCounts,
      uniquePeople:pSet.size,
      isCurrentWeek:w===0,
    });
  }

  // Concentration curve: rank people by 12-wk encounter count
  const personCounts=people.map(p=>{
    const cnt=encounters.filter(e=>
      e.date>=twelveWkStart&&e.date<=todayISO&&
      (encPartsMap[e.id]||[]).includes(p.id)
    ).length;
    return {name:p.name,count:cnt};
  }).filter(p=>p.count>0).sort((a,b)=>b.count-a.count);

  const totalEncounterAppearances=personCounts.reduce((s,p)=>s+p.count,0)||1;
  let cumSum=0;
  const concentrationCurve=personCounts.map((p,i)=>{
    cumSum+=p.count;
    return {
      rank:i+1,
      name:p.name,
      count:p.count,
      cumulativePct:Math.round((cumSum/totalEncounterAppearances)*100),
      peoplePct:Math.round(((i+1)/personCounts.length)*100),
    };
  });

  // Goals achievability
  const peopleWithInterval=people.filter(p=>p.contactintervaldays);
  const requiredPerDay=peopleWithInterval.reduce((s,p)=>s+(1/p.contactintervaldays),0);
  const requiredPerWeek=requiredPerDay*7;

  function actualPeoplePerDay(days) {
    const since=toISO(addDays(todayDate,-days));
    const pSet=new Set();
    encounters.filter(e=>e.date>=since&&e.date<=todayISO)
      .forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    return +(pSet.size/days).toFixed(2);
  }
  const actualPerDay7 =actualPeoplePerDay(7);
  const actualPerDay30=actualPeoplePerDay(30);
  const actualPerDay90=actualPeoplePerDay(90);

  // Rhythm histogram
  const rhythmBuckets={ahead:0,onTrack:0,slightlyBehind:0,overdue:0,significantlyOverdue:0};
  const rhythmDetail=[];
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    const dates=(personEncsMap[p.id]||[])
      .map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length) return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const ratio=daysSince/p.contactintervaldays;
    let bucket;
    if(ratio<0.5)      bucket='ahead';
    else if(ratio<=1.2) bucket='onTrack';
    else if(ratio<=1.5) bucket='slightlyBehind';
    else if(ratio<=2.0) bucket='overdue';
    else                bucket='significantlyOverdue';
    rhythmBuckets[bucket]++;
    rhythmDetail.push({person:p,daysSince,ratio,bucket});
  });

  // Interval recommendations (8+ weeks consistent >30% divergence)
  const recommendations=[];
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    // Need enough history: at least 8 weeks
    const allDates=(personEncsMap[p.id]||[])
      .map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(allDates.length<3) return;
    // Compute actual avg interval from last 12 weeks
    const recent=allDates.filter(d=>d>=twelveWkStart);
    if(recent.length<2) return;
    let totalGap=0,cnt=0;
    for(let i=0;i<recent.length-1;i++){
      const g=Math.round((new Date(recent[i]+'T00:00:00')-new Date(recent[i+1]+'T00:00:00'))/86400000);
      if(g>0){totalGap+=g;cnt++;}
    }
    if(!cnt) return;
    const actualAvg=Math.round(totalGap/cnt);
    const target=p.contactintervaldays;
    const divergePct=((actualAvg-target)/target)*100;
    // Only fire if >30% divergence sustained (proxy: use 12-wk window)
    if(Math.abs(divergePct)>=30) {
      recommendations.push({
        person:p, target, actualAvg,
        direction:divergePct>0?'increase':'decrease',
        divergePct:Math.round(Math.abs(divergePct)),
      });
    }
  });

  // ── SECTION 3: Next Week ──────────────────────────────────────

  const nextWeekStart=addDays(todayDate,1);
  const nextWeekEnd  =addDays(todayDate,7);
  const seedStr      =todayISO; // date seed for random selections

  // People per week target
  const targetPerWeek=+(requiredPerWeek).toFixed(1);

  // Birthdays next week
  const birthdays=people
    .filter(p=>p.birthday_month&&p.birthday_day)
    .map(p=>{
      let next=new Date(nextWeekStart.getFullYear(),p.birthday_month-1,p.birthday_day);
      if(next<nextWeekStart) next=new Date(nextWeekStart.getFullYear()+1,p.birthday_month-1,p.birthday_day);
      const daysUntil=Math.round((next-nextWeekStart)/86400000);
      return {...p,nextDate:next,daysUntil};
    })
    .filter(p=>p.daysUntil>=0&&p.daysUntil<=6)
    .sort((a,b)=>a.daysUntil-b.daysUntil);

  // Due soon: interval will be crossed within next 7 days
  const dueSoon=[];
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    const dates=(personEncsMap[p.id]||[])
      .map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length) return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const daysUntilDue=p.contactintervaldays-daysSince;
    if(daysUntilDue>=0&&daysUntilDue<=7) dueSoon.push({person:p,daysUntilDue,daysSince});
  });
  const dueSoonSelected=seededShuffle(dueSoon,seedStr+'due').slice(0,3);

  // Long overdue: >1.5x interval AND last seen >7 days ago
  const longOverdue=[];
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    const dates=(personEncsMap[p.id]||[])
      .map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length) return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    if(daysSince<7) return;
    const ratio=daysSince/p.contactintervaldays;
    if(ratio>=1.5) longOverdue.push({person:p,daysSince,ratio});
  });
  // Exclude anyone already in dueSoon
  const dueSoonIds=new Set(dueSoonSelected.map(d=>d.person.id));
  const longOverdueFiltered=longOverdue.filter(p=>!dueSoonIds.has(p.person.id));
  const longOverdueSelected=seededShuffle(longOverdueFiltered,seedStr+'overdue').slice(0,3);

  // Momentum: last 2 weeks vs 12-wk avg — deterministic, top 3 by delta
  const twoWkStart=toISO(addDays(todayDate,-14));
  const excludeIds=new Set([...dueSoonSelected.map(d=>d.person.id),...longOverdueSelected.map(d=>d.person.id)]);
  const momentumCandidates=people
    .filter(p=>!excludeIds.has(p.id))
    .map(p=>{
      const recentEncs=encounters.filter(e=>e.date>=twoWkStart&&e.date<=todayISO&&(encPartsMap[e.id]||[]).includes(p.id)).length;
      const avgPer2Wk=+(personWeeklyAvg[p.id]*2);
      const delta=recentEncs-avgPer2Wk;
      return {person:p,recentEncs,avgPer2Wk,delta};
    })
    .filter(p=>p.delta>0&&p.recentEncs>0)
    .sort((a,b)=>b.delta-a.delta)
    .slice(0,3);

  // One year ago
  const targetYearAgo=toISO(addDays(todayDate,-365));
  const yearAgoEncs=encounters
    .filter(e=>e.description&&e.description.trim().length>10)
    .map(e=>({...e,diff:Math.abs(new Date(e.date)-new Date(targetYearAgo))}))
    .filter(e=>e.diff<=7*86400000)
    .sort((a,b)=>a.diff-b.diff);
  const yearAgo=yearAgoEncs.length?{
    ...yearAgoEncs[0],
    names:(encPartsMap[yearAgoEncs[0].id]||[])
      .map(pid=>people.find(p=>p.id===pid)?.name).filter(Boolean).join(' & '),
  }:null;

  return {
    weekStart, weekStartISO, todayISO,
    // Section 1
    weekTypeCounts, avgTypeCounts,
    weekPeopleCount, weekUniquePeople, avgUniquePeoplePerWeek,
    personWeeklyAvg, newPeople, moments,
    peopleWithInterval,
    // Section 2
    weeklyStacks, concentrationCurve,
    requiredPerDay, requiredPerWeek,
    actualPerDay7, actualPerDay30, actualPerDay90,
    rhythmBuckets, rhythmDetail, recommendations,
    // Section 3
    targetPerWeek, birthdays,
    dueSoonSelected, longOverdueSelected, momentumCandidates,
    yearAgo,
  };
}

// ── HTML report builder ───────────────────────────────────────────
function buildHTML(people, encounters, participants, todayDate) {
  const weekStart=addDays(todayDate,-6);
  const weekLabel=`${formatShort(weekStart)} – ${formatShort(todayDate)} ${todayDate.getFullYear()}`;
  const a=computeAnalytics(people,encounters,participants,todayDate);
  const personMap=Object.fromEntries(people.map(p=>[p.id,p]));

  // ── Encounter bar chart
  const encTypes=[{key:'total',label:'Total'},...ALL_TYPES.map(t=>({key:t,label:TYPE_LABELS[t]}))];
  const maxEncBar=Math.max(...encTypes.map(t=>Math.max(a.weekTypeCounts[t.key]||0,(a.avgTypeCounts[t.key]||0)*1.2)),1);
  const encBarsHTML=encTypes.map(t=>{
    const val=a.weekTypeCounts[t.key]||0;
    const avg=a.avgTypeCounts[t.key]||0;
    const w=Math.round((val/maxEncBar)*100);
    const avgW=Math.round((avg/maxEncBar)*100);
    const color=t.key==='total'?'#0D1B2A':(TYPE_COLORS[t.key]||'#4A5B6E');
    return `<div class="bar-row">
      <div class="bar-label">${esc(t.label)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${w}%;background:${color}">
          ${val>0?`<span class="bar-val">${val}</span>`:''}
        </div>
        ${avg>0?`<div class="bar-baseline" style="left:${avgW}%" title="12-wk avg: ${avg}"></div>`:''}
      </div>
    </div>`;
  }).join('');

  // ── People bar chart
  const peopleSorted=Object.entries(a.weekPeopleCount)
    .sort((a,b)=>b[1]-a[1])
    .map(([pid,cnt])=>({person:personMap[pid],cnt}))
    .filter(x=>x.person);
  const maxPeopleBar=Math.max(a.weekUniquePeople,a.avgUniquePeoplePerWeek*1.2,1);
  const totalPeopleAvgW=Math.round((a.avgUniquePeoplePerWeek/maxPeopleBar)*100);
  const peopleBarsHTML=[
    `<div class="bar-row">
      <div class="bar-label">Total</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round((a.weekUniquePeople/maxPeopleBar)*100)}%;background:#0D1B2A">
          ${a.weekUniquePeople>0?`<span class="bar-val">${a.weekUniquePeople}</span>`:''}
        </div>
        ${a.avgUniquePeoplePerWeek>0?`<div class="bar-baseline" style="left:${totalPeopleAvgW}%"></div>`:''}
      </div>
    </div>`,
    ...peopleSorted.map(({person,cnt})=>{
      const avg=a.personWeeklyAvg[person.id]||0;
      const w=Math.round((cnt/maxPeopleBar)*100);
      const avgW=Math.round((avg/maxPeopleBar)*100);
      return `<div class="bar-row">
        <div class="bar-label">${esc(person.name)}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${w}%;background:#D4A855">
            <span class="bar-val">${cnt}</span>
          </div>
          ${avg>0?`<div class="bar-baseline" style="left:${avgW}%"></div>`:''}
        </div>
      </div>`;
    })
  ].join('');

  // ── Stacked column chart (12 weeks)
  const maxStack=Math.max(...a.weeklyStacks.map(w=>Math.max(w.total,w.uniquePeople)),1);
  const stackedHTML=a.weeklyStacks.map(w=>{
    const totalH=Math.round((w.total/maxStack)*120);
    const peopleH=Math.round((w.uniquePeople/maxStack)*120);
    let stackOffset=0;
    const segments=ALL_TYPES.map(t=>{
      const cnt=w.typeCounts[t]||0;
      if(!cnt) return '';
      const h=Math.round((cnt/maxStack)*120);
      stackOffset+=h;
      return `<div style="height:${h}px;background:${TYPE_COLORS[t]};width:100%"></div>`;
    }).reverse().join('');
    return `<div class="stack-col ${w.isCurrentWeek?'stack-col-current':''}">
      <div class="stack-bars">
        <div class="stack-bar" style="height:${totalH}px">${segments}</div>
        <div class="stack-people-dot" style="bottom:${peopleH}px" title="${w.uniquePeople} people"></div>
      </div>
      <div class="stack-label">${w.label}</div>
    </div>`;
  }).join('');

  // ── Concentration curve
  const maxCurvePeople=concentrationCurvePoints(a.concentrationCurve);
  const curvePointsHTML=a.concentrationCurve.map(p=>
    `<div class="curve-point" style="left:${p.peoplePct}%;bottom:${p.cumulativePct}%" title="${esc(p.name)}: ${p.cumulativePct}%"></div>`
  ).join('');

  // ── Rhythm histogram
  const rhythmTotalPeople=Object.values(a.rhythmBuckets).reduce((s,v)=>s+v,0)||1;
  const rhythmBucketDefs=[
    {key:'ahead',label:'Well ahead',color:'#2D9E5F'},
    {key:'onTrack',label:'On track',color:'#40916C'},
    {key:'slightlyBehind',label:'Slightly behind',color:'#E07B2A'},
    {key:'overdue',label:'Overdue',color:'#C0392B'},
    {key:'significantlyOverdue',label:'Significantly overdue',color:'#7B0000'},
  ];
  const rhythmHTML=rhythmBucketDefs.map(b=>{
    const cnt=a.rhythmBuckets[b.key]||0;
    const w=Math.round((cnt/rhythmTotalPeople)*100);
    return `<div class="bar-row">
      <div class="bar-label" style="font-size:10px">${b.label}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${w}%;background:${b.color}">
          ${cnt>0?`<span class="bar-val">${cnt}</span>`:''}
        </div>
      </div>
    </div>`;
  }).join('');

  // ── Recommendations
  const recsHTML=a.recommendations.length
    ?a.recommendations.map(r=>`<div class="rec-item">
        <span class="rec-name">${esc(r.person.name)}</span>
        Consider ${r.direction==='decrease'?'reducing':'increasing'} interval from
        <strong>${r.target}</strong> to <strong>${r.actualAvg}</strong> days
        &mdash; actual average is ${r.actualAvg} days over the past 12 weeks.
      </div>`).join('')
    :`<div class="empty-note">No interval adjustments suggested this week.</div>`;

  // ── Due soon
  const dueSoonHTML=a.dueSoonSelected.length
    ?a.dueSoonSelected.map(d=>`<div class="suggest-row">
        <span class="suggest-name">${esc(d.person.name)}</span>
        <span class="suggest-detail">Due ${d.daysUntilDue===0?'today':`in ${d.daysUntilDue} day${d.daysUntilDue!==1?'s':''}`} · last seen ${d.daysSince}d ago</span>
      </div>`).join('')
    :`<div class="empty-note">No contacts due this week.</div>`;

  // ── Long overdue
  const overdueHTML=a.longOverdueSelected.length
    ?a.longOverdueSelected.map(d=>`<div class="suggest-row">
        <span class="suggest-name">${esc(d.person.name)}</span>
        <span class="suggest-detail">${d.daysSince}d since last seen · ${Math.round(d.ratio*10)/10}× their interval</span>
      </div>`).join('')
    :`<div class="empty-note">No significantly overdue contacts.</div>`;

  // ── Momentum
  const momentumHTML=a.momentumCandidates.length
    ?a.momentumCandidates.map(d=>`<div class="suggest-row">
        <span class="suggest-name">${esc(d.person.name)}</span>
        <span class="suggest-detail">${d.recentEncs} encounters in 2 weeks vs avg ${d.avgPer2Wk.toFixed(1)}</span>
      </div>`).join('')
    :`<div class="empty-note">No momentum contacts identified.</div>`;

  // ── Birthdays
  const bdHTML=a.birthdays.length
    ?a.birthdays.map(p=>`<div class="suggest-row">
        <span class="suggest-name">${esc(p.name)}</span>
        <span class="suggest-detail">${formatDow(p.nextDate)}</span>
      </div>`).join('')
    :`<div class="empty-note">No birthdays next week.</div>`;

  // ── Moments
  const momentsHTML=a.moments.length
    ?a.moments.map(m=>`<div class="moment-card">
        <div class="moment-meta">${formatShort(new Date(m.date))} · ${esc(m.names||'—')} · ${esc(TYPE_LABELS[m.type]||m.type)}</div>
        <div class="moment-quote">${esc(m.note.length>180?m.note.slice(0,177)+'…':m.note)}</div>
      </div>`).join('')
    :`<div class="empty-note">No notes recorded this week.</div>`;

  // ── One year ago
  const yearAgoHTML=a.yearAgo
    ?`<div class="moment-card moment-history">
        <div class="moment-meta">${formatMed(new Date(a.yearAgo.date))} · ${esc(a.yearAgo.names||'—')} · ${esc(TYPE_LABELS[a.yearAgo.type]||a.yearAgo.type)}</div>
        <div class="moment-quote">${esc(a.yearAgo.note?.slice(0,180)||'')}</div>
      </div>`
    :`<div class="empty-note">No notes found from around this time last year.</div>`;

  // ── New people
  const newPeopleHTML=a.newPeople.length
    ?a.newPeople.map(p=>`<div class="new-person-row">+ ${esc(p.name)}</div>`).join('')
    :`<div class="empty-note">No new people this week.</div>`;

  // ── Legend
  const legendHTML=ALL_TYPES.map(t=>
    `<span class="legend-item"><span class="legend-dot" style="background:${TYPE_COLORS[t]}"></span>${TYPE_LABELS[t]}</span>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  :root{--navy:#0D1B2A;--slate:#4A5B6E;--fog:#8A9BAC;--amber:#D4A855;--green:#2D6A4F;}
  body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#1a1a1a;background:#fff;font-size:12px;line-height:1.6;}

  /* Hero */
  .hero{background:var(--navy);color:#fff;padding:40px 48px 36px;}
  .hero-brand{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.18em;color:var(--fog);margin-bottom:6px;}
  .hero-title{font-size:26px;font-weight:800;letter-spacing:-0.03em;color:#fff;margin-bottom:4px;}
  .hero-week{font-size:12px;color:var(--fog);}

  /* Body */
  .body{padding:36px 48px;}
  .section{margin-bottom:32px;page-break-inside:avoid;}
  .section-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.16em;color:var(--fog);padding-bottom:8px;border-bottom:1px solid #e8e8e8;margin-bottom:16px;}
  .subsection-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:14px 0 8px;}
  .two-col{display:flex;gap:28px;}
  .two-col>div{flex:1;min-width:0;}
  .empty-note{color:var(--fog);font-style:italic;font-size:11px;}

  /* Bar charts */
  .bar-row{display:flex;align-items:center;gap:6px;margin-bottom:5px;}
  .bar-label{width:88px;font-size:10px;color:var(--slate);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .bar-track{flex:1;background:#f0f0f0;border-radius:3px;height:14px;position:relative;overflow:visible;}
  .bar-fill{height:100%;border-radius:3px;position:relative;min-width:2px;display:flex;align-items:center;}
  .bar-val{font-size:9px;font-weight:700;color:#fff;padding:0 4px;white-space:nowrap;}
  .bar-baseline{position:absolute;top:-3px;bottom:-3px;width:2px;background:#333;border-radius:1px;z-index:2;}

  /* Stacked chart */
  .stack-wrap{display:flex;align-items:flex-end;gap:3px;height:140px;margin-bottom:6px;}
  .stack-col{display:flex;flex-direction:column;align-items:center;flex:1;}
  .stack-col-current .stack-bar{opacity:1;}
  .stack-col:not(.stack-col-current) .stack-bar{opacity:0.65;}
  .stack-bars{position:relative;width:100%;display:flex;align-items:flex-end;}
  .stack-bar{width:100%;display:flex;flex-direction:column-reverse;border-radius:2px 2px 0 0;overflow:hidden;}
  .stack-people-dot{position:absolute;left:50%;transform:translateX(-50%);width:6px;height:6px;background:#fff;border:2px solid #333;border-radius:50%;}
  .stack-label{font-size:7px;color:var(--fog);margin-top:4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;}
  .legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}
  .legend-item{display:flex;align-items:center;gap:3px;font-size:9px;color:var(--slate);}
  .legend-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0;}

  /* Curve */
  .curve-wrap{position:relative;height:120px;border-left:1px solid #ddd;border-bottom:1px solid #ddd;margin:8px 0;}
  .curve-point{position:absolute;width:4px;height:4px;background:var(--navy);border-radius:50%;transform:translate(-50%,50%);}
  .curve-axis-label{font-size:8px;color:var(--fog);}
  .curve-labels{display:flex;justify-content:space-between;margin-top:2px;}

  /* Stats */
  .stat-row{display:flex;gap:16px;margin-bottom:12px;}
  .stat-box{flex:1;background:#f8f9fa;border-radius:6px;padding:10px 12px;}
  .stat-val{font-size:22px;font-weight:800;color:var(--navy);letter-spacing:-0.03em;line-height:1;}
  .stat-lbl{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--slate);margin-top:3px;}
  .stat-comp{font-size:9px;color:var(--fog);margin-top:2px;}

  /* Suggestions */
  .suggest-group{margin-bottom:16px;}
  .suggest-group-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--fog);margin-bottom:6px;}
  .suggest-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid #f4f4f4;}
  .suggest-row:last-child{border-bottom:none;}
  .suggest-name{font-weight:700;color:var(--navy);font-size:12px;}
  .suggest-detail{color:var(--slate);font-size:10px;}

  /* Recommendations */
  .rec-item{padding:8px 10px;background:#fffbf2;border-left:3px solid var(--amber);border-radius:0 4px 4px 0;margin-bottom:6px;font-size:11px;color:var(--navy);}
  .rec-name{font-weight:700;}

  /* Moments */
  .moment-card{background:#f8f9fa;border-left:3px solid var(--navy);border-radius:0 6px 6px 0;padding:12px 14px;margin-bottom:10px;}
  .moment-history{border-left-color:var(--amber);}
  .moment-meta{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--fog);margin-bottom:5px;}
  .moment-quote{font-size:12px;color:var(--navy);line-height:1.5;font-style:italic;}

  /* New people */
  .new-person-row{font-size:12px;color:var(--navy);padding:3px 0;font-weight:500;}

  /* Section dividers */
  .section-divider{border:none;border-top:2px solid var(--navy);margin:28px 0;}

  /* Footer */
  .footer{padding:14px 48px;border-top:1px solid #e8e8e8;font-size:9px;color:#c0c0c0;}
</style>
</head>
<body>

<div class="hero">
  <div class="hero-brand">Personal Log · Weekly Report</div>
  <div class="hero-title">Your Week in Review</div>
  <div class="hero-week">${esc(weekLabel)}</div>
</div>

<div class="body">

<!-- ═══ SECTION 1: YOUR WEEK ═══════════════════════════════════ -->
<div class="section">
  <div class="section-title">Your week at a glance</div>
  <div class="two-col">
    <div>
      <div class="subsection-title">Encounters by type <span style="font-size:8px;font-style:italic;font-weight:400">(line = 12-wk avg)</span></div>
      ${encBarsHTML}
    </div>
    <div>
      <div class="subsection-title">People encountered <span style="font-size:8px;font-style:italic;font-weight:400">(line = 12-wk avg)</span></div>
      ${peopleBarsHTML}
    </div>
  </div>

  <div style="margin-top:16px">
    <div class="subsection-title">New people this week</div>
    ${newPeopleHTML}
  </div>

  ${a.moments.length?`
  <div style="margin-top:16px">
    <div class="subsection-title">Moments from the week</div>
    ${momentsHTML}
  </div>`:''}
</div>

<hr class="section-divider"/>

<!-- ═══ SECTION 2: TRENDS ══════════════════════════════════════ -->
<div class="section">
  <div class="section-title">Trends</div>

  <div class="subsection-title">Encounter trajectory &amp; composition — 12 weeks</div>
  <div class="stack-wrap">${stackedHTML}</div>
  <div style="font-size:8px;color:var(--fog);margin-bottom:4px">&#9679; = unique people encountered that week</div>
  <div class="legend">${legendHTML}</div>

  <div style="margin-top:24px">
    <div class="subsection-title">Social breadth — encounter concentration</div>
    <div class="curve-wrap">${curvePointsHTML}</div>
    <div class="curve-labels">
      <span class="curve-axis-label">0% of people</span>
      <span class="curve-axis-label">100% of encounters</span>
    </div>
    <div style="font-size:10px;color:var(--slate);margin-top:6px">
      Each dot is one person. A steep curve means encounters are concentrated among a few people; a gradual curve means broadly distributed.
    </div>
  </div>

  <div style="margin-top:24px">
    <div class="subsection-title">Goals achievability</div>
    <div class="stat-row">
      <div class="stat-box">
        <div class="stat-val">${a.requiredPerDay.toFixed(2)}</div>
        <div class="stat-lbl">Required people/day</div>
        <div class="stat-comp">Based on ${a.peopleWithInterval.length} contacts with intervals set</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${a.actualPerDay7}</div>
        <div class="stat-lbl">Actual last 7 days</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${a.actualPerDay30}</div>
        <div class="stat-lbl">Actual last 30 days</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${a.actualPerDay90}</div>
        <div class="stat-lbl">Actual last 90 days</div>
      </div>
    </div>
  </div>

  <div style="margin-top:24px">
    <div class="subsection-title">Relationship rhythm — interval tracking</div>
    ${rhythmHTML}
  </div>

  ${a.recommendations.length?`
  <div style="margin-top:24px">
    <div class="subsection-title">Suggested interval adjustments</div>
    ${recsHTML}
  </div>`:''}
</div>

<hr class="section-divider"/>

<!-- ═══ SECTION 3: NEXT WEEK ═══════════════════════════════════ -->
<div class="section">
  <div class="section-title">Next week</div>

  <div style="font-size:12px;color:var(--slate);margin-bottom:16px">
    Your relationship goals suggest catching up with approximately
    <strong style="color:var(--navy)">${a.targetPerWeek.toFixed(0)} people</strong> this week
    (${a.requiredPerDay.toFixed(2)} per day).
  </div>

  <div class="suggest-group">
    <div class="suggest-group-title">Due soon</div>
    ${dueSoonHTML}
  </div>
  <div class="suggest-group">
    <div class="suggest-group-title">Long overdue</div>
    ${overdueHTML}
  </div>
  <div class="suggest-group">
    <div class="suggest-group-title">Momentum</div>
    ${momentumHTML}
  </div>

  <div style="margin-top:20px">
    <div class="subsection-title">Birthdays next week</div>
    ${bdHTML}
  </div>

  ${a.yearAgo?`
  <div style="margin-top:20px">
    <div class="subsection-title">One year ago</div>
    ${yearAgoHTML}
  </div>`:''}
</div>

</div><!-- /body -->

<div class="footer">Personal Log · Weekly Report · Generated ${toISO(todayDate)}</div>

</body>
</html>`;
}

function concentrationCurvePoints(curve) { return curve.length; }

// ── PDF + Email ───────────────────────────────────────────────────
async function generatePDF(html) {
  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox']});
  const page=await browser.newPage();
  await page.setContent(html,{waitUntil:'networkidle0'});
  const pdf=await page.pdf({format:'A4',printBackground:true,margin:{top:'0',right:'0',bottom:'0',left:'0'}});
  await browser.close();
  return pdf;
}

async function sendEmail(pdf,weekLabel) {
  const t=nodemailer.createTransport({host:'smtp.gmail.com',port:587,secure:false,auth:{user:SMTP_USER,pass:SMTP_PASSWORD}});
  await t.sendMail({
    from:'"Personal Log" <justin.mitchell.assist@gmail.com>',
    to:RECIPIENT,
    subject:`Weekly Report · ${weekLabel}`,
    text:`Your Personal Log weekly report for ${weekLabel} is attached.`,
    attachments:[{filename:`weekly-${weekLabel.replace(/\s/g,'-')}.pdf`,content:pdf,contentType:'application/pdf'}],
  });
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching data...');
  const {people,encounters,participants}=await fetchData();
  const today=melbourneNow();
  const weekStart=addDays(today.date,-6);
  const weekLabel=`${formatShort(weekStart)}–${formatShort(today.date)} ${today.date.getFullYear()}`;
  console.log(`Generating weekly report: ${weekLabel}`);
  const html=buildHTML(people,encounters,participants,today.date);
  console.log('Generating PDF...');
  const pdf=await generatePDF(html);
  console.log('Sending email...');
  await sendEmail(pdf,weekLabel);
  console.log('Weekly report sent successfully.');
}

main().catch(err=>{console.error('Weekly report failed:',err.message);process.exit(1);});
