'use strict';
/* Student attendance (demo v0.2): trainer page. */

const APP_VERSION = '0.2.1';
const API_URL = (window.APP_CONFIG || {}).API_URL || '';
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAME_CARD_GAP_MS = 2500;   // a card kept in view is ignored until it has been out of view this long
const OLD_SESSION_MS = 12 * 3600 * 1000;
const ADMIN_HOLD_MS = 3000;

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
  marked: new Map(),   // "cardBatch|roll" -> scan record
  recent: [],
  stream: null, photoStream: null,
  detector: null, detectorErrors: 0,
  scanning: false, paused: false,
  lastCode: '', lastCodeAt: 0,
  audio: null, wake: null, hmacKey: null,
  ignorePop: 0, punching: false,
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
function setting(name, dflt) { const v = ((S.config || {}).settings || {})[name]; return v === undefined || v === '' ? dflt : v; }
function batchInfo(code) { return ((S.config || {}).batches || []).find((b) => b.code === code) || null; }
function labelOf(code) { const b = batchInfo(code); return (b && b.label) || ((S.config || {}).labels || {})[code] || code; }
function roster(code) { return (((S.config || {}).rosters || {})[code]) || []; }

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
  S.config = { trainer: r.trainer, batches: r.batches, labels: r.labels, rosters: r.rosters, settings: r.settings, cardKey: r.cardKey, at: Date.now() };
  S.hmacKey = null;
  LS.set('config', S.config);
}

/* ---------------- sound, speech, vibration ---------------- */
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
  if (!vs.length) return; // voices still loading
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
function unlockAudio() {
  try { if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)(); if (S.audio.state === 'suspended') S.audio.resume(); } catch (e) { /* ignore */ }
}
function beep(freq, dur, type = 'sine') {
  const a = S.audio;
  if (!a) return;
  try {
    const o = a.createOscillator(); const g = a.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = 0.3;
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur);
  } catch (e) { /* ignore */ }
}
function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }
function feedback(kind) {
  if (kind === 'ok') vibrate(80);
  if (kind === 'dup') { beep(880, 0.12); vibrate([40, 40, 40]); }
  if (kind === 'other') { beep(660, 0.15); vibrate([120, 60, 120]); }
  if (kind === 'invalid') { beep(150, 0.4, 'square'); vibrate(400); }
}

/* ---------------- location ---------------- */
function getPosition(timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => resolve(null), { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 });
  });
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
    if (r.ok) { saveConfig(r); if (!quiet) $('admin-msg').textContent = 'Batches updated.'; if (!$('scr-home').classList.contains('hidden')) showHome(); }
    else if (!quiet) $('admin-msg').textContent = r.error || 'Not accepted';
  } catch (e) { if (!quiet) $('admin-msg').textContent = 'Offline. Using saved batch list.'; }
}

