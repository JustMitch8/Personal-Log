// ─────────────────────────────────────────────────────────────────
//  Contact Tracker — App Logic
//  Single-file JS for MVP: auth, data, search, encounter saving.
// ─────────────────────────────────────────────────────────────────

// ── Supabase client (loaded via CDN in a <script> we inject) ─────
let supabase = null;

// ── App state ────────────────────────────────────────────────────
let allPeople       = [];
let selectedPeople  = [];   // array of {id, name}
let searchHighlight = -1;
let currentType     = '1-on-1';

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────
(function boot() {
  // Inject Supabase CDN script, then initialise
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  s.onload = init;
  s.onerror = () => showAuthError('Could not load Supabase library. Check your connection.');
  document.head.appendChild(s);
})();

async function init() {
  // Guard: config must be filled in
  if (!SUPABASE_URL || SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    showAuthError('Open config.js and fill in your Supabase URL and anon key.');
    return;
  }

  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  // Check for existing session
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await enterApp();
  } else {
    showScreen('auth-screen');
  }
}

// ─────────────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────────────
async function handleLogin() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!email || !password) {
    showAuthError('Please enter your email and password.');
    return;
  }

  const btn = document.getElementById('auth-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  hideAuthError();

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    showAuthError(error.message);
    btn.disabled = false;
    btn.textContent = 'Sign In';
    return;
  }

  await enterApp();
}

