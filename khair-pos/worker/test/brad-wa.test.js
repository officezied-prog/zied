// v61 (owner 2026-10-18: «ابدأ المرحلة الثانية: إرسال الواتساب تلقائيًا») — automatic WhatsApp for Khair Order Brad, on the Worker:
// the step's template goes out through Meta's Cloud API (a stand-in fetch here) and is logged; not set up / over the month's
// cap → nothing is sent and the app sends by hand; Meta's webhook is accepted only when signed, moves the order only for the
// cold store's own number, never twice for the same message, and keeps every message's delivery status.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert, d1Mock } from './shim.js';
import { handleBrad, handleWaWebhook } from '../src/brad.js';
import { signatureOk } from '../src/wa.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000', SECRET = 'app-secret-test', VERIFY = 'verify-me-123';
const ENV = { WA_TOKEN: 'tok-test', WA_PHONE_ID: '1098765', WA_WABA_ID: '5550001', WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: VERIFY };
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: h(user, pin), data });
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Mgr', role: 'manager', pin_hash: h('Mgr', '2222'), active: true });
  insert(db, 'cold_warehouses', { id: 1, code: 'BOSCO', name: 'Bosco', address: 'Bekasi', pic_wa: '6281211112222', active: true, parser: 'generic', created_at: '2026-01-01' });
  insert(db, 'cold_products', { id: 1, code: 'AJWA', name: 'Ajwa', kg_per_ctn: 10, ctn_per_pallet: 50, aliases: 'ajwa', active: true });
  insert(db, 'cold_pallets', { id: 1, pallet_code: 'AJ-1', product: 'AJWA', exp_date: '2027-02-01', warehouse: 'BOSCO' });
  insert(db, 'cold_movements', { id: 1, seq: 1, move_date: '2026-10-01', at: '2026-10-01T02:00:00Z', type: 'IN', pallet_code: 'AJ-1', warehouse: 'BOSCO', cartons: 30, ref_seq: 0, grp: 1, order_no: '', reason: '', by_user: 'x' });
  return db;
}
async function at(iso, fn) {
  const RealDate = Date, FIXED = RealDate.parse(iso);
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}
/** A stand-in for graph.facebook.com: records each call; answers a message id per send. */
function graph() {
  const calls = []; let n = 0;
  const f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method || 'GET', auth: (init.headers || {}).Authorization, body });
    if (/\/messages$/.test(url)) return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: body.to }], messages: [{ id: 'wamid.OUT' + (++n) }] }), { status: 200 });
    if (/message_templates\?/.test(url)) return new Response(JSON.stringify({ data: [{ name: 'khair_pintu_brad', status: 'APPROVED', language: 'id', category: 'UTILITY' }] }), { status: 200 });
    if (/message_templates$/.test(url)) return new Response(JSON.stringify({ id: '77' + calls.length, status: 'PENDING', category: 'UTILITY' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  f.calls = calls;
  return f;
}
const W = '2026-10-14T03:00:00Z'; // Wednesday 10:00 WIB
async function flow(a, env, f, upTo) { // an order up to `upTo`
  const call = (action, data, iso = W) => at(iso, () => handleBrad(a, base(action, 'Mgr', '2222', data), {}, KEY, { env, fetch: f }));
  const o = (await call('order_save', { warehouse: 'BOSCO', order_date: '2026-10-14', dest_type: 'pelanggan', dest_name: 'Toko Zahra', dest_phone: '081300000099', lines: [{ pallet_code: 'AJ-1', cartons: 5 }] })).order;
  const steps = { sent: await call('order_status', { order_no: o.order_no, to: 'sent' }) };
  return { no: o.order_no, call, steps };
}
const webhook = (a, payload, env = ENV, f) => { const raw = JSON.stringify(payload); return at('2026-10-14T03:30:00Z', () => handleWaWebhook(a, 'POST', new URL('https://w.test/webhook/wa'), raw, { 'x-hub-signature-256': sign(raw) }, env, f)); };
const msgEvent = (m) => ({ object: 'whatsapp_business_account', entry: [{ id: '5550001', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1098765' }, messages: [m] } }] }] });
const statusEvent = (s) => ({ object: 'whatsapp_business_account', entry: [{ id: '5550001', changes: [{ field: 'messages', value: { statuses: [s] } }] }] });

test('wa: not set up — nothing is sent, the app is told to send by hand', async () => {
  const db = seed(), a = sqliteAdapter(db), f = graph();
  const { steps } = await flow(a, {}, f);
  assert.deepEqual(steps.sent.wa_sent, [{ kind: 'order', ok: false, error: 'WA_OFF' }]);
  assert.equal(steps.sent.wa, undefined); // the message itself never reaches the app
  assert.equal(f.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM brad_wa_log').get().n, 0);
});

test('wa: set up — the order template goes to the cold store (body values + quick-reply payloads), logged, counted; the cap holds', async () => {
  const db = seed(), a = sqliteAdapter(db), f = graph();
  const { no, steps, call } = await flow(a, ENV, f);
  assert.deepEqual(steps.sent.wa_sent, [{ kind: 'order', ok: true, error: '' }]);
  const c = f.calls[0];
  assert.equal(c.url, 'https://graph.facebook.com/v24.0/1098765/messages');
  assert.equal(c.auth, 'Bearer tok-test');
  assert.deepEqual([c.body.messaging_product, c.body.to, c.body.type, c.body.template.name, c.body.template.language.code], ['whatsapp', '6281211112222', 'template', 'khair_order_brad', 'id']);
  const [body, ...btns] = c.body.template.components;
  assert.deepEqual(body.parameters.map((p) => p.text), [no, 'Rabu, 14 Oktober 2026', 'Bosco', 'Toko Zahra (pelanggan)', '5 ctn Ajwa, palet AJ-1, kode AJWA', '5 ctn, 1 palet']);
  assert.deepEqual(btns, ['APPROVE', 'REJECT', 'READY'].map((k, i) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: 'BRD|' + k + '|' + no }] })));
  const log = db.prepare('SELECT wamid, dir, peer, order_no, kind, template, status FROM brad_wa_log').all().map((r) => ({ ...r }));
  assert.deepEqual(log, [{ wamid: 'wamid.OUT1', dir: 'out', peer: '6281211112222', order_no: no, kind: 'order', template: 'khair_order_brad', status: 'accepted' }]);
  assert.equal(db.prepare("SELECT n FROM pos_api_usage WHERE api = 'wa_send'").get().n, 1);
  const bs = await call('bootstrap', {});
  assert.deepEqual([bs.wa.on, bs.wa.count, bs.wa.cap, bs.wa_log.length], [true, 1, 3000, 1]);
  // the month's cap reached: not sent, said, logged
  await at(W, () => handleBrad(a, base('settings_save', 'Pemilik', '1234', { wa_cap: 1 }), {}, KEY, { env: ENV, fetch: f }));
  const second = await flow(a, ENV, f);
  assert.deepEqual(second.steps.sent.wa_sent, [{ kind: 'order', ok: false, error: 'WA_CAP' }]);
  assert.equal(f.calls.length, 1);
  assert.equal(db.prepare("SELECT status FROM brad_wa_log WHERE order_no = ?").get(second.no).status, 'not_sent');
});

test('wa: Meta refuses (e.g. template not approved yet) → the app sends by hand, the reason is kept', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const f = async () => new Response(JSON.stringify({ error: { code: 132001, message: 'Template name does not exist in the translation' } }), { status: 404 });
  const { steps } = await flow(a, ENV, f);
  assert.equal(steps.sent.wa_sent[0].ok, false);
  assert.match(steps.sent.wa_sent[0].error, /WA 404 #132001/);
  assert.equal(db.prepare('SELECT status FROM brad_wa_log').get().status, 'failed');
});

test('wa webhook: handshake; unsigned → 401; the cold store\'s button moves the order (once); other numbers do not; statuses climb only', async () => {
  const db = seed(), a = sqliteAdapter(db), f = graph();
  const { no } = await flow(a, ENV, f);
  const url = (tok) => new URL('https://w.test/webhook/wa?hub.mode=subscribe&hub.verify_token=' + tok + '&hub.challenge=4242');
  assert.deepEqual(await handleWaWebhook(a, 'GET', url(VERIFY), '', {}, ENV), { status: 200, text: '4242' });
  assert.equal((await handleWaWebhook(a, 'GET', url('wrong'), '', {}, ENV)).status, 403);
  const tap = (id, from, payload) => msgEvent({ from, id, timestamp: '1', type: 'button', context: { from: '628000', id: 'wamid.OUT1' }, button: { payload, text: 'Setuju' } });
  const raw = JSON.stringify(tap('wamid.IN1', '6281211112222', 'BRD|APPROVE|' + no));
  assert.equal((await handleWaWebhook(a, 'POST', new URL('https://w.test/webhook/wa'), raw, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, ENV)).status, 401);
  assert.equal((await handleWaWebhook(a, 'POST', new URL('https://w.test/webhook/wa'), raw, {}, ENV)).status, 401);
  const statusOf = () => db.prepare('SELECT status FROM brad_orders WHERE order_no = ?').get(no).status;
  assert.equal((await webhook(a, tap('wamid.INX', '6289999999999', 'BRD|APPROVE|' + no))).status, 200);
  assert.equal(statusOf(), 'sent'); // not the cold store's number
  await webhook(a, tap('wamid.IN1', '6281211112222', 'BRD|APPROVE|' + no));
  assert.equal(statusOf(), 'approved');
  await webhook(a, tap('wamid.IN2', '6281211112222', 'BRD|READY|' + no));
  await webhook(a, tap('wamid.IN2', '6281211112222', 'BRD|READY|' + no)); // Meta's retry: the same message again
  assert.equal(statusOf(), 'ready');
  assert.equal(JSON.parse(db.prepare('SELECT log FROM brad_orders WHERE order_no = ?').get(no).log).filter((l) => l.to === 'ready').length, 1);
  assert.deepEqual(db.prepare("SELECT applied FROM brad_wa_log WHERE dir = 'in' ORDER BY id").all().map((r) => r.applied), ['not_cooler', 'approved', 'ready']);
  // delivery statuses: delivered → read; a late "sent" never lowers it; a failure keeps its reason
  await webhook(a, statusEvent({ id: 'wamid.OUT1', status: 'delivered', timestamp: '2', recipient_id: '6281211112222' }));
  await webhook(a, statusEvent({ id: 'wamid.OUT1', status: 'read', timestamp: '3', recipient_id: '6281211112222' }));
  await webhook(a, statusEvent({ id: 'wamid.OUT1', status: 'sent', timestamp: '1', recipient_id: '6281211112222' }));
  assert.equal(db.prepare("SELECT status FROM brad_wa_log WHERE wamid = 'wamid.OUT1'").get().status, 'read');
});

test('wa webhook: the cold store answers the car message with "pintu 9" → the car is in at door 9 and the driver gets the door by itself', async () => {
  const db = seed(), a = sqliteAdapter(db), f = graph();
  const { no, call } = await flow(a, ENV, f);
  for (const to of ['approved', 'ready']) await call('order_status', { order_no: no, to });
  const car = await call('car_save', { order_no: no, via: 'lalamove', driver: 'Pak Budi', driver_wa: '081299990000', plate: 'B 1 AB', eta_min: 20 });
  assert.deepEqual(car.wa_sent, [{ kind: 'car', ok: true, error: '' }]);
  const carMsg = f.calls[1];
  assert.equal(carMsg.body.template.name, 'khair_mobil_brad');
  assert.deepEqual(carMsg.body.template.components[1].parameters, [{ type: 'payload', payload: 'BRD|IN|' + no }]);
  await webhook(a, msgEvent({ from: '6281211112222', id: 'wamid.IN9', timestamp: '1', type: 'text', text: { body: 'Mobil sudah masuk, pintu 9' }, context: { from: '628000', id: 'wamid.OUT2' } }), ENV, f);
  const row = db.prepare('SELECT status, door, arrived_at FROM brad_orders WHERE order_no = ?').get(no);
  assert.deepEqual({ ...row }, { status: 'door', door: '9', arrived_at: '2026-10-14T03:30:00.000Z' });
  const doorMsg = f.calls[2];
  assert.deepEqual([doorMsg.body.to, doorMsg.body.template.name, doorMsg.body.template.components[0].parameters[4].text], ['6281299990000', 'khair_pintu_brad', '9']);
  assert.equal(db.prepare("SELECT n FROM pos_api_usage WHERE api = 'wa_send'").get().n, 3);
});

test('wa admin: the status (manager) lists the templates; the owner registers the missing ones; a test message', async () => {
  const db = seed(), a = sqliteAdapter(db), f = graph();
  const call = (u, p, data) => at(W, () => handleBrad(a, base('wa_admin', u, p, data), {}, KEY, { env: ENV, fetch: f }));
  const st = await call('Mgr', '2222', { op: 'status' });
  assert.deepEqual([st.on, st.set.secret, st.templates[0].status, st.count, st.cap], [true, true, 'APPROVED', 0, 3000]);
  assert.equal((await call('Mgr', '2222', { op: 'templates' })).error, 'FORBIDDEN');
  const reg = await call('Pemilik', '1234', { op: 'templates' });
  assert.deepEqual(reg.templates.map((t) => [t.name, t.status]), [['khair_order_brad', 'PENDING'], ['khair_mobil_brad', 'PENDING'], ['khair_pintu_brad', 'EXISTS'], ['khair_berangkat_brad', 'PENDING']]);
  const posts = f.calls.filter((c) => c.method === 'POST' && /message_templates$/.test(c.url));
  assert.equal(posts.length, 3);
  assert.equal(posts[0].url, 'https://graph.facebook.com/v24.0/5550001/message_templates');
  assert.deepEqual([posts[0].body.category, posts[0].body.language, posts[0].body.components[1].buttons.map((b) => b.text)], ['UTILITY', 'id', ['Setuju', 'Tolak', 'Barang siap']]);
  const tst = await call('Pemilik', '1234', { op: 'test', to: '0812 1111 0000' });
  assert.deepEqual(tst.wa_sent, [{ kind: 'test', ok: true, error: '' }]);
  assert.equal(f.calls[f.calls.length - 1].body.template.name, 'khair_berangkat_brad');
});

test('wa: the signature check itself, and the route through the Worker (handshake answered as plain text)', async () => {
  const raw = '{"a":1}';
  assert.equal(await signatureOk(SECRET, raw, sign(raw)), true);
  assert.equal(await signatureOk(SECRET, raw + ' ', sign(raw)), false);
  assert.equal(await signatureOk('', raw, sign(raw)), false);
  const env = { DB: d1Mock(seed()), STORE_KEY: KEY, ...ENV };
  const r = await worker.fetch(new Request('https://w.test/webhook/wa?hub.mode=subscribe&hub.verify_token=' + VERIFY + '&hub.challenge=99'), env);
  assert.deepEqual([r.status, await r.text()], [200, '99']);
  const bad = await worker.fetch(new Request('https://w.test/webhook/wa', { method: 'POST', body: raw }), env);
  assert.equal(bad.status, 401);
});
