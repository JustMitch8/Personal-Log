// encounters-log.js — v1.8
// Encounter Log: list, sort, filter, fuzzy search, swipe-to-delete, edit (with people), save confirm.

// ── State ──────────────────────────────────────────────────────────────────
let allEncounters   = [];
let allPeopleLog    = [];  // [{id,name}] loaded once for people picker
let filtered        = [];
let sortCol         = 'date';
let sortAsc         = false;
let filterType      = '';
let searchQuery     = '';
let pendingEditId   = null;
let pendingDeleteId = null;
let editPeople      = [];  // selected people in edit modal

const TYPE_LABELS = {
  'call':'Call','1-on-1':'1-on-1','small-group':'Small group',
  'large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'
};

function db() { return window._plSupabase; }

// ── Entry point ────────────────────────────────────────────────────────────
window.openLogScreen = async function() {
  showScreen('log-screen');
  await loadLog();
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Load ───────────────────────────────────────────────────────────────────
async function loadLog() {
  setLogLoading(true);

  const [{data:encs,error:e1},{data:parts},{data:people}] = await Promise.all([
    db().from('encounters').select('id,date,type,description').order('date',{ascending:false}),
    db().from('encounter_participants').select('encounterid,personid'),
    db().from('people').select('id,name').order('name'),
  ]);

  if (e1||!encs) { setLogLoading(false,'Failed to load encounters.'); return; }

  allPeopleLog = people||[];

  const personMap = Object.fromEntries((people||[]).map(p=>[p.id,p.name]));
  const partMap   = {};
  (parts||[]).forEach(({encounterid,personid})=>{
    if (!partMap[encounterid]) partMap[encounterid]=[];
    partMap[encounterid].push({id:personid, name:personMap[personid]||'Unknown'});
  });

  allEncounters = encs.map(e=>({
    ...e,
    people:    (partMap[e.id]||[]).sort((a,b)=>a.name.localeCompare(b.name)),
    peopleStr: (partMap[e.id]||[]).sort((a,b)=>a.name.localeCompare(b.name)).map(p=>p.name).join(', '),
  }));

  applyFilters();
  setLogLoading(false);
}

function setLogLoading(loading,msg) {
  const list=document.getElementById('log-list');
  if (loading) { list.innerHTML='<div class="log-loading">Loading\u2026</div>'; return; }
  if (msg)     { list.innerHTML=`<div class="log-loading log-error">${msg}</div>`; }
}

// ── Filter + sort ──────────────────────────────────────────────────────────
function applyFilters() {
  const q=searchQuery.toLowerCase().trim();
  filtered=allEncounters.filter(e=>{
    if (filterType&&e.type!==filterType) return false;
    if (!q) return true;
    return (
      e.date.includes(q)||
      (TYPE_LABELS[e.type]||e.type).toLowerCase().includes(q)||
      e.peopleStr.toLowerCase().includes(q)||
      (e.description||'').toLowerCase().includes(q)
    );
  });
  filtered.sort((a,b)=>{
    let va,vb;
    if (sortCol==='date')   { va=a.date;       vb=b.date; }
    else if (sortCol==='type')   { va=TYPE_LABELS[a.type]||a.type; vb=TYPE_LABELS[b.type]||b.type; }
    else if (sortCol==='people') { va=a.peopleStr; vb=b.peopleStr; }
    if (va<vb) return sortAsc?-1:1;
    if (va>vb) return sortAsc?1:-1;
    return 0;
  });
  renderLog();
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderLog() {
  const list=document.getElementById('log-list');
  if (!filtered.length) { list.innerHTML='<div class="log-loading">No encounters found.</div>'; return; }

  list.innerHTML=filtered.map(e=>{
    const typeLabel=TYPE_LABELS[e.type]||e.type;
    const typeClass='log-type-'+e.type.replace(/[^a-z0-9]/g,'-');
    const notes=e.description?`<div class="log-notes">${esc(e.description)}</div>`:'';
    return `
    <div class="log-card-wrap" data-id="${e.id}">
      <div class="log-swipe-bg">
        <span class="log-swipe-label">Delete</span>
      </div>
      <div class="log-card" data-id="${e.id}">
        <div class="log-card-top">
          <div class="log-card-left">
            <div class="log-date">${formatDate(e.date)}</div>
            <div class="log-type-badge ${typeClass}">${typeLabel}</div>
          </div>
          <button class="log-action-btn log-edit-btn" data-id="${e.id}" title="Edit">&#x270E;</button>
        </div>
        <div class="log-people">${esc(e.peopleStr||'\u2014')}</div>
        ${notes}
      </div>
    </div>`;
  }).join('');

  // Edit buttons
  list.querySelectorAll('.log-edit-btn').forEach(btn=>{
    btn.addEventListener('click',ev=>{ev.stopPropagation();openEditModal(btn.dataset.id);});
  });

  // Swipe-to-delete on each card
  list.querySelectorAll('.log-card-wrap').forEach(wrap=>attachSwipe(wrap));
}

// ── Swipe to delete ────────────────────────────────────────────────────────
const SWIPE_THRESHOLD  = 80;   // px to reveal delete zone
const SWIPE_CONFIRM    = 200;  // px to trigger delete modal

function attachSwipe(wrap) {
  const card=wrap.querySelector('.log-card');
  let startX=0, currentX=0, dragging=false;

  function onStart(x) { startX=x; currentX=x; dragging=true; card.style.transition='none'; }
  function onMove(x) {
    if (!dragging) return;
    currentX=x;
    const dx=Math.min(0, x-startX); // only left swipe
    card.style.transform=`translateX(${dx}px)`;
    wrap.querySelector('.log-swipe-bg').style.opacity= Math.min(1, Math.abs(dx)/SWIPE_THRESHOLD);
  }
  function onEnd() {
    if (!dragging) return;
    dragging=false;
    const dx=currentX-startX;
    card.style.transition='transform 0.25s ease';
    if (dx < -SWIPE_CONFIRM) {
      // Trigger delete modal then snap back
      card.style.transform='translateX(0)';
      wrap.querySelector('.log-swipe-bg').style.opacity=0;
      openDeleteModal(wrap.dataset.id);
    } else {
      card.style.transform='translateX(0)';
      wrap.querySelector('.log-swipe-bg').style.opacity=0;
    }
  }

  // Touch
  card.addEventListener('touchstart', e=>{ onStart(e.touches[0].clientX); },{passive:true});
  card.addEventListener('touchmove',  e=>{ onMove(e.touches[0].clientX);  },{passive:true});
  card.addEventListener('touchend',   ()=>onEnd());

  // Mouse (desktop fallback)
  card.addEventListener('mousedown',  e=>{ onStart(e.clientX); });
  card.addEventListener('mousemove',  e=>{ if(dragging) onMove(e.clientX); });
  card.addEventListener('mouseup',    ()=>onEnd());
  card.addEventListener('mouseleave', ()=>{ if(dragging) onEnd(); });
}

// ── Edit modal ─────────────────────────────────────────────────────────────
function openEditModal(id) {
  const enc=allEncounters.find(e=>e.id===id);
  if (!enc) return;
  pendingEditId=id;

  document.getElementById('log-edit-date').value  = enc.date;
  document.getElementById('log-edit-type').value  = enc.type;
  document.getElementById('log-edit-notes').value = enc.description||'';

  // Seed people picker with current participants
  editPeople=[...enc.people];
  renderEditChips();
  document.getElementById('log-edit-people-search').value='';
  document.getElementById('log-edit-people-results').classList.add('hidden');
  document.getElementById('log-edit-people-results').innerHTML='';

  document.getElementById('log-edit-modal').classList.remove('hidden');
}

function renderEditChips() {
  const wrap=document.getElementById('log-edit-chips');
  if (!editPeople.length) { wrap.innerHTML='<span style="color:var(--slate);font-size:0.82rem">No people added</span>'; return; }
  wrap.innerHTML=editPeople.map(p=>
    `<div class="chip" style="font-size:0.82rem;padding:0.25rem 0.6rem">
      ${esc(p.name)}
      <button class="chip-remove" data-id="${p.id}">&times;</button>
    </div>`
  ).join('');
  wrap.querySelectorAll('.chip-remove').forEach(btn=>{
    btn.addEventListener('click',()=>{
      editPeople=editPeople.filter(p=>p.id!==btn.dataset.id);
      renderEditChips();
    });
  });
}

function handleEditPeopleSearch(e) {
  const q=e.target.value.trim().toLowerCase();
  const res=document.getElementById('log-edit-people-results');
  if (!q) { res.classList.add('hidden'); res.innerHTML=''; return; }

  const selectedIds=new Set(editPeople.map(p=>p.id));
  const matches=allPeopleLog
    .filter(p=>!selectedIds.has(p.id)&&p.name.toLowerCase().includes(q))
    .slice(0,6);

  if (!matches.length) { res.innerHTML='<div class="search-no-results">No results</div>'; res.classList.remove('hidden'); return; }

  res.innerHTML=matches.map(p=>
    `<div class="search-result-item" data-id="${p.id}" data-name="${esc(p.name)}">
      <div class="search-result-avatar">${initials(p.name)}</div>
      <span class="search-result-name">${esc(p.name)}</span>
    </div>`
  ).join('');
  res.classList.remove('hidden');
  res.querySelectorAll('.search-result-item').forEach(item=>{
    item.addEventListener('click',()=>{
      editPeople.push({id:item.dataset.id,name:item.dataset.name});
      document.getElementById('log-edit-people-search').value='';
      res.classList.add('hidden'); res.innerHTML='';
      renderEditChips();
    });
  });
}

// "Save Changes" button → show confirm modal
function requestSaveEdit() {
  if (!pendingEditId) return;
  document.getElementById('log-save-confirm-modal').classList.remove('hidden');
}

async function confirmSaveEdit() {
  document.getElementById('log-save-confirm-modal').classList.add('hidden');
  if (!pendingEditId) return;

  const btn=document.getElementById('log-edit-save');
  btn.disabled=true; btn.textContent='Saving\u2026';

  const date  = document.getElementById('log-edit-date').value;
  const type  = document.getElementById('log-edit-type').value;
  const notes = document.getElementById('log-edit-notes').value.trim();

  // Update encounter record
  const {error:e1}=await db().from('encounters')
    .update({date,type,description:notes||null}).eq('id',pendingEditId);

  if (e1) { alert('Save failed: '+e1.message); btn.disabled=false; btn.textContent='Save Changes'; return; }

  // Replace participants: delete all then re-insert
  await db().from('encounter_participants').delete().eq('encounterid',pendingEditId);
  if (editPeople.length) {
    const {error:e2}=await db().from('encounter_participants')
      .insert(editPeople.map(p=>({encounterid:pendingEditId,personid:p.id})));
    if (e2) { alert('Encounter saved but people update failed: '+e2.message); }
  }

  btn.disabled=false; btn.textContent='Save Changes';
  closeEditModal();
  await loadLog();
}

function closeEditModal() {
  pendingEditId=null; editPeople=[];
  document.getElementById('log-edit-modal').classList.add('hidden');
  document.getElementById('log-save-confirm-modal').classList.add('hidden');
}

// ── Delete modal ───────────────────────────────────────────────────────────
function openDeleteModal(id) {
  const enc=allEncounters.find(e=>e.id===id);
  if (!enc) return;
  pendingDeleteId=id;
  const typeLabel=TYPE_LABELS[enc.type]||enc.type;
  document.getElementById('log-delete-msg').textContent=
    `Delete the ${typeLabel} on ${formatDate(enc.date)} with ${enc.peopleStr||'\u2014'}?`;
  document.getElementById('log-delete-modal').classList.remove('hidden');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  const btn=document.getElementById('log-delete-confirm');
  btn.disabled=true; btn.textContent='Deleting\u2026';
  await db().from('encounter_participants').delete().eq('encounterid',pendingDeleteId);
  const {error}=await db().from('encounters').delete().eq('id',pendingDeleteId);
  btn.disabled=false; btn.textContent='Delete';
  if (error) { alert('Delete failed: '+error.message); closeDeleteModal(); return; }
  closeDeleteModal();
  await loadLog();
}

function closeDeleteModal() {
  pendingDeleteId=null;
  document.getElementById('log-delete-modal').classList.add('hidden');
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '\u2014';
  const [y,m,d]=iso.split('-');
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function initials(name) {
  return name.split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase();
}

// ── Wire up listeners ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{

  document.getElementById('log-back-btn').addEventListener('click',()=>showScreen('app-screen'));

  document.getElementById('log-search-input').addEventListener('input',e=>{
    searchQuery=e.target.value; applyFilters();
  });
  document.getElementById('log-filter-type').addEventListener('change',e=>{
    filterType=e.target.value; applyFilters();
  });
  document.getElementById('log-sort-col').addEventListener('change',e=>{
    sortCol=e.target.value; applyFilters();
  });
  document.getElementById('log-sort-dir').addEventListener('click',()=>{
    sortAsc=!sortAsc;
    document.getElementById('log-sort-dir').innerHTML=sortAsc?'&#x2191;':'&#x2193;';
    applyFilters();
  });

  // Edit modal
  document.getElementById('log-edit-save').addEventListener('click',requestSaveEdit);
  document.getElementById('log-edit-cancel').addEventListener('click',closeEditModal);
  document.getElementById('log-edit-people-search').addEventListener('input',handleEditPeopleSearch);

  // Save confirm modal
  document.getElementById('log-save-confirm-ok').addEventListener('click',confirmSaveEdit);
  document.getElementById('log-save-confirm-cancel').addEventListener('click',()=>{
    document.getElementById('log-save-confirm-modal').classList.add('hidden');
  });

  // Delete modal
  document.getElementById('log-delete-confirm').addEventListener('click',confirmDelete);
  document.getElementById('log-delete-cancel').addEventListener('click',closeDeleteModal);

  // Backdrop taps close modals
  ['log-edit-modal','log-delete-modal','log-save-confirm-modal'].forEach(id=>{
    document.getElementById(id).addEventListener('click',e=>{
      if (e.target===document.getElementById(id)) {
        if (id==='log-edit-modal') closeEditModal();
        else if (id==='log-delete-modal') closeDeleteModal();
        else document.getElementById(id).classList.add('hidden');
      }
    });
  });
});
