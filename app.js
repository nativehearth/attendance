'use strict';
/* Student attendance (demo v0.4): trainer page. */

const APP_VERSION = '0.6.0';
const API_URL = (window.APP_CONFIG || {}).API_URL || '';
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAME_CARD_GAP_MS = 2500;   // a card kept in view is ignored until it has been out of view this long
const OLD_SESSION_MS = 12 * 3600 * 1000;
const ADMIN_HOLD_MS = 3000;
const SNAPSHOT_EVERY = 10;       // on average 1 in 10 card scans saves a camera snapshot as evidence
const FAST_GAP_MS = 1000;        // two different cards read faster than this count as a fast scan

const $ = (id) => document.getElementById(id);

/* ---------------- storage ---------------- */
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('attendance', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('records', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('records', mode);
    let out;
    const r = fn(tx.objectStore('records'));
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const recPut = (rec) => idb('readwrite', (st) => st.put(rec));
const recDel = (id) => idb('readwrite', (st) => st.delete(id));
const recAll = () => idb('readonly', (st) => st.getAll());
const recGet = (id) => idb('readonly', (st) => st.get(id));

/* ---------------- state ---------------- */
const S = {
  config: LS.get('config'),
  session: LS.get('session'),
  pendingBatch: null,  // batch tapped, own attendance not yet marked
  marked: new Map(),   // studentId -> scan record
  recent: [],
  stream: null, detector: null, detectorErrors: 0,
  scanning: false, paused: false,
  lastCode: '', lastCodeAt: 0,
  wake: null, hmacKey: null, registered: null,
  ignorePop: 0, watchId: null, lastFix: null,
  week: 0, tab: 'classes', flagFirst: false,
};

/* ---------------- helpers ---------------- */
function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Date.now().toString(36) + '-' + Array.from(a, (b) => B32[b & 31]).join('');
}
const pad = (n) => String(n).padStart(2, '0');
function localDate(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function localTime(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function titleCase(s) { return s.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()); }
function show(id) { ['scr-login', 'scr-home', 'scr-resume', 'scr-scan'].forEach((s) => $(s).classList.toggle('hidden', s !== id)); }
function batchInfo(code) {
  const c = S.config || {};
  return (c.batches || []).find((b) => b.code === code) || (c.allBatches || []).find((b) => b.code === code) || null;
}
function labelOf(code) { const b = batchInfo(code); return (b && b.label) || code; }
function roster(code) { return (((S.config || {}).rosters || {})[code]) || []; }
function inRoster(code, id) { return roster(code).find((s) => s.id === id) || null; }
function regInfo(id) { // { c: current card number, b: batches } for every enrolled student
  const r = (S.config || {}).registered;
  return r && !Array.isArray(r) ? r[id] || null : null;
}

/* ---------------- back button: each screen or dialog is a history layer ---------------- */
const layers = [];
const PAGE_TOKEN = uid(); // history entries from an earlier page load count as depth 0
history.replaceState({ app: PAGE_TOKEN, depth: 0 }, '');
function pushLayer(name, onBack) { layers.push({ name, onBack }); history.pushState({ app: PAGE_TOKEN, depth: layers.length }, ''); }
function popLayers(n = 1) { if (n > 0) history.go(-n); }
function dropAllLayers() { const n = layers.length; layers.length = 0; if (n) { S.ignorePop++; history.go(-n); } }
window.addEventListener('popstate', (e) => {
  if (S.ignorePop) { S.ignorePop--; return; }
  const target = (e.state && e.state.app === PAGE_TOKEN && e.state.depth) || 0;
  while (layers.length > target) {
    const l = layers.pop();
    if (l.onBack && l.onBack() === false) { layers.push(l); history.pushState({ app: PAGE_TOKEN, depth: layers.length }, ''); break; }
  }
});

/* ---------------- card check code (must match Code.gs) ---------------- */
async function getHmacKey() {
  if (S.hmacKey) return S.hmacKey;
  if (!S.config || !S.config.cardKey) return null;
  S.hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(S.config.cardKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return S.hmacKey;
}
async function checkCode(id, cardNo, name) {
  const key = await getHmacKey();
  if (!key) return null;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id + '|' + cardNo + '|' + name)));
  const v = (sig[0] << 22) | (sig[1] << 14) | (sig[2] << 6) | (sig[3] >> 2);
  let s = '';
  for (let i = 0; i < 6; i++) s += B32[(v >>> (25 - 5 * i)) & 31];
  return s;
}
async function parseCard(text) {
  const p = String(text).trim().split('|');
  if (p.length !== 5 || p[0] !== 'TNS3') return null;
  const [, id, cardNo, name, code] = p;
  if (!id || !cardNo || !name || !code) return null;
  const expected = await checkCode(id, cardNo, name);
  return expected && expected === code ? { id, cardNo: Number(cardNo), name } : null;
}

/* ---------------- server ---------------- */
async function api(action, body = {}, timeoutMs = 30000) {
  if (!/^https:\/\/script\.google\.com\//.test(API_URL)) throw new Error('Server URL not set in config.js');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(API_URL, { method: 'POST', body: JSON.stringify(Object.assign({ action }, body)),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) throw new Error('Server replied ' + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Server took too long');
    throw e;
  } finally { clearTimeout(t); }
}
function saveConfig(r) {
  const extra = (S.config && S.config.extraRosters) || {}; // lists downloaded for substitute classes
  S.config = { trainer: r.trainer, batches: r.batches, allBatches: r.allBatches, rosters: Object.assign({}, extra, r.rosters), extraRosters: extra,
    registered: r.registered, cardKey: r.cardKey, classes: r.classes || [], trainerNames: r.trainerNames || {}, register: r.register || {}, at: Date.now() };
  S.hmacKey = null;
  LS.set('config', S.config);
}

