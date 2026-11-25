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
    const t = setTimeout(() => ctl.abort(), 60000);
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
    photo: r.photo || null, attendanceStart: r.attendanceStart, attendanceEnd: r.attendanceEnd, fastScans: r.fastScans }, gps(r.gps), gps(r.gpsEnd, 'End'));

  // Items saved by an older app version that the current backend no longer takes: remove so they do not wait forever
  async function cleanOld() {
    const old = (await all()).filter((r) => !['scan', 'session', 'classphoto'].includes(r.kind) || (r.kind === 'scan' && !r.studentId));
    for (const r of old) await del(r.id);
    return old.length;
  }

  // Sends everything that is ready. onProgress(left) is called as items go. Throws if a send fails (caller retries later).
  async function sendAll(apiUrl, onProgress) {
    const count = async () => (await all()).filter((r) => r.ready).length;
    const report = async () => { if (onProgress) onProgress(await count()); };
    await report();
    const ready = (await all()).filter((r) => r.ready);
    // student rows in time order; rows with images one per request, the rest up to 50 per request (grouped by trainer)
    const scans = ready.filter((r) => r.kind === 'scan').sort((a, b) => a.ts - b.ts);
    let group = [];
    const flush = async () => {
      if (!group.length) return;
      await post(apiUrl, { trainer: group[0].trainer, records: group.map(scanOut) });
      group = [];
      await report();
    };
    for (const r of scans) {
      if (group.length && group[0].trainer !== r.trainer) await flush();
      if (r.photo || r.snapshot) { await flush(); await post(apiUrl, { trainer: r.trainer, records: [scanOut(r)] }); await report(); }
      else { group.push(r); if (group.length >= 50) await flush(); }
    }
    await flush();
    // a class goes only after all its student rows are in; one class per request (it carries the class photo)
    const left = await all();
    for (const s of left.filter((x) => x.kind === 'session' && x.ready)) {
      if (left.some((x) => x.kind === 'scan' && x.sessionId === s.id && x.ready)) continue;
      await post(apiUrl, { trainer: s.trainer, sessions: [sessionOut(s)] });
      await report();
    }
    return count();
  }

  return { sendAll, cleanOld };
})();
