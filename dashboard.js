// dashboard.js — Personal Log analytics dashboard v2

const ALL_TYPES = ['call','1-on-1','small-group','large-group','message','birthday-acknowledgment'];
const TYPE_LABELS = {
  'call':'Call','1-on-1':'1-on-1','small-group':'Small group',
  'large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'
};
const TYPE_COLORS = {
  'call':'#2171A8','1-on-1':'#D4A855','small-group':'#40916C',
  'large-group':'#2D6A4F','message':'#4A5B6E','birthday-acknowledgment':'#E07B9A'
};
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function db() { return window._plSupabase; }
function addDays(date,n){const d=new Date(date);d.setDate(d.getDate()+n);return d;}
function toISO(date){const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;}
function formatShort(date){return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;}
function formatMedium(date){return `${date.getDate()} ${MONTHS_LONG[date.getMonth()]}`;}
function formatDow(date){return date.toLocaleDateString('en-AU',{weekday:'long'});}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

function seededRandom(seed){
  let h=0;for(let i=0;i<seed.length;i++)h=Math.imul(31,h)+seed.charCodeAt(i)|0;
  return function(){h=Math.imul(h^(h>>>16),0x45d9f3b)|0;h=Math.imul(h^(h>>>16),0x45d9f3b)|0;return((h^(h>>>16))>>>0)/4294967296;};
}
function seededShuffle(arr,seedStr){
  const rng=seededRandom(seedStr);const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}

// ── Entry point ────────────────────────────────────────────────────
window.openDashboard = async function() {
  showScreen('dashboard-screen');
  document.getElementById('dashboard-content').innerHTML='<div class="dash-loading">Loading analytics\u2026</div>';
  try {
    const {people,encounters,participants}=await fetchDashboardData();
    const a=computeAnalytics(people,encounters,participants);
    renderDashboard(a,people);
  } catch(e) {
    document.getElementById('dashboard-content').innerHTML=
      `<div class="dash-loading dash-error">Failed to load: ${esc(e.message)}</div>`;
  }
};

function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');}

async function fetchDashboardData(){
  const [{data:people,error:e1},{data:encounters,error:e2},{data:participants,error:e3}]=await Promise.all([
    db().from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays,firstmet'),
    db().from('encounters').select('id,date,type,description').order('date',{ascending:false}),
    db().from('encounter_participants').select('encounterid,personid'),
  ]);
  if(e1||e2||e3) throw new Error((e1||e2||e3).message);
  return {people:people||[],encounters:encounters||[],participants:participants||[]};
}

