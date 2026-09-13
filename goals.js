// goals.js — Personal Log 4-Week Block Goals View
// Self-contained module, loaded alongside dashboard.js

const ALL_TYPES    = ['call','1-on-1','small-group','large-group','message','birthday-acknowledgment'];
const EXCLUDED     = new Set(['message','birthday-acknowledgment']);
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const BLOCK_DAYS   = 28;

function db(){return window._plSupabase;}
function addDays(d,n){const r=new Date(d);r.setDate(r.getDate()+n);return r;}
function toISO(d){const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function fmtShort(d){return `${String(d.getDate()).padStart(2,'0')}-${MONTHS_SHORT[d.getMonth()]}`;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// ── Block maths ────────────────────────────────────────────────────
// Block 1 of each year = first Monday of the year
function getYearFirstMonday(year){
  const jan1=new Date(year,0,1);
  const dow=jan1.getDay(); // 0=Sun
  const diff=dow===0?1:(dow===1?0:8-dow);
  return new Date(year,0,1+diff);
}

function getCurrentBlock(today){
  const year=today.getFullYear();
  let blockStart=getYearFirstMonday(year);
  // If today is before first Monday of this year, use previous year
  if(today<blockStart){
    blockStart=getYearFirstMonday(year-1);
  }
  // Walk forward in 28-day increments
  let blockNum=1;
  while(addDays(blockStart,BLOCK_DAYS)<=today){
    blockStart=addDays(blockStart,BLOCK_DAYS);
    blockNum++;
  }
  const blockEnd=addDays(blockStart,BLOCK_DAYS-1);
  return {blockStart,blockEnd,blockNum,
    blockStartISO:toISO(blockStart),blockEndISO:toISO(blockEnd)};
}

function getPrevBlock(blockStart){
  const prevStart=addDays(blockStart,-BLOCK_DAYS);
  const prevEnd=addDays(blockStart,-1);
  return {blockStart:prevStart,blockEnd:prevEnd,
    blockStartISO:toISO(prevStart),blockEndISO:toISO(prevEnd)};
}

// ── Entry point ────────────────────────────────────────────────────
window.openGoals = async function(){
  const content=document.getElementById('dashboard-content');
  content.innerHTML='<div class="dash-loading">Loading goals\u2026</div>';
  try{
    const {people,encounters,participants}=await fetchData();
    const analytics=computeGoals(people,encounters,participants);
    renderGoals(analytics,people,encounters,participants);
  }catch(e){
    content.innerHTML=`<div class="dash-loading dash-error">Failed to load: ${esc(e.message)}</div>`;
  }
};

async function fetchData(){
  const [{data:people,error:e1},{data:encounters,error:e2},{data:participants,error:e3}]=await Promise.all([
    db().from('people').select('id,name,contactintervaldays,notes').order('name'),
    db().from('encounters').select('id,date,type,description').order('date',{ascending:false}),
    db().from('encounter_participants').select('encounterid,personid'),
  ]);
  if(e1||e2||e3) throw new Error((e1||e2||e3).message);
  return {people:people||[],encounters:encounters||[],participants:participants||[]};
}

// ── Analytics ──────────────────────────────────────────────────────
function computeGoals(people,encounters,participants){
  const today=new Date();today.setHours(0,0,0,0);
  const block=getCurrentBlock(today);
  const prev=getPrevBlock(block.blockStart);

  const encPartsMap={},personEncsMap={};
  participants.forEach(({encounterid,personid})=>{
    if(!encPartsMap[encounterid])encPartsMap[encounterid]=[];encPartsMap[encounterid].push(personid);
    if(!personEncsMap[personid])personEncsMap[personid]=[];personEncsMap[personid].push(encounterid);
  });
  const encMap=Object.fromEntries(encounters.map(e=>[e.id,e]));

  // Qualifying encounters = exclude message + birthday
  const qual=e=>!EXCLUDED.has(e.type);

  // This block's encounters
  const blockEncs=encounters.filter(e=>qual(e)&&e.date>=block.blockStartISO&&e.date<=toISO(today));
  // Previous block's encounters (full block)
  const prevEncs=encounters.filter(e=>qual(e)&&e.date>=prev.blockStartISO&&e.date<=prev.blockEndISO);

  // KPI helpers
  function countEncs(encs){return encs.length;}
  function countUnique(encs){const s=new Set();encs.forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>s.add(pid)));return s.size;}
  function countActivity(encs){let n=0;encs.forEach(e=>{n+=(encPartsMap[e.id]||[]).length;});return n;}

  // Block targets from intervals
  // Target per block = round(28/interval), except low-frequency special logic
  function personBlockTarget(person){
    if(!person.contactintervaldays) return null;
    const interval=person.contactintervaldays;
    const raw=BLOCK_DAYS/interval;
    if(raw>=0.5) return Math.round(raw);
    // Low frequency: target 1 if interval crosses within this block
    // Find last qualifying encounter date
    const dates=(personEncsMap[person.id]||[])
      .map(id=>encMap[id])
      .filter(e=>e&&qual(e))
      .map(e=>e.date).sort().reverse();
    const lastDate=dates.length?new Date(dates[0]+'T00:00:00'):null;
    if(!lastDate) return 0; // never seen, not due this block
    const dueDate=addDays(lastDate,interval);
    // Due within this block?
    if(dueDate>=block.blockStart&&dueDate<=block.blockEnd) return 1;
    // Already overdue entering this block?
    if(dueDate<block.blockStart) return 1;
    return 0;
  }

  // Overall block targets (derived from sum of person targets)
  const peopleWithInterval=people.filter(p=>p.contactintervaldays);
  const activityTarget=Math.round(peopleWithInterval.reduce((s,p)=>{
    const t=personBlockTarget(p);return s+(t||0);
  },0));
  // Unique people target: count of people with target>=1
  const uniqueTarget=peopleWithInterval.filter(p=>(personBlockTarget(p)||0)>=1).length;
  // Encounter target: approximate from activity (1 person per encounter avg as baseline)
  const encTarget=activityTarget;

  // Day progress
  const dayElapsed=Math.round((today-block.blockStart)/86400000)+1;
  const dayTotal=BLOCK_DAYS;
  const blockPct=Math.round((dayElapsed/dayTotal)*100);

  // This-block actuals
  const actActivity=countActivity(blockEncs);
  const actUnique=countUnique(blockEncs);
  const actEncs=countEncs(blockEncs);

  // Prev block same-day actuals (for delta)
  const prevSameDay=addDays(prev.blockStart,dayElapsed-1);
  const prevSameDayISO=toISO(prevSameDay);
  const prevSameDayEncs=prevEncs.filter(e=>e.date<=prevSameDayISO);
  const prevActivity=countActivity(prevSameDayEncs);
  const prevUnique=countUnique(prevSameDayEncs);
  const prevEncCount=countEncs(prevSameDayEncs);

  // Full prev block totals for burn-up comparison
  const prevDailyActivity=buildDailyTimeseries(prevEncs,prev.blockStart,prev.blockEnd,encPartsMap,'activity');
  const prevDailyUnique=buildDailyTimeseries(prevEncs,prev.blockStart,prev.blockEnd,encPartsMap,'unique');
  const prevDailyEncs=buildDailyTimeseries(prevEncs,prev.blockStart,prev.blockEnd,encPartsMap,'encs');

  // This block daily timeseries
  const thisDailyActivity=buildDailyTimeseries(blockEncs,block.blockStart,today,encPartsMap,'activity');
  const thisDailyUnique=buildDailyTimeseries(blockEncs,block.blockStart,today,encPartsMap,'unique');
  const thisDailyEncs=buildDailyTimeseries(blockEncs,block.blockStart,today,encPartsMap,'encs');

  // Pace: 4 weeks within block
  const weeks=[];
  for(let w=0;w<4;w++){
    const wStart=addDays(block.blockStart,w*7);
    const wEnd=addDays(block.blockStart,w*7+6);
    const wStartISO=toISO(wStart);
    const wEndISO=toISO(wEnd);
    const wToday=today>=wStart&&today<=wEnd;
    const wPast=today>wEnd;
    const wEncs=blockEncs.filter(e=>e.date>=wStartISO&&e.date<=wEndISO);
    weeks.push({wStart,wEnd,wStartISO,wEndISO,
      actual:{activity:countActivity(wEncs),unique:countUnique(wEncs),encs:countEncs(wEncs)},
      isCurrent:wToday,isPast:wPast,
      daysElapsedInWeek:wToday?Math.round((today-wStart)/86400000)+1:(wPast?7:0),
      label:`${fmtShort(wStart)}`,
    });
  }

  // Person cards
  const personCards=peopleWithInterval.map(p=>{
    const target=personBlockTarget(p);
    const pEncs=blockEncs.filter(e=>(encPartsMap[e.id]||[]).includes(p.id));
    const actual=pEncs.length;
    const pct=target>0?Math.min(actual/target,2):1; // cap at 200% for display
    const encounterDetails=(personEncsMap[p.id]||[])
      .map(id=>encMap[id]).filter(e=>e&&qual(e)&&e.date>=block.blockStartISO&&e.date<=toISO(today))
      .sort((a,b)=>b.date.localeCompare(a.date))
      .map(e=>({date:e.date,type:e.type,description:e.description,
        names:(encPartsMap[e.id]||[]).map(pid=>people.find(pp=>pp.id===pid)?.name).filter(Boolean).filter(n=>n!==p.name).join(', ')}));
    return {person:p,target,actual,pct,encounterDetails};
  })
  // Sort by interval ascending (most frequent first), then alpha
  .sort((a,b)=>(a.person.contactintervaldays||999)-(b.person.contactintervaldays||999)||a.person.name.localeCompare(b.person.name));

  return {
    today,block,prev,blockPct,dayElapsed,dayTotal,
    actActivity,actUnique,actEncs,
    activityTarget,uniqueTarget,encTarget,
    prevActivity,prevUnique,prevEncCount,
    prevDailyActivity,prevDailyUnique,prevDailyEncs,
    thisDailyActivity,thisDailyUnique,thisDailyEncs,
    weeks,personCards,
  };
}

