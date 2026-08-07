// Contact Tracker - App Logic

let supabase       = null;
let allPeople      = [];
let selectedPeople = [];
let searchHighlight = -1;
let currentType    = 'call';

// Status helper - writes to button AND error div so something MUST be visible
function setStatus(msg, isError) {
  var btn = document.getElementById('auth-btn');
  var err = document.getElementById('auth-error');
  if (btn) btn.textContent = msg;
  if (err) {
    err.textContent = msg;
    err.classList.remove('hidden');
    if (isError) {
      err.style.background = 'rgba(192,57,43,0.3)';
      err.style.color = '#ffaaaa';
    } else {
      err.style.background = 'rgba(212,168,85,0.2)';
      err.style.color = '#ffe0a0';
    }
  }
}

// Boot - load Supabase library
setStatus('Loading...');

if (typeof SUPABASE_URL === 'undefined' || SUPABASE_URL === 'YOUR_SUPABASE_URL') {
  setStatus('ERROR: config.js not configured. Fill in SUPABASE_URL and SUPABASE_ANON.', true);
} else {
  setStatus('Connecting...');
  var script = document.createElement('script');
  script.src = 'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js';
  script.onload = function() { setStatus('Initialising...'); init(); };
  script.onerror = function() { setStatus('ERROR: Could not load Supabase library. Check internet connection.', true); };
  document.head.appendChild(script);
}

async function init() {
  try {
    var sb = window.supabase || window.Supabase || window.supabaseJs;
    if (!sb || !sb.createClient) throw new Error('Supabase library did not expose createClient');
    supabase = sb.createClient(SUPABASE_URL, SUPABASE_ANON);
  } catch(e) {
    setStatus('ERROR creating client: ' + e.message, true);
    return;
  }

  try {
    var result = await supabase.auth.getSession();
    if (result.error) {
      setStatus('Session error: ' + result.error.message, true);
      return;
    }
    if (result.data && result.data.session) {
      await enterApp();
    } else {
      // Ready - restore button to normal
      var btn = document.getElementById('auth-btn');
      if (btn) btn.textContent = 'Sign In';
      var err = document.getElementById('auth-error');
      if (err) err.classList.add('hidden');
      showScreen('auth-screen');
    }
  } catch(e) {
    setStatus('ERROR: ' + e.message, true);
  }
}

async function handleLogin() {
  if (!supabase) {
    setStatus('Not ready yet - please wait a moment', true);
    return;
  }

  var email    = document.getElementById('auth-email').value.trim();
  var password = document.getElementById('auth-password').value;

  if (!email || !password) {
    setStatus('Enter your email and password', true);
    return;
  }

  setStatus('Signing in...');

  var result;
  try {
    result = await supabase.auth.signInWithPassword({ email: email, password: password });
  } catch(e) {
    setStatus('Network error: ' + e.message, true);
    return;
  }

  if (result.error) {
    setStatus('Login failed: ' + result.error.message, true);
    var btn = document.getElementById('auth-btn');
    if (btn) {
      btn.textContent = 'Sign In';
      btn.disabled = false;
    }
    return;
  }

  setStatus('Signed in! Loading...');
  await enterApp();
}

async function handleSignOut() {
  if (supabase) await supabase.auth.signOut();
  allPeople      = [];
  selectedPeople = [];
  document.getElementById('auth-email').value    = '';
  document.getElementById('auth-password').value = '';
  var btn = document.getElementById('auth-btn');
  if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
  var err = document.getElementById('auth-error');
  if (err) err.classList.add('hidden');
  showScreen('auth-screen');
}

async function enterApp() {
  showScreen('app-screen');
  setDefaultDate();
  await loadPeople();
}

function setDefaultDate() {
  var d   = new Date();
  var pad = function(n) { return String(n).padStart(2, '0'); };
  var val = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
  var el  = document.getElementById('date-input');
  if (el) el.value = val;
}

async function loadPeople() {
  var result = await supabase.from('people').select('id, name').order('name');
  if (result.error) { console.error('loadPeople:', result.error.message); return; }
  allPeople = result.data || [];
}

