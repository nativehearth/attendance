'use strict';
/* Student attendance pilot: trainer page. */

const APP_VERSION = '0.1.0';
const API_URL = (window.APP_CONFIG || {}).API_URL || '';
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAME_CARD_GAP_MS = 2500;      // same card held in view is ignored for this long after last sighting
const OTHER_BATCH_BUTTON_MS = 8000; // how long "Add anyway" stays on screen
const OLD_SESSION_MS = 12 * 3600 * 1000;

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

/* ---------------- state ---------------- */
const S = {
  config: LS.get('config'),
  session: LS.get('session'),
  selectedBatch: LS.get('lastBatch'),
  roster: [],
  marked: new Map(),   // key "batch|roll" -> record
  recent: [],
  stream: null,
  detector: null,
  detectorErrors: 0,
  scanning: false,
  paused: false,
  lastCode: '',
  lastCodeAt: 0,
  otherCard: null,
  otherTimer: null,
  audio: null,
  wake: null,
  hmacKey: null,
  photoTarget: null,
};

/* ---------------- small helpers ---------------- */
function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Date.now().toString(36) + '-' + Array.from(a, (b) => B32[b & 31]).join('');
}
const pad = (n) => String(n).padStart(2, '0');
function localDate(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function localTime(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function show(id) {
  ['scr-login', 'scr-home', 'scr-scan'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function titleCase(s) { return s.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()); }

/* ---------------- card check code (must match Code.gs) ---------------- */
async function getHmacKey() {
  if (S.hmacKey) return S.hmacKey;
  if (!S.config || !S.config.cardKey) return null;
  S.hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(S.config.cardKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return S.hmacKey;
}
async function checkCode(batch, roll, name) {
  const key = await getHmacKey();
  if (!key) return null;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(batch + '|' + roll + '|' + name)));
  const v = (sig[0] << 22) | (sig[1] << 14) | (sig[2] << 6) | (sig[3] >> 2);
  let s = '';
  for (let i = 0; i < 6; i++) s += B32[(v >>> (25 - 5 * i)) & 31];
  return s;
}
async function parseCard(text) {
  const p = String(text).trim().split('|');
  if (p.length !== 5 || p[0] !== 'TNS1') return null;
  const [, batch, roll, name, code] = p;
  if (!batch || !roll || !name || !code) return null;
  const expected = await checkCode(batch, roll, name);
  return expected && expected === code ? { batch, roll, name } : null;
}

/* ---------------- server ---------------- */
async function api(action, body = {}, timeoutMs = 30000) {
  if (!/^https:\/\/script\.google\.com\//.test(API_URL)) throw new Error('Server URL not set in config.js');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ action }, body)),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error('Server replied ' + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Server took too long');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- sound, speech, vibration ---------------- */
let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /en[-_]IN/i.test(v.lang) && v.localService)
    || vs.find((v) => /en[-_]IN/i.test(v.lang))
    || vs.find((v) => /^en/i.test(v.lang) && v.localService)
    || vs.find((v) => /^en/i.test(v.lang)) || null;
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
  try {
    if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(go, 60); } else { go(); }
  } catch (e) { /* ignore */ }
}
function unlockAudio() {
  try {
    if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (S.audio.state === 'suspended') S.audio.resume();
  } catch (e) { /* ignore */ }
}
function beep(freq, dur, type = 'sine') {
  const a = S.audio;
  if (!a) return;
  try {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = 0.3;
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  } catch (e) { /* ignore */ }
}
function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }
function feedback(kind) {
  if (kind === 'ok') vibrate(80);
  if (kind === 'dup') { beep(880, 0.12); vibrate([40, 40, 40]); }
  if (kind === 'other') vibrate(300);
  if (kind === 'invalid') { beep(150, 0.4, 'square'); vibrate(400); }
}

/* ---------------- screen: login ---------------- */
async function doLogin() {
  const code = $('in-trainer').value.trim().toUpperCase();
  if (!code) return;
  $('login-msg').textContent = 'Checking...';
  try {
    const r = await api('config', { trainer: code });
    if (!r.ok) { $('login-msg').textContent = r.error || 'Not accepted'; return; }
    S.config = { trainer: r.trainer, batches: r.batches, cardKey: r.cardKey, at: Date.now() };
    S.hmacKey = null;
    LS.set('config', S.config);
    showHome();
  } catch (e) {
    $('login-msg').textContent = 'Could not reach server. Check internet and try again. (' + e.message + ')';
  }
}

