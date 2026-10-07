// node test-core.js — checks the attendance core without n8n: SHA-256, check-in/out, face and place checks,
// wages only for the owner, day seals, and that any edit / delete in the stored rows is reported.
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const KAtt = new Function(fs.readFileSync(path.join(__dirname, 'att-core.js'), 'utf8') + '\nreturn KAtt;')();
for (const s of ['', 'abc', 'Khair Mart — عربي ✓', 'x'.repeat(1000)]) assert.strictEqual(KAtt.sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));

// a tiny in-memory "n8n": tables with ids, settings rows, the same mapping as process-att.js
const T = { workers: [], records: [], seals: [], settings: [] }; let nextId = 1;
const settings = () => { const o = {}; T.settings.forEach(r => { o[r.skey] = JSON.parse(r.svalue); }); return o; };
function call(action, data, who, at) {
  const st = settings();
  const res = KAtt.core({ action, data, me: who, now: new Date(at), settings: st, store: { lat: -6.27, lng: 106.86 }, workers: T.workers.map(w => Object.assign({}, w)),
    records: T.records.map(r => Object.assign({}, r)), seals: T.seals.map(r => Object.assign({}, r)), head: st.att_head || null });
  res.ops.workers.forEach(w => { const o = Object.assign({}, w); const id = o._id; delete o._id; if (id === -1 || id === undefined) { o.id = nextId++; T.workers.push(o); } else Object.assign(T.workers.find(x => x.id === id), o); });
  res.ops.records.forEach(r => { const o = Object.assign({}, r); delete o._id; o.id = nextId++; T.records.push(o); });
  res.ops.seals.forEach(r => { const o = Object.assign({}, r); delete o._id; o.id = nextId++; T.seals.push(o); });
  res.ops.settings.forEach(x => { const ex = T.settings.find(r => r.skey === x.skey); if (ex) ex.svalue = x.svalue; else T.settings.push({ skey: x.skey, svalue: x.svalue }); });
  return res.response;
}
const OWNER = { name: 'zied salah', role: 'owner' }, MGR = { name: 'Jihan', role: 'manager' }, KASIR = { name: 'Emma', role: 'kasir' }, SALES = { name: 'Wahyu', role: 'sales' };
// seeded random faces: two different people are ~0.9 apart (like real face-api descriptors), one person ~0.2 between photos
const face = seed => { let x = seed * 2654435761 >>> 0; return Array.from({ length: 128 }, () => { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; return ((x % 2000) / 1000 - 1) * 0.1; }); };
const near = (f, d) => f.map((x, i) => x + (i % 2 ? d : -d) / Math.sqrt(128));
const SHOP = { lat: -6.2701, lng: 106.8601 };
const D1 = '2026-10-07T01:05:00Z'; // 08:05 WIB

let r = call('worker_save', { name: 'Budi', job: 'Kuli angkut', daily_wage: 120000 }, MGR, D1);
assert.strictEqual(r.error, 'FORBIDDEN'); // the manager may not set wages
r = call('worker_save', { name: 'Budi', job: 'Kuli angkut', phone: '0812 1111 2222' }, MGR, D1); assert(r.ok);
const budi = r.worker.worker_id;
assert.strictEqual(r.worker.daily_wage, undefined);
r = call('worker_save', { worker_id: budi, name: 'Budi', daily_wage: 120000 }, OWNER, D1); assert(r.ok && r.worker.daily_wage === 120000);
r = call('worker_save', { name: 'Siti Aminah', job: 'Gudang' }, OWNER, D1); const siti = r.worker.worker_id;
assert.strictEqual(call('worker_save', { name: 'budi' }, OWNER, D1).error, 'INVALID'); // duplicate name
assert.strictEqual(call('worker_save', { name: 'Budi<script>' }, OWNER, D1).error, 'INVALID');