/* ---------------- home ---------------- */
function showHome() {
  show('scr-home');
  const t = S.config.trainer;
  $('home-name').textContent = t.name + ' (' + t.code + ')';
  const list = $('batch-list');
  list.innerHTML = '';
  (S.config.batches || []).forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'batch';
    btn.innerHTML = '<b>' + esc(b.label) + '</b><span>' + esc(b.code) + ' · ' + esc(b.course) + '</span>';
    btn.onclick = () => startSession(b.code);
    list.appendChild(btn);
  });
  if (!(S.config.batches || []).length) list.innerHTML = '<p class="small">No batches assigned. Ask admin.</p>';
  const lp = LS.get('lastPunch');
  $('punch-status').textContent = lp && localDate(lp.ts) === localDate(Date.now()) ? 'Marked ' + lp.time.slice(0, 5) : '';
  updatePending();
  updateVoiceWarn();
}
async function updatePending() {
  try {
    const n = (await recAll()).filter((r) => r.ready).length;
    $('pending-line').textContent = n + ' item' + (n === 1 ? '' : 's') + ' waiting to send. ' + (navigator.onLine ? 'Sending automatically.' : 'Will send when online.');
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
async function changeTrainer() {
  const pending = (await recAll()).filter((r) => r.ready).length;
  if (!confirm((pending ? pending + ' items are not sent yet. They will still be sent later. ' : '') + 'Change trainer on this phone?')) return;
  LS.del('config'); S.config = null; S.hmacKey = null;
  dropAllLayers();
  $('dlg-admin').classList.add('hidden');
  $('in-trainer').value = ''; $('login-msg').textContent = '';
  show('scr-login');
}

/* ---------------- own attendance (punch) ---------------- */
async function doPunch() {
  if (S.punching) return;
  S.punching = true;
  unlockAudio();
  if (setting('Selfie on punch', 'N').toUpperCase() === 'Y') {
    try {
      S.photoStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } });
    } catch (e) { S.punching = false; $('punch-status').textContent = 'Camera not available'; return; }
    openPhoto({ title: 'Selfie', stream: S.photoStream, onTaken: (img) => { popLayers(1); finishPunch(img); },
      onClose: () => { stopPhotoStream(); if (S.punching && !S.selfieTaken) S.punching = false; S.selfieTaken = false; } });
    return;
  }
  finishPunch(null);
}
async function finishPunch(selfie) {
  S.selfieTaken = !!selfie;
  $('punch-status').textContent = 'Getting location...';
  const gps = await getPosition(15000);
  const ts = Date.now();
  const rec = { id: uid(), kind: 'punch', ready: true, ts, date: localDate(ts), time: localTime(ts), trainer: S.config.trainer.code, gps, selfie };
  await recPut(rec);
  LS.set('lastPunch', { ts, time: rec.time });
  $('punch-status').textContent = 'Marked ' + rec.time.slice(0, 5) + (gps ? '' : ' · no location');
  say('Attendance marked');
  vibrate(80);
  S.punching = false;
  updatePending();
  sync(false);
}