/* ---------------- screen: home ---------------- */
function showHome() {
  show('scr-home');
  $('home-trainer').textContent = S.config.trainer.name + ' (' + S.config.trainer.code + ')';
  const list = $('batch-list');
  list.innerHTML = '';
  (S.config.batches || []).forEach((b) => {
    const btn = document.createElement('button');
    btn.textContent = b;
    btn.className = 'batch' + (b === S.selectedBatch ? ' sel' : '');
    btn.onclick = () => { S.selectedBatch = b; LS.set('lastBatch', b); showHome(); };
    list.appendChild(btn);
  });
  if (!(S.config.batches || []).includes(S.selectedBatch)) S.selectedBatch = null;
  $('btn-start').disabled = !S.selectedBatch;
  updatePending();
  showDiag();
}
async function refreshBatches() {
  try {
    const r = await api('config', { trainer: S.config.trainer.code }, 15000);
    if (r.ok) {
      S.config = { trainer: r.trainer, batches: r.batches, cardKey: r.cardKey, at: Date.now() };
      S.hmacKey = null;
      LS.set('config', S.config);
      $('sync-msg').textContent = 'Batches updated.';
    } else {
      $('sync-msg').textContent = r.error || 'Not accepted';
    }
  } catch (e) { $('sync-msg').textContent = 'Offline. Using saved batch list.'; }
  showHome();
}
async function changeTrainer() {
  const pending = (await recAll()).length;
  if (pending && !confirm(pending + ' records are not sent yet. They will still be sent later. Change trainer?')) return;
  LS.del('config'); S.config = null; S.hmacKey = null;
  show('scr-login');
}
function showDiag() {
  const scanner = ('BarcodeDetector' in window) ? 'built-in scanner available' : 'fallback scanner';
  const v = voice ? (voice.name + (voice.localService ? ', offline voice' : ', online voice')) : 'no voice found yet';
  $('diag').textContent = 'Version ' + APP_VERSION + ' · ' + scanner + ' · ' + v;
}
async function updatePending() {
  try {
    const all = await recAll();
    $('pending-count').textContent = all.filter((r) => r.ready).length;
  } catch (e) { /* ignore */ }
}

/* ---------------- session ---------------- */
async function startSession() {
  if (!S.selectedBatch) return;
  unlockAudio();
  say(' ');
  const now = Date.now();
  S.session = { id: uid(), batch: S.selectedBatch, date: localDate(now), startTs: now, trainer: S.config.trainer.code, gps: null };
  LS.set('session', S.session);
  getGps();
  const cached = LS.get('roster:' + S.selectedBatch);
  S.roster = cached ? cached.students : [];
  loadRoster(S.selectedBatch);
  await openScan();
}
function getGps() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition((p) => {
    if (!S.session) return;
    S.session.gps = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    LS.set('session', S.session);
  }, () => { /* denied or unavailable: rows will have blank GPS */ }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
}
async function loadRoster(batch) {
  try {
    const r = await api('roster', { trainer: S.config.trainer.code, batch }, 15000);
    if (r.ok) {
      LS.set('roster:' + batch, { students: r.students, at: Date.now() });
      if (S.session && S.session.batch === batch) S.roster = r.students;
    }
  } catch (e) { /* offline: keep cached roster */ }
}

/* ---------------- screen: scan ---------------- */
async function openScan() {
  show('scr-scan');
  $('scan-batch').textContent = 'Batch ' + S.session.batch;
  S.marked = new Map();
  S.recent = [];
  const all = await recAll();
  all.filter((r) => r.sessionId === S.session.id).sort((a, b) => a.ts - b.ts).forEach((r) => {
    S.marked.set(r.cardBatch + '|' + r.roll, r);
    S.recent.push(r);
  });
  if (!S.roster.length) { const c = LS.get('roster:' + S.session.batch); if (c) S.roster = c.students; }
  renderRecent();
  try {
    await startCamera();
  } catch (e) {
    banner('red', 'Camera not available: ' + e.message);
    return;
  }
  banner('', 'Ready · show card');
  requestWake();
  if (!S.scanning) { S.scanning = true; tick(); }
}

