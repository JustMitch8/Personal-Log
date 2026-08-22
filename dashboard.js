// dashboard.js — Personal Log analytics dashboard
// 4th screen, same navigation pattern as encounters-log.js
// Shares analytics logic with weekly-brief.js but runs live in browser

// ── Constants ──────────────────────────────────────────────────────
const ALL_TYPES = ['call','1-on-1','small-group','large-group','message','birthday-acknowledgment'];
const TYPE_LABELS = {
  'call':'Call','1-on-1':'1-on-1','small-group':'Small group',
  'large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'
};
const TYPE_COLORS = {
  'call':'#2171A8','1-on-1':'#D4A855','small-group':'#40916C',
  'large-group':'#2D6A4F','message':'#4A5B6E','birthday-acknowledgment':'#E07B9A'
};

// ── Helpers ────────────────────────────────────────────────────────
function db() { return window._plSupabase; }

function addDays(date,n) { const d=new Date(date); d.setDate(d.getDate()+n); return d; }
function toISO(date) {
  const p=n=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
}
function formatShort(date) {
  return date.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
}
function formatDow(date) {
  return date.toLocaleDateString('en-AU',{weekday:'long'});
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Seeded random — same result all day, different tomorrow
function seededRandom(seed) {
  let h=0;
  for(let i=0;i<seed.length;i++) h=Math.imul(31,h)+seed.charCodeAt(i)|0;
  return function(){
    h=Math.imul(h^(h>>>16),0x45d9f3b)|0;
    h=Math.imul(h^(h>>>16),0x45d9f3b)|0;
    return((h^(h>>>16))>>>0)/4294967296;
  };
}
function seededShuffle(arr,seedStr) {
  const rng=seededRandom(seedStr);
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(rng()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

// ── Entry point ────────────────────────────────────────────────────
window.openDashboard = async function() {
  showScreen('dashboard-screen');
  document.getElementById('dashboard-content').innerHTML = '<div class="dash-loading">Loading analytics\u2026</div>';
  try {
    const { people, encounters, participants } = await fetchDashboardData();
    const analytics = computeDashboardAnalytics(people, encounters, participants);
    renderDashboard(analytics, people);
  } catch(e) {
    document.getElementById('dashboard-content').innerHTML =
      `<div class="dash-loading dash-error">Failed to load: ${esc(e.message)}</div>`;
  }
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Data fetch ─────────────────────────────────────────────────────
async function fetchDashboardData() {
  const [
    {data:people,   error:e1},
    {data:encounters,error:e2},
    {data:participants,error:e3},
  ] = await Promise.all([
    db().from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays,firstmet'),
    db().from('encounters').select('id,date,type,description').order('date',{ascending:false}),
    db().from('encounter_participants').select('encounterid,personid'),
  ]);
  if(e1||e2||e3) throw new Error((e1||e2||e3).message);
  return { people:people||[], encounters:encounters||[], participants:participants||[] };
}

// ── Analytics (mirrors weekly-brief logic) ─────────────────────────
function computeDashboardAnalytics(people, encounters, participants) {
  const todayDate = new Date();
  todayDate.setHours(0,0,0,0);
  const todayISO    = toISO(todayDate);
  const weekStart   = addDays(todayDate,-6);
  const weekStartISO= toISO(weekStart);
  const twelveWkStart= toISO(addDays(todayDate,-84));
  const seedStr     = todayISO;

  // Indexes
  const encPartsMap={}, personEncsMap={};
  participants.forEach(({encounterid,personid})=>{
    if(!encPartsMap[encounterid]) encPartsMap[encounterid]=[];
    encPartsMap[encounterid].push(personid);
    if(!personEncsMap[personid]) personEncsMap[personid]=[];
    personEncsMap[personid].push(encounterid);
  });
  const encMap=Object.fromEntries(encounters.map(e=>[e.id,e]));
  const personMap=Object.fromEntries(people.map(p=>[p.id,p]));

  // Week encounters
  const weekEncs=encounters.filter(e=>e.date>=weekStartISO&&e.date<=todayISO);
  const twelveWkEncs=encounters.filter(e=>e.date>=twelveWkStart&&e.date<weekStartISO);
  const priorWeeks=11;

  // Encounter type counts
  const weekTypeCounts={total:weekEncs.length};
  const avgTypeCounts={total:+(twelveWkEncs.length/priorWeeks).toFixed(1)};
  ALL_TYPES.forEach(t=>{
    weekTypeCounts[t]=weekEncs.filter(e=>e.type===t).length;
    avgTypeCounts[t]=+(twelveWkEncs.filter(e=>e.type===t).length/priorWeeks).toFixed(1);
  });

  // People counts
  const weekPeopleCount={};
  weekEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>{
    weekPeopleCount[pid]=(weekPeopleCount[pid]||0)+1;
  }));
  const weekUniquePeople=Object.keys(weekPeopleCount).length;

  let totalUnique=0;
  for(let w=1;w<=priorWeeks;w++){
    const ws=toISO(addDays(todayDate,-(w*7+6)));
    const we=toISO(addDays(todayDate,-(w*7)));
    const pSet=new Set();
    twelveWkEncs.filter(e=>e.date>=ws&&e.date<=we)
      .forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    totalUnique+=pSet.size;
  }
  const avgUniquePeoplePerWeek=+(totalUnique/priorWeeks).toFixed(1);

  const personWeeklyAvg={};
  people.forEach(p=>{
    personWeeklyAvg[p.id]=+(twelveWkEncs.filter(e=>(encPartsMap[e.id]||[]).includes(p.id)).length/priorWeeks).toFixed(1);
  });

  // New people this week
  const newPeople=people.filter(p=>{
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort();
    return dates.length&&dates[0]>=weekStartISO&&dates[0]<=todayISO;
  });

  // 12-week stacked chart
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
      total:wEncs.length, typeCounts,
      uniquePeople:pSet.size, isCurrentWeek:w===0,
    });
  }

  // Concentration curve
  const personCounts=people.map(p=>({
    name:p.name,
    count:encounters.filter(e=>e.date>=twelveWkStart&&e.date<=todayISO&&(encPartsMap[e.id]||[]).includes(p.id)).length
  })).filter(p=>p.count>0).sort((a,b)=>b.count-a.count);
  const totalApp=personCounts.reduce((s,p)=>s+p.count,0)||1;
  let cumSum=0;
  const concentrationCurve=personCounts.map((p,i)=>{
    cumSum+=p.count;
    return {rank:i+1,name:p.name,count:p.count,
      cumulativePct:Math.round((cumSum/totalApp)*100),
      peoplePct:Math.round(((i+1)/personCounts.length)*100)};
  });

  // Goals achievability
  const peopleWithInterval=people.filter(p=>p.contactintervaldays);
  const requiredPerDay=peopleWithInterval.reduce((s,p)=>s+(1/p.contactintervaldays),0);
  const requiredPerWeek=requiredPerDay*7;

  function actualPPD(days) {
    const since=toISO(addDays(todayDate,-days));
    const pSet=new Set();
    encounters.filter(e=>e.date>=since&&e.date<=todayISO)
      .forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    return +(pSet.size/days).toFixed(2);
  }

  // Rhythm histogram
  const rhythmBuckets={ahead:0,onTrack:0,slightlyBehind:0,overdue:0,significantlyOverdue:0};
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length) return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const ratio=daysSince/p.contactintervaldays;
    if(ratio<0.5) rhythmBuckets.ahead++;
    else if(ratio<=1.2) rhythmBuckets.onTrack++;
    else if(ratio<=1.5) rhythmBuckets.slightlyBehind++;
    else if(ratio<=2.0) rhythmBuckets.overdue++;
    else rhythmBuckets.significantlyOverdue++;
  });

  // Recommendations
  const recommendations=[];
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    const allDates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(allDates.length<3) return;
    const recent=allDates.filter(d=>d>=twelveWkStart);
    if(recent.length<2) return;
    let totalGap=0,cnt=0;
    for(let i=0;i<recent.length-1;i++){
      const g=Math.round((new Date(recent[i]+'T00:00:00')-new Date(recent[i+1]+'T00:00:00'))/86400000);
      if(g>0){totalGap+=g;cnt++;}
    }
    if(!cnt) return;
    const actualAvg=Math.round(totalGap/cnt);
    const divergePct=((actualAvg-p.contactintervaldays)/p.contactintervaldays)*100;
    if(Math.abs(divergePct)>=30) {
      recommendations.push({person:p,target:p.contactintervaldays,actualAvg,
        direction:divergePct>0?'increase':'decrease',
        divergePct:Math.round(Math.abs(divergePct))});
    }
  });

  // Section 3: suggestions
  const dueSoon=[];
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length) return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const daysUntilDue=p.contactintervaldays-daysSince;
    if(daysUntilDue>=0&&daysUntilDue<=7) dueSoon.push({person:p,daysUntilDue,daysSince});
  });
  const dueSoonSelected=seededShuffle(dueSoon,seedStr+'due').slice(0,3);

  const longOverdue=[];
  people.forEach(p=>{
    if(!p.contactintervaldays) return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length) return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    if(daysSince<7) return;
    const ratio=daysSince/p.contactintervaldays;
    if(ratio>=1.5) longOverdue.push({person:p,daysSince,ratio});
  });
  const dueSoonIds=new Set(dueSoonSelected.map(d=>d.person.id));
  const longOverdueSelected=seededShuffle(longOverdue.filter(p=>!dueSoonIds.has(p.person.id)),seedStr+'overdue').slice(0,3);

  const twoWkStart=toISO(addDays(todayDate,-14));
  const excludeIds=new Set([...dueSoonSelected.map(d=>d.person.id),...longOverdueSelected.map(d=>d.person.id)]);
  const momentumCandidates=people
    .filter(p=>!excludeIds.has(p.id))
    .map(p=>{
      const recentEncs=encounters.filter(e=>e.date>=twoWkStart&&e.date<=todayISO&&(encPartsMap[e.id]||[]).includes(p.id)).length;
      const avgPer2Wk=+(personWeeklyAvg[p.id]*2);
      return {person:p,recentEncs,avgPer2Wk,delta:recentEncs-avgPer2Wk};
    })
    .filter(p=>p.delta>0&&p.recentEncs>0)
    .sort((a,b)=>b.delta-a.delta).slice(0,3);

  // Birthdays next week
  const nextWeekStart=addDays(todayDate,1);
  const birthdays=people
    .filter(p=>p.birthday_month&&p.birthday_day)
    .map(p=>{
      let next=new Date(nextWeekStart.getFullYear(),p.birthday_month-1,p.birthday_day);
      if(next<nextWeekStart) next=new Date(nextWeekStart.getFullYear()+1,p.birthday_month-1,p.birthday_day);
      return {...p,nextDate:next,daysUntil:Math.round((next-nextWeekStart)/86400000)};
    })
    .filter(p=>p.daysUntil>=0&&p.daysUntil<=6)
    .sort((a,b)=>a.daysUntil-b.daysUntil);

  return {
    weekStart, todayDate, weekStartISO, todayISO,
    weekTypeCounts, avgTypeCounts,
    weekPeopleCount, weekUniquePeople, avgUniquePeoplePerWeek,
    personWeeklyAvg, personMap, newPeople,
    weeklyStacks, concentrationCurve,
    requiredPerDay, requiredPerWeek, peopleWithInterval,
    actualPerDay7:actualPPD(7), actualPerDay30:actualPPD(30), actualPerDay90:actualPPD(90),
    rhythmBuckets, recommendations,
    dueSoonSelected, longOverdueSelected, momentumCandidates,
    birthdays, targetPerWeek:+(requiredPerWeek).toFixed(1),
  };
}

