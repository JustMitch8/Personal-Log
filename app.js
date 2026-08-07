import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── State ─────────────────────────────────────────────────────────
let supabase        = null;
let allPeople       = [];
let selectedPeople  = [];
let searchHighlight = -1;
let currentType     = 'call';

// ── UI helpers ────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError() {
  document.getElementById('auth-error').classList.add('hidden');
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function showSaveStatus(msg, type) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = 'save-status ' + type;
}

// ── Boot ──────────────────────────────────────────────────────────
async function boot() {
  if (typeof SUPABASE_URL === 'undefined' || SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    showError('Fill in SUPABASE_URL and SUPABASE_ANON in config.js');
    return;
  }

  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
  } catch (e) {
    showError('Failed to connect: ' + e.message);
    return;
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) { showError('Session error: ' + error.message); return; }

  if (session) {
    await enterApp();
  } else {
    showScreen('auth-screen');
  }
}

// ── Auth ──────────────────────────────────────────────────────────
async function handleLogin() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!email || !password) { showError('Enter your email and password.'); return; }

  hideError();
  const btn = document.getElementById('auth-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    showError('Login failed: ' + error.message);
    btn.disabled = false;
    btn.textContent = 'Sign In';
    return;
  }

  btn.textContent = 'Sign In';
  btn.disabled = false;
  await enterApp();
}

async function handleSignOut() {
  await supabase.auth.signOut();
  allPeople = []; selectedPeople = [];
  document.getElementById('auth-email').value    = '';
  document.getElementById('auth-password').value = '';
  hideError();
  showScreen('auth-screen');
}

// ── App entry ─────────────────────────────────────────────────────
async function enterApp() {
  showScreen('app-screen');
  // Set today's date
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('date-input').value =
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  // Load contacts
  const { data, error } = await supabase.from('people').select('id, name').order('name');
  if (!error) allPeople = data || [];
}

// ── Encounter type ────────────────────────────────────────────────
function handleTypeClick(e) {
  const btn = e.currentTarget;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentType = btn.dataset.type;
}

// ── Search ────────────────────────────────────────────────────────
function handleSearchInput(e) {
  searchHighlight = -1;
  const q = e.target.value.trim().toLowerCase();
  const resultsEl = document.getElementById('search-results');

  if (!q) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; return; }

  const selectedIds = new Set(selectedPeople.map(p => p.id));
  const scored = allPeople
    .filter(p => !selectedIds.has(p.id))
    .map(p => ({ p, score: scoreMatch(p.name, q) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (!scored.length) {
    resultsEl.innerHTML = `<div class="search-no-results">No results</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = scored.map(({ p }) =>
    `<div class="search-result-item" data-id="${p.id}" data-name="${esc(p.name)}">
       <div class="search-result-avatar">${initials(p.name)}</div>
       <span class="search-result-name">${esc(p.name)}</span>
     </div>`
  ).join('');
  resultsEl.classList.remove('hidden');

  // Attach tap listeners to each result
  resultsEl.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click',     () => addPerson(item.dataset.id, item.dataset.name));
    item.addEventListener('touchend',  (e) => { e.preventDefault(); addPerson(item.dataset.id, item.dataset.name); });
  });
}

function handleSearchKey(e) {
  const resultsEl = document.getElementById('search-results');
  const items = [...resultsEl.querySelectorAll('.search-result-item')];
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchHighlight = Math.min(searchHighlight + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchHighlight = Math.max(searchHighlight - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = searchHighlight >= 0 ? items[searchHighlight] : items[0];
    if (target) addPerson(target.dataset.id, target.dataset.name);
    return;
  } else if (e.key === 'Escape') {
    clearSearch(); return;
  }
  items.forEach((el, i) => el.classList.toggle('highlighted', i === searchHighlight));
}

function scoreMatch(name, q) {
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/);
  if (words[0].startsWith(q)) return 300;
  if (words.slice(1).some(w => w.startsWith(q))) return 200;
  if (lower.includes(q)) return 100;
  return 0;
}

// ── Selected people ───────────────────────────────────────────────
function addPerson(id, name) {
  if (selectedPeople.find(p => p.id === id)) { clearSearch(); return; }
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
  if (!selectedPeople.length) { section.style.display = 'none'; wrap.innerHTML = ''; return; }
  section.style.display = 'block';
  wrap.innerHTML = selectedPeople.map(p =>
    `<div class="chip">${esc(p.name)}<button class="chip-remove" data-id="${p.id}">&times;</button></div>`
  ).join('');
  wrap.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => removePerson(btn.dataset.id));
  });
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  const r = document.getElementById('search-results');
  r.classList.add('hidden'); r.innerHTML = '';
  searchHighlight = -1;
}

// ── Save encounter ────────────────────────────────────────────────
async function handleSave() {
  if (!selectedPeople.length) { showSaveStatus('Add at least one person first.', 'error'); return; }
  const date  = document.getElementById('date-input').value;
  const notes = document.getElementById('notes-input').value.trim();
  if (!date)  { showSaveStatus('Please select a date.', 'error'); return; }

  const btn = document.getElementById('save-btn');
  const txt = document.getElementById('save-btn-text');
  btn.disabled = true; txt.textContent = 'Saving...';

  const { data: enc, error: e1 } = await supabase
    .from('encounters')
    .insert({ date, type: currentType, description: notes || null })
    .select('id').single();

  if (e1) { showSaveStatus('Error: ' + e1.message, 'error'); btn.disabled = false; txt.textContent = 'Save Encounter'; return; }

  const { error: e2 } = await supabase.from('encounter_participants')
    .insert(selectedPeople.map(p => ({ encounterid: enc.id, personid: p.id })));

  if (e2) { showSaveStatus('Saved but participants failed: ' + e2.message, 'error'); btn.disabled = false; txt.textContent = 'Save Encounter'; return; }

  showSaveStatus('Saved with ' + selectedPeople.map(p => p.name).join(', ') + '.', 'success');
  selectedPeople = []; renderChips();
  document.getElementById('notes-input').value = '';
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-type="call"]').classList.add('active');
  currentType = 'call';
  btn.disabled = false; txt.textContent = 'Save Encounter';
  setTimeout(() => document.getElementById('save-status').classList.add('hidden'), 4000);
}

// ── Helpers ───────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function initials(name) {
  return name.split(/\s+/).slice(0,2).map(w => w[0]||'').join('').toUpperCase();
}

// ── Wire up all listeners once DOM is ready ───────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('auth-btn')
    .addEventListener('click', handleLogin);

  document.getElementById('sign-out-btn')
    .addEventListener('click', handleSignOut);

  document.getElementById('save-btn')
    .addEventListener('click', handleSave);

  document.getElementById('search-input')
    .addEventListener('input', handleSearchInput);

  document.getElementById('search-input')
    .addEventListener('keydown', handleSearchKey);

  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', handleTypeClick);
  });

  boot();
});