function buildDailyTimeseries(encs,startDate,endDate,encPartsMap,mode){
  // Returns array of {day,cumulative} for each day in range
  const result=[];
  let cum=0;
  const d=new Date(startDate);
  const end=new Date(endDate);
  while(d<=end){
    const iso=toISO(d);
    const dayEncs=encs.filter(e=>e.date===iso);
    if(mode==='activity') dayEncs.forEach(e=>{cum+=(encPartsMap[e.id]||[]).length;});
    else if(mode==='unique'){
      const s=new Set();encs.filter(e=>e.date<=iso).forEach(e=>(encPartsMap[e.id]||[]).forEach(pid=>s.add(pid)));
      cum=s.size;
    }
    else if(mode==='encs') cum+=dayEncs.length;
    result.push({day:new Date(d),iso,cumulative:cum});
    d.setDate(d.getDate()+1);
  }
  return result;
}

// ── Render ─────────────────────────────────────────────────────────
let _currentKPI='activity';
let _goalsData=null;
let _goalsAllPeople=null;

function renderGoals(a,people,encounters,participants){
  _goalsData=a;_goalsAllPeople=people;
  const content=document.getElementById('dashboard-content');

  function kpiBox(label,actual,target,prevActual){
    const diff=actual-prevActual;
    const cls=diff>=0?'kpi-up':'kpi-dn';
    const sign=diff>=0?'+':'';
    return `<div class="dash-kpi-box">
      <div class="dash-kpi-val">${actual}<span class="goals-kpi-target">/${target}</span></div>
      <div class="dash-kpi-lbl">${esc(label)}</div>
      <div class="dash-kpi-delta ${cls}">${diff>=0?'&#x2191;':'&#x2193;'} ${sign}${diff} vs this time last block</div>
    </div>`;
  }

  content.innerHTML=`
    <!-- Block progress -->
    <div class="section" style="padding:1rem 1.2rem 0">
      <div class="goals-block-header">
        <span class="goals-block-label">Block ${a.block.blockNum} &nbsp;·&nbsp; ${fmtShort(a.block.blockStart)} – ${fmtShort(a.block.blockEnd)}</span>
        <span class="goals-block-pct">${a.blockPct}%</span>
      </div>
      <div class="goals-progress-bar"><div class="goals-progress-fill" style="width:${a.blockPct}%"></div></div>
      <div class="goals-progress-meta"><span>${fmtShort(a.block.blockStart)}</span><span>${a.dayElapsed} of ${a.dayTotal} days</span><span>${fmtShort(a.block.blockEnd)}</span></div>
    </div>

    <!-- KPIs -->
    <div class="section" style="padding:0.8rem 1.2rem 0">
      <div class="dash-kpi-row">
        ${kpiBox('Social activity',a.actActivity,a.activityTarget,a.prevActivity)}
        ${kpiBox('Unique people',a.actUnique,a.uniqueTarget,a.prevUnique)}
        ${kpiBox('Encounters',a.actEncs,a.encTarget,a.prevEncCount)}
      </div>
    </div>

    <!-- KPI selector + Pace chart -->
    <div class="section" style="padding:0.8rem 1.2rem 0">
      <div class="goals-chart-header">
        <span class="dash-section-label" style="font-size:0.72rem">Pace</span>
        <div class="goals-kpi-sel">
          <button class="goals-kpi-btn${_currentKPI==='activity'?' active':''}" data-kpi="activity">Activity</button>
          <button class="goals-kpi-btn${_currentKPI==='unique'?' active':''}" data-kpi="unique">People</button>
          <button class="goals-kpi-btn${_currentKPI==='encs'?' active':''}" data-kpi="encs">Encounters</button>
        </div>
      </div>
      <div id="goals-pace-chart"></div>
    </div>

    <!-- Burn-up chart -->
    <div class="section" style="padding:0.8rem 1.2rem 0">
      <div class="dash-section-label" style="font-size:0.72rem;margin-bottom:0.5rem">Cumulative progress</div>
      <div id="goals-burnup-chart"></div>
      <div class="goals-burnup-legend">
        <span><span class="goals-legend-line goals-line-this"></span>This block</span>
        <span><span class="goals-legend-line goals-line-prev"></span>Last block</span>
        <span><span class="goals-legend-line goals-line-proj" style="border-style:dashed"></span>Projection</span>
      </div>
    </div>

    <!-- Person cards -->
    <div class="section" style="padding:0.8rem 1.2rem 0">
      <div class="dash-section-label" style="font-size:0.72rem;margin-bottom:0.6rem">Personal goals this block</div>
      <div class="goals-card-grid" id="goals-card-grid"></div>
    </div>

    <!-- Card popup -->
    <div id="goals-card-popup" class="goals-popup-backdrop hidden">
      <div class="goals-popup" id="goals-popup-inner"></div>
    </div>

    <div style="height:2rem"></div>
  `;

  renderPaceChart(a,_currentKPI);
  renderBurnupChart(a,_currentKPI);
  renderPersonCards(a);

  // KPI selector
  document.querySelectorAll('.goals-kpi-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      _currentKPI=btn.dataset.kpi;
      document.querySelectorAll('.goals-kpi-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderPaceChart(_goalsData,_currentKPI);
      renderBurnupChart(_goalsData,_currentKPI);
    });
  });

  // Popup close
  document.getElementById('goals-card-popup')?.addEventListener('click',e=>{
    if(e.target===document.getElementById('goals-card-popup')){
      document.getElementById('goals-card-popup').classList.add('hidden');
    }
  });
}

