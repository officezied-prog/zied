// Parity tests for the Attendance API: the build-time wrap (att-core.js + process-att.js,
// including the pure-JS sha256 hash chain) preserves behaviour, and a worker_save writes a
// worker + a chained attendance record + the att_head seal pointer. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleAtt, parseAtt, loadAttNodes } from '../src/attendance.js';
import { makeAccessor } from '../src/db.js';
import { runProcessAtt } from '../src/generated/process-att.gen.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const core = readFileSync(new URL('../../backend/attendance/att-core.js', import.meta.url), 'utf8');
const wrap = readFileSync(new URL('../../backend/attendance/process-att.js', import.meta.url), 'utf8');
const origAttFn = new Function('$', (core + '\n' + wrap).replace("'__STORE_KEY__'", JSON.stringify(KEY)));

const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  return db;
}

function frozen(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-06T03:00:00.000Z');
  const oR = Math.random; let s = 42;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = oR; }
}

test('attendance: generated runProcessAtt == original (att-core + process-att)', async () => {
  const cases = [
    base('att_bootstrap', 'Pemilik', '1234'),
    base('worker_save', 'Pemilik', '1234', { name: 'Ahmad' }),
    base('worker_save', 'Jihan', '2222', { name: 'Budi Santoso', phone: '0812 3456 7890' }),
    base('worker_save', 'Jihan', '2222', {}), // invalid: no name
    { action: 'att_bootstrap', key: 'WRONG', user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: {} },
  ];
  for (const body of cases) {
    const nodes = await loadAttNodes(sqliteAdapter(seed()), parseAtt(body));
    const $ = makeAccessor(nodes);
    const gen = frozen(() => runProcessAtt($, KEY)[0].json);
    const orig = frozen(() => origAttFn($)[0].json);
    assert.deepEqual(gen, orig, 'mismatch for att action ' + body.action);
  }
});

test('attendance: worker_save writes worker + chained record + att_head', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleAtt(a, base('worker_save', 'Pemilik', '1234', { name: 'Ahmad' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const w = a.all("SELECT * FROM pos_workers WHERE name = 'Ahmad'", []);
  assert.equal(w.length, 1);
  assert.equal(w[0].active, 1); // boolean stored 0/1
  const recs = a.all('SELECT * FROM pos_attendance', []);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'worker');
  assert.match(recs[0].hash, /^[a-f0-9]{64}$/); // tamper-proof chain hash
  const headRow = a.all("SELECT svalue FROM pos_settings WHERE skey = 'att_head'", []);
  assert.equal(headRow.length, 1);
  assert.ok(JSON.parse(headRow[0].svalue).hash, 'att_head carries the chain head');
});

test('attendance: non-boss cannot save a worker', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  const r = await handleAtt(sqliteAdapter(db), base('worker_save', 'Siti', '1111', { name: 'Ahmad' }), {}, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FORBIDDEN');
});
