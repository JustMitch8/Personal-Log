// -----------------------------------------------------------------
//  Contact Tracker -- App Logic
// -----------------------------------------------------------------

let supabase       = null;
let allPeople      = [];
let selectedPeople = [];
let searchHighlight = -1;
let currentType    = 'call';

// -----------------------------------------------------------------
//  DEBUG PANEL (visible on-screen, no dev tools needed)
// -----------------------------------------------------------------
function dbg(msg) {
  const el = document.getElementById('debug-log');
  if (!el) return;
  el.style.display = 'block';
  el.textContent += '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n';
}

// -----------------------------------------------------------------
//  BOOT
// -----------------------------------------------------------------
(function boot() {
  dbg('Boot started');
  dbg('SUPABASE_URL = ' + (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : 'UNDEFINED'));

  if (typeof SUPABASE_URL === 'undefined' || SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    showAuthError('Open config.js and fill in your Supabase URL and anon key.');
    dbg('ERROR: config.js not filled in');
    return;
  }

  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  s.onload = function() { dbg('Supabase library loaded'); init(); };
  s.onerror = function() {
    dbg('ERROR: Failed to load Supabase library');
    showAuthError('Could not load Supabase library. Check your connection.');
  };
  document.head.appendChild(s);
  dbg('Supabase library request sent');
})();

async function init() {
  dbg('init() called');
  try {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    dbg('Supabase client created');
  } catch(e) {
    dbg('ERROR creating client: ' + e.message);
    showAuthError('Failed to connect to Supabase: ' + e.message);
    return;
  }

  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) { dbg('getSession error: ' + error.message); }
    dbg('Session check done. Has session: ' + !!session);
    if (session) {
      await enterApp();
    } else {
      showScreen('auth-screen');
      dbg('Ready to sign in');
    }
  } catch(e) {
    dbg('ERROR in getSession: ' + e.message);
  }
}

// -----------------------------------------------------------------
//  AUTH
// -----------------------------------------------------------------
async function handleLogin() {
  dbg('handleLogin() called');

  if (!supabase) {
    showAuthError('Still connecting - please wait a moment and try again.');
    dbg('ERROR: supabase not ready yet');
    return;
  }

  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!email || !password) {
    showAuthError('Please enter your email and password.');
    return;
  }

  dbg('Attempting sign in for: ' + email);

  const btn = document.getElementById('auth-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  hideAuthError();

  let result;
  try {
    result = await supabase.auth.signInWithPassword({ email, password });
  } catch(e) {
    dbg('EXCEPTION during signIn: ' + e.message);
    showAuthError('Network error - check your connection and try again.');
    btn.disabled = false;
    btn.textContent = 'Sign In';
    return;
  }

  const { error } = result;
  if (error) {
    dbg('Sign in error: ' + error.message);
    showAuthError(error.message);
    btn.disabled = false;
    btn.textContent = 'Sign In';
    return;
  }

  dbg('Sign in successful');
  await enterApp();
}

async function handleSignOut() {
  await supabase.auth.signOut();
  allPeople      = [];
  selectedPeople = [];
  showScreen('auth-screen');
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

// -----------------------------------------------------------------
//  APP ENTRY
// -----------------------------------------------------------------
async function enterApp() {
  dbg('Entering app');
  showScreen('app-screen');
  setDefaultDate();
  await loadPeople();
}

function setDefaultDate() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  const val = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
  document.getElementById('date-input').value = val;
}

// -----------------------------------------------------------------
//  DATA
// -----------------------------------------------------------------
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

// -----------------------------------------------------------------
//  ENCOUNTER TYPE
// -----------------------------------------------------------------
function selectType(btn) {
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentType = btn.dataset.type;
}