async function startCamera() {
  if (S.stream && S.stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
  stopCamera();
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const v = $('video');
  v.srcObject = S.stream;
  await v.play().catch(() => {});
  try {
    const track = S.stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch (e) { /* not supported */ }
  if (!S.detector && 'BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) S.detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (e) { S.detector = null; }
  }
}
function stopCamera() {
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
  $('video').srcObject = null;
  $('video2').srcObject = null;
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
        const codes = await S.detector.detect(v);
        codes.forEach((c) => texts.push(c.rawValue));
        S.detectorErrors = 0;
      } else if (window.jsQR) {
        const w = v.videoWidth; const h = v.videoHeight;
        const scale = Math.min(1, 720 / Math.max(w, h));
        canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (r && r.data) texts.push(r.data);
      }
    } catch (e) {
      if (S.detector && ++S.detectorErrors > 20) S.detector = null; // fall back to jsQR
    }
  }
  for (const t of texts) await onCode(t);
  setTimeout(tick, S.detector ? 100 : 160);
}

async function onCode(text) {
  const now = Date.now();
  if (text === S.lastCode && now - S.lastCodeAt < SAME_CARD_GAP_MS) { S.lastCodeAt = now; return; }
  S.lastCode = text; S.lastCodeAt = now;

  const card = await parseCard(text);
  if (!card) { feedback('invalid'); banner('red', 'Card not valid'); say('card not valid'); return; }
  if (card.batch !== S.session.batch) {
    if (S.marked.has(card.batch + '|' + card.roll)) { feedback('dup'); banner('amber', card.name + ' · already added'); return; }
    feedback('other');
    banner('red', card.name + ' · different batch (' + card.batch + ')', card);
    say('different batch');
    return;
  }
  if (S.marked.has(card.batch + '|' + card.roll)) { feedback('dup'); banner('amber', card.name + ' · already marked'); return; }
  await addRecord({ roll: card.roll, name: card.name, method: 'QR' });
  feedback('ok');
  banner('green', card.name);
  say(card.name);
}

async function addRecord({ roll, name, method, flag = '', photo = null, isNew = false, cardBatch = null }) {
  const ts = Date.now();
  const s = S.session;
  const rec = {
    id: uid(), sessionId: s.id, ts, date: localDate(ts), time: localTime(ts), batch: s.batch, roll, name, method, flag,
    trainer: s.trainer, gps: s.gps, photo, isNew, cardBatch: cardBatch || s.batch, ready: false,
  };
  await recPut(rec);
  S.marked.set(rec.cardBatch + '|' + roll, rec);
  S.recent.push(rec);
  renderRecent();
  return rec;
}

function banner(color, text, otherCard = null) {
  const b = $('banner');
  b.className = color || '';
  $('banner-text').textContent = text;
  const f = $('flash');
  if (color) {
    f.style.background = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' }[color];
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 30);
  }
  clearTimeout(S.otherTimer);
  S.otherCard = otherCard;
  $('btn-add-anyway').classList.toggle('hidden', !otherCard);
  if (otherCard) S.otherTimer = setTimeout(() => { S.otherCard = null; $('btn-add-anyway').classList.add('hidden'); }, OTHER_BATCH_BUTTON_MS);
}

async function addAnyway() {
  const c = S.otherCard;
  if (!c) return;
  S.otherCard = null;
  $('btn-add-anyway').classList.add('hidden');
  await addRecord({ roll: c.roll, name: c.name, method: 'QR', flag: 'other batch: ' + c.batch, cardBatch: c.batch });
  feedback('ok');
  banner('amber', c.name + ' · added, flagged');
  say(c.name);
}

function renderRecent() {
  $('scan-count').textContent = S.marked.size;
  const ul = $('recent');
  ul.innerHTML = '';
  S.recent.slice(-5).reverse().forEach((r) => {
    const li = document.createElement('li');
    const badge = r.flag ? '<span class="badge flag">other batch</span>'
      : (r.method !== 'QR' ? '<span class="badge ' + r.method + '">' + r.method + '</span>' : '');
    li.innerHTML = (r.photo ? '<img alt="" src="' + r.photo + '">' : '') +
      '<span>' + esc(r.name) + ' ' + badge + '</span><span class="meta">' + esc(r.roll) + '<br>' + r.time.slice(0, 5) + '</span>';
    li.onclick = () => removeRecord(r);
    ul.appendChild(li);
  });
  if (!S.recent.length) ul.innerHTML = '<li style="color:#6b7280">Scanned names appear here. Tap one to remove it.</li>';
}