/* ---------------- class session ---------------- */
async function startSession(batch) {
  unlockAudio();
  say(' ');
  const now = Date.now();
  S.session = { id: uid(), batch, date: localDate(now), startTs: now, trainer: S.config.trainer.code, gps: null, gpsEnd: null,
    fastScans: 0, lastQrTs: 0 };
  LS.set('session', S.session);
  getPosition(20000).then((g) => { if (g && S.session && !S.session.gps) { S.session.gps = g; LS.set('session', S.session); } });
  await openScan();
}
async function openScan() {
  show('scr-scan');
  pushLayer('scan', backFromScan);
  $('scan-label').textContent = labelOf(S.session.batch);
  S.marked = new Map();
  S.recent = [];
  (await recAll()).filter((r) => r.kind === 'scan' && r.sessionId === S.session.id).sort((a, b) => a.ts - b.ts)
    .forEach((r) => { S.marked.set(r.cardBatch + '|' + r.roll, r); S.recent.push(r); });
  renderList();
  try { await startCamera(); } catch (e) { banner('red', 'Camera not available: ' + e.message); return; }
  banner('', 'Ready · show card');
  requestWake();
  if (!S.scanning) { S.scanning = true; tick(); }
}
function backFromScan() {
  if (S.marked.size === 0) { // nothing scanned: leave without saving a class
    S.scanning = false; stopCamera(); releaseWake();
    LS.del('session'); S.session = null;
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
function stopPhotoStream() {
  if (S.photoStream) { S.photoStream.getTracks().forEach((t) => t.stop()); S.photoStream = null; }
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
  const now = Date.now();
  if (text === S.lastCode && now - S.lastCodeAt < SAME_CARD_GAP_MS) { S.lastCodeAt = now; return; }
  S.lastCode = text; S.lastCodeAt = now;
  const card = await parseCard(text);
  if (!card) { feedback('invalid'); banner('red', 'Card not valid'); say('card not valid'); return; }
  const key = card.batch + '|' + card.roll;
  if (S.marked.has(key)) { feedback('dup'); banner('amber', card.name + ' · already marked'); return; }
  const other = card.batch !== S.session.batch;
  // fast-scan check: two different cards read faster than a student can walk up
  const gapMs = Number(setting('Fast scan gap (seconds)', '1')) * 1000;
  if (S.session.lastQrTs && now - S.session.lastQrTs < gapMs) S.session.fastScans++;
  S.session.lastQrTs = now;
  LS.set('session', S.session);
  const n = Math.max(1, Number(setting('Snapshot every Nth scan', '10')) || 10);
  const snapshot = Math.random() < 1 / n ? frameJpeg($('video'), 480, 0.5) : null;
  // genuine card but not on the downloaded batch list (added after last update, or marked left): accept, flag for admin
  const list = roster(card.batch);
  const unlisted = !other && list.length && !list.some((st) => String(st.roll) === String(card.roll));
  await addRecord({ roll: card.roll, name: card.name, method: 'QR',
    flag: other ? 'other batch: ' + card.batch : (unlisted ? 'not on batch list' : ''), cardBatch: card.batch, snapshot });
  if (other) {
    feedback('other');
    banner('amber', card.name + ' · other batch (' + labelOf(card.batch) + ')');
    say(card.name + ', other batch');
  } else {
    feedback('ok');
    banner('green', card.name);
    say(card.name);
  }
}

async function addRecord({ roll, name, method, flag = '', photo = null, snapshot = null, isNew = false, cardBatch = null }) {
  const ts = Date.now();
  const s = S.session;
  const rec = { id: uid(), kind: 'scan', sessionId: s.id, ts, date: localDate(ts), time: localTime(ts), batch: s.batch, roll, name, method,
    flag, trainer: s.trainer, gps: s.gps, photo, snapshot, isNew, cardBatch: cardBatch || s.batch, ready: false };
  await recPut(rec);
  S.marked.set(rec.cardBatch + '|' + roll, rec);
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
  if (String(r.flag || '').indexOf('other batch') === 0) return '<span class="badge flag">other batch</span>';
  if (r.flag) return '<span class="badge flag">not on list</span>';
  if (r.method !== 'QR') return '<span class="badge ' + r.method + '">' + (r.method === 'manual' ? 'no card' : 'new') + '</span>';
  return '';
}
function rowHtml(r) {
  return (r.photo ? '<img alt="" src="' + r.photo + '">' : '') + '<span class="name">' + esc(r.name) + badgeFor(r) + '</span>' +
    '<span class="meta">' + esc(r.roll) + '<br>' + r.time.slice(0, 5) + '</span><button class="x" aria-label="Remove">✕</button>';
}
function renderList() {
  $('scan-count').textContent = S.marked.size;
  const ul = $('recent');
  ul.innerHTML = '';
  if (!S.recent.length) { ul.innerHTML = '<li class="empty">Names appear here as cards are scanned.</li>'; return; }
  S.recent.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = rowHtml(r);
    li.querySelector('.x').onclick = () => removeRecord(r);
    ul.appendChild(li);
  });
  ul.scrollTop = ul.scrollHeight;
}
async function removeRecord(r, after) {
  const wasPaused = S.paused;
  S.paused = true;
  const ok = confirm('Remove ' + r.name + ' (' + r.roll + ')?');
  S.paused = wasPaused;
  if (!ok) return;
  await recDel(r.id);
  S.marked.delete(r.cardBatch + '|' + r.roll);
  S.recent = S.recent.filter((x) => x.id !== r.id);
  S.lastCode = '';
  renderList();
  if (after) after();
}