async function handleSignOut() {
  await supabase.auth.signOut();
  allPeople      = [];
  selectedPeople = [];
  showScreen('auth-screen');
  // Reset auth form
  document.getElementById('auth-email').value    = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-btn').disabled   = false;
  document.getElementById('auth-btn').textContent = 'Sign In';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideAuthError() {
  document.getElementById('auth-error').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────
//  APP ENTRY
// ─────────────────────────────────────────────────────────────────
async function enterApp() {
  showScreen('app-screen');
  setDefaultDate();
  await loadPeople();
}

function setDefaultDate() {
  const d = new Date();
  // Format as YYYY-MM-DD local
  const pad = n => String(n).padStart(2, '0');
  const val = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  document.getElementById('date-input').value = val;
}

// ─────────────────────────────────────────────────────────────────
//  DATA: PEOPLE
// ─────────────────────────────────────────────────────────────────
async function loadPeople() {
  const { data, error } = await supabase
    .from('people')
    .select('id, name')
    .order('name');

  if (error) {
    console.error('Failed to load people:', error.message);
    return;
  }

  allPeople = data || [];
}

// ─────────────────────────────────────────────────────────────────
//  ENCOUNTER TYPE
// ─────────────────────────────────────────────────────────────────
function selectType(btn) {
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentType = btn.dataset.type;
}

// ─────────────────────────────────────────────────────────────────
//  SEARCH
// ─────────────────────────────────────────────────────────────────
function handleSearch(query) {
  searchHighlight = -1;
  const q = query.trim().toLowerCase();
  const resultsEl = document.getElementById('search-results');

  if (!q) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  // Filter + rank
  const selectedIds = new Set(selectedPeople.map(p => p.id));
  const scored = allPeople
    .filter(p => !selectedIds.has(p.id))
    .map(p => ({ person: p, score: scoreMatch(p.name, q) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (scored.length === 0) {
    resultsEl.innerHTML = `<div class="search-no-results">No results for "${query}"</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = scored.map((r, i) =>
    `<div class="search-result-item" data-id="${r.person.id}" data-name="${escapeHtml(r.person.name)}"
          onclick="addPersonById('${r.person.id}', '${escapeHtml(r.person.name)}')">
       <div class="search-result-avatar">${initials(r.person.name)}</div>
       <span class="search-result-name">${escapeHtml(r.person.name)}</span>
     </div>`
  ).join('');

  resultsEl.classList.remove('hidden');
}

function scoreMatch(name, q) {
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/);
  if (words[0].startsWith(q)) return 300;
  if (words.slice(1).some(w => w.startsWith(q))) return 200;
  if (lower.includes(q)) return 100;
  return 0;
}

function handleSearchKey(e) {
  const resultsEl = document.getElementById('search-results');
  const items = resultsEl.querySelectorAll('.search-result-item');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchHighlight = Math.min(searchHighlight + 1, items.length - 1);
    updateHighlight(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchHighlight = Math.max(searchHighlight - 1, 0);
    updateHighlight(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchHighlight >= 0 && items[searchHighlight]) {
      const item = items[searchHighlight];
      addPersonById(item.dataset.id, item.dataset.name);
    } else if (items.length === 1) {
      // Auto-select the only result on Enter
      const item = items[0];
      addPersonById(item.dataset.id, item.dataset.name);
    }
  } else if (e.key === 'Escape') {
    clearSearch();
  }
}

function updateHighlight(items) {
  items.forEach((el, i) => {
    el.classList.toggle('highlighted', i === searchHighlight);
  });
}

// ─────────────────────────────────────────────────────────────────
//  SELECTED PEOPLE (CHIPS)
// ─────────────────────────────────────────────────────────────────
function addPersonById(id, name) {
  // Prevent duplicates
  if (selectedPeople.find(p => p.id === id)) {
    clearSearch();
    return;
  }
  selectedPeople.push({ id, name });
  clearSearch();
  renderChips();
}

function removePerson(id) {
  selectedPeople = selectedPeople.filter(p => p.id !== id);
  renderChips();
}

function renderChips() {
  const wrap    = document.getElementById('chips-wrap');
  const section = document.getElementById('selected-section');

  if (selectedPeople.length === 0) {
    section.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  wrap.innerHTML = selectedPeople.map(p =>
    `<div class="chip">
       ${escapeHtml(p.name)}
       <button class="chip-remove" onclick="removePerson('${p.id}')" aria-label="Remove ${escapeHtml(p.name)}">×</button>
     </div>`
  ).join('');
}

function clearSearch() {
  const input     = document.getElementById('search-input');
  const resultsEl = document.getElementById('search-results');
  input.value     = '';
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
  searchHighlight = -1;
}

// ─────────────────────────────────────────────────────────────────
//  SAVE ENCOUNTER
// ─────────────────────────────────────────────────────────────────
async function saveEncounter() {
  if (selectedPeople.length === 0) {
    showSaveStatus('Add at least one person before saving.', 'error');
    return;
  }

  const notes = document.getElementById('notes-input').value.trim();
  const date  = document.getElementById('date-input').value;

  if (!date) {
    showSaveStatus('Please select a date.', 'error');
    return;
  }

  const btn     = document.getElementById('save-btn');
  const btnText = document.getElementById('save-btn-text');
  btn.disabled   = true;
  btnText.textContent = 'Saving…';

  // 1. Insert encounter
  const { data: encounter, error: encErr } = await supabase
    .from('encounters')
    .insert({ date, type: currentType, description: notes || null })
    .select('id')
    .single();

  if (encErr) {
    showSaveStatus(`Error saving encounter: ${encErr.message}`, 'error');
    btn.disabled  = false;
    btnText.textContent = 'Save Encounter';
    return;
  }

  // 2. Insert participants
  const participants = selectedPeople.map(p => ({
    encounterid: encounter.id,
    personid:    p.id,
  }));

  const { error: partErr } = await supabase
    .from('encounter_participants')
    .insert(participants);

  if (partErr) {
    showSaveStatus(`Encounter saved but participants failed: ${partErr.message}`, 'error');
    btn.disabled  = false;
    btnText.textContent = 'Save Encounter';
    return;
  }

  // ✅ Success — reset form
  showSaveStatus(`✓ Encounter with ${selectedPeople.map(p => p.name).join(', ')} saved.`, 'success');
  selectedPeople = [];
  renderChips();
  document.getElementById('notes-input').value = '';
  setDefaultDate();
  // Reset type to 1-on-1
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-type="1-on-1"]').classList.add('active');
  currentType = '1-on-1';

  btn.disabled  = false;
  btnText.textContent = 'Save Encounter';

  // Hide success message after 4s
  setTimeout(() => {
    document.getElementById('save-status').classList.add('hidden');
  }, 4000);
}

function showSaveStatus(msg, type) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = `save-status ${type}`;
  el.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────
//  SCREEN MANAGEMENT
// ─────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0] || '')
    .join('')
    .toUpperCase();
}