// -----------------------------------------------------------------
//  SEARCH
// -----------------------------------------------------------------
function handleSearch(query) {
  searchHighlight = -1;
  const q = query.trim().toLowerCase();
  const resultsEl = document.getElementById('search-results');

  if (!q) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  const selectedIds = new Set(selectedPeople.map(p => p.id));
  const scored = allPeople
    .filter(p => !selectedIds.has(p.id))
    .map(p => ({ person: p, score: scoreMatch(p.name, q) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (scored.length === 0) {
    resultsEl.innerHTML = '<div class="search-no-results">No results for "' + escapeHtml(query) + '"</div>';
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = scored.map(function(r) {
    return '<div class="search-result-item" data-id="' + r.person.id + '" data-name="' + escapeHtml(r.person.name) + '" onclick="addPersonById(\'' + r.person.id + '\', \'' + escapeHtml(r.person.name).replace(/'/g, "&#39;") + '\')">' +
      '<div class="search-result-avatar">' + initials(r.person.name) + '</div>' +
      '<span class="search-result-name">' + escapeHtml(r.person.name) + '</span>' +
      '</div>';
  }).join('');

  resultsEl.classList.remove('hidden');
}

function scoreMatch(name, q) {
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/);
  if (words[0].startsWith(q)) return 300;
  if (words.slice(1).some(function(w) { return w.startsWith(q); })) return 200;
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
      var item = items[searchHighlight];
      addPersonById(item.dataset.id, item.dataset.name);
    } else if (items.length === 1) {
      addPersonById(items[0].dataset.id, items[0].dataset.name);
    }
  } else if (e.key === 'Escape') {
    clearSearch();
  }
}

function updateHighlight(items) {
  items.forEach(function(el, i) {
    el.classList.toggle('highlighted', i === searchHighlight);
  });
}

// -----------------------------------------------------------------
//  SELECTED PEOPLE (CHIPS)
// -----------------------------------------------------------------
function addPersonById(id, name) {
  if (selectedPeople.find(function(p) { return p.id === id; })) {
    clearSearch();
    return;
  }
  selectedPeople.push({ id: id, name: name });
  clearSearch();
  renderChips();
}

function removePerson(id) {
  selectedPeople = selectedPeople.filter(function(p) { return p.id !== id; });
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
  wrap.innerHTML = selectedPeople.map(function(p) {
    return '<div class="chip">' +
      escapeHtml(p.name) +
      '<button class="chip-remove" onclick="removePerson(\'' + p.id + '\')" aria-label="Remove ' + escapeHtml(p.name) + '">&times;</button>' +
      '</div>';
  }).join('');
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  const resultsEl = document.getElementById('search-results');
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
  searchHighlight = -1;
}

// -----------------------------------------------------------------
//  SAVE ENCOUNTER
// -----------------------------------------------------------------
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
  btn.disabled        = true;
  btnText.textContent = 'Saving...';

  const { data: encounter, error: encErr } = await supabase
    .from('encounters')
    .insert({ date: date, type: currentType, description: notes || null })
    .select('id')
    .single();

  if (encErr) {
    showSaveStatus('Error saving encounter: ' + encErr.message, 'error');
    btn.disabled        = false;
    btnText.textContent = 'Save Encounter';
    return;
  }

  const participants = selectedPeople.map(function(p) {
    return { encounterid: encounter.id, personid: p.id };
  });

  const { error: partErr } = await supabase
    .from('encounter_participants')
    .insert(participants);

  if (partErr) {
    showSaveStatus('Encounter saved but participants failed: ' + partErr.message, 'error');
    btn.disabled        = false;
    btnText.textContent = 'Save Encounter';
    return;
  }

  var names = selectedPeople.map(function(p) { return p.name; }).join(', ');
  showSaveStatus('Saved encounter with ' + names + '.', 'success');

  selectedPeople = [];
  renderChips();
  document.getElementById('notes-input').value = '';
  setDefaultDate();
  document.querySelectorAll('.type-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelector('[data-type="call"]').classList.add('active');
  currentType = 'call';

  btn.disabled        = false;
  btnText.textContent = 'Save Encounter';

  setTimeout(function() {
    document.getElementById('save-status').classList.add('hidden');
  }, 4000);
}

function showSaveStatus(msg, type) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = 'save-status ' + type;
  el.classList.remove('hidden');
}

// -----------------------------------------------------------------
//  SCREEN MANAGEMENT
// -----------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

// -----------------------------------------------------------------
//  HELPERS
// -----------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map(function(w) { return w[0] || ''; }).join('').toUpperCase();
}