// ── Pace chart ─────────────────────────────────────────────────────
function renderPaceChart(a,kpi){
  const el=document.getElementById('goals-pace-chart');
  if(!el)return;

  const target=kpi==='activity'?a.activityTarget:kpi==='unique'?a.uniqueTarget:a.encTarget;
  const weeklyTarget=target/4;
  const totalActual=kpi==='activity'?a.actActivity:kpi==='unique'?a.actUnique:a.actEncs;
  const remaining=Math.max(target-totalActual,0);

  // Max Y for chart
  const maxVal=Math.max(...a.weeks.map(w=>w.actual[kpi]),weeklyTarget*1.3,1);

  const bars=a.weeks.map((w,i)=>{
    const actual=w.actual[kpi];
    const actualH=Math.round((actual/maxVal)*100);
    const targetH=Math.round((weeklyTarget/maxVal)*100);

    // Silhouette: remaining encounters distributed across remaining days
    const totalDaysLeft=a.dayTotal-a.dayElapsed+1;
    let silhouette=0;
    if(w.isCurrent){
      const daysLeftInWeek=7-w.daysElapsedInWeek;
      silhouette=totalDaysLeft>0?Math.round((remaining/totalDaysLeft)*daysLeftInWeek):0;
    } else if(!w.isPast){
      silhouette=totalDaysLeft>0?Math.round((remaining/totalDaysLeft)*7):0;
    }
    const silH=Math.round((silhouette/maxVal)*100);
    const targetLineY=Math.round((weeklyTarget/maxVal)*100);

    return `<div class="goals-pace-col${w.isCurrent?' goals-pace-current':''}${w.isPast?'':(!w.isCurrent?' goals-pace-future':'')}">
      <div class="goals-pace-bar-wrap">
        <div class="goals-pace-bar-track">
          <div class="goals-pace-actual" style="height:${actualH}%"></div>
          ${silhouette>0?`<div class="goals-pace-silhouette" style="height:${silH}%"></div>`:''}
          <div class="goals-pace-target-line" style="bottom:${targetLineY}%"></div>
        </div>
      </div>
      <div class="goals-pace-label">${w.label}${w.isCurrent?' ◀':''}</div>
    </div>`;
  }).join('');

  const yMid=Math.round(maxVal/2);
  el.innerHTML=`<div class="goals-pace-wrap">
    <div class="dash-y-axis" style="height:100px"><span>${Math.round(maxVal)}</span><span>${yMid}</span><span>0</span></div>
    <div style="flex:1;min-width:0">
      <div class="goals-pace-cols" style="height:100px">${bars}</div>
      <div class="dash-x-axis-line"></div>
    </div>
  </div>
  <div class="goals-pace-legend">
    <span><span class="goals-leg-box goals-leg-actual"></span>Actual</span>
    <span><span class="goals-leg-box goals-leg-sil"></span>Needed</span>
    <span style="color:var(--fog);font-size:0.6rem">— = weekly avg target</span>
  </div>`;
}

