'use strict';
/* Sending saved records to the Sheet. Shared by the page and the service worker (background sending). */
const SENDER = (() => {
  let dbp = null;
  function openDb() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('attendance', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('records', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
      const t = d.transaction('records', mode);
      let out;
      const r = fn(t.objectStore('records'));
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  }
  const all = () => tx('readonly', (st) => st.getAll());
  const del = (id) => tx('readwrite', (st) => st.delete(id));

  async function post(apiUrl, body) {
    if (!/^https:\/\/script\.google\.com\//.test(apiUrl || '')) throw new Error('Server URL not set in config.js');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await fetch(apiUrl, { method: 'POST', body: JSON.stringify(Object.assign({ action: 'submit' }, body)),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal });
      if (!r.ok) throw new Error('Server replied ' + r.status);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Server error');
      for (const id of j.accepted) await del(id);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Server took too long');
      throw e;
    } finally { clearTimeout(t); }
  }
  const gps = (g, suffix = '') => { const o = {}; o['lat' + suffix] = g ? g.lat : null; o['lng' + suffix] = g ? g.lng : null; return o; };
  const scanOut = (r) => ({ id: r.id, sessionId: r.sessionId, date: r.date, time: r.time, batch: r.batch, studentId: r.studentId, name: r.name,
    method: r.method, flag: r.flag, trainer: r.trainer, photo: r.photo || null, snapshot: r.snapshot || null });
  const sessionOut = (r) => Object.assign({ id: r.id, date: r.date, trainer: r.trainer, batch: r.batch, batchSize: r.batchSize, present: r.present,
    absent: r.absent, manual: r.manual, newc: r.newc, other: r.other, notReg: r.notReg, classStart: r.classStart, photoTime: r.photoTime,
    photo: r.photo || null, attendanceStart: r.attendanceStart, attendanceEnd: r.attendanceEnd, fastScans: r.fastScans,
    comment: r.comment || '', substitute: !!r.substitute }, gps(r.gps), gps(r.gpsEnd, 'End'));

  // Items saved by an older app version that the current backend no longer takes: remove so they do not wait forever
  async function cleanOld() {
    const old = (await all()).filter((r) => !['scan', 'session', 'classphoto'].includes(r.kind) || (r.kind === 'scan' && !r.studentId) ||
      (r.kind === 'session' && r.classStart === undefined));
    for (const r of old) await del(r.id);
    return old.length;
  }

  // Sends everything that is ready: one request per class (its student rows, photos and class details together).
  // Only one sender runs at a time (page or background). onProgress(classesLeft). Throws if a send fails (caller retries).
  const MAX_BYTES = 5000000; // a very large class is split into parts below this size
  const size = (r) => 600 + String(r.photo || '').length + String(r.snapshot || '').length;
  async function sendClasses(apiUrl, onProgress) {
    const ready = (await all()).filter((r) => r.ready);
    const sessions = ready.filter((r) => r.kind === 'session');
    const report = (n) => { if (onProgress) onProgress(n); };
    let left = sessions.length;
    report(left);
    for (const s of sessions) {
      const rows = ready.filter((r) => r.kind === 'scan' && r.sessionId === s.id).sort((a, b) => a.ts - b.ts);
      const parts = [[]];
      let bytes = size(s);
      for (const r of rows) {
        if (bytes + size(r) > MAX_BYTES && parts[parts.length - 1].length) { parts.push([]); bytes = 0; }
        parts[parts.length - 1].push(r); bytes += size(r);
      }
      for (let i = 0; i < parts.length; i++) {
        const body = { trainer: s.trainer, records: parts[i].map(scanOut) };
        if (i === parts.length - 1) body.sessions = [sessionOut(s)];
        await post(apiUrl, body);
      }
      report(--left);
    }
    return (await all()).filter((r) => r.ready).length;
  }
  async function sendAll(apiUrl, onProgress) {
    const locks = self.navigator && self.navigator.locks;
    if (!locks) return sendClasses(apiUrl, onProgress);
    return locks.request('attendance-send', { ifAvailable: true }, async (lock) => {
      if (!lock) return (await all()).filter((r) => r.ready).length; // another sender is already at work
      return sendClasses(apiUrl, onProgress);
    });
  }

  return { sendAll, cleanOld };
})();