// ── Analytics ──────────────────────────────────────────────────────
function computeAnalytics(people,encounters,participants){
  const todayDate=new Date();todayDate.setHours(0,0,0,0);
  const todayISO=toISO(todayDate);
  const weekStart=addDays(todayDate,-6);
  const weekStartISO=toISO(weekStart);
  const twelveWkStart=toISO(addDays(todayDate,-84));
  const seedStr=todayISO;
  const priorWeeks=11;

  const encPartsMap={},personEncsMap={};
  participants.forEach(({encounterid,personid})=>{
    if(!encPartsMap[encounterid])encPartsMap[encounterid]=[];encPartsMap[encounterid].push(personid);
    if(!personEncsMap[personid])personEncsMap[personid]=[];personEncsMap[personid].push(encounterid);
  });
  const encMap=Object.fromEntries(encounters.map(e=>[e.id,e]));
  const personMap=Object.fromEntries(people.map(p=>[p.id,p]));

  const weekEncs=encounters.filter(e=>e.date>=weekStartISO&&e.date<=todayISO);
  const twelveWkEncs=encounters.filter(e=>e.date>=twelveWkStart&&e.date<weekStartISO);

  // Type counts
  const weekTypeCounts={};const avgTypeCounts={};
  ALL_TYPES.forEach(t=>{
    weekTypeCounts[t]=weekEncs.filter(e=>e.type===t).length;
    avgTypeCounts[t]=+(twelveWkEncs.filter(e=>e.type===t).length/priorWeeks).toFixed(1);
  });

  // People counts
  const weekPeopleCount={};
  let weekTotalAppearances=0;
  weekEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>{
    weekPeopleCount[pid]=(weekPeopleCount[pid]||0)+1;
    weekTotalAppearances++;
  }));
  const weekUniquePeople=Object.keys(weekPeopleCount).length;

  // 12-wk avg unique people per week
  let totalUnique=0;
  for(let w=1;w<=priorWeeks;w++){
    const ws=toISO(addDays(todayDate,-(w*7+6)));const we=toISO(addDays(todayDate,-(w*7)));
    const pSet=new Set();
    twelveWkEncs.filter(e=>e.date>=ws&&e.date<=we).forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    totalUnique+=pSet.size;
  }
  const avgUniquePeoplePerWeek=+(totalUnique/priorWeeks).toFixed(1);

  // 12-wk avg total appearances per week
  let totalAppearances12wk=0;
  for(let w=1;w<=priorWeeks;w++){
    const ws=toISO(addDays(todayDate,-(w*7+6)));const we=toISO(addDays(todayDate,-(w*7)));
    const cnt=participants.filter(p=>{
      const enc=encMap[p.encounterid];
      return enc&&enc.date>=ws&&enc.date<=we;
    }).length;
    totalAppearances12wk+=cnt;
  }
  const avgTotalAppearances=+(totalAppearances12wk/priorWeeks).toFixed(1);

  // Per-person weekly avg appearances
  const personWeeklyAvg={};
  people.forEach(p=>{personWeeklyAvg[p.id]=+(twelveWkEncs.filter(e=>(encPartsMap[e.id]||[]).includes(p.id)).length/priorWeeks).toFixed(1);});

  // KPI deltas
  const weekTotalEncs=weekEncs.length;
  const avgTotalEncs=+(twelveWkEncs.length/priorWeeks).toFixed(1);

  function kpiDelta(actual,avg){
    const diff=+(actual-avg).toFixed(1);
    const pct=avg>0?Math.round((diff/avg)*100):null;
    return {diff,pct,up:diff>=0};
  }

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
    const typeCounts={};ALL_TYPES.forEach(t=>{typeCounts[t]=wEncs.filter(e=>e.type===t).length;});
    const pSet=new Set();wEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    weeklyStacks.push({label:formatShort(new Date(ws)),total:wEncs.length,typeCounts,uniquePeople:pSet.size,isCurrentWeek:w===0});
  }
  const maxStackVal=Math.max(...weeklyStacks.map(w=>Math.max(w.total,w.uniquePeople)),1);

  // Social breadth scatter: actual vs expected encounters per person over 12 weeks
  // Observed: sorted descending independently
  const obsPoints=people.map(p=>({
    name:p.name,
    count:encounters.filter(e=>e.date>=twelveWkStart&&e.date<=todayISO&&(encPartsMap[e.id]||[]).includes(p.id)).length,
  })).filter(p=>p.count>0).sort((a,b)=>b.count-a.count);

  // Expected: 84/interval for people with interval, sorted descending independently
  const expPoints=people.filter(p=>p.contactintervaldays).map(p=>({
    name:p.name,
    count:+(84/p.contactintervaldays).toFixed(1),
  })).sort((a,b)=>b.count-a.count);

  const scatterMaxY=Math.max(
    obsPoints.length?obsPoints[0].count:0,
    expPoints.length?expPoints[0].count:0,
    1
  );
  const scatterN=Math.max(obsPoints.length,expPoints.length,1);

  // Goals achievability
  const peopleWithInterval=people.filter(p=>p.contactintervaldays);
  const requiredPerDay=peopleWithInterval.reduce((s,p)=>s+(1/p.contactintervaldays),0);
  const requiredPerWeek=requiredPerDay*7;
  function actualPPD(days){
    const since=toISO(addDays(todayDate,-days));const pSet=new Set();
    encounters.filter(e=>e.date>=since&&e.date<=todayISO).forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    return +(pSet.size/days).toFixed(2);
  }

  // Rhythm histogram + stats
  const rhythmBuckets={ahead:0,onTrack:0,slightlyBehind:0,overdue:0,significantlyOverdue:0};
  const totalPeople=people.length;
  const totalWithInterval=people.filter(p=>p.contactintervaldays).length;
  people.forEach(p=>{
    if(!p.contactintervaldays)return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length)return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const ratio=daysSince/p.contactintervaldays;
    if(ratio<0.5)rhythmBuckets.ahead++;
    else if(ratio<=1.2)rhythmBuckets.onTrack++;
    else if(ratio<=1.5)rhythmBuckets.slightlyBehind++;
    else if(ratio<=2.0)rhythmBuckets.overdue++;
    else rhythmBuckets.significantlyOverdue++;
  });

  // Recommendations
  const recommendations=[];
  people.forEach(p=>{
    if(!p.contactintervaldays)return;
    const allDates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(allDates.length<3)return;
    const recent=allDates.filter(d=>d>=twelveWkStart);
    if(recent.length<2)return;
    let totalGap=0,cnt=0;
    for(let i=0;i<recent.length-1;i++){const g=Math.round((new Date(recent[i]+'T00:00:00')-new Date(recent[i+1]+'T00:00:00'))/86400000);if(g>0){totalGap+=g;cnt++;}}
    if(!cnt)return;
    const actualAvg=Math.round(totalGap/cnt);
    const divergePct=((actualAvg-p.contactintervaldays)/p.contactintervaldays)*100;
    if(Math.abs(divergePct)>=30)recommendations.push({person:p,target:p.contactintervaldays,actualAvg,direction:divergePct>0?'increase':'decrease'});
  });

  // Suggestions
  const dueSoon=[];
  people.forEach(p=>{
    if(!p.contactintervaldays)return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length)return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const daysUntilDue=p.contactintervaldays-daysSince;
    if(daysUntilDue>=0&&daysUntilDue<=7)dueSoon.push({person:p,daysUntilDue,daysSince});
  });
  const dueSoonSelected=seededShuffle(dueSoon,seedStr+'due').slice(0,3);

  const longOverdue=[];
  people.forEach(p=>{
    if(!p.contactintervaldays)return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length)return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    if(daysSince<7)return;
    const ratio=daysSince/p.contactintervaldays;
    if(ratio>=1.5)longOverdue.push({person:p,daysSince,ratio});
  });
  const dueSoonIds=new Set(dueSoonSelected.map(d=>d.person.id));
  const longOverdueSelected=seededShuffle(longOverdue.filter(p=>!dueSoonIds.has(p.person.id)),seedStr+'overdue').slice(0,3);

  const twoWkStart=toISO(addDays(todayDate,-14));
  const excludeIds=new Set([...dueSoonSelected.map(d=>d.person.id),...longOverdueSelected.map(d=>d.person.id)]);
  const momentumCandidates=people.filter(p=>!excludeIds.has(p.id)).map(p=>{
    const recentEncs=encounters.filter(e=>e.date>=twoWkStart&&e.date<=todayISO&&(encPartsMap[e.id]||[]).includes(p.id)).length;
    const avgPer2Wk=+(personWeeklyAvg[p.id]*2);
    return {person:p,recentEncs,avgPer2Wk,delta:recentEncs-avgPer2Wk};
  }).filter(p=>p.delta>0&&p.recentEncs>0).sort((a,b)=>b.delta-a.delta).slice(0,3);

  // Full birthday section (like daily report)
  const allWithBirthday=people.filter(p=>p.birthday_month&&p.birthday_day).map(p=>{
    let next=new Date(todayDate.getFullYear(),p.birthday_month-1,p.birthday_day);
    if(next<todayDate)next=new Date(todayDate.getFullYear()+1,p.birthday_month-1,p.birthday_day);
    const daysUntil=Math.round((next-todayDate)/86400000);
    let ageStr='';
    if(p.birthday_year){const age=next.getFullYear()-p.birthday_year;ageStr=`turning ${age}`;}
    else ageStr='age unknown';
    return {...p,nextDate:next,daysUntil,ageStr};
  }).sort((a,b)=>a.daysUntil-b.daysUntil);

  const bdToday=allWithBirthday.filter(p=>p.daysUntil===0);
  const bdWeek=allWithBirthday.filter(p=>p.daysUntil>0&&p.daysUntil<=7);
  const bdNext=allWithBirthday.filter(p=>p.daysUntil>7).slice(0,3);
  const birthdayKnown=people.filter(p=>p.birthday_month&&p.birthday_day).length;
  const birthdayTotal=people.length;
  const birthdayPct=birthdayTotal>0?Math.round((birthdayKnown/birthdayTotal)*100):0;

  return {
    weekStart,todayDate,weekStartISO,todayISO,
    weekTotalEncs,avgTotalEncs,
    kpiEncs:kpiDelta(weekTotalEncs,avgTotalEncs),
    weekTotalAppearances,avgTotalAppearances,
    kpiAppearances:kpiDelta(weekTotalAppearances,avgTotalAppearances),
    weekUniquePeople,avgUniquePeoplePerWeek,
    kpiPeople:kpiDelta(weekUniquePeople,avgUniquePeoplePerWeek),
    weekTypeCounts,avgTypeCounts,
    weekPeopleCount,personWeeklyAvg,personMap,newPeople,
    weeklyStacks,maxStackVal,
    obsPoints,expPoints,scatterMaxY,scatterN,
    requiredPerDay,requiredPerWeek,peopleWithInterval,
    actualPerDay7:actualPPD(7),actualPerDay30:actualPPD(30),actualPerDay90:actualPPD(90),
    rhythmBuckets,totalPeople,totalWithInterval,recommendations,
    dueSoonSelected,longOverdueSelected,momentumCandidates,
    targetPerWeek:+(requiredPerWeek).toFixed(1),
    bdToday,bdWeek,bdNext,birthdayKnown,birthdayTotal,birthdayPct,
  };
}