/* ---------------- speech and vibration ---------------- */
let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /en[-_]IN/i.test(v.lang) && v.localService) || vs.find((v) => /en[-_]IN/i.test(v.lang))
    || vs.find((v) => /^en/i.test(v.lang) && v.localService) || vs.find((v) => /^en/i.test(v.lang)) || null;
  updateVoiceWarn();
}
function updateVoiceWarn() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return;
  $('voice-warn').classList.toggle('hidden', vs.some((v) => /^en/i.test(v.lang) && v.localService));
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text) {
  if (!('speechSynthesis' in window)) return;
  const go = () => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-IN'; }
    u.rate = 1.05;
    speechSynthesis.speak(u);
  };
  try { if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(go, 60); } else { go(); } } catch (e) { /* ignore */ }
}
function unlockSpeech() { say(' '); }
function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }

/* ---------------- location: keep trying during the whole class ---------------- */
function startLocation() {
  if (!('geolocation' in navigator) || S.watchId !== null) return;
  const onFix = (p) => {
    const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    S.lastFix = fix;
    if (S.session && (!S.session.gps || fix.acc < S.session.gps.acc)) { S.session.gps = fix; LS.set('session', S.session); }
  };
  const opts = { enableHighAccuracy: true, maximumAge: 600000, timeout: 60000 };
  navigator.geolocation.getCurrentPosition(onFix, () => {}, opts); // a recent last-known position is accepted at once
  S.watchId = navigator.geolocation.watchPosition(onFix, () => {}, opts);
}
function stopLocation() {
  if (S.watchId !== null) { try { navigator.geolocation.clearWatch(S.watchId); } catch (e) { /* ignore */ } }
  S.watchId = null;
}

/* ---------------- login ---------------- */
async function doLogin(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return false;
  show('scr-login');
  $('in-trainer').value = code;
  $('login-msg').textContent = 'Checking...';
  try {
    const r = await api('config', { trainer: code });
    if (!r.ok) { $('login-msg').textContent = r.error || 'Not accepted'; return false; }
    saveConfig(r);
    pickVoice();
    showHome();
    return true;
  } catch (e) {
    $('login-msg').textContent = 'Could not reach server. Check internet and try again. (' + e.message + ')';
    return false;
  }
}
async function refreshConfig(quiet) {
  if (!S.config || !navigator.onLine) return;
  try {
    const r = await api('config', { trainer: S.config.trainer.code }, 15000);
    if (r.ok) { saveConfig(r); if (!quiet) $('admin-msg').textContent = 'Batches updated.'; if (!$('scr-home').classList.contains('hidden')) showHome(false); }
    else if (!quiet) $('admin-msg').textContent = r.error || 'Not accepted';
  } catch (e) { if (!quiet) $('admin-msg').textContent = 'Offline. Using saved batch list.'; }
}

/* ---------------- home ---------------- */
async function showHome(toToday = true) {
  show('scr-home');
  const t = S.config.trainer;
  $('home-name').textContent = t.name + ' (' + t.code + ')';
  const list = $('batch-list');
  list.innerHTML = '';
  (S.config.batches || []).forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'batch';
    btn.innerHTML = '<b>' + esc(b.label) + '</b><span>' + esc(b.code) + ' · ' + esc(b.course) + '</span>';
    btn.onclick = () => startFromList(b.code);
    list.appendChild(btn);
  });
  if (!(S.config.batches || []).length) list.innerHTML = '<p class="small">No batches assigned. Ask admin.</p>';
  if (toToday) { S.week = 0; }
  await renderWeek();
  if (S.tab === 'students') renderStudents();
  updatePending();
  updateVoiceWarn();
}
/* Classes tab: one calendar week (Mon to Sun) per screen, 2 weeks back and 2 ahead. Timetable from the Batches tab (Days,
   Time); classes taken come from the server (as of the last time online) plus classes on this phone not yet sent. */