function selectType(btn) {
  document.querySelectorAll('.type-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  currentType = btn.dataset.type;
}

function handleSearch(query) {
  searchHighlight = -1;
  var q = query.trim().toLowerCase();
  var resultsEl = document.getElementById('search-results');
  if (!q) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; return; }

  var selectedIds = new Set(selectedPeople.map(function(p) { return p.id; }));
  var scored = allPeople
    .filter(function(p) { return !selectedIds.has(p.id); })
    .map(function(p) { return { person: p, score: scoreMatch(p.name, q) }; })
    .filter(function(r) { return r.score > 0; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, 8);

  if (scored.length === 0) {
    resultsEl.innerHTML = '<div class="search-no-results">No results for "' + escapeHtml(query) + '"</div>';
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = scored.map(function(r) {
    var id   = r.person.id;
    var name = r.person.name;
    return '<div class="search-result-item" onclick="addPersonById(\'' + id + '\', \'' + escapeHtml(name).replace(/'/g,'&#39;') + '\')">' +
      '<div class="search-result-avatar">' + initials(name) + '</div>' +
      '<span class="search-result-name">' + escapeHtml(name) + '</span></div>';
  }).join('');
  resultsEl.classList.remove('hidden');
}

function scoreMatch(name, q) {
  var lower = name.toLowerCase();
  var words = lower.split(/\s+/);
  if (words[0].startsWith(q)) return 300;
  if (words.slice(1).some(function(w) { return w.startsWith(q); })) return 200;
  if (lower.includes(q)) return 100;
  return 0;
}

function handleSearchKey(e) {
  var resultsEl = document.getElementById('search-results');
  var items = resultsEl.querySelectorAll('.search-result-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchHighlight = Math.min(searchHighlight + 1, items.length - 1);
    items.forEach(function(el, i) { el.classList.toggle('highlighted', i === searchHighlight); });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchHighlight = Math.max(searchHighlight - 1, 0);
    items.forEach(function(el, i) { el.classList.toggle('highlighted', i === searchHighlight); });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    var target = searchHighlight >= 0 ? items[searchHighlight] : (items.length === 1 ? items[0] : null);
    if (target) { var onclick = target.getAttribute('onclick'); if (onclick) eval(onclick); }
  } else if (e.key === 'Escape') {
    clearSearch();
  }
}

function addPersonById(id, name) {
  if (selectedPeople.find(function(p) { return p.id === id; })) { clearSearch(); return; }
  selectedPeople.push({ id: id, name: name });
  clearSearch();
  renderChips();
}

function removePerson(id) {
  selectedPeople = selectedPeople.filter(function(p) { return p.id !== id; });
  renderChips();
}

function renderChips() {
  var wrap    = document.getElementById('chips-wrap');
  var section = document.getElementById('selected-section');
  if (selectedPeople.length === 0) {
    section.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  section.style.display = 'block';
  wrap.innerHTML = selectedPeople.map(function(p) {
    return '<div class="chip">' + escapeHtml(p.name) +
      '<button class="chip-remove" onclick="removePerson(\'' + p.id + '\')">&times;</button></div>';
  }).join('');
}

function clearSearch() {
  var input = document.getElementById('search-input');
  var resultsEl = document.getElementById('search-results');
  if (input) input.value = '';
  if (resultsEl) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; }
  searchHighlight = -1;
}

async function saveEncounter() {
  if (selectedPeople.length === 0) { showSaveStatus('Add at least one person first.', 'error'); return; }
  var notes = document.getElementById('notes-input').value.trim();
  var date  = document.getElementById('date-input').value;
  if (!date) { showSaveStatus('Please select a date.', 'error'); return; }

  var btn     = document.getElementById('save-btn');
  var btnText = document.getElementById('save-btn-text');
  btn.disabled = true;
  btnText.textContent = 'Saving...';

  var encResult = await supabase
    .from('encounters')
    .insert({ date: date, type: currentType, description: notes || null })
    .select('id')
    .single();

  if (encResult.error) {
    showSaveStatus('Error: ' + encResult.error.message, 'error');
    btn.disabled = false; btnText.textContent = 'Save Encounter';
    return;
  }

  var participants = selectedPeople.map(function(p) {
    return { encounterid: encResult.data.id, personid: p.id };
  });

  var partResult = await supabase.from('encounter_participants').insert(participants);
  if (partResult.error) {
    showSaveStatus('Participants error: ' + partResult.error.message, 'error');
    btn.disabled = false; btnText.textContent = 'Save Encounter';
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
  btn.disabled = false; btnText.textContent = 'Save Encounter';
  setTimeout(function() { document.getElementById('save-status').classList.add('hidden'); }, 4000);
}

function showSaveStatus(msg, type) {
  var el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = 'save-status ' + type;
  el.classList.remove('hidden');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  var el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function initials(name) {
  return name.split(/\s+/).slice(0,2).map(function(w){ return w[0]||''; }).join('').toUpperCase();
}

// Attach login button listener on DOM ready
document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('auth-btn');
  if (btn) {
    btn.addEventListener('click', handleLogin);
    btn.addEventListener('touchend', function(e) { e.preventDefault(); handleLogin(); });
  }
});