// ── Render ─────────────────────────────────────────────────────────
function renderDashboard(a, people) {
  const content = document.getElementById('dashboard-content');

  const weekLabel = `${formatShort(a.weekStart)} – ${formatShort(a.todayDate)}`;

  // ── Bar chart builders
  function encBarsHTML() {
    const types=[{key:'total',label:'Total'},...ALL_TYPES.map(t=>({key:t,label:TYPE_LABELS[t]}))];
    const maxV=Math.max(...types.map(t=>Math.max(a.weekTypeCounts[t.key]||0,(a.avgTypeCounts[t.key]||0)*1.3)),1);
    return types.map(t=>{
      const val=a.weekTypeCounts[t.key]||0;
      const avg=a.avgTypeCounts[t.key]||0;
      const w=Math.round((val/maxV)*100);
      const avgW=Math.round((avg/maxV)*100);
      const color=t.key==='total'?'#0D1B2A':(TYPE_COLORS[t.key]||'#4A5B6E');
      return `<div class="dash-bar-row">
        <div class="dash-bar-label">${esc(t.label)}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:${color}">
            ${val>0?`<span class="dash-bar-val">${val}</span>`:''}
          </div>
          ${avg>0?`<div class="dash-bar-avg" style="left:${avgW}%" title="12-wk avg: ${avg}"></div>`:''}
        </div>
      </div>`;
    }).join('');
  }

  function peopleBarsHTML() {
    const sorted=Object.entries(a.weekPeopleCount)
      .sort((x,y)=>y[1]-x[1])
      .map(([pid,cnt])=>({person:a.personMap[pid],cnt}))
      .filter(x=>x.person);
    const maxV=Math.max(a.weekUniquePeople,a.avgUniquePeoplePerWeek*1.3,1);
    const rows=[
      `<div class="dash-bar-row">
        <div class="dash-bar-label">Total</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${Math.round((a.weekUniquePeople/maxV)*100)}%;background:#0D1B2A">
            ${a.weekUniquePeople>0?`<span class="dash-bar-val">${a.weekUniquePeople}</span>`:''}
          </div>
          ${a.avgUniquePeoplePerWeek>0?`<div class="dash-bar-avg" style="left:${Math.round((a.avgUniquePeoplePerWeek/maxV)*100)}%"></div>`:''}
        </div>
      </div>`,
      ...sorted.map(({person,cnt})=>{
        const avg=a.personWeeklyAvg[person.id]||0;
        const w=Math.round((cnt/maxV)*100);
        const avgW=Math.round((avg/maxV)*100);
        return `<div class="dash-bar-row">
          <div class="dash-bar-label">${esc(person.name)}</div>
          <div class="dash-bar-track">
            <div class="dash-bar-fill" style="width:${w}%;background:#D4A855">
              <span class="dash-bar-val">${cnt}</span>
            </div>
            ${avg>0?`<div class="dash-bar-avg" style="left:${avgW}%"></div>`:''}
          </div>
        </div>`;
      })
    ];
    return rows.join('');
  }

  function stackedChartHTML() {
    const maxV=Math.max(...a.weeklyStacks.map(w=>Math.max(w.total,w.uniquePeople)),1);
    const cols=a.weeklyStacks.map(w=>{
      const totalH=Math.round((w.total/maxV)*120);
      const peopleH=Math.round((w.uniquePeople/maxV)*120);
      const segs=ALL_TYPES.map(t=>{
        const cnt=w.typeCounts[t]||0;
        if(!cnt) return '';
        const h=Math.round((cnt/maxV)*120);
        return `<div style="height:${h}px;background:${TYPE_COLORS[t]}"></div>`;
      }).reverse().join('');
      return `<div class="dash-stack-col${w.isCurrentWeek?' dash-stack-current':''}">
        <div class="dash-stack-bars">
          <div class="dash-stack-bar" style="height:${totalH}px">${segs}</div>
          <div class="dash-stack-dot" style="bottom:${peopleH}px" title="${w.uniquePeople} people"></div>
        </div>
        <div class="dash-stack-label">${w.label}</div>
      </div>`;
    }).join('');
    const legend=ALL_TYPES.map(t=>
      `<span class="dash-legend-item"><span class="dash-legend-dot" style="background:${TYPE_COLORS[t]}"></span>${TYPE_LABELS[t]}</span>`
    ).join('');
    return `<div class="dash-stack-wrap">${cols}</div>
      <div style="font-size:10px;color:#8A9BAC;margin-bottom:6px">&#9679; = unique people that week</div>
      <div class="dash-legend">${legend}</div>`;
  }

  function curveHTML() {
    const pts=a.concentrationCurve.map(p=>
      `<div class="dash-curve-dot" style="left:${p.peoplePct}%;bottom:${p.cumulativePct}%" title="${esc(p.name)}: ${p.cumulativePct}% of encounters"></div>`
    ).join('');
    return `<div class="dash-curve-wrap">${pts}</div>
      <div class="dash-curve-labels">
        <span>0% of people →</span>
        <span>→ 100% of encounters</span>
      </div>
      <div class="dash-curve-note">Each dot = one person. Steep curve = concentrated. Gradual = distributed.</div>`;
  }

  function rhythmHTML() {
    const total=Object.values(a.rhythmBuckets).reduce((s,v)=>s+v,0)||1;
    const buckets=[
      {key:'ahead',label:'Well ahead',color:'#2D9E5F'},
      {key:'onTrack',label:'On track',color:'#40916C'},
      {key:'slightlyBehind',label:'Slightly behind',color:'#E07B2A'},
      {key:'overdue',label:'Overdue',color:'#C0392B'},
      {key:'significantlyOverdue',label:'Significantly overdue',color:'#7B0000'},
    ];
    return buckets.map(b=>{
      const cnt=a.rhythmBuckets[b.key]||0;
      const w=Math.round((cnt/total)*100);
      return `<div class="dash-bar-row">
        <div class="dash-bar-label" style="font-size:11px;width:140px">${b.label}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:${b.color}">
            ${cnt>0?`<span class="dash-bar-val">${cnt}</span>`:''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function suggestRow(name, detail) {
    return `<div class="dash-suggest-row">
      <span class="dash-suggest-name">${esc(name)}</span>
      <span class="dash-suggest-detail">${esc(detail)}</span>
    </div>`;
  }

  content.innerHTML = `

    <!-- ═ SECTION 1: YOUR WEEK ═════════════════════════════════ -->
    <div class="dash-section-header">
      <span class="dash-section-label">Your week at a glance</span>
      <span class="dash-section-date">${esc(weekLabel)}</span>
    </div>

    <div class="dash-two-col">
      <div class="dash-card">
        <div class="dash-card-title">Encounters by type <span class="dash-avg-note">(line = 12-wk avg)</span></div>
        ${encBarsHTML()}
      </div>
      <div class="dash-card">
        <div class="dash-card-title">People encountered <span class="dash-avg-note">(line = 12-wk avg)</span></div>
        ${peopleBarsHTML()}
      </div>
    </div>

    ${a.newPeople.length?`
    <div class="dash-card" style="margin-top:0">
      <div class="dash-card-title">New people this week</div>
      ${a.newPeople.map(p=>`<div class="dash-new-person">+ ${esc(p.name)}</div>`).join('')}
    </div>`:''}

    <!-- ═ SECTION 2: TRENDS ════════════════════════════════════ -->
    <div class="dash-section-header" style="margin-top:8px">
      <span class="dash-section-label">Trends</span>
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Encounter trajectory &amp; composition — 12 weeks</div>
      ${stackedChartHTML()}
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Social breadth — encounter concentration</div>
      ${curveHTML()}
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Goals achievability</div>
      <div class="dash-stat-row">
        <div class="dash-stat-box">
          <div class="dash-stat-val">${a.requiredPerDay.toFixed(2)}</div>
          <div class="dash-stat-lbl">Required people/day</div>
          <div class="dash-stat-note">${a.peopleWithInterval.length} contacts with intervals</div>
        </div>
        <div class="dash-stat-box">
          <div class="dash-stat-val">${a.actualPerDay7}</div>
          <div class="dash-stat-lbl">Actual last 7d</div>
        </div>
        <div class="dash-stat-box">
          <div class="dash-stat-val">${a.actualPerDay30}</div>
          <div class="dash-stat-lbl">Actual last 30d</div>
        </div>
        <div class="dash-stat-box">
          <div class="dash-stat-val">${a.actualPerDay90}</div>
          <div class="dash-stat-lbl">Actual last 90d</div>
        </div>
      </div>
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Relationship rhythm</div>
      ${rhythmHTML()}
    </div>

    ${a.recommendations.length?`
    <div class="dash-card">
      <div class="dash-card-title">Suggested interval adjustments</div>
      ${a.recommendations.map(r=>`
        <div class="dash-rec-item">
          <span class="dash-rec-name">${esc(r.person.name)}</span>
          Consider ${r.direction==='decrease'?'reducing':'increasing'} interval from
          <strong>${r.target}</strong> to <strong>${r.actualAvg}</strong> days
          &mdash; actual avg ${r.actualAvg}d over 12 weeks
        </div>`).join('')}
    </div>`:''}

    <!-- ═ SECTION 3: NEXT WEEK ══════════════════════════════════ -->
    <div class="dash-section-header" style="margin-top:8px">
      <span class="dash-section-label">Next week</span>
      <span class="dash-section-date">Target: ~${a.targetPerWeek.toFixed(0)} people</span>
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Due soon</div>
      ${a.dueSoonSelected.length
        ? a.dueSoonSelected.map(d=>suggestRow(d.person.name,
            `Due ${d.daysUntilDue===0?'today':`in ${d.daysUntilDue}d`} · last seen ${d.daysSince}d ago`)).join('')
        : '<div class="dash-empty">No contacts due this week.</div>'}
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Long overdue</div>
      ${a.longOverdueSelected.length
        ? a.longOverdueSelected.map(d=>suggestRow(d.person.name,
            `${d.daysSince}d since last seen · ${(Math.round(d.ratio*10)/10)}× their interval`)).join('')
        : '<div class="dash-empty">No significantly overdue contacts.</div>'}
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Momentum</div>
      ${a.momentumCandidates.length
        ? a.momentumCandidates.map(d=>suggestRow(d.person.name,
            `${d.recentEncs} encounters in 2 weeks vs avg ${d.avgPer2Wk.toFixed(1)}`)).join('')
        : '<div class="dash-empty">No momentum contacts identified.</div>'}
    </div>

    ${a.birthdays.length?`
    <div class="dash-card">
      <div class="dash-card-title">Birthdays next week</div>
      ${a.birthdays.map(p=>suggestRow(p.name,formatDow(p.nextDate))).join('')}
    </div>`:''}

  `;
}

// ── Wire up ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const backBtn = document.getElementById('dashboard-back-btn');
  if (backBtn) backBtn.addEventListener('click', () => {
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('app-screen').classList.add('active');
  });
});