const WEEKS_BACK = 2, WEEKS_AHEAD = 2;
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WDN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (d) => d.getDate() + ' ' + MON[d.getMonth()];
const dmStr = (s) => (s ? Number(s.slice(8)) + ' ' + MON[Number(s.slice(5, 7)) - 1] : '');
const shortLabel = (l) => String(l || '').replace(/\s+-\s+/, '-');
const initials = (n) => String(n || '').replace(/^(Prof|Dr|Mr|Ms|Mrs)\.?\s+/i, '').split(/\s+/)[0];
function onDays(b, wd) { return String(b.days || '').split(/[,;\s]+/).map((x) => x.toLowerCase().slice(0, 3)).indexOf(wd) >= 0; }
function scheduledToday(code) { const b = batchInfo(code); return !b || !b.days || onDays(b, WD[new Date().getDay()]); }
function startFromList(code) {
  if (!scheduledToday(code) && !confirm(labelOf(code) + ' is not scheduled today. Start anyway?')) return;
  openClass(code);
}
function absClass(present, size) { const p = size ? present / size * 100 : 0; return p > 90 ? 'ok' : (p >= 70 ? 'wa' : 'bad'); }
async function renderWeek() {
  const cfg = S.config || {};
  const me = cfg.trainer.code;
  const names = cfg.trainerNames || {};
  const waiting = new Set((await recAll()).filter((r) => r.kind === 'session').map((r) => r.id));
  const taken = {};
  (cfg.classes || []).forEach((c) => { taken[c.id] = c; });
  LS.get('recentClasses', []).forEach((c) => { if (c.batch) taken[c.id] = Object.assign({ trainer: me }, c, { start: String(c.start).slice(0, 5) }); });
  const all = Object.values(taken);
  const now = new Date();
  const todayStr = localDate(now.getTime());
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + 7 * S.week, 12);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 12);
  $('wk-title').textContent = dm(monday) + ' to ' + dm(sunday) + (S.week === 0 ? ' · this week' : '');
  $('wk-prev').disabled = S.week <= -WEEKS_BACK; $('wk-next').disabled = S.week >= WEEKS_AHEAD;
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, 12);
    const date = localDate(d.getTime());
    const when = date < todayStr ? -1 : (date === todayStr ? 0 : 1);
    const done = all.filter((c) => c.date === date);
    const items = [];
    (cfg.batches || []).filter((b) => onDays(b, WD[d.getDay()])).forEach((b) => {
      const k = done.findIndex((c) => c.batch === b.code);
      if (k >= 0) { items.push({ c: done[k], b }); done.splice(k, 1); } else items.push({ b, time: b.time || '' });
    });
    done.forEach((c) => items.push({ c, b: batchInfo(c.batch) || { code: c.batch, label: c.batch } }));
    items.sort((x, y) => String(x.c ? x.c.start : x.time).localeCompare(String(y.c ? y.c.start : y.time)));
    const left = [], right = [];
    items.forEach((it) => {
      left.push(esc((it.c ? it.c.start : it.time) || '') + ' ' + esc(shortLabel(it.b.label || it.b.code)));
      if (it.c) {
        const c = it.c, size = Number(c.present) + Number(c.absent);
        const extra = (c.trainer && c.trainer !== me ? ' · ' + esc(initials(names[c.trainer] || c.trainer)) : '') +
          (c.substitute ? ' · sub' : '') + (waiting.has(c.id) ? ' · <span class="wa">waiting</span>' : '');
        right.push('<span class="' + absClass(Number(c.present), size) + '">' + size + ' · Abs ' + c.absent + '</span>' + extra);
      } else if (when < 0) right.push('<span class="bad">Cancelled</span>');
      else if (when === 0) right.push('<button class="primary" data-start="' + esc(it.b.code) + '">Start</button>');
      else right.push('<span class="mu">/' + roster(it.b.code).length + '</span>');
    });
    html += '<tr' + (when === 0 ? ' class="today"' : '') + '><td class="d">' + WDN[d.getDay()] + ' ' + d.getDate() + '</td>' +
      (items.length ? '<td>' + left.join('<br>') + '</td><td class="s">' + right.join('<br>') + '</td>' : '<td class="none" colspan="2">No class</td>') + '</tr>';
  }
  $('week').innerHTML = html;
  $('week').querySelectorAll('button[data-start]').forEach((btn) => { btn.onclick = () => openClass(btn.dataset.start); });
}
function stepWeek(n) { S.week = Math.max(-WEEKS_BACK, Math.min(WEEKS_AHEAD, S.week + n)); renderWeek(); }

/* Students tab: every student of this trainer's batches, by college and course; figures as of the last time online */
const flagged = (c) => !!(c && (c.flag || c.rating === 'Poor'));
function showTab(which) {
  S.tab = which;
  $('tab-classes').classList.toggle('on', which === 'classes'); $('tab-students').classList.toggle('on', which === 'students');
  $('pane-classes').classList.toggle('hidden', which !== 'classes'); $('pane-students').classList.toggle('hidden', which !== 'students');
  if (which === 'students') renderStudents();
}
function renderStudents() {
  const cfg = S.config || {};
  const reg = cfg.register || {};
  const q = $('in-stu').value.trim().toLowerCase();
  $('btn-flagfirst').classList.toggle('on', !!S.flagFirst);
  const batches = (cfg.batches || []).slice().sort((a, b) => (a.college + a.label).localeCompare(b.college + b.label));
  let html = '';
  batches.forEach((b) => {
    let rows = roster(b.code).map((s) => ({ s, c: ((reg[s.id] || {}).courses || []).find((x) => x.batch === b.code) }))
      .filter((x) => !q || x.s.label.toLowerCase().includes(q) || x.s.id.toLowerCase().includes(q));
    if (S.flagFirst) rows = rows.filter((x) => flagged(x.c)).concat(rows.filter((x) => !flagged(x.c)));
    if (!rows.length) return;
    html += '<h3>' + esc(b.label) + '</h3><table class="stu"><tr><th>Name</th><th class="n">Absence %</th><th class="n">Attend.</th></tr>' +
      rows.map((x) => '<tr class="tap" data-id="' + esc(x.s.id) + '" data-name="' + esc(x.s.label) + '"><td>' + esc(x.s.label) + '<br><small>' + esc(x.s.id) +
        '</small></td><td class="n">' + (x.c && x.c.held ? x.c.absentPct : '') + '</td><td class="n ' + attClass(x.c && x.c.rating) + '">' +
        esc((x.c && x.c.rating) || '') + (flagged(x.c) && x.c.flag ? ' !' : '') + '</td></tr>').join('') + '</table>';
  });
  $('stu-list').innerHTML = html || '<p class="small">No students found.</p>';
  $('stu-list').querySelectorAll('tr.tap').forEach((tr) => { tr.onclick = () => openStudent(tr.dataset.id, tr.dataset.name); });
  $('stu-asof').textContent = cfg.at ? 'Figures as of ' + dmStr(localDate(cfg.at)) + ', ' + localTime(cfg.at).slice(0, 5) + ' (classes received by then).' : '';
}
function attClass(r) { return r === 'High' ? 'ok' : (r === 'Med' ? 'wa' : (r === 'Poor' ? 'bad' : '')); }
async function updatePending() {
  if (syncing) return 0;
  try {
    const n = (await recAll()).filter((r) => r.ready && r.kind === 'session').length;
    $('pending-line').textContent = n + ' class' + (n === 1 ? '' : 'es') + ' waiting to send. ' + (navigator.onLine ? 'Sending automatically.' : 'Will send when online.');
    $('pending-line').classList.toggle('hidden', n === 0);
    return n;
  } catch (e) { return 0; }
}

