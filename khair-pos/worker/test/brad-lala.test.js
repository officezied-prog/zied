// v63 (owner 2026-10-20: «ابدأ المرحلة الثالثة: طلب سيارة لالاموف تلقائيًا») — the Lalamove car booked by the server for Khair Order Brad,
// on the Worker, against a stand-in for Lalamove's Partner API v3 (and Google Maps / WhatsApp): every call is signed as
// Lalamove's SDK signs it; priced → booked (a price that rose and the month's cap asked first) → the driver found (his car to the
// cold store by WhatsApp, as in stage 2) → picked up = the departure → completed = delivered; cancelled at Lalamove first; one
// booking at a time; the webhook trusts nothing it is told; without the keys nothing is called and the manual ways go on.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert, d1Mock } from './shim.js';
import { handleBrad, handleLalaCron, handleLalaWebhook, parseBrad, _resetBradSchemaForTests } from '../src/brad.js';
import { lalaCall, lalaSign, LALA_HOSTS } from '../src/lalamove.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000', LK = 'pk_test_1234567890abcdef', LS = 'sk_test_fedcba0987654321';
const LALA = { LALAMOVE_KEY: LK, LALAMOVE_SECRET: LS };
const WA = { WA_TOKEN: 'tok-test', WA_PHONE_ID: '1098765', WA_WABA_ID: '5550001', WA_APP_SECRET: 'app-secret', WA_VERIFY_TOKEN: 'verify' };
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: h(user, pin), data });
function seed() {
  const db = newDb();
  _resetBradSchemaForTests(); // a new database each test: the Worker makes its runtime tables (the booking locks) again
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Mgr', role: 'manager', pin_hash: h('Mgr', '2222'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Akun', role: 'akuntan', pin_hash: h('Akun', '3333'), active: true });
  insert(db, 'pos_settings', { id: 1, skey: 'store_name', svalue: JSON.stringify('Khair Mart') });
  insert(db, 'pos_settings', { id: 2, skey: 'phone', svalue: JSON.stringify('0812-8000-2700') });
  insert(db, 'cold_warehouses', { id: 1, code: 'BOSCO', name: 'Bosco', address: 'Jl. Industri 2, Bekasi', pic_wa: '6281211112222', active: true, parser: 'generic', created_at: '2026-01-01' });
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
/** A stand-in for rest.(sandbox.)lalamove.com — plus a short Google Maps link and WhatsApp's Graph API. Records every call. */
function net() {
  const calls = [], S = { price: 95000, q: 0, n: 3000, orders: {}, cancelRefuse: false };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const f = async (url, init = {}) => {
    const u = new URL(String(url)), body = init.body ? String(init.body) : '', M = init.method || 'GET', p = u.pathname;
    calls.push({ host: u.host, path: p, method: M, headers: init.headers || {}, body, json: body ? JSON.parse(body) : null });
    if (u.host === 'maps.app.goo.gl') return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/place/Toko+Zahra/@-6.25,106.85,17z/data=!3d-6.2512!4d106.8523' } });
    if (u.host === 'graph.facebook.com') return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.L' + calls.length }] });
    if (!/lalamove\.com$/.test(u.host)) return J({}, 404);
    if (M === 'GET' && p === '/v3/cities') return J({ data: [{ locode: 'ID_SBY', name: 'Surabaya', services: [{ key: 'MOTORCYCLE', description: 'Motor', load: { value: '20', unit: 'kg' } }] },
      { locode: 'ID_JKT', name: 'Jakarta', services: [{ key: 'MOTORCYCLE', description: 'Motor', load: { value: '20', unit: 'kg' } }, { key: 'VAN', description: 'Van', load: { value: '600', unit: 'kg' } },
        { key: 'TRUCK175', description: 'Pickup', load: { value: '1000', unit: 'kg' } }] }] });
    if (M === 'POST' && p === '/v3/quotations') {
      const d = JSON.parse(body).data, q = ++S.q;
      return J({ data: { quotationId: 'Q' + q, scheduleAt: d.scheduleAt || new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), serviceType: d.serviceType,
        language: d.language, stops: (d.stops || []).map((s, i) => ({ stopId: 'S' + q + '-' + i, coordinates: s.coordinates, address: s.address })),
        priceBreakdown: { base: '50000', total: String(S.price), currency: 'IDR' }, distance: { value: '15200', unit: 'm' } } }, 201);
    }
    if (M === 'POST' && p === '/v3/orders') {
      const id = String(++S.n), d = JSON.parse(body).data;
      S.orders[id] = { status: 'ASSIGNING_DRIVER', driverId: '', quotationId: d.quotationId };
      return J({ data: { orderId: id, quotationId: d.quotationId, priceBreakdown: { total: String(S.price), currency: 'IDR' }, driverId: '', shareLink: 'https://share.lalamove.com/?ID=' + id + '&lang=id_ID', status: 'ASSIGNING_DRIVER' } }, 201);
    }
    let m = p.match(/^\/v3\/orders\/(\w+)\/drivers\/(\w+)$/);
    if (m && M === 'GET') return J({ data: { driverId: m[2], name: 'Slamet', phone: '+6281311112222', plateNumber: 'B 9876 TKL', photo: '' } });
    m = p.match(/^\/v3\/orders\/(\w+)$/);
    if (m) {
      const o = S.orders[m[1]];
      if (!o) return J({ errors: [{ id: 'ERR_ORDER_NOT_FOUND', message: 'Order not found' }] }, 404);
      if (M === 'GET') return J({ data: { orderId: m[1], status: o.status, driverId: o.driverId, shareLink: 'https://share.lalamove.com/?ID=' + m[1] + '&lang=id_ID', priceBreakdown: { total: String(S.price), currency: 'IDR' } } });
      if (M === 'DELETE') {
        if (S.cancelRefuse || o.status === 'PICKED_UP') return J({ errors: [{ id: 'ERR_CANCELLATION_FORBIDDEN', message: 'Order cannot be cancelled' }] }, 422);
        o.status = 'CANCELED'; return new Response(null, { status: 204 });
      }
    }
    return J({ errors: [{ id: 'ERR_NOT_FOUND', message: 'no route' }] }, 404);
  };
  f.calls = calls; f.S = S;
  f.lala = () => calls.filter((c) => /lalamove\.com$/.test(c.host));
  f.graph = () => calls.filter((c) => c.host === 'graph.facebook.com');
  return f;
}
const W = '2026-10-14T03:00:00Z'; // Wednesday 10:00 WIB
const mins = (n) => new Date(Date.parse(W) + n * 60000).toISOString();
/** The cooler's and the shop's places, an order for Toko Zahra (its place from a short Maps link) up to "Barang siap". */
async function ready(a, env, f) {
  const call = (action, data, iso = W, user = 'Mgr', pin = '2222') => at(iso, () => handleBrad(a, base(action, user, pin, data), {}, KEY, { env, fetch: f }));
  assert.equal((await call('settings_save', { cooler_geo: { BOSCO: '-6.2383,106.9756' }, store_geo: '-6.2297,106.8679', store_address: 'Jl. Raya Condet No.4' }, W, 'Pemilik', '1234')).ok, true);
  const o = await call('order_save', { warehouse: 'BOSCO', order_date: '2026-10-14', dest_type: 'pelanggan', dest_name: 'Toko Zahra', dest_phone: '081300000099', dest_address: 'Jl. Melati 9',
    dest_geo: 'Lokasi: https://maps.app.goo.gl/Zahra123', lines: [{ pallet_code: 'AJ-1', cartons: 20 }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  for (const to of ['sent', 'approved', 'ready']) assert.equal((await call('order_status', { order_no: o.order.order_no, to })).ok, true, to);
  return { no: o.order.order_no, call };
}
const rowOf = (db, no) => { const r = db.prepare('SELECT * FROM brad_orders WHERE order_no = ?').get(no); return { ...r, car: r.car ? JSON.parse(r.car) : null, log: JSON.parse(r.log) }; };

test('lala: every call is signed as Lalamove\'s SDK signs it (a vector computed here with node:crypto); sandbox unless LALAMOVE_ENV=production', async () => {
  // the known vector
  const ts = '1700000000000', body = JSON.stringify({ data: { serviceType: 'VAN', language: 'id_ID' } });
  const want = (m, p, b) => crypto.createHmac('sha256', LS).update(ts + '\r\n' + m + '\r\n' + p + '\r\n\r\n' + b).digest('hex');
  assert.equal(await lalaSign(LS, ts, 'POST', '/v3/quotations', body), want('POST', '/v3/quotations', body));
  assert.equal(await lalaSign(LS, ts, 'GET', '/v3/cities', ''), want('GET', '/v3/cities', ''));
  // what goes on the wire
  const f = net();
  const r = await at('2023-11-14T22:13:20Z', () => lalaCall(LALA, 'POST', '/v3/quotations', { serviceType: 'VAN', language: 'id_ID' }, f));
  assert.equal(r.ok, true, JSON.stringify(r));
  const c = f.calls[0];
  assert.equal(c.host + c.path, 'rest.sandbox.lalamove.com/v3/quotations');
  assert.equal(c.body, body); // the JSON wrapped as { data }, exactly as signed
  assert.equal(c.headers.Authorization, 'hmac ' + LK + ':' + ts + ':' + want('POST', '/v3/quotations', body));
  assert.deepEqual([c.headers.Market, c.headers['Content-Type'], c.headers.Accept], ['ID', 'application/json', 'application/json']);
  assert.match(c.headers['Request-ID'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await at('2023-11-14T22:13:20Z', () => lalaCall({ ...LALA, LALAMOVE_ENV: 'production' }, 'GET', '/v3/cities', null, f));
  const g = f.calls[1];
  assert.deepEqual([g.host, g.method, g.body, g.headers.Authorization], ['rest.lalamove.com', 'GET', '', 'hmac ' + LK + ':' + ts + ':' + want('GET', '/v3/cities', '')]);
  assert.equal(LALA_HOSTS.sandbox, 'https://rest.sandbox.lalamove.com');
  // Lalamove's errors come back with their ids; no keys → nothing is called
  const e = await lalaCall(LALA, 'GET', '/v3/orders/nope', null, f);
  assert.deepEqual([e.ok, e.error, e.status], [false, 'LALA_ERROR', 404]);
  assert.match(e.message, /ERR_ORDER_NOT_FOUND: Order not found/);
  const off = await lalaCall({}, 'GET', '/v3/cities', null, f);
  assert.deepEqual([off.ok, off.error, f.calls.length], [false, 'LALA_OFF', 3]);
  // a stalled Lalamove: cut at 10 s, said
  const slow = async (u, init) => new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSet(fn, 1);
  try { const t = await lalaCall(LALA, 'GET', '/v3/cities', null, slow); assert.deepEqual([t.ok, t.message], [false, 'tidak menjawab (10 detik)']); } finally { globalThis.setTimeout = realSet; }
});

test('lala: the whole trip — the vehicles cached, priced, booked, the driver found (car WhatsApp to the cold store), picked up = departed, completed = delivered', async () => {
  const db = seed(), a = sqliteAdapter(db), f = net(), env = { ...LALA, ...WA };
  const { no, call } = await ready(a, env, f);
  // the short Maps link of the destination was followed by the Worker: the pin
  assert.deepEqual([rowOf(db, no).dest_lat, rowOf(db, no).dest_lng], [-6.2512, 106.8523]);
  assert.equal(f.calls.filter((c) => c.host === 'maps.app.goo.gl').length, 1);
  // "Tes koneksi": the cities; Jakarta's vehicles kept for the car form (the accountant may not)
  assert.equal((await call('lala_admin', { op: 'test' }, W, 'Akun', '3333')).error, 'FORBIDDEN');
  const t = await call('lala_admin', { op: 'test' });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.deepEqual([t.on, t.env, t.picked, t.cities.map((c) => c.locode), t.lala.services.map((s) => s.key)], [true, 'sandbox', 'ID_JKT', ['ID_SBY', 'ID_JKT'], ['MOTORCYCLE', 'VAN', 'TRUCK175']]);
  const st = await call('lala_admin', { op: 'status' });
  assert.deepEqual([st.on, st.set, st.lala.services_city.locode], [true, { key: true, secret: true }, 'ID_JKT']);
  const bs = await call('bootstrap', {});
  assert.deepEqual([bs.lala.on, bs.lala.env, bs.lala.cap, bs.lala.spent, bs.lala.services.length, 'lala_due' in bs, JSON.stringify(bs).includes(LS)], [true, 'sandbox', 10000000, 0, 3, false, false]);
  // the price (a client's own `_price` is never used: the cap check runs on Lalamove's)
  await call('settings_save', { lala_cap: 90000 }, W, 'Pemilik', '1234');
  const qc = await call('lala_quote', { order_no: no, service: 'TRUCK175', eta_min: 30, _price: 1 });
  assert.deepEqual([qc.ok, qc.error, qc.price], [false, 'LALA_CAP', 95000]);
  await call('settings_save', { lala_cap: 10000000 }, W, 'Pemilik', '1234');
  const q = await call('lala_quote', { order_no: no, service: 'TRUCK175', eta_min: 30 });
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.deepEqual([q.quote.price, q.quote.distance_m, q.quote.service_name, q.quote.eta_at, q.quote.expires_at, q.quote.from, q.quote.to, q.quote.kg],
    [95000, 15200, 'Pickup', '2026-10-14T03:36:00.000Z', '2026-10-14T03:05:00.000Z', 'Jl. Industri 2, Bekasi', 'Jl. Melati 9', 200]);
  const qb = f.lala().filter((c) => c.path === '/v3/quotations')[1].json.data;
  assert.deepEqual(qb, { serviceType: 'TRUCK175', language: 'id_ID', stops: [{ coordinates: { lat: '-6.2383', lng: '106.9756' }, address: 'Jl. Industri 2, Bekasi' }, { coordinates: { lat: '-6.2512', lng: '106.8523' }, address: 'Jl. Melati 9' }] });
  assert.equal(rowOf(db, no).status, 'ready'); // a price changes nothing
  // booked: priced again (fresh), then placed with the quotation's stops, sender = the cooler, recipient = the customer
  assert.equal((await call('lala_book', { order_no: no, service: 'TRUCK175', eta_min: 30 })).error, 'INVALID'); // the price first
  const nq = f.lala().filter((c) => c.path === '/v3/quotations').length;
  const b = await call('lala_book', { order_no: no, service: 'TRUCK175', eta_min: 30, seen_price: q.quote.price });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(f.lala().filter((c) => c.path === '/v3/quotations').length, nq + 1);
  const ob = f.lala().find((c) => c.path === '/v3/orders').json.data;
  assert.deepEqual(ob, { quotationId: 'Q' + f.S.q, sender: { stopId: 'S' + f.S.q + '-0', name: 'Bosco', phone: '+6281211112222' },
    recipients: [{ stopId: 'S' + f.S.q + '-1', name: 'Toko Zahra', phone: '+6281300000099', remarks: 'Order ' + no + ': 20 ctn, 1 palet, ± 200 kg, ambil di Bosco' }], isPODEnabled: false, metadata: { order_no: no } });
  let r = rowOf(db, no);
  assert.deepEqual([r.status, r.car.via, r.car.lala_order_id, r.car.price, r.car.share_link, r.car.lala_status, r.car.vehicle, r.eta_at],
    ['car', 'lalamove_api', '3001', 95000, 'https://share.lalamove.com/?ID=3001&lang=id_ID', 'ASSIGNING_DRIVER', 'Pickup', '2026-10-14T03:36:00.000Z']);
  assert.match(r.log[r.log.length - 1].note, /^Lalamove otomatis · Pickup · Rp 95\.000 · mobil dipesan, mencari sopir · tiba ± 10:36$/);
  assert.equal(f.graph().length, 1); // only the order to the cold store (step 2): no car message before Lalamove names a driver
  const g0 = f.graph().length;
  // a second tap books nothing
  assert.equal((await call('lala_book', { order_no: no, service: 'TRUCK175', seen_price: 95000 })).error, 'LALA_ACTIVE');
  assert.equal(f.lala().filter((c) => c.path === '/v3/orders').length, 1);
  // within 90 s of the last look Lalamove is not asked again; after it the app's own refresh reads the trip
  const n1 = f.lala().length;
  await call('bootstrap', {}, mins(1));
  assert.equal(f.lala().length, n1);
  f.S.orders['3001'] = { status: 'ON_GOING', driverId: 'D77' };
  const bs2 = await call('bootstrap', {}, mins(2));
  assert.deepEqual(f.lala().slice(n1).map((c) => c.method + ' ' + c.path), ['GET /v3/orders/3001', 'GET /v3/orders/3001/drivers/D77']);
  const o2 = bs2.orders.find((x) => x.order_no === no);
  assert.deepEqual([o2.status, o2.car.driver, o2.car.plate, o2.car.driver_wa, o2.car.lala_status], ['car', 'Slamet', 'B 9876 TKL', '6281311112222', 'ON_GOING']);
  // … and the cold store got the car by WhatsApp, as in stage 2 (the same template, its six values)
  const carMsg = f.graph().slice(g0);
  assert.equal(carMsg.length, 1);
  assert.deepEqual([carMsg[0].json.to, carMsg[0].json.template.name, carMsg[0].json.template.components[0].parameters.map((x) => x.text)],
    ['6281211112222', 'khair_mobil_brad', [no, 'Bosco', 'Pickup', 'B 9876 TKL', 'Slamet (081311112222)', '10:36']]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM brad_wa_log WHERE kind = 'car' AND order_no = ?").get(no).n, 1);
  // the light poll reads it again later: the same report → nothing new (no driver read, no message)
  const n2 = f.lala().length, g1 = f.graph().length;
  const p = await call('poll', {}, mins(4));
  assert.deepEqual([p.ok, 'lala_due' in p, f.lala().slice(n2).map((c) => c.path), f.graph().length], [true, false, ['/v3/orders/3001'], g1]);
  // in at door 4 (by hand, as before); then the cron finds it picked up → the departure, the goods out of the stock, the customer told
  assert.equal((await call('order_arrived', { order_no: no, time: '10:40', door: '4' }, mins(41))).ok, true);
  f.S.orders['3001'].status = 'PICKED_UP';
  const cr = await at(mins(50), () => handleLalaCron(a, env, f));
  assert.deepEqual([cr.synced, cr.applied], [1, ['departed']]);
  r = rowOf(db, no);
  assert.deepEqual([r.status, r.car.lala_status, r.log[r.log.length - 1].by], ['departed', 'PICKED_UP', 'Lalamove']);
  assert.deepEqual(db.prepare("SELECT pallet_code, cartons, by_user FROM cold_movements WHERE type = 'OUT'").all().map((x) => ({ ...x })), [{ pallet_code: 'AJ-1', cartons: -20, by_user: 'Lalamove' }]);
  assert.equal(f.graph().slice(-1)[0].json.template.name, 'khair_berangkat_brad');
  // the webhook says only "this order changed": it is read from Lalamove itself — a body claiming more is not believed
  const n3 = f.lala().length;
  assert.deepEqual(await at(mins(51), () => handleLalaWebhook(a, JSON.stringify({ eventType: 'ORDER_STATUS_CHANGED', data: { order: { orderId: '3001', status: 'COMPLETED' } } }), env, f)),
    { ok: true, synced: 1, applied: ['same'] });
  assert.equal(rowOf(db, no).status, 'departed'); // Lalamove itself still says PICKED_UP: the body's "COMPLETED" is not believed
  assert.equal(f.lala().length, n3 + 1);
  assert.deepEqual(await at(mins(51), () => handleLalaWebhook(a, JSON.stringify({ data: { order: { orderId: '3001' } } }), env, f)), { ok: true, synced: 0 }); // read a moment ago
  assert.deepEqual(await at(mins(52), () => handleLalaWebhook(a, JSON.stringify({ data: { order: { orderId: '9999' } } }), env, f)), { ok: true, synced: 0 }); // not ours
  assert.deepEqual(await at(mins(52), () => handleLalaWebhook(a, 'not json', env, f)), { ok: true, synced: 0 });
  assert.equal(f.lala().length, n3 + 1);
  f.S.orders['3001'].status = 'COMPLETED';
  const wh = await at(mins(55), () => handleLalaWebhook(a, JSON.stringify({ data: { order: { orderId: '3001' } } }), env, f));
  assert.deepEqual([wh.synced, wh.applied], [1, ['delivered']]);
  r = rowOf(db, no);
  assert.deepEqual([r.status, r.car.lala_status, r.delivered_at], ['delivered', 'COMPLETED', mins(55)]);
  // finished: nothing is read any more
  const n4 = f.lala().length;
  assert.deepEqual(await at(mins(60), () => handleLalaCron(a, env, f)), { ok: true, synced: 0 });
  await call('bootstrap', {}, mins(60));
  assert.equal(f.lala().length, n4);
  assert.equal((await call('bootstrap', {}, mins(60))).lala.spent, 95000);
});

test('lala: a price that rose more than 5 % is asked again; the month\'s cap; one booking at a time; a refused booking leaves the order as it was', async () => {
  const db = seed(), a = sqliteAdapter(db), f = net(), env = { ...LALA };
  const { no, call } = await ready(a, env, f);
  const q = await call('lala_quote', { order_no: no, service: 'VAN' });
  assert.equal(q.quote.price, 95000);
  f.S.price = 100000; // the fresh price is 5.3 % higher
  const pc = await call('lala_book', { order_no: no, service: 'VAN', seen_price: 95000 });
  assert.deepEqual([pc.ok, pc.error, pc.price, pc.seen_price], [false, 'PRICE_CHANGED', 100000, 95000]);
  assert.equal(f.lala().filter((c) => c.path === '/v3/orders').length, 0);
  f.S.price = 99000; // + 4.2 %: booked
  // the month's cap: over it nothing is booked by the server
  await call('settings_save', { lala_cap: 98000 }, W, 'Pemilik', '1234');
  const cp = await call('lala_book', { order_no: no, service: 'VAN', seen_price: 95000 });
  assert.deepEqual([cp.error, cp.spent, cp.cap, cp.price], ['LALA_CAP', 0, 98000, 99000]);
  assert.match(cp.message, /Batas biaya Lalamove bulan ini \(Rp 98\.000\) tercapai/);
  await call('settings_save', { lala_cap: 10000000 }, W, 'Pemilik', '1234');
  // another phone is booking this order right now (its lock) → wait; a minute later the lock is stale
  db.prepare('INSERT INTO brad_lala_locks (order_no, at) VALUES (?, ?)').run(no, '2026-10-14T02:59:50.000Z');
  assert.equal((await call('lala_book', { order_no: no, service: 'VAN', seen_price: 95000 })).error, 'BUSY');
  assert.equal(f.lala().filter((c) => c.path === '/v3/orders').length, 0);
  const b = await call('lala_book', { order_no: no, service: 'VAN', seen_price: 95000 }, mins(2));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM brad_lala_locks').get().n, 0); // released
  // Lalamove refuses (e.g. the wallet is empty): said, nothing kept
  const db2 = seed(), a2 = sqliteAdapter(db2), f2 = net();
  const two = await ready(a2, env, f2);
  const broke = async (u, init) => (String(u).endsWith('/v3/orders') ? new Response(JSON.stringify({ errors: [{ id: 'ERR_INSUFFICIENT_CREDIT', message: 'Insufficient credit' }] }), { status: 402 }) : f2(u, init));
  const rf = await at(W, () => handleBrad(a2, base('lala_book', 'Mgr', '2222', { order_no: two.no, service: 'VAN', seen_price: 95000 }), {}, KEY, { env, fetch: broke }));
  assert.deepEqual([rf.ok, rf.error], [false, 'LALA_ERROR']);
  assert.match(rf.message, /^Lalamove: HTTP 402 ERR_INSUFFICIENT_CREDIT: Insufficient credit$/);
  assert.deepEqual([rowOf(db2, two.no).status, rowOf(db2, two.no).car], ['ready', null]);
});

test('lala: cancelled at Lalamove first, then back to "book a car"; refused by Lalamove → said, staff may cancel it in Lalamove\'s app; already gone there → goes on', async () => {
  const db = seed(), a = sqliteAdapter(db), f = net(), env = { ...LALA };
  const { no, call } = await ready(a, env, f);
  const book = async () => { const q = await call('lala_quote', { order_no: no, service: 'VAN' }); return call('lala_book', { order_no: no, service: 'VAN', seen_price: q.quote.price }); };
  assert.equal((await book()).ok, true);
  assert.equal((await call('lala_cancel', { order_no: no, reason: '' })).error, 'INVALID');
  assert.equal(f.lala().filter((c) => c.method === 'DELETE').length, 0);
  const c = await call('lala_cancel', { order_no: no, reason: 'Pelanggan ambil sendiri' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(f.lala().filter((x) => x.method === 'DELETE').map((x) => x.path), ['/v3/orders/3001']);
  let r = rowOf(db, no);
  assert.deepEqual([r.status, r.car, r.car_cancels, r.log[r.log.length - 1].note], ['ready', null, 1, 'Lalamove dibatalkan: belum ada sopir — Pelanggan ambil sendiri']);
  // booked again; Lalamove refuses the cancel → nothing changes here, staff are told (and offered the manual way)
  assert.equal((await book()).ok, true);
  f.S.cancelRefuse = true;
  const rf = await call('lala_cancel', { order_no: no, reason: 'Salah pesan' });
  assert.deepEqual([rf.ok, rf.error, rf.manual], [false, 'LALA_ERROR', true]);
  assert.match(rf.message, /ERR_CANCELLATION_FORBIDDEN/);
  assert.equal(rowOf(db, no).status, 'car');
  assert.equal((await call('car_cancel', { order_no: no, reason: 'Salah pesan' })).error, 'LALA_ACTIVE');
  // … unless Lalamove has cancelled it on its side already: then it goes on
  f.S.orders['3002'].status = 'CANCELED';
  const gone = await call('lala_cancel', { order_no: no, reason: 'Salah pesan' });
  assert.deepEqual([gone.ok, rowOf(db, no).status, rowOf(db, no).car_cancels], [true, 'ready', 2]);
  // the server cannot reach Lalamove at all: staff cancel it in Lalamove's app, then say so here (logged as such)
  f.S.cancelRefuse = false;
  assert.equal((await book()).ok, true);
  const down = async (u, init) => (/lalamove\.com/.test(String(u)) ? Promise.reject(new Error('network down')) : f(u, init));
  const nd = await at(W, () => handleBrad(a, base('lala_cancel', 'Mgr', '2222', { order_no: no, reason: 'Batal' }), {}, KEY, { env, fetch: down }));
  assert.deepEqual([nd.ok, nd.error, nd.manual], [false, 'LALA_ERROR', true]);
  const man = await call('car_cancel', { order_no: no, reason: 'Dibatalkan di aplikasi Lalamove', manual: true });
  assert.deepEqual([man.ok, man.order.status], [true, 'ready']);
  assert.match(rowOf(db, no).log.pop().note, /\(dibatalkan sendiri di aplikasi Lalamove\)$/);
  // Lalamove cancels by itself (no driver found) → the sync puts the order back to "book a car"
  assert.equal((await book()).ok, true);
  f.S.orders['3004'].status = 'EXPIRED';
  assert.deepEqual((await at(mins(3), () => handleLalaCron(a, env, f))).applied, ['cancelled']);
  r = rowOf(db, no);
  assert.deepEqual([r.status, r.car_cancels, r.log[r.log.length - 1].note], ['ready', 4, 'Lalamove tidak dapat sopir: belum ada sopir — pesan mobil lagi']);
});

test('lala: no keys — LALA_OFF and nothing is called; the manual ways go on; the cron does nothing (no D1 read); the webhook always answers 200', async () => {
  const db = seed(), a = sqliteAdapter(db), f = net(), env = {};
  const { no, call } = await ready(a, env, f);
  const before = f.calls.length;
  for (const [act, d] of [['lala_quote', { order_no: no, service: 'VAN' }], ['lala_book', { order_no: no, service: 'VAN', seen_price: 9 }], ['lala_admin', { op: 'test' }]]) {
    const r = await call(act, d);
    assert.deepEqual([r.ok, r.error], [false, 'LALA_OFF'], act);
    assert.match(r.message, /Lalamove otomatis belum aktif/);
  }
  const st = await call('lala_admin', { op: 'status' });
  assert.deepEqual([st.ok, st.on, st.env, st.set], [true, false, 'sandbox', { key: false, secret: false }]);
  assert.equal((await call('bootstrap', {})).lala.on, false);
  assert.equal(f.calls.length, before); // Lalamove never called
  // the manual ways: a car typed by hand, as in stage 1
  const m = await call('car_save', { order_no: no, via: 'lalamove', driver: 'Pak Budi', plate: 'B 1 AB', driver_wa: '081299990000', eta_min: 20 });
  assert.deepEqual([m.ok, m.order.status, m.order.car.via], [true, 'car', 'lalamove']);
  // a client can never pose as the server: its __sys is dropped (parseBrad), and a system action from it is refused
  assert.equal(parseBrad({ ...base('lala_sync', 'Mgr', '2222'), __sys: 'lalamove' }).__sys, undefined);
  for (const act of ['lala_sync', 'lala_booked', 'lala_cancelled', 'lala_due', 'lala_services']) {
    const r = await at(W, () => handleBrad(a, { ...base(act, 'Mgr', '2222', { __sys: 'lalamove', items: [] }), __sys: 'lalamove' }, {}, KEY, { env: LALA, fetch: f }));
    assert.equal(r.error, 'FORBIDDEN', act);
  }
  // the cron: without the keys not even one D1 read; with them and no open trip, one small read
  const DB = d1Mock(db);
  await worker.scheduled({ cron: '*/2 * * * *' }, { DB, STORE_KEY: KEY });
  assert.equal(DB.calls, 0);
  await worker.scheduled({ cron: '*/2 * * * *' }, { DB, STORE_KEY: KEY, ...LALA });
  assert.equal(DB.calls, 1);
  assert.deepEqual(await handleLalaCron(sqliteAdapter(db), {}, f), { ok: true, synced: 0, skipped: 'LALA_OFF' });
  // the webhook route answers 200 at once, whatever it is sent
  for (const body of ['', 'garbage', JSON.stringify({ data: { order: { orderId: '3001' } } })]) {
    const r = await worker.fetch(new Request('https://w.test/webhook/lalamove', { method: 'POST', body }), { DB: d1Mock(db), STORE_KEY: KEY });
    assert.deepEqual([r.status, await r.text()], [200, 'ok']);
  }
  const g = await worker.fetch(new Request('https://w.test/webhook/lalamove'), { DB: d1Mock(db), STORE_KEY: KEY });
  assert.equal(g.status, 200);
  assert.equal(f.calls.length, before);
});

test('lala: through the Worker — the cron trigger reads an open trip; the D1 calls stay far under the free plan\'s 50', async () => {
  const db = seed(), a = sqliteAdapter(db), f = net(), env = { ...LALA };
  const { no, call } = await ready(a, env, f);
  const q = await call('lala_quote', { order_no: no, service: 'VAN' });
  assert.equal((await call('lala_book', { order_no: no, service: 'VAN', seen_price: q.quote.price })).ok, true);
  f.S.orders['3001'] = { status: 'ON_GOING', driverId: 'D9' };
  const DB = d1Mock(db, { maxCalls: 50 }), realFetch = globalThis.fetch;
  globalThis.fetch = f; // the Worker's own fetch
  try { await at(mins(5), () => worker.scheduled({ cron: '*/2 * * * *' }, { DB, STORE_KEY: KEY, ...LALA })); } finally { globalThis.fetch = realFetch; }
  assert.ok(DB.calls > 1 && DB.calls <= 10, 'D1 calls: ' + DB.calls);
  const o = rowOf(db, no);
  assert.deepEqual([o.status, o.car.driver, o.car.plate, o.car.lala_status, o.car.lala_synced_at], ['car', 'Slamet', 'B 9876 TKL', 'ON_GOING', mins(5)]);
  assert.deepEqual(f.lala().slice(-2).map((c) => c.method + ' ' + c.path), ['GET /v3/orders/3001', 'GET /v3/orders/3001/drivers/D9']);
});

test('lala: the cron and Lalamove\'s webhook at the same moment read a trip once — the goods go out of the stock once', async () => {
  const db = seed(), a = sqliteAdapter(db), f = net(), env = { ...LALA };
  const { no, call } = await ready(a, env, f);
  const q = await call('lala_quote', { order_no: no, service: 'VAN' });
  assert.equal((await call('lala_book', { order_no: no, service: 'VAN', seen_price: q.quote.price })).ok, true);
  assert.equal((await call('order_arrived', { order_no: no, time: '10:20', door: '2' }, mins(21))).ok, true);
  f.S.orders['3001'].status = 'PICKED_UP';
  const reads = f.lala().length;
  const [x, y] = await at(mins(25), () => Promise.all([handleLalaCron(a, env, f), handleLalaWebhook(a, JSON.stringify({ data: { order: { orderId: '3001' } } }), env, f)]));
  assert.deepEqual([x.applied, y.applied].map((v) => (v || []).join()).sort(), ['', 'departed']);
  assert.equal(f.lala().length, reads + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cold_movements WHERE type = 'OUT'").get().n, 1);
  assert.equal(rowOf(db, no).status, 'departed');
});