/* ---------------- photo dialog (no card, absent student, selfie) ---------------- */
let photoOpts = null;
function openPhoto(opts) {
  photoOpts = opts;
  $('photo-title').textContent = opts.title;
  const v = $('video-photo');
  v.srcObject = opts.stream || S.stream;
  v.play().catch(() => {});
  $('dlg-photo').classList.remove('hidden');
  pushLayer('photo', () => {
    $('dlg-photo').classList.add('hidden');
    $('video-photo').srcObject = null;
    const o = photoOpts; photoOpts = null;
    if (o && o.onClose) o.onClose();
  });
}
$('btn-photo-take').onclick = async () => {
  if (!photoOpts) return;
  const img = frameJpeg($('video-photo'), 640, 0.6);
  if (!img) return;
  const o = photoOpts;
  await o.onTaken(img);
};

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
  const list = roster(S.session.batch);
  const matches = list.filter((s) => {
    const n = s.name.toLowerCase();
    return n.split(/\s+/).some((w) => w.startsWith(q)) || n.includes(q) || String(s.roll).startsWith(q);
  }).slice(0, 8);
  matches.forEach((s) => {
    const li = document.createElement('li');
    const done = S.marked.has(S.session.batch + '|' + s.roll);
    li.textContent = s.name + ' · ' + s.roll + (done ? ' · already marked' : '');
    if (done) li.className = 'empty';
    else { li.className = 'tap'; li.onclick = () => photoForManual({ roll: String(s.roll), name: s.name, method: 'manual' }, 2); }
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
  photoForManual({ roll: 'NEW-' + Array.from(a, (b) => B32[b & 31]).join(''), name, method: 'new', isNew: true }, 2);
}
// layersToClose: 2 from No card (photo + search), 1 from the summary's absent list (photo only)
function photoForManual(t, layersToClose, after) {
  openPhoto({
    title: (t.method === 'new' ? 'New student: ' : 'Photo of ') + t.name,
    onTaken: async (img) => {
      await addRecord({ roll: t.roll, name: t.name, method: t.method, photo: img, isNew: !!t.isNew });
      popLayers(layersToClose);
      feedback('ok');
      banner('green', t.name + ' · marked (' + (t.method === 'new' ? 'new' : 'no card') + ')');
      say(t.name);
      if (after) setTimeout(after, 50);
    },
  });
}

/* ---------------- Finish: summary with present / absent lists ---------------- */
function counts() {
  const recs = [...S.marked.values()];
  const isOther = (r) => String(r.flag || '').indexOf('other batch') === 0;
  const inBatch = recs.filter((r) => !isOther(r));
  const list = roster(S.session.batch);
  const rolls = new Set(inBatch.map((r) => String(r.roll)));
  return {
    present: inBatch, other: recs.filter(isOther),
    absent: list.filter((s) => !rolls.has(String(s.roll))),
    manual: recs.filter((r) => r.method === 'manual').length, newc: recs.filter((r) => r.method === 'new').length,
    batchSize: list.length,
  };
}
function openSummary() {
  S.paused = true;
  getPosition(15000).then((g) => { if (g && S.session) { S.session.gpsEnd = g; LS.set('session', S.session); } });
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
  if (c.other.length) extra.push('Other batch ' + c.other.length + ' (' + c.other.map((r) => r.name).join(', ') + ')');
  if (!c.batchSize) extra.push('Batch list not downloaded, absent count not available');
  $('sum-extra').textContent = extra.join(' · ');
}
function showSumList(which) {
  const c = counts();
  const ul = $('sum-list');
  ul.innerHTML = '';
  S.sumList = which;
  if (which === 'present') {
    $('sum-list-title').textContent = 'Present (' + c.present.length + ') · tap ✕ to remove';
    c.present.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = rowHtml(r);
      li.querySelector('.x').onclick = () => removeRecord(r, () => { renderSummary(); showSumList('present'); });
      ul.appendChild(li);
    });
  } else {
    $('sum-list-title').textContent = 'Absent (' + c.absent.length + ') · tap a name to mark present';
    c.absent.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((s) => {
      const li = document.createElement('li');
      li.className = 'tap';
      li.innerHTML = '<span class="name">' + esc(s.name) + '</span><span class="meta">' + esc(s.roll) + '</span>';
      li.onclick = () => photoForManual({ roll: String(s.roll), name: s.name, method: 'manual' }, 1,
        () => { renderSummary(); showSumList('absent'); });
      ul.appendChild(li);
    });
    if (!c.absent.length) ul.innerHTML = '<li class="empty">No one absent.</li>';
  }
}
async function submitSession() {
  const s = S.session;
  const c = counts();
  const now = Date.now();
  S.scanning = false;
  stopCamera();
  releaseWake();
  dropAllLayers();
  $('dlg-summary').classList.add('hidden');
  S.paused = false;
  const all = await recAll();
  for (const r of all) {
    if (r.kind === 'scan' && r.sessionId === s.id) { r.ready = true; if (!r.gps && s.gps) r.gps = s.gps; await recPut(r); }
  }
  // class start: trainer's own attendance marked that day before attendance began; else first app open that day
  const lp = LS.get('lastPunch');
  const fo = LS.get('firstOpen');
  let classStart = '', classStartSource = '';
  if (lp && localDate(lp.ts) === s.date && lp.ts <= s.startTs) { classStart = lp.time; classStartSource = 'own attendance'; }
  else if (fo && fo.date === s.date) { classStart = fo.time; classStartSource = 'app opened'; }
  await recPut({ id: s.id, kind: 'session', ready: true, date: s.date, trainer: s.trainer, batch: s.batch, batchSize: c.batchSize,
    present: c.present.length, absent: c.absent.length, manual: c.manual, newc: c.newc, other: c.other.length,
    classStart, classStartSource, start: localTime(s.startTs), finish: localTime(now), gps: s.gps, gpsEnd: s.gpsEnd, fastScans: s.fastScans });
  LS.del('session');
  S.session = null; S.marked = new Map(); S.recent = [];
  showHome();
  sync(false);
}