/* admin panel: hold the trainer name for 3 seconds */
let holdTimer = null;
$('home-name').addEventListener('pointerdown', () => { holdTimer = setTimeout(openAdmin, ADMIN_HOLD_MS); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('home-name').addEventListener(ev, () => clearTimeout(holdTimer)));
async function openAdmin() {
  const all = await recAll();
  const scanner = ('BarcodeDetector' in window) ? 'built-in scanner' : 'fallback scanner';
  const v = voice ? voice.name + (voice.localService ? ', offline voice' : ', online voice') : 'no voice';
  $('admin-diag').textContent = 'Version ' + APP_VERSION + ' · ' + scanner + ' · ' + v + ' · waiting to send ' + all.filter((r) => r.ready).length +
    ' · batch lists from ' + (S.config.at ? new Date(S.config.at).toLocaleString() : 'never');
  $('admin-msg').textContent = '';
  $('dlg-admin').classList.remove('hidden');
  pushLayer('admin', () => { $('dlg-admin').classList.add('hidden'); });
}

/* ---------------- class: tap batch, mark own attendance, scan, class photo, finish ---------------- */
function openClass(batch, substitute) {
  unlockSpeech();
  S.pendingBatch = batch;
  S.pendingSub = !!substitute;
  if (substitute && !roster(batch).length) loadRoster(batch);
  show('scr-scan');
  pushLayer('scan', backFromScan);
  $('scan-label').textContent = labelOf(batch);
  $('mark-pane').classList.remove('hidden');
  $('class-bar').classList.add('hidden');
  $('btn-nocard').disabled = true; $('btn-finish').disabled = true;
  S.marked = new Map(); S.recent = [];
  renderList();
}
async function markOwnAttendance() {
  const now = Date.now();
  S.session = { id: uid(), batch: S.pendingBatch, date: localDate(now), classStartTs: now, trainer: S.config.trainer.code,
    gps: null, fastScans: 0, lastQrTs: 0, photoTs: null, comment: '', substitute: !!S.pendingSub };
  S.pendingBatch = null;
  LS.set('session', S.session);
  startLocation();
  say('Attendance marked');
  vibrate(80);
  await enterClass();
}
async function enterClass() {
  $('mark-pane').classList.add('hidden');
  $('class-bar').classList.remove('hidden');
  $('btn-nocard').disabled = false; $('btn-finish').disabled = false;
  $('scan-label').textContent = labelOf(S.session.batch);
  S.marked = new Map(); S.recent = [];
  (await recAll()).filter((r) => r.kind === 'scan' && r.sessionId === S.session.id).sort((a, b) => a.ts - b.ts)
    .forEach((r) => { S.marked.set(r.studentId, r); S.recent.push(r); });
  renderList();
  renderClassBar();
  try { await startCamera(); } catch (e) { banner('red', 'Camera not available: ' + e.message); return; }
  banner('', 'Ready · show card');
  requestWake();
  if (!S.scanning) { S.scanning = true; tick(); }
}
async function resumeClass() {
  unlockSpeech();
  show('scr-scan');
  pushLayer('scan', backFromScan);
  startLocation();
  await enterClass();
}
async function loadRoster(batch) { // student list for a substitute class (needs internet once; kept on the phone)
  if (!navigator.onLine) return;
  try {
    const r = await api('roster', { trainer: S.config.trainer.code, batch }, 20000);
    if (!r.ok) return;
    S.config.extraRosters = S.config.extraRosters || {};
    S.config.extraRosters[batch] = r.roster;
    S.config.rosters[batch] = r.roster;
    LS.set('config', S.config);
  } catch (e) { /* offline: card checks still work from the enrolled list */ }
}
function openSubstitute() {
  $('dlg-sub').classList.remove('hidden');
  $('in-sub').value = '';
  renderSub();
  pushLayer('sub', () => { $('dlg-sub').classList.add('hidden'); });
  setTimeout(() => $('in-sub').focus(), 60);
}
function renderSub() {
  const q = $('in-sub').value.trim().toLowerCase();
  const mine = new Set((S.config.batches || []).map((b) => b.code));
  const list = (S.config.allBatches || []).filter((b) => !mine.has(b.code) &&
    (!q || b.code.toLowerCase().includes(q) || b.label.toLowerCase().includes(q) || b.course.toLowerCase().includes(q)));
  $('sub-results').innerHTML = '';
  list.slice(0, 12).forEach((b) => {
    const li = document.createElement('li');
    li.className = 'tap';
    li.innerHTML = '<span class="name"><b>' + esc(b.label) + '</b> · ' + esc(b.code) + '</span><span class="meta">' + esc(b.course) + '</span>';
    li.onclick = () => { popLayers(1); setTimeout(() => openClass(b.code, true), 80); };
    $('sub-results').appendChild(li);
  });
  if (!list.length) $('sub-results').innerHTML = '<li class="empty">' + (S.config.allBatches ? 'No matching batch.' : 'Open the app once with internet to load all batches.') + '</li>';
}
function renderClassBar() {
  const s = S.session;
  $('class-status').textContent = (s.substitute ? 'Substitute · ' : '') + 'Attendance marked ' + localTime(s.classStartTs).slice(0, 5);
  const btn = $('btn-classphoto');
  btn.textContent = s.photoTs ? 'Class photo ' + localTime(s.photoTs).slice(0, 5) + ' ✓' : 'Take class photo';
  btn.classList.toggle('done', !!s.photoTs);
}
function backFromScan() {
  if (!S.session) { // batch opened but own attendance not marked: nothing saved
    S.pendingBatch = null;
    showHome();
    return true;
  }
  banner('amber', 'Tap Finish to end the class');
  return false;
}
async function startCamera() {
  if (S.stream && S.stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
  stopCamera();
  S.stream = await navigator.mediaDevices.getUserMedia({ audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  const v = $('video');
  v.srcObject = S.stream;
  await v.play().catch(() => {});
  try {
    const track = S.stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch (e) { /* not supported */ }
  if (!S.detector && 'BarcodeDetector' in window) {
    try { if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) S.detector = new BarcodeDetector({ formats: ['qr_code'] }); }
    catch (e) { S.detector = null; }
  }
}
function stopCamera() {
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
  $('video').srcObject = null;
}

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
async function tick() {
  if (!S.scanning) return;
  const v = $('video');
  const texts = [];
  if (!S.paused && v.readyState >= 2 && v.videoWidth) {
    try {
      if (S.detector) {
        (await S.detector.detect(v)).forEach((c) => texts.push(c.rawValue));
        S.detectorErrors = 0;
      } else if (window.jsQR) {
        const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (r && r.data) texts.push(r.data);
      }
    } catch (e) { if (S.detector && ++S.detectorErrors > 20) S.detector = null; }
  }
  for (const t of texts) await onCode(t);
  setTimeout(tick, S.detector ? 100 : 160);
}
function frameJpeg(video, maxSide, quality) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return null;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

async function onCode(text) {
  if (!S.session) return;
  const now = Date.now();
  if (text === S.lastCode && now - S.lastCodeAt < SAME_CARD_GAP_MS) { S.lastCodeAt = now; return; }
  S.lastCode = text; S.lastCodeAt = now;
  const card = await parseCard(text);
  if (!card) { vibrate(400); banner('red', 'Card not valid'); say('card not valid'); return; }
  const reg = regInfo(card.id);
  if (reg && Number(reg.c) !== card.cardNo) { vibrate(400); banner('red', 'Old card, not valid'); say('old card'); return; }
  if (S.marked.has(card.id)) { vibrate([40, 40, 40]); banner('amber', 'Already marked'); say('already marked'); return; }
  const listed = inRoster(S.session.batch, card.id);
  const kind = (listed || (reg && (reg.b || []).includes(S.session.batch))) ? 'in' : (reg ? 'other' : 'notreg');
  const name = listed ? listed.label : card.name;
  if (S.session.lastQrTs && now - S.session.lastQrTs < FAST_GAP_MS) S.session.fastScans++;
  S.session.lastQrTs = now;
  LS.set('session', S.session);
  const snapshot = Math.random() < 1 / SNAPSHOT_EVERY ? frameJpeg($('video'), 480, 0.5) : null;
  await addRecord({ studentId: card.id, name, method: 'QR', flag: kind === 'other' ? 'other batch' : (kind === 'notreg' ? 'not registered' : ''), snapshot });
  if (kind === 'in') { vibrate(80); banner('green', name); say(name); }
  else if (kind === 'other') { vibrate([120, 60, 120]); banner('amber', name + ' · other batch'); say(name + ', other batch'); }
  else { vibrate([120, 60, 120]); banner('amber', name + ' · not registered, added'); say(name + ', not registered'); }
}

async function addRecord({ studentId, name, method, flag = '', photo = null, snapshot = null }) {
  const ts = Date.now();
  const s = S.session;
  const rec = { id: uid(), kind: 'scan', sessionId: s.id, ts, date: localDate(ts), time: localTime(ts), batch: s.batch, studentId, name, method,
    flag, trainer: s.trainer, photo, snapshot, ready: false };
  await recPut(rec);
  S.marked.set(studentId, rec);
  S.recent.push(rec);
  renderList();
  return rec;
}

function banner(color, text) {
  $('banner').className = color || '';
  $('banner-text').textContent = text;
  const f = $('flash');
  if (color) {
    f.style.background = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' }[color];
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 30);
  }
}
function badgeFor(r) {
  if (r.flag === 'other batch') return '<span class="badge flag">other batch</span>';
  if (r.flag === 'not registered') return '<span class="badge new">not registered</span>';
  if (r.method !== 'QR') return '<span class="badge ' + r.method + '">' + (r.method === 'manual' ? 'no card' : 'new') + '</span>';
  return '';
}
function rowHtml(r) {
  return (r.photo ? '<img alt="" src="' + r.photo + '">' : '') + '<span class="name link">' + esc(r.name) + badgeFor(r) + '</span>' +
    '<span class="meta">' + esc(r.studentId) + '<br>' + r.time.slice(0, 5) + '</span><button class="x" aria-label="Remove">✕</button>';
}
function wireRow(li, r, after) {
  li.querySelector('.x').onclick = (e) => { e.stopPropagation(); removeRecord(r, after); };
  li.querySelector('.name').onclick = () => openStudent(r.studentId, r.name);
}
function renderList() {
  $('scan-count').textContent = S.marked.size;
  const ul = $('recent');
  ul.innerHTML = '';
  if (!S.recent.length) { ul.innerHTML = '<li class="empty">Names appear here as cards are scanned. Tap a name to see the record.</li>'; return; }
  S.recent.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = rowHtml(r);
    wireRow(li, r);
    ul.appendChild(li);
  });
  ul.scrollTop = ul.scrollHeight;
}
async function removeRecord(r, after) {
  const wasPaused = S.paused;
  S.paused = true;
  const ok = confirm('Remove ' + r.name + ' (' + r.studentId + ')?');
  S.paused = wasPaused;
  if (!ok) return;
  await recDel(r.id);
  S.marked.delete(r.studentId);
  S.recent = S.recent.filter((x) => x.id !== r.id);
  S.lastCode = '';
  renderList();
  if (after) after();
}

/* ---------------- photo dialog (no card, absent student, class photo) ---------------- */
let photoOpts = null;
function openPhoto(opts) {
  photoOpts = opts;
  $('photo-title').textContent = opts.title;
  $('photo-comment').classList.toggle('hidden', !opts.comment);
  if (opts.comment) $('photo-comment').value = (S.session && S.session.comment) || '';
  const v = $('video-photo');
  v.srcObject = S.stream;
  v.play().catch(() => {});
  $('dlg-photo').classList.remove('hidden');
  const wasPaused = S.paused;
  S.paused = true;
  pushLayer('photo', () => {
    $('dlg-photo').classList.add('hidden');
    $('video-photo').srcObject = null;
    photoOpts = null;
    S.paused = wasPaused;
  });
}
$('btn-photo-take').onclick = async () => {
  if (!photoOpts) return;
  const o = photoOpts;
  const img = frameJpeg($('video-photo'), o.maxSide || 640, o.quality || 0.6);
  if (!img) return;
  await o.onTaken(img);
};
function takeClassPhoto(after) {
  openPhoto({
    title: 'Class photo: fit the whole class in the frame', maxSide: 1280, quality: 0.7, comment: true,
    onTaken: async (img) => {
      const ts = Date.now();
      await recPut({ id: S.session.id + '-photo', kind: 'classphoto', sessionId: S.session.id, ts, img, ready: false });
      S.session.photoTs = ts;
      S.session.comment = $('photo-comment').value.trim().slice(0, 300);
      LS.set('session', S.session);
      popLayers(1);
      renderClassBar();
      vibrate(80);
      banner('green', 'Class photo saved');
      if (after) setTimeout(after, 50);
    },
  });
}

/* ---------------- No card ---------------- */
function openNoCard() {
  S.paused = true;
  $('dlg-nocard').classList.remove('hidden');
  $('in-search').value = '';
  renderSearch();
  pushLayer('nocard', () => { $('dlg-nocard').classList.add('hidden'); S.paused = false; S.lastCode = ''; });
  setTimeout(() => $('in-search').focus(), 60);
}
function renderSearch() {
  const raw = $('in-search').value.trim();
  const q = raw.toLowerCase();
  const ul = $('search-results');
  ul.innerHTML = '';
  const btnNew = $('btn-add-new');
  btnNew.classList.add('hidden');
  if (q.length < 2) return;
  const matches = roster(S.session.batch).filter((s) => {
    const n = s.name.toLowerCase();
    return n.split(/\s+/).some((w) => w.startsWith(q)) || n.includes(q) || s.id.toLowerCase().includes(q);
  }).slice(0, 8);
  matches.forEach((s) => {
    const li = document.createElement('li');
    const done = S.marked.has(s.id);
    li.textContent = s.label + ' · ' + s.id + (done ? ' · already marked' : '');
    if (done) li.className = 'empty';
    else { li.className = 'tap'; li.onclick = () => photoForManual({ studentId: s.id, name: s.label, method: 'manual' }, 2); }
    ul.appendChild(li);
  });
  if (!matches.length && q.length >= 3) {
    btnNew.textContent = 'Add new student: ' + titleCase(raw);
    btnNew.classList.remove('hidden');
  }
}
function addNew() {
  const name = titleCase($('in-search').value);
  if (name.length < 3) return;
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  const college = (batchInfo(S.session.batch) || {}).college || 'NEW';
  photoForManual({ studentId: college + '-NEW-' + Array.from(a, (b) => B32[b & 31]).join(''), name, method: 'new' }, 2);
}
// layersToClose: 2 from No card (photo + search), 1 from the summary's absent list (photo only)
function photoForManual(t, layersToClose, after) {
  openPhoto({
    title: (t.method === 'new' ? 'New student: ' : 'Photo of ') + t.name,
    onTaken: async (img) => {
      await addRecord({ studentId: t.studentId, name: t.name, method: t.method, photo: img });
      popLayers(layersToClose);
      vibrate(80);
      banner('green', t.name + ' · marked (' + (t.method === 'new' ? 'new' : 'no card') + ')');
      say(t.name);
      if (after) setTimeout(after, 50);
    },
  });
}

/* ---------------- student record (needs internet) ---------------- */
function renderStudentRecord(rec) {
  const cs = rec.courses || [];
  const short = (c) => String(c.course).split(' - ').pop();
  $('st-table').querySelector('tbody').innerHTML = cs.map((c) => '<tr><td>' + esc(short(c)) + '</td><td>' + c.held + '</td><td>' + c.absent +
    '</td><td>' + (c.held ? c.absentPct : '') + '</td><td class="' + attClass(c.rating) + '">' + esc(c.rating || '') + '</td></tr>').join('');
  $('st-table').classList.toggle('hidden', !cs.length);
  const flags = cs.filter((c) => c.flag).map((c) => short(c) + ': ' + c.flag);
  $('st-flag').textContent = flags.join(' · ');
  $('st-flag').classList.toggle('hidden', !flags.length);
  $('st-hist').innerHTML = cs.filter((c) => c.marks).map((c) => '<div class="hh">' + esc(short(c)) + ' (' + esc(dmStr(c.from)) + ' to ' + esc(dmStr(c.to)) + ')</div>' +
    '<div class="mk">' + c.marks.split('').map((m) => '<span class="' + m + '">' + m + '</span>').join('') + '</div>').join('');
}
async function openStudent(id, name) {
  $('st-title').textContent = name + ' · ' + id;
  $('st-table').classList.add('hidden'); $('st-flag').classList.add('hidden'); $('st-hist').innerHTML = '';
  $('dlg-student').classList.remove('hidden');
  const wasPaused = S.paused;
  S.paused = true;
  pushLayer('student', () => { $('dlg-student').classList.add('hidden'); S.paused = wasPaused; });
  const cached = ((S.config || {}).register || {})[id];
  const asOf = () => 'Classes received by ' + dmStr(localDate(S.config.at)) + ', ' + localTime(S.config.at).slice(0, 5) + '. Old on the left, newest on the right.';
  if (cached) { renderStudentRecord(cached); $('st-msg').textContent = cached.college + ' · ' + asOf(); return; }
  if (!navigator.onLine) { $('st-msg').textContent = 'Needs internet once to show this student (not in your batches).'; return; }
  $('st-msg').textContent = 'Loading...';
  try {
    const r = await api('student', { trainer: S.config.trainer.code, studentId: id }, 20000);
    if (!r.ok) { $('st-msg').textContent = r.error || 'Not available'; return; }
    renderStudentRecord(r);
    $('st-msg').textContent = r.student.college + ' · classes received so far. Old on the left, newest on the right.';
  } catch (e) { $('st-msg').textContent = 'Could not load (' + e.message + ').'; }
}

/* ---------------- Finish: summary with present / absent lists ---------------- */
function counts() {
  const recs = [...S.marked.values()];
  const isOther = (r) => r.flag === 'other batch';
  const present = recs.filter((r) => !isOther(r));
  const list = roster(S.session.batch);
  const ids = new Set(present.map((r) => r.studentId));
  return {
    present, other: recs.filter(isOther), absent: list.filter((s) => !ids.has(s.id)),
    manual: recs.filter((r) => r.method === 'manual').length, newc: recs.filter((r) => r.method === 'new').length,
    notReg: recs.filter((r) => r.flag === 'not registered').length, batchSize: list.length,
  };
}
function openSummary() {
  S.paused = true;
  $('dlg-summary').classList.remove('hidden');
  $('sum-list-title').textContent = '';
  $('sum-list').innerHTML = '';
  renderSummary();
  pushLayer('summary', () => { $('dlg-summary').classList.add('hidden'); S.paused = false; S.lastCode = ''; });
}
function renderSummary() {
  const c = counts();
  $('sum-title').textContent = labelOf(S.session.batch);
  $('sum-present').textContent = c.present.length;
  $('sum-absent').textContent = c.absent.length;
  $('sum-manual').textContent = c.manual;
  const extra = [];
  if (c.newc) extra.push('New ' + c.newc);
  if (c.notReg) extra.push('Not registered ' + c.notReg);
  if (c.other.length) extra.push('Other batch ' + c.other.length + ' (' + c.other.map((r) => r.name).join(', ') + ')');
  if (!c.batchSize) extra.push('Batch list not downloaded, absent count not available');
  $('sum-extra').textContent = extra.join(' · ');
  const hasPhoto = !!S.session.photoTs;
  $('btn-sum-photo').classList.toggle('hidden', hasPhoto);
  $('sum-photo-ok').classList.toggle('hidden', !hasPhoto);
  if (hasPhoto) $('sum-photo-ok').textContent = 'Class photo taken ' + localTime(S.session.photoTs).slice(0, 5) + (S.session.comment ? ' · ' + S.session.comment : '');
  $('btn-submit').disabled = !hasPhoto;
}
function showSumList(which) {
  const c = counts();
  const ul = $('sum-list');
  ul.innerHTML = '';
  if (which === 'present') {
    $('sum-list-title').textContent = 'Present (' + c.present.length + ') · tap ✕ to remove';
    c.present.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = rowHtml(r);
      wireRow(li, r, () => { renderSummary(); showSumList('present'); });
      ul.appendChild(li);
    });
  } else {
    $('sum-list-title').textContent = 'Absent (' + c.absent.length + ') · tap a name for the record';
    c.absent.slice().sort((a, b) => a.label.localeCompare(b.label)).forEach((s) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="name link">' + esc(s.label) + '</span><span class="meta">' + esc(s.id) + '</span><button class="mark">Mark present</button>';
      li.querySelector('.name').onclick = () => openStudent(s.id, s.label);
      li.querySelector('.mark').onclick = () => photoForManual({ studentId: s.id, name: s.label, method: 'manual' }, 1, () => { renderSummary(); showSumList('absent'); });
      ul.appendChild(li);
    });
    if (!c.absent.length) ul.innerHTML = '<li class="empty">No one absent.</li>';
  }
}
async function submitSession(force) {
  const s = S.session;
  if (!s || (!s.photoTs && !force)) return;
  const c = counts();
  const now = Date.now();
  S.scanning = false;
  stopCamera();
  stopLocation();
  releaseWake();
  dropAllLayers();
  $('dlg-summary').classList.add('hidden');
  S.paused = false;
  const all = await recAll();
  const scans = all.filter((r) => r.kind === 'scan' && r.sessionId === s.id).sort((a, b) => a.ts - b.ts);
  for (const r of scans) { r.ready = true; await recPut(r); }
  const photo = await recGet(s.id + '-photo');
  await recPut({ id: s.id, kind: 'session', ready: true, date: s.date, trainer: s.trainer, batch: s.batch, batchSize: c.batchSize,
    present: c.present.length, absent: c.absent.length, manual: c.manual, newc: c.newc, other: c.other.length, notReg: c.notReg,
    classStart: localTime(s.classStartTs), photoTime: s.photoTs ? localTime(s.photoTs) : '', photo: photo ? photo.img : null,
    attendanceStart: scans.length ? scans[0].time : '', attendanceEnd: localTime(now),
    gps: s.gps, gpsEnd: S.lastFix || s.gps, fastScans: s.fastScans, comment: s.comment || '', substitute: !!s.substitute });
  if (photo) await recDel(photo.id);
  const rc = LS.get('recentClasses', []);
  rc.unshift({ id: s.id, batch: s.batch, trainer: s.trainer, label: labelOf(s.batch), date: s.date, start: localTime(s.classStartTs),
    present: c.present.length, absent: c.absent.length, substitute: !!s.substitute });
  const cutoff = localDate(Date.now() - 9 * 86400000);
  LS.set('recentClasses', rc.filter((x) => x.batch && x.date >= cutoff).slice(0, 60));
  LS.del('session');
  S.session = null; S.marked = new Map(); S.recent = [];
  await showHome();
  requestBackgroundSend();
  sync(false);
}

