import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── State ─────────────────────────────────────────────────────────
let supabase        = null;
let allPeople       = [];
let frequentFriends = [];   // [{id, name, daysSince, interval}]
let selectedPeople  = [];
let searchHighlight = -1;
let currentType     = 'call';

const SECTION_TITLES = [
  'Frequent Friends',
  'Prevalent Pals',
  'Common Companions',
  'Back-to-Back Buddies',
];

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
  if (session) { await enterApp(); } else { showScreen('auth-screen'); }
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
    btn.disabled = false; btn.textContent = 'Sign In';
    return;
  }
  btn.disabled = false; btn.textContent = 'Sign In';
  await enterApp();
}

async function handleSignOut() {
  await supabase.auth.signOut();
  allPeople = []; selectedPeople = []; frequentFriends = [];
  document.getElementById('auth-email').value    = '';
  document.getElementById('auth-password').value = '';
  hideError();
  showScreen('auth-screen');
}

// ── App entry ─────────────────────────────────────────────────────
async function enterApp() {
  showScreen('app-screen');
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('date-input').value =
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  await loadData();
}

// ── Data loading ──────────────────────────────────────────────────
async function loadData() {
  // Load people (with contact interval)
  const { data: people, error: pe } = await supabase
    .from('people')
    .select('id, name, contactintervaldays')
    .order('name');
  if (!pe) allPeople = people || [];

  // Load encounters + participants from last 3 months
  // Exclude messages and birthday acknowledgments
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoff = threeMonthsAgo.toISOString().split('T')[0];

  const { data: encounters, error: ee } = await supabase
    .from('encounters')
    .select('id, date, type')
    .gte('date', cutoff)
    .not('type', 'in', '("message","birthday-acknowledgment")');

  if (ee || !encounters || !encounters.length) {
    renderFrequentFriends();
    return;
  }

  const encounterIds = encounters.map(e => e.id);

  const { data: participants, error: pae } = await supabase
    .from('encounter_participants')
    .select('encounterid, personid')
    .in('encounterid', encounterIds);

  if (pae || !participants) { renderFrequentFriends(); return; }

  // Build a map: personId -> {count, lastDate}
  const encounterDateMap = Object.fromEntries(encounters.map(e => [e.id, e.date]));
  const personStats = {};

  participants.forEach(({ encounterid, personid }) => {
    const date = encounterDateMap[encounterid];
    if (!personStats[personid]) personStats[personid] = { count: 0, lastDate: null };
    personStats[personid].count++;
    if (!personStats[personid].lastDate || date > personStats[personid].lastDate) {
      personStats[personid].lastDate = date;
    }
  });

  // Sort by count desc, take top 8
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const top8 = Object.entries(personStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([personid, stats]) => {
      const person = allPeople.find(p => p.id === personid);
      if (!person) return null;
      const last = new Date(stats.lastDate);
      last.setHours(0, 0, 0, 0);
      const daysSince = Math.round((today - last) / 86400000);
      return {
        id:       person.id,
        name:     person.name,
        daysSince,
        interval: person.contactintervaldays || null,
        count:    stats.count,
      };
    })
    .filter(Boolean);

  frequentFriends = top8;
  renderFrequentFriends();
}

// ── Frequent Friends ──────────────────────────────────────────────
function renderFrequentFriends() {
  const section = document.getElementById('frequent-section');
  const grid    = document.getElementById('frequent-grid');
  const title   = document.getElementById('frequent-title');

  if (!frequentFriends.length) {
    section.style.display = 'none';
    return;
  }

  // Random title
  title.textContent = SECTION_TITLES[Math.floor(Math.random() * SECTION_TITLES.length)];
  section.style.display = 'block';

  grid.innerHTML = frequentFriends.map(f => {
    const alreadySelected = selectedPeople.find(p => p.id === f.id);
    const { color, label } = daysBadge(f.daysSince, f.interval);
    return `
      <button class="ff-card${alreadySelected ? ' ff-selected' : ''}"
              data-id="${f.id}" data-name="${esc(f.name)}">
        <div class="ff-avatar">${initials(f.name)}</div>
        <div class="ff-name">${esc(f.name)}</div>
        <div class="ff-badge" style="background:${color}">${label}</div>
      </button>`;
  }).join('');

  grid.querySelectorAll('.ff-card').forEach(card => {
    card.addEventListener('click', () => {
      const { id, name } = card.dataset;
      if (selectedPeople.find(p => p.id === id)) {
        removePerson(id);
      } else {
        addPerson(id, name);
      }
      // Re-render to update selected state
      renderFrequentFriends();
    });
  });
}

// Returns {color, label} for the days-since badge
function daysBadge(days, interval) {
  const label = days === 0 ? 'today' : days === 1 ? '1d' : `${days}d`;

  // If no interval set, use a simple neutral grey-to-amber scale capped at 90 days
  if (!interval) {
    const t = Math.min(days / 90, 1);
    const color = lerpColor('#2D6A4F', '#8B5E3C', t);
    return { color, label };
  }

  // 0 → green, interval → orange, 2×interval → red, beyond → darker red
  if (days <= 0) return { color: '#2D6A4F', label };

  if (days <= interval) {
    // green → orange
    const t = days / interval;
    return { color: lerpColor('#2D9E5F', '#E07B2A', t), label };
  }

  if (days <= interval * 2) {
    // orange → red
    const t = (days - interval) / interval;
    return { color: lerpColor('#E07B2A', '#C0392B', t), label };
  }

  // red → very dark red (capped at 4× interval)
  const t = Math.min((days - interval * 2) / (interval * 2), 1);
  return { color: lerpColor('#C0392B', '#5C0A0A', t), label };
}

// Linear interpolate between two hex colours
function lerpColor(hex1, hex2, t) {
  const r1 = parseInt(hex1.slice(1,3),16), g1 = parseInt(hex1.slice(3,5),16), b1 = parseInt(hex1.slice(5,7),16);
  const r2 = parseInt(hex2.slice(1,3),16), g2 = parseInt(hex2.slice(3,5),16), b2 = parseInt(hex2.slice(5,7),16);
  const r = Math.round(r1 + (r2-r1)*t);
  const g = Math.round(g1 + (g2-g1)*t);
  const b = Math.round(b1 + (b2-b1)*t);
  return `rgb(${r},${g},${b})`;
}

// ── Encounter type ────────────────────────────────────────────────
function handleTypeClick(e) {
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  e.currentTarget.classList.add('active');
  currentType = e.currentTarget.dataset.type;
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

  resultsEl.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click',    () => addPerson(item.dataset.id, item.dataset.name));
    item.addEventListener('touchend', e => { e.preventDefault(); addPerson(item.dataset.id, item.dataset.name); });
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
    btn.addEventListener('click', () => { removePerson(btn.dataset.id); renderFrequentFriends(); });
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
  if (!date) { showSaveStatus('Please select a date.', 'error'); return; }

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

  // Reload frequent friends to reflect new encounter
  await loadData();

  setTimeout(() => document.getElementById('save-status').classList.add('hidden'), 4000);
}

// ── Helpers ───────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function initials(name) {
  return name.split(/\s+/).slice(0,2).map(w => w[0]||'').join('').toUpperCase();
}

// ── Wire up listeners ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('auth-btn').addEventListener('click', handleLogin);
  document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
  document.getElementById('save-btn').addEventListener('click', handleSave);
  document.getElementById('search-input').addEventListener('input', handleSearchInput);
  document.getElementById('search-input').addEventListener('keydown', handleSearchKey);
  document.querySelectorAll('.type-btn').forEach(btn => btn.addEventListener('click', handleTypeClick));
  boot();
});