/* ---------------- sending ---------------- */
let syncing = false;
function gpsFields(g, suffix = '') {
  const o = {};
  o['lat' + suffix] = g ? g.lat : null; o['lng' + suffix] = g ? g.lng : null; o['acc' + suffix] = g ? g.acc : null;
  return o;
}
function scanForServer(r) {
  return Object.assign({ id: r.id, sessionId: r.sessionId, date: r.date, time: r.time, batch: r.batch, cardBatch: r.cardBatch, roll: r.roll,
    name: r.name, method: r.method, flag: r.flag, trainer: r.trainer, isNew: r.isNew, photo: r.photo || null, snapshot: r.snapshot || null }, gpsFields(r.gps));
}
function sessionForServer(r) {
  return Object.assign({ id: r.id, date: r.date, trainer: r.trainer, batch: r.batch, batchSize: r.batchSize, present: r.present, absent: r.absent,
    manual: r.manual, newc: r.newc, other: r.other, classStart: r.classStart, classStartSource: r.classStartSource,
    start: r.start, finish: r.finish, fastScans: r.fastScans }, gpsFields(r.gps), gpsFields(r.gpsEnd, 'End'));
}
function punchForServer(r) {
  return Object.assign({ id: r.id, date: r.date, time: r.time, trainer: r.trainer, selfie: r.selfie || null }, gpsFields(r.gps));
}
async function send(body) {
  const r = await api('submit', Object.assign({ trainer: S.config.trainer.code }, body), 60000);
  if (!r.ok) throw new Error(r.error || 'Server error');
  for (const id of r.accepted) await recDel(id);
}
async function sync(manual) {
  if (syncing || !S.config) return;
  syncing = true;
  const msg = (t) => { if (manual) $('admin-msg').textContent = t; };
  try {
    let ready = (await recAll()).filter((r) => r.ready);
    if (!ready.length) { msg('Nothing waiting to send.'); return; }
    if (!navigator.onLine) { msg('Offline. Will send when online.'); return; }
    msg('Sending...');
    // scans in time order; rows with images go one per request, the rest up to 50 per request
    const scans = ready.filter((r) => r.kind === 'scan').sort((a, b) => a.ts - b.ts);
    let group = [];
    const flush = async () => { if (group.length) { await send({ records: group.map(scanForServer) }); group = []; } };
    for (const r of scans) {
      if (r.photo || r.snapshot) { await flush(); await send({ records: [scanForServer(r)] }); }
      else { group.push(r); if (group.length >= 50) await flush(); }
    }
    await flush();
    // class summaries go only after all of that class's scans are in
    const left = await recAll();
    const sessions = left.filter((r) => r.kind === 'session' && r.ready && !left.some((x) => x.kind === 'scan' && x.sessionId === r.id && x.ready));
    if (sessions.length) await send({ sessions: sessions.map(sessionForServer) });
    const punches = left.filter((r) => r.kind === 'punch' && r.ready);
    const plainP = punches.filter((r) => !r.selfie);
    if (plainP.length) await send({ punches: plainP.map(punchForServer) });
    for (const p of punches.filter((r) => r.selfie)) await send({ punches: [punchForServer(p)] });
    msg('All sent.');
  } catch (e) {
    msg('Not sent yet (' + e.message + '). Will retry automatically.');
  } finally {
    syncing = false;
    updatePending();
  }
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
$('btn-login').onclick = () => doLogin($('in-trainer').value);
$('in-trainer').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin($('in-trainer').value); });
$('btn-punch').onclick = doPunch;
$('btn-resume').onclick = () => { unlockAudio(); say(' '); openScan(); };
$('btn-nocard').onclick = openNoCard;
$('in-search').addEventListener('input', renderSearch);
$('btn-add-new').onclick = addNew;
$('btn-finish').onclick = openSummary;
$('tile-present').onclick = () => showSumList('present');
$('tile-absent').onclick = () => showSumList('absent');
$('btn-sum-back').onclick = () => popLayers(1);
$('btn-submit').onclick = submitSession;
$('btn-a-sync').onclick = () => sync(true);
$('btn-a-voice').onclick = () => { unlockAudio(); pickVoice(); say('Testing. Asha Kumari. Rahul Verma.'); };
$('btn-a-refresh').onclick = () => refreshConfig(false);
$('btn-a-change').onclick = changeTrainer;
window.addEventListener('online', () => { sync(false); refreshConfig(true); });
window.addEventListener('offline', updatePending);
setInterval(() => sync(false), 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async function init() {
  // first time the app is opened each day (used as class start when own attendance is not marked)
  const fo = LS.get('firstOpen');
  if (!fo || fo.date !== localDate(Date.now())) LS.set('firstOpen', { date: localDate(Date.now()), time: localTime(Date.now()) });
  // each trainer can be sent a personal link ending in ?t=CODE, so nothing has to be typed
  const linkCode = new URLSearchParams(location.search).get('t');
  if (linkCode) history.replaceState(null, '', location.pathname);
  if (linkCode && (!S.config || S.config.trainer.code !== linkCode.trim().toUpperCase())) {
    if (S.config && S.session) { /* keep the open class; ignore link until it is finished */ }
    else { await doLogin(linkCode); return; }
  }
  if (!S.config) { show('scr-login'); return; }
  if (S.session && Date.now() - S.session.startTs > OLD_SESSION_MS) {
    // class left open from an earlier day: submit what was scanned
    const s = S.session;
    S.marked = new Map();
    (await recAll()).filter((r) => r.kind === 'scan' && r.sessionId === s.id).forEach((r) => S.marked.set(r.cardBatch + '|' + r.roll, r));
    await submitSession();
    return;
  }
  if (S.session) {
    show('scr-resume');
    $('btn-resume').textContent = 'Continue class ' + labelOf(S.session.batch);
    return;
  }
  showHome();
  refreshConfig(true);
  sync(false);
})();