/* ---------------- sending (shared with the service worker: sender.js) ---------------- */
let syncing = false;
let syncLeft = 0;
const RETRY_MS = [15000, 60000, 300000]; // quicker retries while the app is open
let retryStep = 0, retryTimer = null;
function showProgress(text) {
  $('pending-line').textContent = text;
  $('pending-line').classList.toggle('hidden', !text);
  $('admin-msg').textContent = text;
}
function requestBackgroundSend() {
  // Chrome on Android finishes sending later, even if the app is closed
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => (reg.sync ? reg.sync.register('send') : null)).catch(() => {});
}
async function sync(manual) {
  if (!S.config) return;
  if (syncing) { if (manual) showProgress('Sending... ' + syncLeft + ' class' + (syncLeft === 1 ? '' : 'es') + ' left'); return; }
  syncing = true;
  try {
    const n = (await recAll()).filter((r) => r.ready && r.kind === 'session').length;
    if (!n) { if (manual) showProgress('Nothing waiting to send.'); return; }
    if (!navigator.onLine) { showProgress(n + ' class' + (n === 1 ? '' : 'es') + ' waiting to send. Will send when online.'); requestBackgroundSend(); return; }
    const left = await SENDER.sendAll(API_URL, (k) => { syncLeft = k; if (k) showProgress('Sending... ' + k + ' class' + (k === 1 ? '' : 'es') + ' left'); });
    showProgress(left ? 'Still waiting to send. Will retry.' : (manual ? 'All sent.' : ''));
    retryStep = 0;
  } catch (e) {
    const n = (await recAll()).filter((r) => r.ready && r.kind === 'session').length;
    showProgress(n + ' class' + (n === 1 ? '' : 'es') + ' waiting to send. Not sent yet (' + e.message + '). Will retry automatically.');
    requestBackgroundSend();
    const delay = RETRY_MS[Math.min(retryStep++, RETRY_MS.length - 1)];
    clearTimeout(retryTimer); retryTimer = setTimeout(() => sync(false), delay);
  } finally {
    syncing = false;
    if (!$('scr-home').classList.contains('hidden')) renderWeek();
  }
}

