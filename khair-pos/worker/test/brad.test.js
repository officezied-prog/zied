// v60 (owner 2026-10-18: «انطلق بالمرحلة الاولى و الاحسن في تطبيق اخر الان منفصل حتى نتأكد منه قبل دمجه مع القديم») — Khair Order Brad
// on the Worker: the build-time wrap keeps the core's behaviour, the whole 9-step flow lands in brad_orders, the gudang
// tables are only read except the goods out at departure, the free plan's 50 D1 calls are never reached, and the order
// reader asks the AI only after the user is checked (claude-haiku-5-5, unclear photo lines → claude-sonnet-5-5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert, d1Mock } from './shim.js';
import { handleBrad, parseBrad, loadBradNodes } from '../src/brad.js';
import { makeAccessor } from '../src/db.js';
import { runProcessBrad } from '../src/generated/process-brad.gen.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const SRC = [['cold', 'cold-parsers.js'], ['cold', 'cold-core.js'], ['brad', 'brad-core.js'], ['brad', 'process-brad.js']]
  .map(([d, f]) => readFileSync(new URL('../../backend/' + d + '/' + f, import.meta.url), 'utf8')).join('\n');
const origFn = new Function('$', SRC);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Mgr', role: 'manager', pin_hash: h('Mgr', '2222'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Akun', role: 'akuntan', pin_hash: h('Akun', '3333'), active: true });
  insert(db, 'pos_settings', { id: 1, skey: 'store_name', svalue: JSON.stringify('Khair Mart') });
  insert(db, 'cold_warehouses', { id: 1, code: 'BOSCO', name: 'Bosco', pic_wa: '6281211112222', active: true, parser: 'generic', created_at: '2026-01-01' });
  insert(db, 'cold_products', { id: 1, code: 'AJWA', name: 'Ajwa', kg_per_ctn: 10, ctn_per_pallet: 50, aliases: 'ajwa', active: true });
  insert(db, 'cold_pallets', { id: 1, pallet_code: 'AJ-1', product: 'AJWA', exp_date: '2027-02-01', warehouse: 'BOSCO' });
  insert(db, 'cold_pallets', { id: 2, pallet_code: 'AJ-2', product: 'AJWA', exp_date: '2026-12-01', warehouse: 'BOSCO' });
  insert(db, 'cold_movements', { id: 1, seq: 1, move_date: '2026-10-01', at: '2026-10-01T02:00:00Z', type: 'IN', pallet_code: 'AJ-1', warehouse: 'BOSCO', cartons: 30, ref_seq: 0, grp: 1, order_no: '', reason: '', by_user: 'x' });
  insert(db, 'cold_movements', { id: 2, seq: 2, move_date: '2026-10-01', at: '2026-10-01T02:00:00Z', type: 'IN', pallet_code: 'AJ-2', warehouse: 'BOSCO', cartons: 50, ref_seq: 0, grp: 2, order_no: '', reason: '', by_user: 'x' });
  insert(db, 'pos_customers', { id: 7, name: 'Toko Zahra', phone: '6281300000099', address: 'Jl. Melati 9', type: 'grosir', debt_balance: 125000 });
  return db;
}
async function at(iso, fn) {
  const RealDate = Date, FIXED = RealDate.parse(iso);
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const aiReply = (o) => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(o) }] }), { status: 200 });

test('brad: generated runProcessBrad == the original sources concatenated', async () => {
  const cases = [base('login', 'Mgr', '2222'), base('bootstrap', 'Akun', '3333'), base('order_save', 'Akun', '3333', { warehouse: 'BOSCO' }),
    base('order_read', 'Mgr', '2222', { text: 'Ajwa 10 ctn' }), { action: 'bootstrap', key: 'WRONG', user: 'Mgr', pin_hash: h('Mgr', '2222'), data: {} }];
  for (const body of cases) {
    const n = await loadBradNodes(sqliteAdapter(seed()), parseBrad(body));
    n['Check Key'] = [{ key_ok: body.key === KEY }];
    const a = await at('2026-10-14T03:00:00Z', async () => runProcessBrad(makeAccessor(n))[0].json);
    const b = await at('2026-10-14T03:00:00Z', async () => origFn(makeAccessor(n))[0].json);
    assert.deepEqual(a, b, body.action);
  }
});