async function removeRecord(r) {
  S.paused = true;
  const ok = confirm('Remove ' + r.name + ' (' + r.roll + ') from this class?');
  S.paused = false;
  if (!ok) return;
  await recDel(r.id);
  S.marked.delete(r.cardBatch + '|' + r.roll);
  S.recent = S.recent.filter((x) => x.id !== r.id);
  S.lastCode = ''; // allow re-scan straight away
  renderRecent();
}

/* ---------------- Add / Mark ---------------- */
function openAdd() {
  S.paused = true;
  $('dlg-add').classList.remove('hidden');
  $('add-search-step').classList.remove('hidden');
  $('add-photo-step').classList.add('hidden');
  $('in-search').value = '';
  renderSearch();
  setTimeout(() => $('in-search').focus(), 60);
}
function closeAdd() {
  $('dlg-add').classList.add('hidden');
  $('video2').srcObject = null;
  S.photoTarget = null;
  S.paused = false;
  S.lastCode = '';
}
function renderSearch() {
  const raw = $('in-search').value.trim();
  const q = raw.toLowerCase();
  const ul = $('search-results');
  ul.innerHTML = '';
  const btnNew = $('btn-add-new');
  if (q.length < 2) {
    btnNew.classList.add('hidden');
    if (!S.roster.length) ul.innerHTML = '<li class="muted">Batch list not downloaded yet. You can still add a student by full name.</li>';
    return;
  }
  const matches = S.roster.filter((s) => {
    const n = s.name.toLowerCase();
    return n.split(/\s+/).some((w) => w.startsWith(q)) || n.includes(q) || String(s.roll).startsWith(q);
  }).slice(0, 8);
  matches.forEach((s) => {
    const li = document.createElement('li');
    const done = S.marked.has(S.session.batch + '|' + s.roll);
    li.textContent = s.name + ' · ' + s.roll + (done ? ' · already marked' : '');
    if (done) li.className = 'muted';
    else li.onclick = () => toPhoto({ roll: String(s.roll), name: s.name, method: 'manual' });
    ul.appendChild(li);
  });
  if (!matches.length && S.roster.length) ul.innerHTML = '<li class="muted">No match in this batch.</li>';
  btnNew.textContent = 'Add new student: ' + titleCase(raw);
  btnNew.classList.remove('hidden');
}
function addNew() {
  const name = titleCase($('in-search').value);
  if (name.length < 2) return;
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  const roll = 'NEW-' + Array.from(a, (b) => B32[b & 31]).join('');
  toPhoto({ roll, name, method: 'new', isNew: true });
}
function toPhoto(t) {
  S.photoTarget = t;
  $('add-search-step').classList.add('hidden');
  $('add-photo-step').classList.remove('hidden');
  $('photo-for').textContent = (t.method === 'new' ? 'New student: ' : '') + t.name + ' · take photo';
  const v2 = $('video2');
  v2.srcObject = S.stream;
  v2.play().catch(() => {});
}
async function takePhoto() {
  const t = S.photoTarget;
  const v = $('video2');
  if (!t || !v.videoWidth) return;
  const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const photo = c.toDataURL('image/jpeg', 0.6);
  await addRecord({ roll: t.roll, name: t.name, method: t.method, photo, isNew: !!t.isNew });
  closeAdd();
  feedback('ok');
  banner('green', t.name + ' · marked (' + t.method + ')');
  say(t.name);
}

/* ---------------- finish and submit ---------------- */
function openFinish() {
  S.paused = true;
  const recs = [...S.marked.values()];
  const n = (m) => recs.filter((r) => r.method === m).length;
  const flagged = recs.filter((r) => r.flag).length;
  $('finish-summary').innerHTML = 'Batch ' + esc(S.session.batch) + '<br>Marked: <b>' + recs.length + '</b><br>' +
    'QR ' + n('QR') + ' · Manual ' + n('manual') + ' · New ' + n('new') + (flagged ? ' · Other batch ' + flagged : '');
  $('dlg-finish').classList.remove('hidden');
}
function closeFinish() { $('dlg-finish').classList.add('hidden'); S.paused = false; }

