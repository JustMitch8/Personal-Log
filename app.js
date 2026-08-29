import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { initNotifications } from './notifications.js';

// ══ State ══════════════════════════════════════════════════════════
let supabase        = null;
let currentUserId   = null;
let allPeople       = [];   // [{id, name, contactintervaldays, daysSince}]
let frequentFriends = [];
let selectedPeople  = [];
let searchHighlight = -1;
let currentType     = null;

// People screen state
let editingPerson  = null;
let unlockedFields = new Set();
let pendingUnlock  = null;

const SECTION_TITLES = [
  'Frequent Friends','Prevalent Pals','Common Companions','Back-to-Back Buddies'
];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

// ══ Helpers ════════════════════════════════════════════════════════
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function initials(name) {
  return name.split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase();
}
function sentenceCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
function yesterdayISO() {
  const d=new Date(); d.setDate(d.getDate()-1);
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function todayISO() {
  const d=new Date(), p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

// ══ Badge colour ═══════════════════════════════════════════════════
function daysBadge(days, interval) {
  if (days === null || days === undefined) return null;
  const label = days === 0 ? 'today' : days === 1 ? '1d' : `${days}d`;
  if (!interval) {
    return { color: lerpColor('#2D6A4F','#8B5E3C', Math.min(days/90,1)), label };
  }
  if (days <= 0)            return { color: '#2D6A4F', label };
  if (days <= interval)     return { color: lerpColor('#2D9E5F','#E07B2A', days/interval), label };
  if (days <= interval*2)   return { color: lerpColor('#E07B2A','#C0392B', (days-interval)/interval), label };
  return { color: lerpColor('#C0392B','#5C0A0A', Math.min((days-interval*2)/(interval*2),1)), label };
}

function lerpColor(h1,h2,t) {
  const x=i=>parseInt(i,16);
  const r1=x(h1.slice(1,3)),g1=x(h1.slice(3,5)),b1=x(h1.slice(5,7));
  const r2=x(h2.slice(1,3)),g2=x(h2.slice(3,5)),b2=x(h2.slice(5,7));
  return `rgb(${Math.round(r1+(r2-r1)*t)},${Math.round(g1+(g2-g1)*t)},${Math.round(b1+(b2-b1)*t)})`;
}

function badgeHTML(person) {
  const badge = daysBadge(person.daysSince, person.contactintervaldays);
  if (!badge) return '';
  return `<span class="person-badge" style="background:${badge.color}">${badge.label}</span>`;
}

// ══ Screen management ══════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ══ Auth error ═════════════════════════════════════════════════════
function showAuthError(msg) {
  const el=document.getElementById('auth-error');
  el.textContent=msg; el.classList.remove('hidden');
}
function hideAuthError() { document.getElementById('auth-error').classList.add('hidden'); }

// ══ Boot ═══════════════════════════════════════════════════════════
async function boot() {
  if (typeof SUPABASE_URL==='undefined'||SUPABASE_URL==='YOUR_SUPABASE_URL') {
    showAuthError('Fill in SUPABASE_URL and SUPABASE_ANON in config.js'); return;
  }
  try { supabase=createClient(SUPABASE_URL,SUPABASE_ANON); window._plSupabase=supabase; }
  catch(e) { showAuthError('Failed to connect: '+e.message); return; }
  const {data:{session},error}=await supabase.auth.getSession();
  if (error) { showAuthError('Session error: '+error.message); return; }
  if (session) { currentUserId=session.user.id; await enterApp(); }
  else { showScreen('auth-screen'); }
}

// ══ Auth ═══════════════════════════════════════════════════════════
async function handleLogin() {
  const email=document.getElementById('auth-email').value.trim();
  const password=document.getElementById('auth-password').value;
  if (!email||!password) { showAuthError('Enter your email and password.'); return; }
  hideAuthError();
  const btn=document.getElementById('auth-btn');
  btn.disabled=true; btn.textContent='Signing in...';
  const {data,error}=await supabase.auth.signInWithPassword({email,password});
  if (error) { showAuthError('Login failed: '+error.message); btn.disabled=false; btn.textContent='Sign In'; return; }
  currentUserId=data.user.id;
  btn.disabled=false; btn.textContent='Sign In';
  await enterApp();
}

async function handleSignOut() {
  await supabase.auth.signOut();
  allPeople=[]; selectedPeople=[]; frequentFriends=[]; currentUserId=null;
  document.getElementById('auth-email').value='';
  document.getElementById('auth-password').value='';
  hideAuthError();
  showScreen('auth-screen');
}

// ══ App entry ══════════════════════════════════════════════════════
async function enterApp() {
  showScreen('app-screen');
  document.getElementById('date-input').value=todayISO();
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
  currentType=null;
  await loadData();
  initNotifications(); // schedule daily reminder, non-blocking
}

// ══ Data loading ═══════════════════════════════════════════════════
async function loadData() {
  // Load all people
  const {data:people,error:pe}=await supabase
    .from('people').select('id,name,contactintervaldays').order('name');
  if (pe||!people) { renderFrequentFriends(); return; }

  // Filter excluded types in JS — PostgREST chokes on hyphens in .not().in()
  const EXCLUDED=new Set(['message','birthday-acknowledgment']);
  const cutoffDate=new Date();
  cutoffDate.setMonth(cutoffDate.getMonth()-3);
  const cutoff=cutoffDate.toISOString().split('T')[0];

  const {data:recentRaw}=await supabase
    .from('encounters').select('id,date,type').gte('date',cutoff);
  const encounters=(recentRaw||[]).filter(e=>!EXCLUDED.has(e.type));

  const {data:allRaw}=await supabase
    .from('encounters').select('id,date,type');
  const allEncounters=(allRaw||[]).filter(e=>!EXCLUDED.has(e.type));

  const {data:allParticipants}=await supabase
    .from('encounter_participants').select('encounterid,personid');

  const today=new Date(); today.setHours(0,0,0,0);

  // Build lastDate map across all time (for badges)
  const lastDateMap={};
  if (allEncounters && allParticipants) {
    const allDateMap=Object.fromEntries(allEncounters.map(e=>[e.id,e.date]));
    allParticipants.forEach(({encounterid,personid})=>{
      const date=allDateMap[encounterid];
      if (!date) return;
      if (!lastDateMap[personid]||date>lastDateMap[personid]) lastDateMap[personid]=date;
    });
  }

  // Attach daysSince to each person
  allPeople=people.map(p=>{
    const lastDate=lastDateMap[p.id];
    let daysSince=null;
    if (lastDate) {
      const last=new Date(lastDate); last.setHours(0,0,0,0);
      daysSince=Math.round((today-last)/86400000);
    }
    return {...p,daysSince};
  });

  // Compute frequentFriends from last 3 months
  if (encounters && encounters.length && allParticipants) {
    const recentIds=new Set(encounters.map(e=>e.id));
    const recentDateMap=Object.fromEntries(encounters.map(e=>[e.id,e.date]));
    const stats={};
    allParticipants.forEach(({encounterid,personid})=>{
      if (!recentIds.has(encounterid)) return;
      if (!stats[personid]) stats[personid]={count:0};
      stats[personid].count++;
    });
    frequentFriends=Object.entries(stats)
      .sort((a,b)=>b[1].count-a[1].count).slice(0,8)
      .map(([pid])=>allPeople.find(p=>p.id===pid))
      .filter(Boolean);
  } else {
    frequentFriends=[];
  }

  renderFrequentFriends();
  renderChips(); // refresh chips with updated badge data
}

// ══ Frequent Friends ═══════════════════════════════════════════════
function renderFrequentFriends() {
  const section=document.getElementById('frequent-section');
  const grid=document.getElementById('frequent-grid');
  const title=document.getElementById('frequent-title');
  if (!frequentFriends.length) { section.style.display='none'; return; }
  title.textContent=SECTION_TITLES[Math.floor(Math.random()*SECTION_TITLES.length)];
  section.style.display='block';
  grid.innerHTML=frequentFriends.map(f=>{
    const sel=selectedPeople.find(p=>p.id===f.id);
    const badge=daysBadge(f.daysSince,f.contactintervaldays);
    return `<button class="ff-card${sel?' ff-selected':''}" data-id="${f.id}" data-name="${esc(f.name)}">
      <div class="ff-avatar">${initials(f.name)}</div>
      <div class="ff-name">${esc(f.name)}</div>
      ${badge?`<div class="ff-badge" style="background:${badge.color}">${badge.label}</div>`:''}
    </button>`;
  }).join('');
  grid.querySelectorAll('.ff-card').forEach(card=>{
    card.addEventListener('click',()=>{
      const {id,name}=card.dataset;
      if (selectedPeople.find(p=>p.id===id)) removePerson(id); else addPerson(id,name);
      renderFrequentFriends();
    });
  });
}

// ══ Encounter type ══════════════════════════════════════════════════
function handleTypeClick(e) {
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
  e.currentTarget.classList.add('active');
  currentType=e.currentTarget.dataset.type;
}

// ══ Encounter search (spills upward) ═══════════════════════════════
function handleSearchInput(e) {
  searchHighlight=-1;
  const raw=e.target.value;
  const q=sentenceCase(raw.trim());
  // Update input value to sentence case
  if (raw&&raw[0]!==raw[0].toUpperCase()) { const el=e.target; const pos=el.selectionStart; el.value=sentenceCase(raw); el.setSelectionRange(pos,pos); }
  const resultsEl=document.getElementById('search-results');
  if (!q) { resultsEl.classList.add('hidden'); resultsEl.innerHTML=''; return; }
  const ql=q.toLowerCase();
  const selectedIds=new Set(selectedPeople.map(p=>p.id));
  const scored=allPeople.filter(p=>!selectedIds.has(p.id))
    .map(p=>({p,score:scoreMatch(p.name,ql)})).filter(r=>r.score>0)
    .sort((a,b)=>b.score-a.score).slice(0,7); // leave room for add-new row

  // Best match at BOTTOM (closest to search bar) — reverse order, add-new at TOP
  const matchRows=scored.reverse().map(({p})=>{
    const badge=daysBadge(p.daysSince,p.contactintervaldays);
    return `<div class="search-result-item" data-id="${p.id}" data-name="${esc(p.name)}">
      <div class="search-result-avatar">${initials(p.name)}</div>
      <span class="search-result-name">${esc(p.name)}</span>
      ${badge?`<span class="person-badge" style="background:${badge.color}">${badge.label}</span>`:''}
    </div>`;
  });

  // Add-new at the very TOP
  const addNewRow=`<div class="search-result-item search-add-new" data-addname="${esc(q)}">
    <div class="search-result-avatar search-avatar-add">+</div>
    <span class="search-result-name">&ldquo;${esc(q)}&rdquo; &mdash; add new person</span>
  </div>`;

  resultsEl.innerHTML=[addNewRow,...matchRows].join('');
  resultsEl.classList.remove('hidden');
  // Always scroll to bottom so best match is visible
  resultsEl.scrollTop=resultsEl.scrollHeight;

  resultsEl.querySelectorAll('.search-result-item:not(.search-add-new)').forEach(item=>{
    item.addEventListener('click',()=>addPerson(item.dataset.id,item.dataset.name));
    item.addEventListener('touchend',ev=>{ev.preventDefault();addPerson(item.dataset.id,item.dataset.name);});
  });
  resultsEl.querySelectorAll('.search-add-new').forEach(item=>{
    item.addEventListener('click',()=>goAddNewFromSearch(item.dataset.addname));
    item.addEventListener('touchend',ev=>{ev.preventDefault();goAddNewFromSearch(item.dataset.addname);});
  });
}

function goAddNewFromSearch(name) {
  clearEncounterSearch();
  openPeopleScreen(name);
}

function handleSearchKey(e) {
  const resultsEl=document.getElementById('search-results');
  const items=[...resultsEl.querySelectorAll('.search-result-item')];
  if (!items.length) return;
  if (e.key==='ArrowDown') { e.preventDefault(); searchHighlight=Math.min(searchHighlight+1,items.length-1); }
  else if (e.key==='ArrowUp') { e.preventDefault(); searchHighlight=Math.max(searchHighlight-1,0); }
  else if (e.key==='Enter') {
    e.preventDefault();
    const t=searchHighlight>=0?items[searchHighlight]:items[items.length-1];
    if (!t) return;
    if (t.classList.contains('search-add-new')) goAddNewFromSearch(t.dataset.addname);
    else addPerson(t.dataset.id,t.dataset.name);
    return;
  } else if (e.key==='Escape') { clearEncounterSearch(); return; }
  items.forEach((el,i)=>el.classList.toggle('highlighted',i===searchHighlight));
}

function scoreMatch(name,q) {
  const lower=name.toLowerCase(), words=lower.split(/\s+/);
  if (words[0].startsWith(q)) return 300;
  if (words.slice(1).some(w=>w.startsWith(q))) return 200;
  if (lower.includes(q)) return 100;
  return 0;
}

// ══ Selected people (chips) ═════════════════════════════════════════
function addPerson(id,name) {
  if (selectedPeople.find(p=>p.id===id)) { clearEncounterSearch(); return; }
  selectedPeople.push({id,name}); clearEncounterSearch(); renderChips();
}
function removePerson(id) {
  selectedPeople=selectedPeople.filter(p=>p.id!==id); renderChips();
}
function renderChips() {
  const wrap=document.getElementById('chips-wrap');
  const section=document.getElementById('selected-section');
  if (!selectedPeople.length) { section.style.display='none'; wrap.innerHTML=''; return; }
  section.style.display='block';
  wrap.innerHTML=selectedPeople.map(p=>{
    const full=allPeople.find(a=>a.id===p.id);
    const badge=full?daysBadge(full.daysSince,full.contactintervaldays):null;
    return `<div class="chip">
      ${badge?`<span class="chip-badge" style="background:${badge.color}">${badge.label}</span>`:''}
      ${esc(p.name)}
      <button class="chip-remove" data-id="${p.id}">&times;</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.chip-remove').forEach(btn=>{
    btn.addEventListener('click',()=>{ removePerson(btn.dataset.id); renderFrequentFriends(); });
  });
}
function clearEncounterSearch() {
  document.getElementById('search-input').value='';
  const r=document.getElementById('search-results');
  r.classList.add('hidden'); r.innerHTML=''; searchHighlight=-1;
}

// ══ Save encounter ══════════════════════════════════════════════════
async function handleSave() {
  if (!selectedPeople.length) { showEncounterStatus('Add at least one person first.','error'); return; }
  if (!currentType) { showEncounterStatus('Please select an encounter type.','error'); return; }
  const date=document.getElementById('date-input').value;
  const notes=document.getElementById('notes-input').value.trim();
  if (!date) { showEncounterStatus('Please select a date.','error'); return; }
  const btn=document.getElementById('save-btn');
  const txt=document.getElementById('save-btn-text');
  btn.disabled=true; txt.textContent='Saving...';
  const {data:enc,error:e1}=await supabase.from('encounters')
    .insert({date,type:currentType,description:notes||null}).select('id').single();
  if (e1) { showEncounterStatus('Error: '+e1.message,'error'); btn.disabled=false; txt.textContent='Save Encounter'; return; }
  const {error:e2}=await supabase.from('encounter_participants')
    .insert(selectedPeople.map(p=>({encounterid:enc.id,personid:p.id})));
  if (e2) { showEncounterStatus('Saved but participants failed: '+e2.message,'error'); btn.disabled=false; txt.textContent='Save Encounter'; return; }
  showEncounterStatus('Saved with '+selectedPeople.map(p=>p.name).join(', ')+'.','success');
  selectedPeople=[]; renderChips();
  document.getElementById('notes-input').value='';
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
  currentType=null; btn.disabled=false; txt.textContent='Save Encounter';
  await loadData();
  setTimeout(()=>document.getElementById('save-status').classList.add('hidden'),4000);
}
function showEncounterStatus(msg,type) {
  const el=document.getElementById('save-status');
  el.textContent=msg; el.className='save-status '+type;
}

// ══════════════════════════════════════════════════════════════════
//  PEOPLE SCREEN
// ══════════════════════════════════════════════════════════════════

function openPeopleScreen(prefillName='') {
  editingPerson=null; unlockedFields=new Set();
  showScreen('people-screen');
  document.getElementById('people-screen-title').textContent='Person';
  document.getElementById('people-search-input').value='';
  document.getElementById('people-search-results').classList.add('hidden');
  document.getElementById('people-search-results').innerHTML='';
  resetPeopleForm();
  showPeopleForm(null);
  if (prefillName) {
    document.getElementById('p-name').value=prefillName;
  }
}

function resetPeopleForm() {
  document.getElementById('p-name').value='';
  document.getElementById('p-firstmet').value=todayISO();
  document.getElementById('p-bday').value='';
  document.getElementById('p-bmonth').value='';
  document.getElementById('p-byear').value='';
  document.getElementById('p-interval').value='';
  document.getElementById('p-notes-new').value='';
  document.getElementById('p-notes-existing').classList.add('hidden');
  document.getElementById('p-notes-existing').innerHTML='';
  document.getElementById('people-save-status').classList.add('hidden');
  ['name','firstmet','birthday'].forEach(f=>{
    document.getElementById(f+'-lock').classList.add('hidden');
    const inp=getFieldInputs(f);
    inp.forEach(i=>i.removeAttribute('disabled'));
  });
}

function getFieldInputs(field) {
  if (field==='name')     return [document.getElementById('p-name')];
  if (field==='firstmet') return [document.getElementById('p-firstmet')];
  if (field==='birthday') return [
    document.getElementById('p-bday'),
    document.getElementById('p-bmonth'),
    document.getElementById('p-byear'),
  ];
  return [];
}

function showPeopleForm(person) {
  editingPerson=person;
  unlockedFields=new Set();
  document.getElementById('people-form-section').style.display='block';
  document.getElementById('people-clear-btn').style.display=person?'block':'none';
  document.getElementById('people-save-btn-text').textContent=person?'Save Changes':'Save Person';
  document.getElementById('people-screen-title').textContent=person?'Edit Person':'Add Person';
  document.getElementById('people-save-status').classList.add('hidden');

  if (!person) { resetPeopleForm(); return; }

  document.getElementById('p-name').value=person.name||'';
  lockField('name',!!person.name);
  document.getElementById('p-firstmet').value=person.firstmet||'';
  lockField('firstmet',!!person.firstmet);
  document.getElementById('p-bday').value=person.birthday_day||'';
  document.getElementById('p-bmonth').value=person.birthday_month||'';
  document.getElementById('p-byear').value=person.birthday_year||'';
  lockField('birthday',!!(person.birthday_day||person.birthday_month||person.birthday_year));
  document.getElementById('p-interval').value=person.contactintervaldays||'';
  const ex=document.getElementById('p-notes-existing');
  if (person.notes) {
    ex.innerHTML=`<div class="notes-existing-label">Existing notes</div><div class="notes-existing-text">${esc(person.notes)}</div>`;
    ex.classList.remove('hidden');
  } else {
    ex.classList.add('hidden');
  }
  document.getElementById('p-notes-new').value='';
}

function lockField(field,hasData) {
  const lock=document.getElementById(field+'-lock');
  const inputs=getFieldInputs(field);
  if (hasData) {
    lock.classList.remove('hidden');
    inputs.forEach(i=>i.setAttribute('disabled',''));
  } else {
    lock.classList.add('hidden');
    inputs.forEach(i=>i.removeAttribute('disabled'));
  }
}

function handleLockClick(field) {
  if (unlockedFields.has(field)) return;
  pendingUnlock=field;
  const labels={name:'the person\'s name',firstmet:'the date you first met',birthday:'their birthday'};
  document.getElementById('unlock-modal-msg').textContent=
    `Changing ${labels[field]} is permanent and can't be undone easily. Are you sure?`;
  document.getElementById('unlock-modal').classList.remove('hidden');
}
function confirmUnlock() {
  if (!pendingUnlock) return;
  unlockedFields.add(pendingUnlock);
  getFieldInputs(pendingUnlock).forEach(i=>i.removeAttribute('disabled'));
  document.getElementById(pendingUnlock+'-lock').classList.add('hidden');
  document.getElementById('unlock-modal').classList.add('hidden');
  pendingUnlock=null;
}
function cancelUnlock() {
  pendingUnlock=null;
  document.getElementById('unlock-modal').classList.add('hidden');
}

// People screen search — spills downward, includes "add new" at bottom
function handlePeopleSearchInput(e) {
  const q=e.target.value.trim();
  const resultsEl=document.getElementById('people-search-results');
  if (!q) { resultsEl.classList.add('hidden'); resultsEl.innerHTML=''; return; }
  const ql=q.toLowerCase();
  const scored=allPeople.map(p=>({p,score:scoreMatch(p.name,ql)}))
    .filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,7);

  const rows=scored.map(({p})=>{
    const badge=daysBadge(p.daysSince,p.contactintervaldays);
    return `<div class="search-result-item" data-id="${p.id}" data-name="${esc(p.name)}">
      <div class="search-result-avatar">${initials(p.name)}</div>
      <span class="search-result-name">${esc(p.name)}</span>
      ${badge?`<span class="person-badge" style="background:${badge.color}">${badge.label}</span>`:''}
    </div>`;
  });

  // "Add new" option prefilled with query
  rows.push(`<div class="search-result-item search-add-new" data-addname="${esc(q)}">
    <div class="search-result-avatar search-avatar-add">+</div>
    <span class="search-result-name">&ldquo;${esc(q)}&rdquo; &mdash; add as new person</span>
  </div>`);

  resultsEl.innerHTML=rows.join('');
  resultsEl.classList.remove('hidden');

  resultsEl.querySelectorAll('.search-result-item:not(.search-add-new)').forEach(item=>{
    item.addEventListener('click',()=>selectPersonForEdit(item.dataset.id));
    item.addEventListener('touchend',ev=>{ev.preventDefault();selectPersonForEdit(item.dataset.id);});
  });
  resultsEl.querySelectorAll('.search-add-new').forEach(item=>{
    item.addEventListener('click',()=>prefillNewPersonFromPeopleSearch(item.dataset.addname));
    item.addEventListener('touchend',ev=>{ev.preventDefault();prefillNewPersonFromPeopleSearch(item.dataset.addname);});
  });
}

function prefillNewPersonFromPeopleSearch(name) {
  document.getElementById('people-search-input').value='';
  document.getElementById('people-search-results').classList.add('hidden');
  resetPeopleForm();
  showPeopleForm(null);
  document.getElementById('p-name').value=name;
}

async function selectPersonForEdit(id) {
  const {data,error}=await supabase.from('people')
    .select('id,name,firstmet,birthday_day,birthday_month,birthday_year,contactintervaldays,notes')
    .eq('id',id).single();
  if (error||!data) { showPeopleStatus('Could not load person.','error'); return; }
  document.getElementById('people-search-input').value='';
  document.getElementById('people-search-results').classList.add('hidden');
  showPeopleForm(data);
}

async function handlePeopleSave() {
  const name=document.getElementById('p-name').value.trim();
  if (!name) { showPeopleStatus('Name is required.','error'); return; }
  const btn=document.getElementById('people-save-btn');
  const txt=document.getElementById('people-save-btn-text');
  btn.disabled=true; txt.textContent='Saving...';

  const firstmet=document.getElementById('p-firstmet').value||null;
  const bday=parseInt(document.getElementById('p-bday').value)||null;
  const bmonth=parseInt(document.getElementById('p-bmonth').value)||null;
  const byear=parseInt(document.getElementById('p-byear').value)||null;
  const interval=parseInt(document.getElementById('p-interval').value)||null;
  const newNote=document.getElementById('p-notes-new').value.trim();
  const stamp=new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});

  if (editingPerson) {
    const payload={contactintervaldays:interval};
    if (!editingPerson.name||unlockedFields.has('name')) payload.name=name;
    if (!editingPerson.firstmet||unlockedFields.has('firstmet')) payload.firstmet=firstmet;
    const hadBirthday=editingPerson.birthday_day||editingPerson.birthday_month||editingPerson.birthday_year;
    if (!hadBirthday||unlockedFields.has('birthday')) {
      payload.birthday_day=bday; payload.birthday_month=bmonth; payload.birthday_year=byear;
    }
    if (newNote) {
      const appended=`[${stamp}] ${newNote}`;
      payload.notes=editingPerson.notes?editingPerson.notes+'\n\n'+appended:appended;
    }
    const {error}=await supabase.from('people').update(payload).eq('id',editingPerson.id);
    if (error) { showPeopleStatus('Error: '+error.message,'error'); btn.disabled=false; txt.textContent='Save Changes'; return; }
    editingPerson={...editingPerson,...payload};
    if (payload.notes) {
      const ex=document.getElementById('p-notes-existing');
      ex.innerHTML=`<div class="notes-existing-label">Existing notes</div><div class="notes-existing-text">${esc(payload.notes)}</div>`;
      ex.classList.remove('hidden');
      document.getElementById('p-notes-new').value='';
    }
    showPeopleStatus('Saved.','success');
    await loadData();
  } else {
    // Add mode — use auth.uid() via RLS default, do NOT pass user_id
    const noteText=newNote?`[${stamp}] ${newNote}`:null;
    const payload={
      name,
      firstmet:firstmet||todayISO(),
      birthday_day:bday, birthday_month:bmonth, birthday_year:byear,
      contactintervaldays:interval, notes:noteText
    };
    const {error}=await supabase.from('people').insert(payload);
    if (error) { showPeopleStatus('Error: '+error.message,'error'); btn.disabled=false; txt.textContent='Save Person'; return; }
    showPeopleStatus('Person added!','success');
    resetPeopleForm();
    await loadData();
  }

  btn.disabled=false;
  txt.textContent=editingPerson?'Save Changes':'Save Person';
  setTimeout(()=>document.getElementById('people-save-status').classList.add('hidden'),4000);
}

function showPeopleStatus(msg,type) {
  const el=document.getElementById('people-save-status');
  el.textContent=msg; el.className='save-status '+type;
}

// ══ Birthday dropdowns ══════════════════════════════════════════════
function populateBirthdayDropdowns() {
  const dayEl=document.getElementById('p-bday');
  const monthEl=document.getElementById('p-bmonth');
  for (let d=1;d<=31;d++) dayEl.innerHTML+=`<option value="${d}">${d}</option>`;
  MONTHS.forEach((m,i)=>monthEl.innerHTML+=`<option value="${i+1}">${m}</option>`);
}

// ══ Wire up all listeners ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded',()=>{
  populateBirthdayDropdowns();

  document.getElementById('auth-btn').addEventListener('click',handleLogin);
  document.getElementById('sign-out-btn').addEventListener('click',handleSignOut);
  document.getElementById('save-btn').addEventListener('click',handleSave);
  document.getElementById('search-input').addEventListener('input',handleSearchInput);
  document.getElementById('search-input').addEventListener('keydown',handleSearchKey);
  document.querySelectorAll('.type-btn').forEach(btn=>btn.addEventListener('click',handleTypeClick));
  document.getElementById('dashboard-btn').addEventListener('click',()=>{ window.openDashboard && window.openDashboard(); });
  document.getElementById('log-btn').addEventListener('click',()=>{ window.openLogScreen && window.openLogScreen(); });
  document.getElementById('add-person-btn').addEventListener('click',()=>openPeopleScreen());
  document.getElementById('btn-today').addEventListener('click',()=>{
    document.getElementById('date-input').value=todayISO();
  });
  document.getElementById('btn-yesterday').addEventListener('click',()=>{
    document.getElementById('date-input').value=yesterdayISO();
  });

  document.getElementById('people-back-btn').addEventListener('click',()=>showScreen('app-screen'));
  document.getElementById('people-clear-btn').addEventListener('click',()=>{
    editingPerson=null; unlockedFields=new Set();
    document.getElementById('people-search-input').value='';
    document.getElementById('people-search-results').classList.add('hidden');
    resetPeopleForm(); showPeopleForm(null);
  });

  document.getElementById('people-search-input').addEventListener('input',handlePeopleSearchInput);
  document.getElementById('p-name').addEventListener('input',function(){
    const el=this; const v=el.value; const pos=el.selectionStart;
    if(v&&v[0]!==v[0].toUpperCase()){el.value=sentenceCase(v);el.setSelectionRange(pos,pos);}
  });
  document.getElementById('people-save-btn').addEventListener('click',handlePeopleSave);

  document.getElementById('name-lock').addEventListener('click',()=>handleLockClick('name'));
  document.getElementById('firstmet-lock').addEventListener('click',()=>handleLockClick('firstmet'));
  document.getElementById('birthday-lock').addEventListener('click',()=>handleLockClick('birthday'));
  document.getElementById('unlock-confirm-btn').addEventListener('click',confirmUnlock);
  document.getElementById('unlock-cancel-btn').addEventListener('click',cancelUnlock);

  boot();
});