assert.strictEqual(call('worker_enroll', { worker_id: budi, descriptor: face(1) }, OWNER, D1).error, 'CONSENT_REQUIRED');
assert.strictEqual(call('worker_enroll', { worker_id: budi, descriptor: [1, 2], consent: true }, OWNER, D1).error, 'INVALID');
assert(call('worker_enroll', { worker_id: budi, descriptor: face(1), consent: true }, MGR, D1).ok);
assert.strictEqual(call('worker_enroll', { worker_id: siti, descriptor: near(face(1), 0.1), consent: true }, OWNER, D1).error, 'FACE_TAKEN');
assert(call('worker_enroll', { worker_id: siti, descriptor: face(2), consent: true }, OWNER, D1).ok);
assert.strictEqual(call('att_mark', { worker_id: budi, descriptor: face(1), loc: SHOP }, SALES, D1).error, 'FORBIDDEN');

// Budi: in 08:05 (on time with 10 min grace? 08:05 ≤ 08:10 → yes), wrong face, outside, out 17:00
r = call('att_mark', { worker_id: budi, descriptor: near(face(1), 0.2), loc: SHOP, device: { id: 'DEV1' }, client_id: 'c1' }, KASIR, D1);
assert(r.ok && r.record.kind === 'in' && r.record.late_min === 0, JSON.stringify(r));
r = call('att_mark', { worker_id: budi, descriptor: near(face(1), 0.2), loc: SHOP, client_id: 'c1' }, KASIR, D1); assert(r.duplicate); // same client_id
r = call('att_mark', { worker_id: budi, descriptor: face(1), loc: SHOP }, KASIR, '2026-10-07T01:06:00Z'); assert(r.duplicate && r.record.kind === 'in'); // double tap
r = call('att_mark', { worker_id: budi, descriptor: face(2), loc: SHOP }, KASIR, '2026-10-07T03:00:00Z'); assert.strictEqual(r.error, 'FACE_MISMATCH');
r = call('att_mark', { worker_id: budi, descriptor: face(1), loc: { lat: -6.30, lng: 106.86 } }, KASIR, '2026-10-07T03:00:00Z'); assert.strictEqual(r.error, 'OUTSIDE');
r = call('att_mark', { worker_id: budi, descriptor: face(1) }, KASIR, '2026-10-07T03:00:00Z'); assert.strictEqual(r.error, 'LOCATION_REQUIRED');
r = call('att_mark', { worker_id: budi, descriptor: face(1), loc: SHOP }, KASIR, '2026-10-07T10:00:00Z'); assert(r.ok && r.record.kind === 'out');
// Siti: in 08:40 → 30 min late
r = call('att_mark', { worker_id: siti, descriptor: face(2), loc: SHOP }, KASIR, '2026-10-07T01:40:00Z'); assert(r.ok && r.record.late_min === 30, JSON.stringify(r));
// next day: Budi only; this write seals 7 Oct
r = call('att_mark', { worker_id: budi, descriptor: face(1), loc: SHOP }, KASIR, '2026-10-08T00:55:00Z'); assert(r.ok && r.record.kind === 'in');
assert.strictEqual(T.seals.length, 1); assert.strictEqual(T.seals[0].period, '2026-10-07');
assert.strictEqual(T.seals[0].count, T.records.filter(x => x.att_date === '2026-10-07').length);

// season: two months before Ramadan the shop closes at 23:00
r = call('att_settings', { settings: { att_seasons: [{ name: 'Menjelang Ramadan', from: '2026-12-08', to: '2027-03-09', work_end: '23:00' }] } }, OWNER, '2026-10-08T02:00:00Z'); assert(r.ok);
assert.strictEqual(call('att_settings', { settings: { att_work_start: '8:00' } }, OWNER, D1).error, 'INVALID');
assert.strictEqual(call('att_settings', { settings: { att_grace_min: 5 } }, MGR, D1).error, 'FORBIDDEN');
assert.strictEqual(KAtt.hoursOn(settings(), '2027-01-10').end, '23:00');
assert.strictEqual(KAtt.hoursOn(settings(), '2026-10-10').end, '21:00');