// ── Burn-up chart ──────────────────────────────────────────────────
function renderBurnupChart(a,kpi){
  const el=document.getElementById('goals-burnup-chart');
  if(!el)return;

  const target=kpi==='activity'?a.activityTarget:kpi==='unique'?a.uniqueTarget:a.encTarget;
  const thisData=kpi==='activity'?a.thisDailyActivity:kpi==='unique'?a.thisDailyUnique:a.thisDailyEncs;
  const prevData=kpi==='activity'?a.prevDailyActivity:kpi==='unique'?a.prevDailyUnique:a.prevDailyEncs;

  const maxVal=Math.max(target,prevData.length?prevData[prevData.length-1].cumulative:0,thisData.length?thisData[thisData.length-1].cumulative:0,1);
  const chartH=90;const chartW=280;

  // This block line (up to today)
  const thisPoints=thisData.map((d,i)=>{
    const x=Math.round((i/(BLOCK_DAYS-1))*chartW);
    const y=chartH-Math.round((d.cumulative/maxVal)*chartH);
    return `${x},${y}`;
  }).join(' ');

  // Previous block line (full 28 days)
  const prevPoints=prevData.map((d,i)=>{
    const x=Math.round((i/(BLOCK_DAYS-1))*chartW);
    const y=chartH-Math.round((d.cumulative/maxVal)*chartH);
    return `${x},${y}`;
  }).join(' ');

  // Projection: from last this-block point to target at day 28
  const lastThis=thisData.length?thisData[thisData.length-1]:null;
  const projStart=lastThis?{x:Math.round(((thisData.length-1)/(BLOCK_DAYS-1))*chartW),y:chartH-Math.round((lastThis.cumulative/maxVal)*chartH)}:null;
  const projEnd={x:chartW,y:chartH-Math.round((target/maxVal)*chartH)};

  // Target line (horizontal)
  const targetY=chartH-Math.round((target/maxVal)*chartH);

  // Y axis labels
  const yMid=Math.round(maxVal/2);

  el.innerHTML=`<div style="display:flex;gap:4px;align-items:flex-start">
    <div class="dash-y-axis" style="height:${chartH}px"><span>${Math.round(maxVal)}</span><span>${yMid}</span><span>0</span></div>
    <svg width="100%" height="${chartH}" viewBox="0 0 ${chartW} ${chartH}" style="overflow:visible;display:block">
      <!-- Target line -->
      <line x1="0" y1="${targetY}" x2="${chartW}" y2="${targetY}" stroke="var(--navy-light)" stroke-width="1" stroke-dasharray="3,3"/>
      <!-- Prev block -->
      ${prevPoints?`<polyline points="${prevPoints}" fill="none" stroke="var(--slate)" stroke-width="1.5" opacity="0.6"/>`:''}
      <!-- Projection -->
      ${projStart?`<line x1="${projStart.x}" y1="${projStart.y}" x2="${projEnd.x}" y2="${projEnd.y}" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.7"/>`:''}
      <!-- This block -->
      ${thisPoints?`<polyline points="${thisPoints}" fill="none" stroke="var(--amber)" stroke-width="2"/>`:''}
      <!-- Current day dot -->
      ${lastThis?`<circle cx="${projStart.x}" cy="${projStart.y}" r="3" fill="var(--amber)"/>`:''}
    </svg>
  </div>
  <div class="dash-x-axis-line" style="margin-left:28px"></div>`;
}

// ── Person cards ───────────────────────────────────────────────────
function renderPersonCards(a){
  const grid=document.getElementById('goals-card-grid');
  if(!grid)return;

  // Block elapsed % for border ring
  const blockPct=a.blockPct/100;

  grid.innerHTML=a.personCards.map((card,i)=>{
    const {person,target,actual,pct}=card;
    // Pie fill colour: 0→red, 1→green, >1→purple
    const fillColor=pct<=0?'#C0392B':pct>=1?pctToColor(pct):'#C0392B';
    // Conic gradient for card background
    const fillDeg=Math.min(pct,1)*360;
    const cardBg=target===0
      // No target this block — full green (nothing needed)
      ?`conic-gradient(#2D9E5F 360deg, transparent 360deg)`
      :fillDeg===0
        ?`var(--navy-mid)`
        :`conic-gradient(${fillColor} ${fillDeg}deg, var(--navy-mid) ${fillDeg}deg)`;

    // Border: % through block
    const borderDeg=Math.round(blockPct*360);

    return `<div class="goals-card" data-idx="${i}" style="--fill-deg:${fillDeg}deg;--border-deg:${borderDeg}deg;background:${cardBg}">
      <div class="goals-card-border" style="background:conic-gradient(var(--amber) ${borderDeg}deg, var(--navy-light) ${borderDeg}deg)"></div>
      <div class="goals-card-inner">
        <div class="goals-card-name">${esc(person.name)}</div>
        <div class="goals-card-count">${actual}/${target===0?'✓':target}</div>
      </div>
    </div>`;
  }).join('');

  // Scroll-safe tap to open popup
  let touchStartX,touchStartY;
  grid.addEventListener('touchstart',e=>{touchStartX=e.touches[0].clientX;touchStartY=e.touches[0].clientY;},{passive:true});
  grid.addEventListener('touchend',e=>{
    const dx=Math.abs(e.changedTouches[0].clientX-touchStartX);
    const dy=Math.abs(e.changedTouches[0].clientY-touchStartY);
    if(dx>10||dy>10)return;
    const card=e.target.closest('.goals-card');
    if(card){e.preventDefault();openCardPopup(+card.dataset.idx,a,card);}
  },{passive:false});
  grid.addEventListener('click',e=>{
    const card=e.target.closest('.goals-card');
    if(card) openCardPopup(+card.dataset.idx,a,card);
  });
}