/* ---------------- screen wake lock ---------------- */
async function requestWake() {
  try { if ('wakeLock' in navigator && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch (e) { /* ignore */ }
}
function releaseWake() { try { if (S.wake) S.wake.release(); } catch (e) { /* ignore */ } S.wake = null; }
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') { // app closed or switched away: hand any waiting items to background sending
    try { if ((await recAll()).some((r) => r.ready)) requestBackgroundSend(); } catch (e) { /* ignore */ }
    return;
  }
  if (S.config && !S.session && !$('scr-home').classList.contains('hidden')) { renderWeek(); refreshConfig(true); }
  if (S.scanning && S.session) {
    requestWake();
    try { await startCamera(); } catch (e) { banner('red', 'Camera not available: ' + e.message); }
  }
  sync(false);
});

/* ---------------- wire up ---------------- */
$('btn-login').onclick = () => doLogin($('in-trainer').value);
$('in-trainer').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin($('in-trainer').value); });
$('btn-mark').onclick = markOwnAttendance;
$('btn-classphoto').onclick = () => takeClassPhoto();
$('btn-resume').onclick = resumeClass;
$('btn-nocard').onclick = openNoCard;
$('in-search').addEventListener('input', renderSearch);
$('btn-add-new').onclick = addNew;
$('btn-finish').onclick = openSummary;
$('tile-present').onclick = () => showSumList('present');
$('tile-absent').onclick = () => showSumList('absent');
$('btn-sum-photo').onclick = () => takeClassPhoto(renderSummary);
$('btn-sum-back').onclick = () => popLayers(1);
$('btn-submit').onclick = () => submitSession(false);
$('btn-a-sync').onclick = () => sync(true);
$('btn-a-voice').onclick = () => { pickVoice(); say('Testing. Asha Kumari. Rahul Verma.'); };
$('btn-a-refresh').onclick = () => refreshConfig(false);
$('btn-st-back').onclick = () => history.back();
$('wk-prev').onclick = () => stepWeek(-1);
$('wk-next').onclick = () => stepWeek(1);
$('tab-classes').onclick = () => showTab('classes');
$('tab-students').onclick = () => showTab('students');
$('in-stu').oninput = () => renderStudents();
$('btn-flagfirst').onclick = () => { S.flagFirst = !S.flagFirst; renderStudents(); };
$('btn-sub').onclick = openSubstitute;
$('in-sub').addEventListener('input', renderSub);
['dlg-nocard', 'dlg-photo', 'dlg-student', 'dlg-admin', 'dlg-sub'].forEach((id) => {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) popLayers(1); }); // tap outside the pop-up closes it
});
window.addEventListener('online', () => { sync(false); refreshConfig(true); });
window.addEventListener('offline', updatePending);
setInterval(() => sync(false), 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async function init() { try { await start(); window.__appStarted = true; } catch (e) { if (window.__fatal) window.__fatal(e.message); } })();
async function start() {
  try { await SENDER.cleanOld(); } catch (e) { /* ignore */ }
  // each trainer can be sent a personal link ending in ?t=CODE, so nothing has to be typed
  const linkCode = new URLSearchParams(location.search).get('t');
  if (linkCode) history.replaceState({ app: PAGE_TOKEN, depth: 0 }, '', location.pathname);
  if (linkCode && (!S.config || S.config.trainer.code !== linkCode.trim().toUpperCase()) && !S.session) { await doLogin(linkCode); return; }
  if (!S.config) { show('scr-login'); return; }
  if (S.session && !S.session.classStartTs) S.session.classStartTs = S.session.startTs || Date.now(); // class left open in an older version
  if (S.session && Date.now() - S.session.classStartTs > OLD_SESSION_MS) {
    // class left open from an earlier day: submit what was scanned (flagged in Summary if no class photo)
    S.marked = new Map();
    (await recAll()).filter((r) => r.kind === 'scan' && r.sessionId === S.session.id).forEach((r) => S.marked.set(r.studentId, r));
    await submitSession(true);
    return;
  }
  if (S.session) {
    show('scr-resume');
    $('btn-resume').textContent = 'Continue class ' + labelOf(S.session.batch);
    return;
  }
  await showHome();
  refreshConfig(true);
  sync(false);
}