test('brad: a fresh database gets brad_orders by itself (idempotent; runs before any other call, the flag is per isolate)', async () => {
  const db = seed();
  db.exec('DROP TABLE brad_orders');
  const a = sqliteAdapter(db);
  const r = await at('2026-10-14T03:00:00Z', () => handleBrad(a, base('bootstrap', 'Mgr', '2222'), {}, KEY));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('brad: the 9 steps land in brad_orders; at departure the goods leave cold_movements; the gudang data is otherwise untouched; ≤ 50 D1 calls', async () => {
  const db = seed(), DB = d1Mock(db, { maxCalls: 50 }), env = { DB, STORE_KEY: KEY };
  const post = (iso, action, user, pin, data) => at(iso, async () => {
    DB.calls = 0;
    const r = await worker.fetch(new Request('https://w.test/webhook/khair-brad', { method: 'POST', body: JSON.stringify(base(action, user, pin, data)) }), env);
    return r.json();
  });
  const snap = (t) => JSON.stringify(db.prepare('SELECT * FROM ' + t + ' ORDER BY id').all());
  const before = { wh: snap('cold_warehouses'), pal: snap('cold_pallets'), ord: snap('cold_orders'), cust: snap('pos_customers') };
  const W = '2026-10-14T03:00:00Z'; // Wednesday 10:00 WIB
  let r = await post(W, 'order_save', 'Mgr', '2222', { warehouse: 'BOSCO', order_date: '2026-10-14', dest_type: 'pelanggan', dest_name: 'Toko Zahra', customer_id: 7, lines: [{ pallet_code: 'AJ-2', cartons: 50 }, { pallet_code: 'AJ-1', cartons: 10 }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const no = r.order.order_no;
  assert.equal(no, 'BRD-261014-001');
  for (const to of ['sent', 'approved', 'ready']) assert.equal((await post(W, 'order_status', 'Mgr', '2222', { order_no: no, to })).ok, true, to);
  assert.equal((await post(W, 'car_save', 'Mgr', '2222', { order_no: no, via: 'lalamove', driver: 'Pak Budi', plate: 'B 1 AB', driver_wa: '081299990000', eta_min: 30 })).ok, true);
  assert.equal((await post('2026-10-14T03:40:00Z', 'order_arrived', 'Mgr', '2222', { order_no: no, time: '10:38', door: '21' })).order.status, 'door');
  assert.equal((await post('2026-10-14T03:42:00Z', 'load_start', 'Mgr', '2222', { order_no: no })).order.load_end_est, '2026-10-14T04:42:00.000Z'); // 2 pallets × 30 min
  r = await post('2026-10-14T04:40:00Z', 'depart', 'Mgr', '2222', { order_no: no });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(DB.calls <= 50, 'D1 calls: ' + DB.calls);
  const row = db.prepare('SELECT status, door, departed_at, car FROM brad_orders WHERE order_no = ?').get(no);
  assert.deepEqual([row.status, row.door, row.departed_at, JSON.parse(row.car).plate], ['departed', '21', '2026-10-14T04:40:00.000Z', 'B 1 AB']);
  const outs = db.prepare("SELECT pallet_code, cartons, order_no, by_user FROM cold_movements WHERE type = 'OUT' ORDER BY seq").all().map((x) => ({ ...x }));
  assert.deepEqual(outs, [{ pallet_code: 'AJ-2', cartons: -50, order_no: no, by_user: 'Mgr' }, { pallet_code: 'AJ-1', cartons: -10, order_no: no, by_user: 'Mgr' }]);
  assert.deepEqual({ wh: snap('cold_warehouses'), pal: snap('cold_pallets'), ord: snap('cold_orders'), cust: snap('pos_customers') }, before);
  // the owner's settings go to pos_settings (brad_* keys only)
  assert.equal((await post(W, 'settings_save', 'Pemilik', '1234', { holidays: [{ date: '2026-12-25', name: 'Natal' }], load_min: 25 })).ok, true);
  assert.equal((await post(W, 'cooler_save', 'Pemilik', '1234', { code: 'BOSCO', wa: '081355556666' })).ok, true);
  const keys = db.prepare('SELECT skey FROM pos_settings ORDER BY skey').all().map((x) => x.skey);
  assert.deepEqual(keys, ['brad_coolers', 'brad_holidays', 'brad_load_min', 'store_name']);
  const bs = await post(W, 'bootstrap', 'Akun', '3333', {});
  assert.deepEqual([bs.ok, bs.coolers[0].wa, bs.load_min, bs.ai_reader, bs.orders[0].step], [true, '6281355556666', 25, false, 9]);
});

test('brad: the order reader — no key: rules, never the AI; a photo: haiku, unclear → sonnet once; the accountant never reaches the AI; nothing saved', async () => {
  const db = seed(), a = sqliteAdapter(db), IMG = 'data:image/jpeg;base64,' + 'A'.repeat(400), keyEnv = { ANTHROPIC_API_KEY: 'test-key' };
  const read = (user, pin, data, env) => at('2026-10-14T03:00:00Z', () => handleBrad(a, base('order_read', user, pin, data), {}, KEY, { env }));
  let calls = 0;
  await withFetch(async () => { calls++; return aiReply({ items: [] }); }, async () => {
    const r = await read('Mgr', '2222', { text: 'Ajwa 60 ctn', _ai: { text: '{"items":[{"pallet":"AJ-1"}]}' } }, {}); // a client's own _ai is ignored
    assert.deepEqual([r.ok, r.read_by, r.draft.lines.map((l) => [l.pallet_code, l.cartons])], [true, 'rules', [['AJ-2', 50], ['AJ-1', 10]]]);
    assert.equal((await read('Mgr', '2222', { image_base64: IMG }, {})).error, 'AI_OFF');
    assert.equal((await read('Akun', '3333', { image_base64: IMG }, keyEnv)).error, 'FORBIDDEN');
    assert.equal((await read('Mgr', '9999', { image_base64: IMG }, keyEnv)).error, 'BAD_PIN');
  });
  assert.equal(calls, 0);
  const sent = [];
  const r = await withFetch(async (url, init) => {
    const b = JSON.parse(init.body); sent.push(b);
    return b.model === 'claude-haiku-5-5' ? aiReply({ items: [{ pallet: 'AJ-9', product: '?', qty: 5, unclear: true }] }) : aiReply({ customer: { name: 'Toko Zahra' }, items: [{ pallet: 'AJ-1', qty: 5 }] });
  }, () => read('Mgr', '2222', { image_base64: IMG, mime: 'image/jpeg' }, keyEnv));
  assert.deepEqual(sent.map((b) => [b.model, b.output_config.effort, b.messages[0].content[0].type]), [['claude-haiku-5-5', 'low', 'image'], ['claude-sonnet-5-5', 'medium', 'image']]);
  assert.match(sent[0].system, /ONE JSON object/);
  assert.match(sent[0].messages[0].content[1].text, /AJ-2 \| AJWA \| BOSCO \| 50/);
  assert.deepEqual([r.read_by, r.draft.unclear, r.draft.lines[0].pallet_code, r.draft.customer_id], ['claude-sonnet-5-5', 0, 'AJ-1', 7]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM brad_orders').get().n, 0);
});

test('brad: the core suite (backend/brad/test-brad.js) passes — it runs in CI with the Worker tests', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../backend/brad/test-brad.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /test-brad: all passed/);
});
