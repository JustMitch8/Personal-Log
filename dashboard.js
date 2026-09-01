// dashboard.js — Personal Log analytics dashboard v3 (interactive)
import { writeIntervalChangeNote } from './utils.js';

const ALL_TYPES = ['call','1-on-1','small-group','large-group','message','birthday-acknowledgment'];
const TYPE_LABELS = {'call':'Call','1-on-1':'1-on-1','small-group':'Small group','large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'};
const TYPE_COLORS = {'call':'#2171A8','1-on-1':'#D4A855','small-group':'#40916C','large-group':'#2D6A4F','message':'#4A5B6E','birthday-acknowledgment':'#E07B9A'};
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function db(){return window._plSupabase;}
function addDays(d,n){const r=new Date(d);r.setDate(r.getDate()+n);return r;}
function toISO(d){const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function formatShort(d){return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;}
function formatMedium(d){return `${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;}
function formatDow(d){return d.toLocaleDateString('en-AU',{weekday:'long'});}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function seededRandom(seed){let h=0;for(let i=0;i<seed.length;i++)h=Math.imul(31,h)+seed.charCodeAt(i)|0;return function(){h=Math.imul(h^(h>>>16),0x45d9f3b)|0;h=Math.imul(h^(h>>>16),0x45d9f3b)|0;return((h^(h>>>16))>>>0)/4294967296;};}
function seededShuffle(arr,s){const rng=seededRandom(s);const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

// ── State for interval adjustment modal ───────────────────────────
let _intervalModalPerson = null;
let _allPeopleCache = [];

// ── Entry point ────────────────────────────────────────────────────
window.openDashboard = async function() {
  showScreen('dashboard-screen');
  document.getElementById('dashboard-content').innerHTML='<div class="dash-loading">Loading analytics\u2026</div>';
  try {
    const {people,encounters,participants}=await fetchDashboardData();
    _allPeopleCache = people;
    const a=computeAnalytics(people,encounters,participants);
    renderDashboard(a,people,encounters,participants);
  } catch(e) {
    document.getElementById('dashboard-content').innerHTML=`<div class="dash-loading dash-error">Failed to load: ${esc(e.message)}</div>`;
  }
};

function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');}

async function fetchDashboardData(){
  const [{data:people,error:e1},{data:encounters,error:e2},{data:participants,error:e3}]=await Promise.all([
    db().from('people').select('id,name,birthday_day,birthday_month,birthday_year,contactintervaldays,notes,firstmet'),
    db().from('encounters').select('id,date,type,description').order('date',{ascending:false}),
    db().from('encounter_participants').select('encounterid,personid'),
  ]);
  if(e1||e2||e3) throw new Error((e1||e2||e3).message);
  return {people:people||[],encounters:encounters||[],participants:participants||[]};
}

// ── Analytics (unchanged from v2) ─────────────────────────────────
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

  const weekTypeCounts={};const avgTypeCounts={};
  ALL_TYPES.forEach(t=>{weekTypeCounts[t]=weekEncs.filter(e=>e.type===t).length;avgTypeCounts[t]=+(twelveWkEncs.filter(e=>e.type===t).length/priorWeeks).toFixed(1);});

  const weekPeopleCount={};let weekTotalAppearances=0;
  weekEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>{weekPeopleCount[pid]=(weekPeopleCount[pid]||0)+1;weekTotalAppearances++;}));
  const weekUniquePeople=Object.keys(weekPeopleCount).length;

  let totalUnique=0;
  for(let w=1;w<=priorWeeks;w++){const ws=toISO(addDays(todayDate,-(w*7+6)));const we=toISO(addDays(todayDate,-(w*7)));const pSet=new Set();twelveWkEncs.filter(e=>e.date>=ws&&e.date<=we).forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));totalUnique+=pSet.size;}
  const avgUniquePeoplePerWeek=+(totalUnique/priorWeeks).toFixed(1);

  let totalAppearances12wk=0;
  for(let w=1;w<=priorWeeks;w++){const ws=toISO(addDays(todayDate,-(w*7+6)));const we=toISO(addDays(todayDate,-(w*7)));totalAppearances12wk+=participants.filter(p=>{const enc=encMap[p.encounterid];return enc&&enc.date>=ws&&enc.date<=we;}).length;}
  const avgTotalAppearances=+(totalAppearances12wk/priorWeeks).toFixed(1);

  const personWeeklyAvg={};
  people.forEach(p=>{personWeeklyAvg[p.id]=+(twelveWkEncs.filter(e=>(encPartsMap[e.id]||[]).includes(p.id)).length/priorWeeks).toFixed(1);});

  const weekTotalEncs=weekEncs.length;
  const avgTotalEncs=+(twelveWkEncs.length/priorWeeks).toFixed(1);
  function kpiDelta(actual,avg){const diff=+(actual-avg).toFixed(1);const pct=avg>0?Math.round((diff/avg)*100):null;return {diff,pct,up:diff>=0};}

  const newPeople=people.filter(p=>{const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort();return dates.length&&dates[0]>=weekStartISO&&dates[0]<=todayISO;});

  const weeklyStacks=[];
  for(let w=11;w>=0;w--){
    const ws=w===0?weekStartISO:toISO(addDays(todayDate,-(w*7+6)));
    const we=w===0?todayISO:toISO(addDays(todayDate,-(w*7)));
    const wEncs=encounters.filter(e=>e.date>=ws&&e.date<=we);
    const typeCounts={};ALL_TYPES.forEach(t=>{typeCounts[t]=wEncs.filter(e=>e.type===t).length;});
    const pSet=new Set();wEncs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));
    weeklyStacks.push({label:formatShort(new Date(ws)),total:wEncs.length,typeCounts,uniquePeople:pSet.size,isCurrentWeek:w===0,weekStartISO:ws,weekEndISO:we});
  }
  const maxStackVal=Math.max(...weeklyStacks.map(w=>Math.max(w.total,w.uniquePeople)),1);

  const obsPoints=people.map(p=>({name:p.name,count:encounters.filter(e=>e.date>=twelveWkStart&&e.date<=todayISO&&(encPartsMap[e.id]||[]).includes(p.id)).length})).filter(p=>p.count>0).sort((a,b)=>b.count-a.count);
  const expPoints=people.filter(p=>p.contactintervaldays).map(p=>({name:p.name,count:+(84/p.contactintervaldays).toFixed(1)})).sort((a,b)=>b.count-a.count);
  const scatterMaxY=Math.max(obsPoints.length?obsPoints[0].count:0,expPoints.length?expPoints[0].count:0,1);
  const scatterN=Math.max(obsPoints.length,expPoints.length,1);

  const peopleWithInterval=people.filter(p=>p.contactintervaldays);
  const requiredPerDay=peopleWithInterval.reduce((s,p)=>s+(1/p.contactintervaldays),0);
  const requiredPerWeek=requiredPerDay*7;
  function actualPPD(days){const since=toISO(addDays(todayDate,-days));const pSet=new Set();encounters.filter(e=>e.date>=since&&e.date<=todayISO).forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>pSet.add(pid)));return +(pSet.size/days).toFixed(2);}

  const rhythmBuckets={ahead:0,onTrack:0,slightlyBehind:0,overdue:0,significantlyOverdue:0,noEncounters:0};
  const rhythmPeople={ahead:[],onTrack:[],slightlyBehind:[],overdue:[],significantlyOverdue:[],noEncounters:[]};
  const totalPeople=people.length;
  const totalWithInterval=people.filter(p=>p.contactintervaldays).length;
  people.forEach(p=>{
    if(!p.contactintervaldays)return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length){rhythmBuckets.noEncounters++;rhythmPeople.noEncounters.push({name:p.name,daysSince:null,ratio:null});return;}
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const ratio=daysSince/p.contactintervaldays;
    let bucket;
    if(ratio<0.5)bucket='ahead';
    else if(ratio<=1.2)bucket='onTrack';
    else if(ratio<=1.5)bucket='slightlyBehind';
    else if(ratio<=2.0)bucket='overdue';
    else bucket='significantlyOverdue';
    rhythmBuckets[bucket]++;
    rhythmPeople[bucket].push({name:p.name,daysSince,ratio,interval:p.contactintervaldays});
  });

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

  // Full suggestion lists (not just top 3)
  const dueSoonAll=[];
  people.forEach(p=>{
    if(!p.contactintervaldays)return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length)return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    const daysUntilDue=p.contactintervaldays-daysSince;
    if(daysUntilDue>=0&&daysUntilDue<=7)dueSoonAll.push({person:p,daysUntilDue,daysSince});
  });
  const dueSoonSelected=seededShuffle(dueSoonAll,seedStr+'due').slice(0,3);

  const longOverdueAll=[];
  people.forEach(p=>{
    if(!p.contactintervaldays)return;
    const dates=(personEncsMap[p.id]||[]).map(id=>encMap[id]?.date).filter(Boolean).sort().reverse();
    if(!dates.length)return;
    const daysSince=Math.round((todayDate-new Date(dates[0]+'T00:00:00'))/86400000);
    if(daysSince<7)return;
    const ratio=daysSince/p.contactintervaldays;
    if(ratio>=1.5)longOverdueAll.push({person:p,daysSince,ratio});
  });
  const dueSoonIds=new Set(dueSoonSelected.map(d=>d.person.id));
  const longOverdueSelected=seededShuffle(longOverdueAll.filter(p=>!dueSoonIds.has(p.person.id)),seedStr+'overdue').slice(0,3);

  const twoWkStart=toISO(addDays(todayDate,-14));
  const excludeIds=new Set([...dueSoonSelected.map(d=>d.person.id),...longOverdueSelected.map(d=>d.person.id)]);
  const momentumAll=people.filter(p=>!excludeIds.has(p.id)).map(p=>{
    const recentEncs=encounters.filter(e=>e.date>=twoWkStart&&e.date<=todayISO&&(encPartsMap[e.id]||[]).includes(p.id)).length;
    const avgPer2Wk=+(personWeeklyAvg[p.id]*2);
    return {person:p,recentEncs,avgPer2Wk,delta:recentEncs-avgPer2Wk};
  }).filter(p=>p.delta>0&&p.recentEncs>0).sort((a,b)=>b.delta-a.delta);
  const momentumCandidates=momentumAll.slice(0,3);

  const allWithBirthday=people.filter(p=>p.birthday_month&&p.birthday_day).map(p=>{
    let next=new Date(todayDate.getFullYear(),p.birthday_month-1,p.birthday_day);
    if(next<todayDate)next=new Date(todayDate.getFullYear()+1,p.birthday_month-1,p.birthday_day);
    const daysUntil=Math.round((next-todayDate)/86400000);
    let ageStr=p.birthday_year?`turning ${next.getFullYear()-p.birthday_year}`:'age unknown';
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
    weekTotalEncs,avgTotalEncs,kpiEncs:kpiDelta(weekTotalEncs,avgTotalEncs),
    weekTotalAppearances,avgTotalAppearances,kpiAppearances:kpiDelta(weekTotalAppearances,avgTotalAppearances),
    weekUniquePeople,avgUniquePeoplePerWeek,kpiPeople:kpiDelta(weekUniquePeople,avgUniquePeoplePerWeek),
    weekTypeCounts,avgTypeCounts,weekPeopleCount,personWeeklyAvg,personMap,newPeople,
    weeklyStacks,maxStackVal,obsPoints,expPoints,scatterMaxY,scatterN,
    requiredPerDay,requiredPerWeek,peopleWithInterval,
    actualPerDay7:actualPPD(7),actualPerDay30:actualPPD(30),actualPerDay90:actualPPD(90),
    rhythmBuckets,rhythmPeople,totalPeople,totalWithInterval,recommendations,
    dueSoonSelected,dueSoonAll,longOverdueSelected,longOverdueAll,momentumCandidates,momentumAll,
    targetPerWeek:+(requiredPerWeek).toFixed(1),
    bdToday,bdWeek,bdNext,allWithBirthday,birthdayKnown,birthdayTotal,birthdayPct,
  };
}

// ── Touch interaction helper ───────────────────────────────────────
// Returns a function to attach touch handlers to a chart container.
// onScrub(normX, normY) called during touchmove
// onTap() called when touchend is a quick tap (<300ms, <10px movement)
// onEnd() called when touch ends without tap
function makeTouchHandler(el, onScrub, onTap, onEnd) {
  let startX, startY, startTime, active=false;

  el.addEventListener('touchstart', e=>{
    e.preventDefault();
    active=true;
    startX=e.touches[0].clientX;
    startY=e.touches[0].clientY;
    startTime=Date.now();
    const rect=el.getBoundingClientRect();
    const normX=Math.max(0,Math.min(1,(startX-rect.left)/rect.width));
    const normY=Math.max(0,Math.min(1,(startY-rect.top)/rect.height));
    if(onScrub) onScrub(normX, normY);
  },{passive:false});

  el.addEventListener('touchmove', e=>{
    if(!active)return;
    e.preventDefault();
    const rect=el.getBoundingClientRect();
    const cx=e.touches[0].clientX;
    const cy=e.touches[0].clientY;
    const normX=Math.max(0,Math.min(1,(cx-rect.left)/rect.width));
    const normY=Math.max(0,Math.min(1,(cy-rect.top)/rect.height));
    if(onScrub) onScrub(normX, normY);
  },{passive:false});

  el.addEventListener('touchend', e=>{
    if(!active)return;
    active=false;
    const endX=e.changedTouches[0].clientX;
    const endY=e.changedTouches[0].clientY;
    const dx=Math.abs(endX-startX);
    const dy=Math.abs(endY-startY);
    const dt=Date.now()-startTime;
    if(dt<300&&dx<10&&dy<10) { if(onTap) onTap(startX,startY); }
    else { if(onEnd) onEnd(); }
  },{passive:true});

  el.addEventListener('touchcancel', ()=>{ active=false; if(onEnd) onEnd(); },{passive:true});
}

// ── Tooltip helpers ────────────────────────────────────────────────
function showTooltip(el, html) {
  let tt = el.querySelector('.dash-tooltip');
  if(!tt){ tt=document.createElement('div'); tt.className='dash-tooltip'; el.appendChild(tt); }
  tt.innerHTML=html;
  tt.style.display='block';
}
function hideTooltip(el) {
  const tt=el.querySelector('.dash-tooltip');
  if(tt) tt.style.display='none';
}

// ── Render ─────────────────────────────────────────────────────────
function renderDashboard(a, people, encounters, participants) {
  const content=document.getElementById('dashboard-content');
  const weekLabel=`${formatShort(a.weekStart)} – ${formatShort(a.todayDate)}`;

  function kpiBox(label,value,delta,avg){
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

  // ── Encounter bars
  function encBarsHTML(){
    const maxV=Math.max(...ALL_TYPES.map(t=>Math.max(a.weekTypeCounts[t]||0,(a.avgTypeCounts[t]||0)*1.3)),1);
    const rows=ALL_TYPES.map((t,i)=>{
      const val=a.weekTypeCounts[t]||0;
      const avg=a.avgTypeCounts[t]||0;
      const w=Math.round((val/maxV)*100);
      const avgW=Math.round((avg/maxV)*100);
      return `<div class="dash-bar-row dash-bar-interactive" data-idx="${i}" data-val="${val}" data-avg="${avg}" data-label="${esc(TYPE_LABELS[t])}">
        <div class="dash-bar-label">${esc(TYPE_LABELS[t])}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:${TYPE_COLORS[t]}">
            ${val>0?`<span class="dash-bar-val">${val}</span>`:''}
          </div>
          ${avg>0?`<div class="dash-bar-avg" style="left:${avgW}%" title="12-wk avg: ${avg}"></div>`:''}
        </div>
      </div>`;
    }).join('');
    return `<div class="dash-bar-chart-wrap" id="enc-bar-chart">${rows}<div class="dash-tooltip" style="display:none"></div></div>`;
  }

  // ── People bars
  function peopleBarsHTML(){
    const sorted=Object.entries(a.weekPeopleCount).sort((x,y)=>y[1]-x[1]).map(([pid,cnt])=>({person:a.personMap[pid],cnt})).filter(x=>x.person);
    if(!sorted.length) return '<div class="dash-empty">No encounters this week.</div>';
    const maxV=Math.max(...sorted.map(p=>Math.max(p.cnt,(a.personWeeklyAvg[p.person.id]||0)*1.3)),1);
    const rows=sorted.map(({person,cnt},i)=>{
      const avg=a.personWeeklyAvg[person.id]||0;
      const targetPerWk=person.contactintervaldays?+(7/person.contactintervaldays).toFixed(2):null;
      const w=Math.round((cnt/maxV)*100);
      const avgW=Math.round((avg/maxV)*100);
      const targetW=targetPerWk?Math.round((targetPerWk/maxV)*100):null;
      return `<div class="dash-bar-row dash-bar-interactive" data-idx="${i}" data-name="${esc(person.name)}" data-val="${cnt}" data-avg="${avg}" data-target="${targetPerWk||''}">
        <div class="dash-bar-label">${esc(person.name)}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:#D4A855"><span class="dash-bar-val">${cnt}</span></div>
          ${avg>0?`<div class="dash-bar-avg" style="left:${avgW}%"></div>`:''}
          ${targetW!==null?`<div class="dash-bar-target" style="left:${targetW}%"></div>`:''}
        </div>
      </div>`;
    }).join('');
    return `<div class="dash-bar-chart-wrap" id="people-bar-chart">${rows}<div class="dash-tooltip" style="display:none"></div></div>`;
  }

  // ── Stacked chart
  function stackedChartHTML(){
    const maxV=a.maxStackVal;
    const yMid=Math.round(maxV/2);
    const cols=a.weeklyStacks.map((w,i)=>{
      const totalH=Math.round((w.total/maxV)*120);
      const peopleH=Math.round((w.uniquePeople/maxV)*120);
      const segs=ALL_TYPES.map(t=>{const cnt=w.typeCounts[t]||0;if(!cnt)return'';const h=Math.round((cnt/maxV)*120);return `<div style="height:${h}px;background:${TYPE_COLORS[t]}"></div>`;}).reverse().join('');
      return `<div class="dash-stack-col${w.isCurrentWeek?' dash-stack-current':''}" data-idx="${i}">
        <div class="dash-stack-bars">
          <div class="dash-stack-bar" style="height:${totalH}px">${segs}</div>
          <div class="dash-stack-dot" style="bottom:${peopleH}px"></div>
        </div>
        <div class="dash-stack-label">${w.label}</div>
      </div>`;
    }).join('');
    const legend=ALL_TYPES.map(t=>`<span class="dash-legend-item"><span class="dash-legend-dot" style="background:${TYPE_COLORS[t]}"></span>${TYPE_LABELS[t]}</span>`).join('');
    return `<div class="dash-chart-wrap" id="trajectory-chart-wrap">
      <div class="dash-y-axis"><span>${maxV}</span><span>${yMid}</span><span>0</span></div>
      <div style="flex:1;min-width:0;position:relative">
        <div class="dash-stack-wrap" id="trajectory-chart">${cols}</div>
        <div class="dash-x-axis-line"></div>
        <div class="dash-tooltip" id="trajectory-tooltip" style="display:none;position:absolute;top:0;left:50%;transform:translateX(-50%)"></div>
      </div>
    </div>
    <div style="font-size:10px;color:#8A9BAC;margin:4px 0 4px 28px">&#9679; = unique people · Tap a column for details</div>
    <div class="dash-legend" style="margin-left:28px">${legend}</div>
    <div id="trajectory-detail" class="dash-detail-panel" style="display:none"></div>`;
  }

  // ── Social breadth scatter
  function curveHTML(){
    if(!a.obsPoints.length&&!a.expPoints.length) return '<div class="dash-empty">Not enough data yet.</div>';
    const maxY=a.scatterMaxY;const n=a.scatterN;
    const yStep=Math.ceil(maxY/3);
    const yMarks=[0,yStep,yStep*2,maxY].filter((v,i,arr)=>arr.indexOf(v)===i).map(v=>`<div class="dash-curve-y-mark" style="bottom:${Math.round((v/maxY)*100)}%"><span>${v}</span></div>`).join('');
    const obsDots=a.obsPoints.map((p,i)=>{const x=n>1?Math.round((i/(n-1))*100):50;const y=Math.round((p.count/maxY)*100);return `<div class="dash-curve-dot dash-curve-obs" style="left:${x}%;bottom:${y}%"></div>`;}).join('');
    const expDots=a.expPoints.map((p,i)=>{const x=n>1?Math.round((i/(n-1))*100):50;const y=Math.round((p.count/maxY)*100);return `<div class="dash-curve-dot dash-curve-target" style="left:${x}%;bottom:${y}%"></div>`;}).join('');
    const xTickCount=Math.min(n,6);
    const xTicks=Array.from({length:xTickCount},(_,i)=>{const rank=Math.round((i/(xTickCount-1))*(n-1))+1;const pct=n>1?Math.round(((rank-1)/(n-1))*100):0;return `<div class="dash-curve-x-mark" style="left:${pct}%"><span>${rank}</span></div>`;}).join('');
    return `<div style="display:flex;align-items:center;gap:2px">
      <div class="dash-curve-y-title">Encounters (12 wks)</div>
      <div class="dash-curve-outer" style="flex:1">
        <div class="dash-curve-y-axis">${yMarks}</div>
        <div style="flex:1;min-width:0;position:relative">
          <div class="dash-curve-wrap" id="scatter-chart" style="cursor:crosshair">${obsDots}${expDots}
            <div class="dash-scatter-crosshair" id="scatter-crosshair" style="display:none"></div>
          </div>
          <div class="dash-curve-x-axis" style="position:relative;height:16px">${xTicks}</div>
          <div style="font-size:0.55rem;color:var(--slate);text-align:center;margin-top:1px">Rank (each series sorted independently, most &#x2192; least)</div>
        </div>
      </div>
    </div>
    <div id="scatter-tooltip" class="dash-scatter-info" style="display:none"></div>
    <div class="dash-curve-legend">
      <span><span class="dash-curve-dot dash-curve-obs" style="position:relative;display:inline-block;width:8px;height:8px;vertical-align:middle;bottom:auto;left:auto"></span> Actual (12 wks)</span>
      <span><span class="dash-curve-dot dash-curve-target" style="position:relative;display:inline-block;width:8px;height:8px;vertical-align:middle;bottom:auto;left:auto"></span> Expected (ranked separately)</span>
    </div>`;
  }

  // ── Rhythm bars
  function rhythmHTML(){
    const total=a.totalWithInterval||1;
    const buckets=[
      {key:'ahead',label:'Well ahead',color:'#2D9E5F'},
      {key:'onTrack',label:'On track',color:'#40916C'},
      {key:'slightlyBehind',label:'Slightly behind',color:'#E07B2A'},
      {key:'overdue',label:'Overdue',color:'#C0392B'},
      {key:'significantlyOverdue',label:'Significantly overdue',color:'#7B0000'},
      {key:'noEncounters',label:'No encounters recorded',color:'#2A3A4A'},
    ];
    const statsRow=`<div class="dash-rhythm-stats"><span>${a.totalPeople} total</span><span>·</span><span>${a.totalWithInterval} with intervals</span><span>·</span><span>${a.totalPeople-a.totalWithInterval} without</span></div>`;
    const bars=buckets.map(b=>{
      const cnt=a.rhythmBuckets[b.key]||0;
      const w=Math.round((cnt/total)*100);
      return `<div class="dash-bar-row dash-rhythm-bar" data-bucket="${b.key}" style="cursor:${cnt>0?'pointer':'default'}">
        <div class="dash-bar-label" style="width:130px;font-size:0.68rem">${b.label}</div>
        <div class="dash-bar-track">
          <div class="dash-bar-fill" style="width:${w}%;background:${b.color}">${cnt>0?`<span class="dash-bar-val">${cnt}</span>`:''}</div>
        </div>
      </div>`;
    }).join('');
    return statsRow+bars+`<div id="rhythm-detail" class="dash-detail-panel" style="display:none"></div>`;
  }

  // ── Suggestion group with show-more
  function suggestGroup(title, selected, all, rowFn) {
    const hasMore = all.length > selected.length;
    const moreCount = all.length - selected.length;
    const id = 'sg-' + title.replace(/\s+/g,'').toLowerCase();
    return `<div class="dash-card">
      <div class="dash-card-title">${esc(title)}</div>
      <div id="${id}-shown">
        ${selected.length ? selected.map(rowFn).join('') : '<div class="dash-empty">None identified.</div>'}
      </div>
      ${hasMore ? `<div id="${id}-more" style="display:none">${all.slice(3).map(rowFn).join('')}</div>
        <button class="dash-show-more" onclick="document.getElementById('${id}-more').style.display='block';this.style.display='none'">
          Show ${moreCount} more &#x25BE;
        </button>` : ''}
    </div>`;
  }

  function suggestRow(name,detail){return `<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(name)}</span><span class="dash-suggest-detail">${esc(detail)}</span></div>`;}

  // ── Birthdays with expand-all
  function birthdayHTML(){
    const pct=a.birthdayPct;
    const fracColor=pct>=100?'#2D9E5F':pct>=50?`rgb(${Math.round(212-((pct-50)/50)*212)},${Math.round(168+((pct-50)/50)*22)},${Math.round(85-85*((pct-50)/50))})`:`rgb(${Math.round(192+((pct/50)*20))},${Math.round(57+((pct/50)*111))},${Math.round(43+((pct/50)*42))})`;
    const popper=pct>=100?' 🎉':'';
    let html=`<div class="dash-bd-fraction" style="color:${fracColor}">${a.birthdayKnown}/${a.birthdayTotal} birthdays known${popper}</div>`;
    if(a.bdToday.length){html+=`<div class="dash-bd-subhead">Today</div>`;html+=a.bdToday.map(p=>`<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(p.name)}</span><span class="dash-suggest-detail">${p.ageStr}</span></div>`).join('');}
    if(a.bdWeek.length){html+=`<div class="dash-bd-subhead">This week</div>`;html+=a.bdWeek.map(p=>`<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(p.name)}</span><span class="dash-suggest-detail">${formatDow(p.nextDate)} · ${p.ageStr}</span></div>`).join('');}
    else html+=`<div class="dash-empty" style="margin:4px 0">No birthdays in the next 7 days.</div>`;
    if(a.bdNext.length){html+=`<div class="dash-bd-subhead">Next birthdays</div>`;html+=a.bdNext.map(p=>`<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(p.name)}</span><span class="dash-suggest-detail">${formatMedium(p.nextDate)} · ${p.ageStr}</span></div>`).join('');}
    // Show all by month
    html+=`<div id="bd-all-panel" style="display:none">`;
    // Group by month
    const byMonth={};
    a.allWithBirthday.forEach(p=>{const m=p.birthday_month-1;if(!byMonth[m])byMonth[m]=[];byMonth[m].push(p);});
    const today=new Date();const startMonth=today.getMonth();
    for(let i=0;i<12;i++){
      const m=(startMonth+i)%12;
      if(!byMonth[m])continue;
      html+=`<div class="dash-bd-subhead">${MONTHS_LONG[m]}</div>`;
      html+=byMonth[m].map(p=>`<div class="dash-suggest-row"><span class="dash-suggest-name">${esc(p.name)}</span><span class="dash-suggest-detail">${p.birthday_day} ${MONTHS_SHORT[p.birthday_month-1]}${p.birthday_year?' · '+p.ageStr:' · age unknown'}</span></div>`).join('');
    }
    html+=`</div>`;
    html+=`<button class="dash-show-more" id="bd-show-all-btn" onclick="document.getElementById('bd-all-panel').style.display='block';this.style.display='none'">Show all by month &#x25BE;</button>`;
    return html;
  }

  // ── Recommendations with modal trigger
  function recsHTML(){
    if(!a.recommendations.length) return '';
    return `<div class="dash-card">
      <div class="dash-card-title">Suggested interval adjustments</div>
      ${a.recommendations.map(r=>`
        <div class="dash-rec-item dash-rec-clickable" data-person-id="${r.person.id}" data-current="${r.target}" data-suggested="${r.actualAvg}">
          <span class="dash-rec-name">${esc(r.person.name)}</span>
          Consider ${r.direction==='decrease'?'reducing':'increasing'} from <strong>${r.target}</strong> to <strong>${r.actualAvg}</strong> days
          <span class="dash-rec-tap-hint">Tap to update ›</span>
        </div>`).join('')}
    </div>`;
  }

  // ── Interval adjustment modal HTML (injected once)
  const intervalModalHTML=`
    <div id="interval-modal" class="modal-backdrop hidden">
      <div class="modal">
        <h3 class="modal-title" id="interval-modal-title">Update contact interval</h3>
        <p class="modal-msg" id="interval-modal-msg"></p>
        <div class="field-group" style="margin:0.8rem 0">
          <label class="field-label">New interval (days)</label>
          <input class="field-input" id="interval-modal-input" type="number" min="1" max="365"/>
        </div>
        <div id="interval-modal-status" style="font-size:0.8rem;margin-bottom:0.5rem;display:none"></div>
        <div class="modal-actions">
          <button class="btn-secondary" id="interval-modal-cancel">Cancel</button>
          <button class="btn-primary" id="interval-modal-confirm" style="flex:1">Update interval</button>
        </div>
      </div>
    </div>`;

  // ── Rhythm detail panel renderer
  function showRhythmDetail(bucketKey) {
    const bucketLabels={ahead:'Well ahead',onTrack:'On track',slightlyBehind:'Slightly behind',overdue:'Overdue',significantlyOverdue:'Significantly overdue',noEncounters:'No encounters recorded'};
    const panel=document.getElementById('rhythm-detail');
    const people=a.rhythmPeople[bucketKey]||[];
    if(!people.length){panel.style.display='none';return;}
    panel.innerHTML=`<div class="dash-detail-header">${esc(bucketLabels[bucketKey])} — ${people.length} contact${people.length!==1?'s':''}</div>`+
      people.map(p=>{
        if(p.daysSince===null) return `<div class="dash-detail-row"><span class="dash-detail-name">${esc(p.name)}</span><span class="dash-detail-stat">No encounters recorded</span></div>`;
        return `<div class="dash-detail-row"><span class="dash-detail-name">${esc(p.name)}</span><span class="dash-detail-stat">${p.daysSince}d since last · ${Math.round(p.ratio*10)/10}× interval (${p.interval}d)</span></div>`;
      }).join('');
    panel.style.display='block';
    panel.scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  // ── Write content
  content.innerHTML=`
    ${intervalModalHTML}

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
        <div class="dash-card-title">People encountered <span class="dash-avg-note">(white=avg · green=target)</span></div>
        ${peopleBarsHTML()}
      </div>
    </div>

    ${a.newPeople.length?`<div class="dash-card" style="margin-top:0"><div class="dash-card-title">New people this week</div>${a.newPeople.map(p=>`<div class="dash-new-person">+ ${esc(p.name)}</div>`).join('')}</div>`:''}

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
        <div class="dash-stat-box"><div class="dash-stat-val">${a.requiredPerDay.toFixed(2)}</div><div class="dash-stat-lbl">Required people/day</div><div class="dash-stat-note">${a.peopleWithInterval.length} contacts with intervals</div></div>
        <div class="dash-stat-box"><div class="dash-stat-val">${a.actualPerDay7}</div><div class="dash-stat-lbl">Actual last 7d</div></div>
        <div class="dash-stat-box"><div class="dash-stat-val">${a.actualPerDay30}</div><div class="dash-stat-lbl">Actual last 30d</div></div>
        <div class="dash-stat-box"><div class="dash-stat-val">${a.actualPerDay90}</div><div class="dash-stat-lbl">Actual last 90d</div></div>
      </div>
    </div>

    <div class="dash-card">
      <div class="dash-card-title">Relationship rhythm <span class="dash-avg-note">Tap a bar to see who's in each group</span></div>
      ${rhythmHTML()}
    </div>

    ${recsHTML()}

    <div class="dash-section-header" style="margin-top:8px">
      <span class="dash-section-label">Next week</span>
      <span class="dash-section-date">Target: ~${a.targetPerWeek.toFixed(0)} people</span>
    </div>

    ${suggestGroup('Due soon', a.dueSoonSelected, a.dueSoonAll, d=>suggestRow(d.person.name, `Due ${d.daysUntilDue===0?'today':`in ${d.daysUntilDue}d`} · last seen ${d.daysSince}d ago`))}
    ${suggestGroup('Long overdue', a.longOverdueSelected, a.longOverdueAll, d=>suggestRow(d.person.name, `${d.daysSince}d since last seen · ${(Math.round(d.ratio*10)/10)}× their interval`))}
    ${suggestGroup('Momentum', a.momentumCandidates, a.momentumAll, d=>suggestRow(d.person.name, `${d.recentEncs} encounters in 2 weeks vs avg ${d.avgPer2Wk.toFixed(1)}`))}

    <div class="dash-section-header" style="margin-top:8px">
      <span class="dash-section-label">Birthdays</span>
    </div>
    <div class="dash-card">${birthdayHTML()}</div>

    <div style="height:2rem"></div>
  `;

  // ── Wire up all interactions after render ─────────────────────────

  // 1. Encounter bar chart — touch hover
  const encChart=document.getElementById('enc-bar-chart');
  if(encChart){
    const rows=[...encChart.querySelectorAll('.dash-bar-interactive')];
    makeTouchHandler(encChart,
      (normX,normY)=>{
        // Find which row is being touched by Y position
        const rect=encChart.getBoundingClientRect();
        const absY=rect.top+normY*rect.height;
        let closest=null,minD=Infinity;
        rows.forEach(row=>{const r=row.getBoundingClientRect();const mid=(r.top+r.bottom)/2;const d=Math.abs(absY-mid);if(d<minD){minD=d;closest=row;}});
        if(closest){
          const val=closest.dataset.val;const avg=closest.dataset.avg;const label=closest.dataset.label;
          showTooltip(encChart,`<strong>${label}</strong><br>This week: ${val}<br>12-wk avg: ${avg}`);
        }
      },
      null,
      ()=>hideTooltip(encChart)
    );
  }

  // 2. People bar chart — touch hover
  const peopleChart=document.getElementById('people-bar-chart');
  if(peopleChart){
    const rows=[...peopleChart.querySelectorAll('.dash-bar-interactive')];
    makeTouchHandler(peopleChart,
      (normX,normY)=>{
        const rect=peopleChart.getBoundingClientRect();
        const absY=rect.top+normY*rect.height;
        let closest=null,minD=Infinity;
        rows.forEach(row=>{const r=row.getBoundingClientRect();const mid=(r.top+r.bottom)/2;const d=Math.abs(absY-mid);if(d<minD){minD=d;closest=row;}});
        if(closest){
          const val=closest.dataset.val;const avg=closest.dataset.avg;const target=closest.dataset.target;const name=closest.dataset.name;
          let tt=`<strong>${name}</strong><br>This week: ${val}<br>12-wk avg: ${avg}`;
          if(target) tt+=`<br>Weekly target: ${(+target).toFixed(2)}`;
          showTooltip(peopleChart,tt);
        }
      },
      null,
      ()=>hideTooltip(peopleChart)
    );
  }

  // 3. Trajectory chart — hover + tap for detail
  const trajChart=document.getElementById('trajectory-chart');
  const trajTooltip=document.getElementById('trajectory-tooltip');
  const trajDetail=document.getElementById('trajectory-detail');
  if(trajChart){
    const cols=[...trajChart.querySelectorAll('.dash-stack-col')];
    let lastHoverIdx=-1;

    function getColIdx(normX){
      return Math.max(0,Math.min(cols.length-1,Math.floor(normX*cols.length)));
    }

    makeTouchHandler(trajChart,
      (normX)=>{
        const idx=getColIdx(normX);
        lastHoverIdx=idx;
        const w=a.weeklyStacks[idx];
        if(!w||!trajTooltip)return;
        const typeLines=ALL_TYPES.filter(t=>w.typeCounts[t]>0).map(t=>`${TYPE_LABELS[t]}: ${w.typeCounts[t]}`).join('<br>');
        trajTooltip.innerHTML=`<strong>${w.label}</strong><br>Total: ${w.total}<br>People: ${w.uniquePeople}<br>${typeLines}`;
        trajTooltip.style.display='block';
        // Position above the column
        const col=cols[idx];
        if(col){
          const colRect=col.getBoundingClientRect();
          const wrapRect=trajChart.getBoundingClientRect();
          const leftPct=Math.round(((colRect.left+colRect.width/2)-wrapRect.left)/wrapRect.width*100);
          trajTooltip.style.left=`${leftPct}%`;
        }
      },
      async (tapX)=>{
        // Tap — fetch week detail
        if(!trajChart)return;
        const rect=trajChart.getBoundingClientRect();
        const normX=(tapX-rect.left)/rect.width;
        const idx=getColIdx(normX);
        const w=a.weeklyStacks[idx];
        if(!w||!trajDetail)return;
        if(trajTooltip) trajTooltip.style.display='none';

        // Toggle if same week tapped again
        if(trajDetail.dataset.activeIdx===String(idx)&&trajDetail.style.display!=='none'){
          trajDetail.style.display='none';
          trajDetail.dataset.activeIdx='';
          return;
        }
        trajDetail.dataset.activeIdx=String(idx);
        trajDetail.innerHTML=`<div class="dash-detail-header">Loading ${w.label}…</div>`;
        trajDetail.style.display='block';
        trajDetail.scrollIntoView({behavior:'smooth',block:'nearest'});

        // Fetch encounters for this week
        try {
          const {data:encs}=await db().from('encounters').select('id,date,type,description').gte('date',w.weekStartISO).lte('date',w.weekEndISO).order('date',{ascending:false});
          const {data:parts}=await db().from('encounter_participants').select('encounterid,personid').in('encounterid',(encs||[]).map(e=>e.id));
          const {data:ppl}=await db().from('people').select('id,name');
          const pMap=Object.fromEntries((ppl||[]).map(p=>[p.id,p.name]));
          const partMap={};(parts||[]).forEach(({encounterid,personid})=>{if(!partMap[encounterid])partMap[encounterid]=[];partMap[encounterid].push(pMap[personid]||'?');});

          // Group by type
          const byType={};
          (encs||[]).forEach(e=>{if(!byType[e.type])byType[e.type]=[];byType[e.type].push(e);});
          const uniquePeople=new Set((parts||[]).map(p=>p.personid));

          let html=`<div class="dash-detail-header">${w.label} — ${(encs||[]).length} encounter${(encs||[]).length!==1?'s':''} · ${uniquePeople.size} unique people</div>`;
          ALL_TYPES.forEach(t=>{
            const group=byType[t];if(!group||!group.length)return;
            html+=`<div class="dash-detail-type-header" style="color:${TYPE_COLORS[t]}">${TYPE_LABELS[t]} (${group.length})</div>`;
            group.forEach(e=>{
              const names=(partMap[e.id]||[]).join(', ')||'—';
              html+=`<div class="dash-detail-enc-row">
                <span class="dash-detail-enc-date">${e.date}</span>
                <span class="dash-detail-enc-names">${esc(names)}</span>
                ${e.description?`<div class="dash-detail-enc-note">${esc(e.description)}</div>`:''}
              </div>`;
            });
          });
          trajDetail.innerHTML=html;
        } catch(err){
          trajDetail.innerHTML=`<div class="dash-detail-header">Failed to load: ${esc(err.message)}</div>`;
        }
      },
      ()=>{if(trajTooltip)trajTooltip.style.display='none';}
    );
  }

  // 4. Scatter chart — crosshair scrub
  const scatterChart=document.getElementById('scatter-chart');
  const scatterTooltip=document.getElementById('scatter-tooltip');
  const scatterCrosshair=document.getElementById('scatter-crosshair');
  if(scatterChart&&a.obsPoints.length){
    makeTouchHandler(scatterChart,
      (normX)=>{
        // Find nearest obs and exp points by rank
        const obsIdx=Math.round(normX*(a.obsPoints.length-1));
        const expIdx=Math.round(normX*(a.expPoints.length-1));
        const obs=a.obsPoints[Math.min(obsIdx,a.obsPoints.length-1)];
        const exp=a.expPoints[Math.min(expIdx,a.expPoints.length-1)];
        if(scatterCrosshair){scatterCrosshair.style.display='block';scatterCrosshair.style.left=`${Math.round(normX*100)}%`;}
        if(scatterTooltip){
          let html=``;
          if(obs) html+=`<span class="st-obs">&#9679; ${esc(obs.name)}: ${obs.count} actual</span>`;
          if(exp) html+=`<span class="st-exp">&#9679; ${esc(exp.name)}: ${exp.count.toFixed(1)} expected</span>`;
          scatterTooltip.innerHTML=html;
          scatterTooltip.style.display='flex';
        }
      },
      null,
      ()=>{
        if(scatterCrosshair)scatterCrosshair.style.display='none';
        if(scatterTooltip)scatterTooltip.style.display='none';
      }
    );
  }

  // 5. Rhythm bars — tap to show people in bucket
  document.querySelectorAll('.dash-rhythm-bar').forEach(bar=>{
    bar.addEventListener('click',()=>{
      const bucket=bar.dataset.bucket;
      showRhythmDetail(bucket);
    });
    // Also touchend for mobile
    bar.addEventListener('touchend',e=>{
      e.preventDefault();
      showRhythmDetail(bar.dataset.bucket);
    },{passive:false});
  });

  // 6. Interval recommendation modal
  document.querySelectorAll('.dash-rec-clickable').forEach(el=>{
    const openModal=()=>{
      const personId=el.dataset.personId;
      const current=+el.dataset.current;
      const suggested=+el.dataset.suggested;
      const person=_allPeopleCache.find(p=>p.id===personId);
      if(!person)return;
      _intervalModalPerson={person,current,suggested};
      document.getElementById('interval-modal-title').textContent=`Update: ${person.name}`;
      document.getElementById('interval-modal-msg').textContent=`Current interval: ${current} days. Suggested: ${suggested} days.`;
      document.getElementById('interval-modal-input').value=suggested;
      document.getElementById('interval-modal-status').style.display='none';
      document.getElementById('interval-modal').classList.remove('hidden');
    };
    el.addEventListener('click',openModal);
    el.addEventListener('touchend',e=>{e.preventDefault();openModal();},{passive:false});
  });

  document.getElementById('interval-modal-cancel')?.addEventListener('click',()=>{
    document.getElementById('interval-modal').classList.add('hidden');
    _intervalModalPerson=null;
  });

  document.getElementById('interval-modal-confirm')?.addEventListener('click',async ()=>{
    if(!_intervalModalPerson)return;
    const newVal=parseInt(document.getElementById('interval-modal-input').value);
    if(!newVal||newVal<1){
      const s=document.getElementById('interval-modal-status');
      s.textContent='Please enter a valid number of days.';s.style.color='#e8a09a';s.style.display='block';
      return;
    }
    const btn=document.getElementById('interval-modal-confirm');
    btn.disabled=true;btn.textContent='Saving…';
    const {person,current}=_intervalModalPerson;
    const {error}=await writeIntervalChangeNote(db(),person.id,current,newVal,person.notes);
    if(error){
      const s=document.getElementById('interval-modal-status');
      s.textContent='Failed: '+error.message;s.style.color='#e8a09a';s.style.display='block';
      btn.disabled=false;btn.textContent='Update interval';
      return;
    }
    const s=document.getElementById('interval-modal-status');
    s.textContent=`Updated from ${current} → ${newVal} days. Note added.`;s.style.color='#74c69d';s.style.display='block';
    btn.disabled=false;btn.textContent='Update interval';
    // Update local cache
    person.notes=(person.notes?person.notes+'\n\n':'')+`[${new Date().toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}] Contact frequency changed from ${current} → ${newVal} days`;
    person.contactintervaldays=newVal;
    setTimeout(()=>document.getElementById('interval-modal').classList.add('hidden'),1800);
    _intervalModalPerson=null;
  });
}

document.addEventListener('DOMContentLoaded',()=>{
  const btn=document.getElementById('dashboard-back-btn');
  if(btn)btn.addEventListener('click',()=>{document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById('app-screen').classList.add('active');});
});
