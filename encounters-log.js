// encounters-log.js
// Self-contained module for the Encounter Log screen.
// Communicates with app.js only via window.openLogScreen (called by app.js nav button)
// and reads window._plSupabase set by app.js on boot.

// ── State ──────────────────────────────────────────────────────────────────
let allEncounters  = [];  // raw from DB, enriched with participant names
let filtered       = [];  // current view after search/filter/sort
let sortCol        = 'date';
let sortAsc        = false; // newest first by default
let filterType     = '';
let searchQuery    = '';
let pendingEditId  = null;
let pendingDeleteId= null;

const TYPE_LABELS = {
  'call':'Call','1-on-1':'1-on-1','small-group':'Small group',
  'large-group':'Large group','message':'Message','birthday-acknowledgment':'Birthday'
};

// ── Supabase access (set by app.js after boot) ─────────────────────────────
function db() { return window._plSupabase; }

// ── Entry point exposed to app.js ─────────────────────────────────────────
window.openLogScreen = async function() {
  showScreen('log-screen');
  await loadLog();
};

// ── Screen helper (mirrors app.js showScreen) ──────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Load all encounters with participant names ──────────────────────────────
async function loadLog() {
  setLogLoading(true);

  // Fetch encounters
  const {data:encs, error:e1} = await db()
    .from('encounters')
    .select('id,date,type,description')
    .order('date', {ascending:false});

  if (e1||!encs) { setLogLoading(false,'Failed to load encounters.'); return; }

  // Fetch all participants + people names in parallel
  const {data:parts} = await db()
    .from('encounter_participants')
    .select('encounterid,personid');

  const {data:people} = await db()
    .from('people').select('id,name');

  const personMap = Object.fromEntries((people||[]).map(p=>[p.id,p.name]));

  // Group participants by encounter
  const partMap = {};
  (parts||[]).forEach(({encounterid,personid})=>{
    if (!partMap[encounterid]) partMap[encounterid]=[];
    partMap[encounterid].push(personMap[personid]||'Unknown');
  });

  // Enrich
  allEncounters = encs.map(e=>({
    ...e,
    people: (partMap[e.id]||[]).sort(),
    peopleStr: (partMap[e.id]||[]).sort().join(', '),
  }));

  applyFilters();
  setLogLoading(false);
}

function setLogLoading(loading, msg) {
  const list = document.getElementById('log-list');
  if (loading) { list.innerHTML='<div class="log-loading">Loading...</div>'; return; }
  if (msg)     { list.innerHTML=`<div class="log-loading log-error">${msg}</div>`; }
}

// ── Filter + sort + render ──────────────────────────────────────────────────
function applyFilters() {
  const q = searchQuery.toLowerCase().trim();

  filtered = allEncounters.filter(e=>{
    if (filterType && e.type !== filterType) return false;
    if (!q) return true;
    // Fuzzy: check date, type label, people names, notes
    return (
      e.date.includes(q) ||
      (TYPE_LABELS[e.type]||e.type).toLowerCase().includes(q) ||
      e.peopleStr.toLowerCase().includes(q) ||
      (e.description||'').toLowerCase().includes(q)
    );
  });

  filtered.sort((a,b)=>{
    let va, vb;
    if (sortCol==='date')   { va=a.date; vb=b.date; }
    else if (sortCol==='type')   { va=TYPE_LABELS[a.type]||a.type; vb=TYPE_LABELS[b.type]||b.type; }
    else if (sortCol==='people') { va=a.peopleStr; vb=b.peopleStr; }
    if (va<vb) return sortAsc?-1:1;
    if (va>vb) return sortAsc?1:-1;
    return 0;
  });

  renderLog();
}

function renderLog() {
  const list = document.getElementById('log-list');

  if (!filtered.length) {
    list.innerHTML='<div class="log-loading">No encounters found.</div>';
    return;
  }

  list.innerHTML = filtered.map(e=>{
    const dateStr = formatDate(e.date);
    const typeLabel = TYPE_LABELS[e.type]||e.type;
    const notes = e.description ? `<div class="log-notes">${esc(e.description)}</div>` : '';
    return `
    <div class="log-card" data-id="${e.id}">
      <div class="log-card-top">
        <div class="log-card-left">
          <div class="log-date">${dateStr}</div>
          <div class="log-type-badge log-type-${e.type.replace(/[^a-z]/g,'-')}">${typeLabel}</div>
        </div>
        <div class="log-card-actions">
          <button class="log-action-btn log-edit-btn" data-id="${e.id}" title="Edit">&#x270E;</button>
          <button class="log-action-btn log-delete-btn" data-id="${e.id}" title="Delete">&#x1F5D1;</button>
        </div>
      </div>
      <div class="log-people">${esc(e.peopleStr||'—')}</div>
      ${notes}
    </div>`;
  }).join('');

  // Bind action buttons
  list.querySelectorAll('.log-edit-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{ e.stopPropagation(); openEditModal(btn.dataset.id); });
  });
  list.querySelectorAll('.log-delete-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{ e.stopPropagation(); openDeleteModal(btn.dataset.id); });
  });
}