// report: owner sees wages, manager does not; chain intact
let rep = call('att_report', { from: '2026-10-07', to: '2026-10-08' }, OWNER, '2026-10-08T03:00:00Z');
assert(rep.ok && rep.verify.ok, JSON.stringify(rep.verify));
const tb = rep.totals.find(x => x.worker_id === budi), ts = rep.totals.find(x => x.worker_id === siti);
assert.strictEqual(tb.present, 2); assert.strictEqual(tb.wage_due, 240000); assert.strictEqual(tb.fails, 3);
assert.strictEqual(ts.present, 1); assert.strictEqual(ts.absent, 0); assert.strictEqual(ts.late_days, 1); // 8 Oct is today: not arrived yet, not absent
assert.strictEqual(rep.rows.find(x => x.worker_id === siti && x.date === '2026-10-08').status, 'belum');
const b7 = rep.rows.find(x => x.worker_id === budi && x.date === '2026-10-07'); assert.strictEqual(b7.minutes, 535); // 08:05 → 17:00
rep = call('att_report', { from: '2026-10-07', to: '2026-10-08' }, MGR, '2026-10-08T03:00:00Z');
assert(rep.ok && rep.totals.every(x => x.wage_due === undefined && x.daily_wage === undefined));
assert.strictEqual(call('att_report', { from: '2026-10-07', to: '2026-10-08' }, KASIR, D1).error, 'FORBIDDEN');
assert(rep.events.some(e => e.kind === 'enroll') && rep.events.some(e => e.kind === 'fail') && rep.events.some(e => e.kind === 'setting'));

// tampering with the stored rows is visible
const check = () => call('att_report', { from: '2026-10-07', to: '2026-10-08' }, OWNER, '2026-10-08T03:00:00Z').verify;
const inRow = T.records.find(x => x.worker_id === siti && x.kind === 'in');
const saved = inRow.at; inRow.at = '2026-10-07T00:59:00Z'; // someone makes Siti "on time"
let v = check(); assert(!v.ok && v.issues.some(i => i.problem === 'changed'), JSON.stringify(v)); inRow.at = saved;
assert(check().ok);
const idx = T.records.findIndex(x => x.kind === 'fail'); const [gone] = T.records.splice(idx, 1); // someone deletes a failed attempt
v = check(); assert(!v.ok && v.issues.some(i => i.problem === 'gap' || i.problem === 'count'), JSON.stringify(v)); T.records.splice(idx, 0, gone);
const lastDay7 = T.records.filter(x => x.att_date === '2026-10-07').pop(); const i7 = T.records.indexOf(lastDay7); T.records.splice(i7, 1); // delete the day's last row
v = check(); assert(!v.ok && v.issues.some(i => i.problem === 'count' || i.problem === 'seal_hash'), JSON.stringify(v)); T.records.splice(i7, 0, lastDay7);
T.seals[0].count = 99; v = check(); assert(!v.ok && v.issues.some(i => i.problem === 'seal_changed')); T.seals[0].count = T.records.filter(x => x.att_date === '2026-10-07').length;
assert(check().ok);
// face data can be deleted (owner only); attendance stays, the deletion is in the chain
assert.strictEqual(call('worker_forget', { worker_id: siti }, MGR, '2026-10-08T04:00:00Z').error, 'FORBIDDEN');
r = call('worker_forget', { worker_id: siti }, OWNER, '2026-10-08T04:00:00Z'); assert(r.ok && r.worker.enrolled === false);
assert.strictEqual(call('att_mark', { worker_id: siti, descriptor: face(2), loc: SHOP }, KASIR, '2026-10-08T04:05:00Z').error, 'NOT_ENROLLED');
assert(check().ok && T.records.some(x => x.kind === 'forget'));
console.log('attendance core: all checks passed (' + T.records.length + ' records, ' + T.seals.length + ' seal)');