async function closeSession() {
  const s = S.session;
  if (!s) return;
  const all = await recAll();
  for (const r of all) {
    if (r.sessionId === s.id) {
      r.ready = true;
      if (!r.gps && s.gps) r.gps = s.gps;
      await recPut(r);
    }
  }
  LS.del('session');
  S.session = null;
  S.marked = new Map();
  S.recent = [];
}
async function submitSession() {
  $('dlg-finish').classList.add('hidden');
  S.scanning = false;
  S.paused = false;
  stopCamera();
  releaseWake();
  await closeSession();
  showHome();
  await sync(true);
}

let syncing = false;
async function sync(manual) {
  if (syncing || !S.config) return;
  syncing = true;
  const msg = (t) => { $('sync-msg').textContent = t; };
  try {
    const all = (await recAll()).filter((r) => r.ready);
    if (!all.length) { if (manual) msg('Nothing waiting to send.'); return; }
    if (!navigator.onLine) { msg('Offline. ' + all.length + ' will be sent when online.'); return; }
    msg('Sending ' + all.length + '...');
    const plain = all.filter((r) => !r.photo);
    const withPhoto = all.filter((r) => r.photo);
    const groups = [];
    for (let i = 0; i < plain.length; i += 50) groups.push(plain.slice(i, i + 50));
    withPhoto.forEach((r) => groups.push([r]));
    let sent = 0;
    for (const g of groups) {
      const r = await api('submit', { trainer: S.config.trainer.code, records: g.map(forServer) }, 60000);
      if (!r.ok) throw new Error(r.error || 'Server error');
      for (const id of r.accepted) { await recDel(id); sent++; }
      await updatePending();
    }
    msg('Sent ' + sent + '. All done.');
  } catch (e) {
    msg('Not sent yet (' + e.message + '). Will retry automatically.');
  } finally {
    syncing = false;
    updatePending();
  }
}
function forServer(r) {
  return {
    id: r.id, sessionId: r.sessionId, date: r.date, time: r.time, batch: r.batch, roll: r.roll, name: r.name,
    method: r.method, flag: r.flag, trainer: r.trainer, isNew: r.isNew, photo: r.photo || null,
    lat: r.gps ? r.gps.lat : null, lng: r.gps ? r.gps.lng : null, acc: r.gps ? r.gps.acc : null,
  };
}

/* ---------------- screen wake lock ---------------- */
async function requestWake() {
  try { if ('wakeLock' in navigator && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch (e) { /* ignore */ }
}
function releaseWake() { try { if (S.wake) S.wake.release(); } catch (e) { /* ignore */ } S.wake = null; }

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (S.scanning && S.session) {
    requestWake();
    try { await startCamera(); } catch (e) { banner('red', 'Camera not available: ' + e.message); }
  }
  sync(false);
});

/* ---------------- wire up ---------------- */
$('btn-login').onclick = doLogin;
$('in-trainer').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('btn-start').onclick = startSession;
$('btn-sync').onclick = () => sync(true);
$('btn-refresh').onclick = refreshBatches;
$('btn-change').onclick = changeTrainer;
$('btn-voice').onclick = () => { unlockAudio(); pickVoice(); say('Testing. Asha Kumari. Rahul Verma.'); setTimeout(showDiag, 300); };
$('btn-addmark').onclick = openAdd;
$('btn-add-close').onclick = closeAdd;
$('in-search').addEventListener('input', renderSearch);
$('btn-add-new').onclick = addNew;
$('btn-photo-back').onclick = () => { $('add-photo-step').classList.add('hidden'); $('add-search-step').classList.remove('hidden'); };
$('btn-photo-take').onclick = takePhoto;
$('btn-finish').onclick = openFinish;
$('btn-finish-back').onclick = closeFinish;
$('btn-submit').onclick = submitSession;
$('btn-add-anyway').onclick = addAnyway;
window.addEventListener('online', () => sync(false));
setInterval(() => sync(false), 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async function init() {
  if (!S.config) { show('scr-login'); return; }
  if (S.session && Date.now() - S.session.startTs > OLD_SESSION_MS) {
    await closeSession(); // class left open from an earlier day: send what was scanned
  }
  if (S.session) {
    const c = LS.get('roster:' + S.session.batch);
    S.roster = c ? c.students : [];
    await openScan(); // reopened app: same class continues
    // Browsers allow sound and speech only after a tap on the page.
    banner('amber', 'Class resumed · tap screen once to turn on sound');
    document.addEventListener('pointerdown', () => { unlockAudio(); say('sound on'); banner('', 'Ready · show card'); }, { once: true });
    return;
  }
  showHome();
  sync(false);
})();