// ── Edit modal ─────────────────────────────────────────────────────────────
function openEditModal(id) {
  const enc = allEncounters.find(e=>e.id===id);
  if (!enc) return;
  pendingEditId = id;
  document.getElementById('log-edit-date').value  = enc.date;
  document.getElementById('log-edit-type').value  = enc.type;
  document.getElementById('log-edit-notes').value = enc.description||'';
  document.getElementById('log-edit-modal').classList.remove('hidden');
}

async function saveEdit() {
  if (!pendingEditId) return;
  const btn = document.getElementById('log-edit-save');
  btn.disabled=true; btn.textContent='Saving...';

  const date  = document.getElementById('log-edit-date').value;
  const type  = document.getElementById('log-edit-type').value;
  const notes = document.getElementById('log-edit-notes').value.trim();

  const {error} = await db()
    .from('encounters')
    .update({date, type, description:notes||null})
    .eq('id', pendingEditId);

  btn.disabled=false; btn.textContent='Save Changes';

  if (error) { alert('Save failed: '+error.message); return; }

  closeEditModal();
  await loadLog();
}

function closeEditModal() {
  pendingEditId=null;
  document.getElementById('log-edit-modal').classList.add('hidden');
}

// ── Delete modal ────────────────────────────────────────────────────────────
function openDeleteModal(id) {
  const enc = allEncounters.find(e=>e.id===id);
  if (!enc) return;
  pendingDeleteId = id;
  const dateStr = formatDate(enc.date);
  const typeLabel = TYPE_LABELS[enc.type]||enc.type;
  document.getElementById('log-delete-msg').textContent =
    `Delete the ${typeLabel} on ${dateStr} with ${enc.peopleStr||'—'}?`;
  document.getElementById('log-delete-modal').classList.remove('hidden');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  const btn = document.getElementById('log-delete-confirm');
  btn.disabled=true; btn.textContent='Deleting...';

  // Delete participants first (FK constraint)
  await db().from('encounter_participants').delete().eq('encounterid', pendingDeleteId);
  const {error} = await db().from('encounters').delete().eq('id', pendingDeleteId);

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
  if (!iso) return '—';
  const [y,m,d] = iso.split('-');
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Wire up listeners once DOM ready ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', ()=>{

  // Back button
  document.getElementById('log-back-btn').addEventListener('click', ()=>{
    showScreen('app-screen');
  });

  // Search
  document.getElementById('log-search-input').addEventListener('input', e=>{
    searchQuery = e.target.value;
    applyFilters();
  });

  // Type filter
  document.getElementById('log-filter-type').addEventListener('change', e=>{
    filterType = e.target.value;
    applyFilters();
  });

  // Sort column
  document.getElementById('log-sort-col').addEventListener('change', e=>{
    sortCol = e.target.value;
    applyFilters();
  });

  // Sort direction toggle
  document.getElementById('log-sort-dir').addEventListener('click', ()=>{
    sortAsc = !sortAsc;
    document.getElementById('log-sort-dir').innerHTML = sortAsc ? '&#x2191;' : '&#x2193;';
    applyFilters();
  });

  // Edit modal actions
  document.getElementById('log-edit-save').addEventListener('click', saveEdit);
  document.getElementById('log-edit-cancel').addEventListener('click', closeEditModal);

  // Delete modal actions
  document.getElementById('log-delete-confirm').addEventListener('click', confirmDelete);
  document.getElementById('log-delete-cancel').addEventListener('click', closeDeleteModal);

  // Close modals on backdrop tap
  document.getElementById('log-edit-modal').addEventListener('click', e=>{
    if (e.target===document.getElementById('log-edit-modal')) closeEditModal();
  });
  document.getElementById('log-delete-modal').addEventListener('click', e=>{
    if (e.target===document.getElementById('log-delete-modal')) closeDeleteModal();
  });
});