// ── Render ──────────────────────────────────────────────────────────
function renderDashboard(a,people){
  const content=document.getElementById('dashboard-content');
  const weekLabel=`${formatShort(a.weekStart)} – ${formatShort(a.todayDate)}`;

  // ── KPI box
  function kpiBox(label,value,delta,avg){
    const arrow=delta.up?'&#x2191;':'&#x2191;';
    const cls=delta.up?'kpi-up':'kpi-dn';
    const sign=delta.diff>=0?'+':'';
    const pctStr=delta.pct!==null?` (${delta.pct>=0?'+':''}${delta.pct}%)`:'';
    return `<div class="dash-kpi-box">
      <div class="dash-kpi-val">${value}</div>
      <div class="dash-kpi-lbl">${esc(label)}</div>
      <div class="dash-kpi-delta ${cls}">${delta.up?'&#x2191;':'&#x2193;'} ${sign}${delta.diff}${pctStr}</div>
      <div class="dash-kpi-avg">12-wk avg: ${avg}</div>
    </div>`;
  }

  // ── Encounter bars (no total row)
  function encBarsHTML(){
    const maxV=Math.max(...ALL_TYPES.map(t=>Math.max(a.weekTypeCounts[t]||0,(a.avgTypeCounts[t]||0)*1.3)),1);
    return ALL_TYPES.map(t=>{
      const val=a.weekTypeCounts[t]||0;
      const avg=a.avgTypeCounts[t]||0;
      const target=avg; // baseline = 12wk avg
      const w=Math.round((val/maxV)*100);
      const avgW=Math.round((avg/maxV)*100);
      return `<div class="dash-bar-row">
        <div class="dash-bar-label">${esc(TYPE_LABELS[t])}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:${TYPE_COLORS[t]}">
            ${val>0?`<span class="dash-bar-val">${val}</span>`:''}
          </div>
          ${avg>0?`<div class="dash-bar-avg" style="left:${avgW}%" title="12-wk avg: ${avg}"></div>`:''}
        </div>
      </div>`;
    }).join('');
  }

  // ── People bars (no total row)
  function peopleBarsHTML(){
    const sorted=Object.entries(a.weekPeopleCount).sort((x,y)=>y[1]-x[1])
      .map(([pid,cnt])=>({person:a.personMap[pid],cnt})).filter(x=>x.person);
    if(!sorted.length) return '<div class="dash-empty">No encounters this week.</div>';
    const maxV=Math.max(...sorted.map(p=>Math.max(p.cnt,(a.personWeeklyAvg[p.person.id]||0)*1.3)),1);
    return sorted.map(({person,cnt})=>{
      const avg=a.personWeeklyAvg[person.id]||0;
      // target per week = 7/interval
      const targetPerWk=person.contactintervaldays?+(7/person.contactintervaldays).toFixed(2):null;
      const w=Math.round((cnt/maxV)*100);
      const avgW=Math.round((avg/maxV)*100);
      const targetW=targetPerWk?Math.round((targetPerWk/maxV)*100):null;
      return `<div class="dash-bar-row">
        <div class="dash-bar-label">${esc(person.name)}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:#D4A855">
            <span class="dash-bar-val">${cnt}</span>
          </div>
          ${avg>0?`<div class="dash-bar-avg" style="left:${avgW}%" title="12-wk avg: ${avg}"></div>`:''}
          ${targetW!==null?`<div class="dash-bar-target" style="left:${targetW}%" title="Weekly target: ${targetPerWk}"></div>`:''}
        </div>
      </div>`;
    }).join('');
  }

  // ── Stacked chart with axes
  function stackedChartHTML(){
    const maxV=a.maxStackVal;
    // Y axis labels (0, half, max)
    const yMid=Math.round(maxV/2);
    const cols=a.weeklyStacks.map(w=>{
      const totalH=Math.round((w.total/maxV)*120);
      const peopleH=Math.round((w.uniquePeople/maxV)*120);
      const segs=ALL_TYPES.map(t=>{
        const cnt=w.typeCounts[t]||0;if(!cnt)return'';
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
    return `<div class="dash-chart-wrap">
      <div class="dash-y-axis">
        <span>${maxV}</span><span>${yMid}</span><span>0</span>
      </div>
      <div style="flex:1;min-width:0">
        <div class="dash-stack-wrap">${cols}</div>
        <div class="dash-x-axis-line"></div>
      </div>
    </div>
    <div style="font-size:10px;color:#8A9BAC;margin:4px 0 4px 28px">&#9679; = unique people that week</div>
    <div class="dash-legend" style="margin-left:28px">${legend}</div>`;
  }

  // ── Social breadth scatter
  function curveHTML(){
    if(!a.obsPoints.length&&!a.expPoints.length) return '<div class="dash-empty">Not enough data yet.</div>';
    const maxY=a.scatterMaxY;
    const n=a.scatterN;

    // Y axis: 4 marks from 0 to maxY
    const yStep=Math.ceil(maxY/3);
    const yMarks=[0,yStep,yStep*2,maxY].filter((v,i,arr)=>arr.indexOf(v)===i).map(v=>
      `<div class="dash-curve-y-mark" style="bottom:${Math.round((v/maxY)*100)}%"><span>${v}</span></div>`
    ).join('');

    // Dots: x position = rank/total across shared x-axis width
    const obsDots=a.obsPoints.map((p,i)=>{
      const x=n>1?Math.round((i/(n-1))*100):50;
      const y=Math.round((p.count/maxY)*100);
      return `<div class="dash-curve-dot dash-curve-obs" style="left:${x}%;bottom:${y}%" title="${esc(p.name)}: ${p.count} encounters"></div>`;
    }).join('');

    const expDots=a.expPoints.map((p,i)=>{
      const x=n>1?Math.round((i/(n-1))*100):50;
      const y=Math.round((p.count/maxY)*100);
      return `<div class="dash-curve-dot dash-curve-target" style="left:${x}%;bottom:${y}%" title="${esc(p.name)}: ${p.count.toFixed(1)} expected"></div>`;
    }).join('');

    // X-axis ticks — rank numbers evenly spaced
    const xTickCount=Math.min(n,6);
    const xTicks=Array.from({length:xTickCount},(_,i)=>{
      const rank=Math.round((i/(xTickCount-1))*(n-1))+1;
      const pct=n>1?Math.round(((rank-1)/(n-1))*100):0;
      return `<div class="dash-curve-x-mark" style="left:${pct}%"><span>${rank}</span></div>`;
    }).join('');

    // Y-axis label (rotated)
    const yAxisLabel=`<div class="dash-curve-y-title">Encounters (12 wks)</div>`;

    return `<div style="display:flex;align-items:center;gap:2px">
      ${yAxisLabel}
      <div class="dash-curve-outer" style="flex:1">
        <div class="dash-curve-y-axis">${yMarks}</div>
        <div style="flex:1;min-width:0">
          <div class="dash-curve-wrap">${obsDots}${expDots}</div>
          <div class="dash-curve-x-axis" style="position:relative;height:16px">${xTicks}</div>
          <div style="font-size:0.55rem;color:var(--slate);text-align:center;margin-top:1px">Rank (each series sorted independently, most &#x2192; least)</div>
        </div>
      </div>
    </div>
    <div class="dash-curve-legend">
      <span><span class="dash-curve-dot dash-curve-obs" style="position:relative;display:inline-block;width:8px;height:8px;vertical-align:middle;bottom:auto;left:auto"></span> Actual (12 wks)</span>
      <span><span class="dash-curve-dot dash-curve-target" style="position:relative;display:inline-block;width:8px;height:8px;vertical-align:middle;bottom:auto;left:auto"></span> Expected (12 wks, ranked separately)</span>
    </div>`;
  }

  // ── Rhythm bars
  function rhythmHTML(){
    const total=Object.values(a.rhythmBuckets).reduce((s,v)=>s+v,0)||1;
    const buckets=[
      {key:'ahead',label:'Well ahead',color:'#2D9E5F'},
      {key:'onTrack',label:'On track',color:'#40916C'},
      {key:'slightlyBehind',label:'Slightly behind',color:'#E07B2A'},
      {key:'overdue',label:'Overdue',color:'#C0392B'},
      {key:'significantlyOverdue',label:'Significantly overdue',color:'#7B0000'},
    ];
    const statsRow=`<div class="dash-rhythm-stats">
      <span>${a.totalPeople} total contacts</span>
      <span>·</span>
      <span>${a.totalWithInterval} with intervals set</span>
      <span>·</span>
      <span>${a.totalPeople-a.totalWithInterval} without</span>
    </div>`;
    const bars=buckets.map(b=>{
      const cnt=a.rhythmBuckets[b.key]||0;
      const w=Math.round((cnt/total)*100);
      return `<div class="dash-bar-row">
        <div class="dash-bar-label" style="width:130px;font-size:0.68rem">${b.label}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:${b.color}">
            ${cnt>0?`<span class="dash-bar-val">${cnt}</span>`:''}
          </div>
        </div>
      </div>`;
    }).join('');
    return statsRow+bars;
  }

  function suggestRow(name,detail){
    return `<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(name)}</span><span class="dash-suggest-detail">${esc(detail)}</span></div>`;
  }

  // ── Birthday section
  function birthdayHTML(){
    const pct=a.birthdayPct;
    // Interpolate from red(0%) through amber(50%) to green(100%)
    const fracColor=pct>=100?'#2D9E5F':pct>=50?`rgb(${Math.round(212-((pct-50)/50)*212)},${Math.round(168+((pct-50)/50)*22)},${Math.round(85-85*((pct-50)/50))})`
      :`rgb(${Math.round(192+((pct/50)*20))},${Math.round(57+((pct/50)*111))},${Math.round(43+((pct/50)*42))})`;
    const popper=pct>=100?' 🎉':'';
    const fracHTML=`<div class="dash-bd-fraction" style="color:${fracColor}">${a.birthdayKnown}/${a.birthdayTotal} birthdays known${popper}</div>`;

    let html=fracHTML;

    if(a.bdToday.length){
      html+=`<div class="dash-bd-subhead">Today</div>`;
      html+=a.bdToday.map(p=>`<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(p.name)}</span><span class="dash-suggest-detail">${p.ageStr}</span></div>`).join('');
    }

    if(a.bdWeek.length){
      html+=`<div class="dash-bd-subhead">This week</div>`;
      html+=a.bdWeek.map(p=>`<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(p.name)}</span><span class="dash-suggest-detail">${formatDow(p.nextDate)} · ${p.ageStr}</span></div>`).join('');
    } else {
      html+=`<div class="dash-empty" style="margin:4px 0">No birthdays in the next 7 days.</div>`;
    }

    if(a.bdNext.length){
      html+=`<div class="dash-bd-subhead">Next birthdays</div>`;
      html+=a.bdNext.map(p=>`<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(p.name)}</span><span class="dash-suggest-detail">${formatMedium(p.nextDate)} · ${p.ageStr}</span></div>`).join('');
    }

    return html;
  }

  content.innerHTML=`

    <!-- SECTION 1 -->
    <div class="dash-section-header">
      <span class="dash-section-label">Your week at a glance</span>
      <span class="dash-section-date">${esc(weekLabel)}</span>
    </div>

    <div class="dash-kpi-row">
      ${kpiBox('Total encounters',a.weekTotalEncs,a.kpiEncs,a.avgTotalEncs)}
      ${kpiBox('Unique people',a.weekUniquePeople,a.kpiPeople,a.avgUniquePeoplePerWeek)}
      ${kpiBox('Social activity',a.weekTotalAppearances,a.kpiAppearances,a.avgTotalAppearances)}
    </div>

    <div class="dash-two-col">
      <div class="dash-card">
        <div class="dash-card-title">Encounters by type <span class="dash-avg-note">(line = 12-wk avg)</span></div>
        ${encBarsHTML()}
      </div>
      <div class="dash-card">
        <div class="dash-card-title">People encountered <span class="dash-avg-note">(white = avg · green = target)</span></div>
        ${peopleBarsHTML()}
      </div>
    </div>

    ${a.newPeople.length?`
    <div class="dash-card" style="margin-top:0">
      <div class="dash-card-title">New people this week</div>
      ${a.newPeople.map(p=>`<div class="dash-new-person">+ ${esc(p.name)}</div>`).join('')}
    </div>`:''}

    <!-- SECTION 2 -->
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
      ${a.recommendations.map(r=>`<div class="dash-rec-item"><span class="dash-rec-name">${esc(r.person.name)}</span> Consider ${r.direction==='decrease'?'reducing':'increasing'} from <strong>${r.target}</strong> to <strong>${r.actualAvg}</strong> days &mdash; actual avg over 12 weeks</div>`).join('')}
    </div>`:''}

    <!-- SECTION 3 -->
    <div class="dash-section-header" style="margin-top:8px">
      <span class="dash-section-label">Next week</span>
      <span class="dash-section-date">Target: ~${a.targetPerWeek.toFixed(0)} people</span>
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Due soon</div>
      ${a.dueSoonSelected.length?a.dueSoonSelected.map(d=>suggestRow(d.person.name,`Due ${d.daysUntilDue===0?'today':`in ${d.daysUntilDue}d`} · last seen ${d.daysSince}d ago`)).join(''):'<div class="dash-empty">No contacts due this week.</div>'}
    </div>
    <div class="dash-card">
      <div class="dash-card-title">Long overdue</div>
      ${a.longOverdueSelected.length?a.longOverdueSelected.map(d=>suggestRow(d.person.name,`${d.daysSince}d since last seen · ${(Math.round(d.ratio*10)/10)}× their interval`)).join(''):'<div class="dash-empty">No significantly overdue contacts.</div>'}
    </div>
    <div class="dash-card">
      <div class="dash-card-title">Momentum</div>
      ${a.momentumCandidates.length?a.momentumCandidates.map(d=>suggestRow(d.person.name,`${d.recentEncs} encounters in 2 weeks vs avg ${d.avgPer2Wk.toFixed(1)}`)).join(''):'<div class="dash-empty">No momentum contacts identified.</div>'}
    </div>

    <!-- BIRTHDAYS -->
    <div class="dash-section-header" style="margin-top:8px">
      <span class="dash-section-label">Birthdays</span>
    </div>
    <div class="dash-card">
      ${birthdayHTML()}
    </div>

    <div style="height:2rem"></div>
  `;
}

document.addEventListener('DOMContentLoaded',()=>{
  const btn=document.getElementById('dashboard-back-btn');
  if(btn)btn.addEventListener('click',()=>{document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById('app-screen').classList.add('active');});
});