function pctToColor(pct){
  // 0→red, 1→green, >1→purple (more purple as pct increases beyond 1)
  if(pct<=0) return '#C0392B';
  if(pct<1){
    // red→green
    const t=pct;
    const r=Math.round(192+(45-192)*t);
    const g=Math.round(57+(106-57)*t);
    const b=Math.round(43+(79-43)*t);
    return `rgb(${r},${g},${b})`;
  }
  if(pct>=1){
    // green→purple, capped at 2×
    const t=Math.min(pct-1,1);
    const r=Math.round(45+(128-45)*t);
    const g=Math.round(106+(0-106)*t);
    const b=Math.round(79+(128-79)*t);
    return `rgb(${r},${g},${b})`;
  }
  return '#2D9E5F';
}

function openCardPopup(idx,a,cardEl){
  const card=a.personCards[idx];
  if(!card)return;
  const {person,target,actual,encounterDetails}=card;

  const TYPE_LABELS={'call':'Call','1-on-1':'1-on-1','small-group':'Small group','large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'};

  const encsHTML=encounterDetails.length
    ?encounterDetails.map(e=>`<div class="goals-popup-enc">
        <span class="goals-popup-enc-date">${e.date}</span>
        <span class="goals-popup-enc-type">${esc(TYPE_LABELS[e.type]||e.type)}</span>
        ${e.names?`<span class="goals-popup-enc-with">with ${esc(e.names)}</span>`:''}
        ${e.description?`<div class="goals-popup-enc-note">${esc(e.description)}</div>`:''}
      </div>`).join('')
    :`<div class="goals-popup-empty">No encounters logged yet this block.</div>`;

  const pct=target>0?Math.round((actual/target)*100):100;
  const fillColor=pctToColor(actual/(target||1));
  const fillDeg=Math.min(actual/(target||1),1)*360;

  document.getElementById('goals-popup-inner').innerHTML=`
    <div class="goals-popup-header">
      <div class="goals-popup-pie" style="background:conic-gradient(${fillColor} ${fillDeg}deg, var(--navy-light) ${fillDeg}deg)">
        <div class="goals-popup-pie-inner">${actual}/${target===0?'✓':target}</div>
      </div>
      <div>
        <div class="goals-popup-name">${esc(person.name)}</div>
        <div class="goals-popup-sub">${pct}% of block target · interval ${person.contactintervaldays}d</div>
      </div>
      <button class="goals-popup-close" onclick="document.getElementById('goals-card-popup').classList.add('hidden')">&#x2715;</button>
    </div>
    <div class="goals-popup-encs">${encsHTML}</div>
  `;

  document.getElementById('goals-card-popup').classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded',()=>{
  // goals-card-popup backdrop handled inline
});
