// Parity tests for the Field (sales-lapangan) API: the build-time wrap preserves behaviour,
// and the field writer handles both the images upsert and the special product_flags partial
// update of pos_products. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleField, parseField, loadFieldNodes, FIELD_MIGRATIONS } from '../src/field.js';
import { makeAccessor } from '../src/db.js';
import { runProcessField } from '../src/generated/process-field.gen.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const origSrc = readFileSync(new URL('../../backend/field/process-field.js', import.meta.url), 'utf8').replace('__STORE_KEY__', KEY);
const origFieldFn = new Function('$', origSrc);

const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(300); // >100 chars after the data-url strip

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Rani', role: 'sales', pin_hash: h('Rani', '3333'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, shop_stock: 20, active: true });
  insert(db, 'pos_customers', { id: 7, name: 'Toko Berkah', phone: '0812', type: 'grosir', debt_balance: 0 });
  insert(db, 'pos_shops', { id: 1, shop_id: 'S1', name: 'Toko A', area: 'Condet', type: 'toko', status: 'calon', visits: 0 });
  return db;
}

function frozen(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-06T03:00:00.000Z');
  const oR = Math.random; let s = 999;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = oR; }
}

test('field: generated runProcessField == original process-field.js', async () => {
  const cases = [
    base('field_bootstrap', 'Rani', '3333'),
    base('day_start', 'Rani', '3333', { lat: -6.26, lng: 106.86, acc: 10 }),
    base('set_product_image', 'Pemilik', '1234', { product_id: 1, image_base64: IMG }),
    { action: 'field_bootstrap', key: 'WRONG', user: 'Rani', pin_hash: h('Rani', '3333'), data: {} },
    base('field_bootstrap', 'Siti', '1111'), // unknown user
  ];
  for (const body of cases) {
    const nodes = await loadFieldNodes(sqliteAdapter(seed()), parseField(body, {}));
    const $ = makeAccessor(nodes);
    const gen = frozen(() => runProcessField($, KEY)[0].json);
    const orig = frozen(() => origFieldFn($)[0].json);
    assert.deepEqual(gen, orig, 'mismatch for field action ' + body.action);
  }
});

test('field: set_product_image inserts an image and flags the product (product_flags partial update)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('set_product_image', 'Pemilik', '1234', { product_id: 1, image_base64: IMG }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const imgs = a.all('SELECT * FROM pos_product_images WHERE product_id = 1', []);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].image_base64.length, 300); // data-url prefix stripped
  // product_flags → UPDATE pos_products.image_updated only (other columns untouched)
  const p = a.all('SELECT image_updated, stock, active FROM pos_products WHERE id = 1', [])[0];
  assert.ok(p.image_updated, 'image_updated stamped');
  assert.equal(p.stock, 20, 'stock untouched by the partial update');
  assert.equal(p.active, 1, 'active untouched');
});

test('field: day_start inserts a working day for the sales rep', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('day_start', 'Rani', '3333', { lat: -6.26, lng: 106.86, acc: 10 }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const days = a.all("SELECT * FROM pos_field_days WHERE user = 'Rani'", []);
  assert.equal(days.length, 1);
  assert.equal(days[0].day_date, new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10));
});

test('field: kasir may not use field actions beyond cashier_orders', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  const r = await handleField(sqliteAdapter(db), base('field_bootstrap', 'Siti', '1111'), {}, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FORBIDDEN');
});

test('field v30: check_in stores the star rating on the visit', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'ci1', shop_id: 'S1', lat: -6.26, lng: 106.86, acc: 10, outcome: 'tertarik', rating: 4, notes: 'ramah' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = a.all("SELECT * FROM pos_visits WHERE client_id = 'ci1'", [])[0];
  assert.ok(v, 'visit saved');
  assert.equal(v.rating, 4);
});

test('field v30: field_order stores the payment method', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('field_order', 'Rani', '3333', { client_id: 'fo1', shop_id: 'S1', payment_method: 'tempo', items: [{ product_id: 1, qty: 3 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const o = a.all("SELECT * FROM pos_field_orders WHERE client_id = 'fo1'", [])[0];
  assert.ok(o, 'order saved');
  assert.equal(o.payment_method, 'tempo');
});

test('field v30: the accountant may read the field report; a sales rep may not', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 5, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  const a = sqliteAdapter(db);
  const ra = await handleField(a, base('list_field', 'Aqil', '4444', { from: '2026-10-01', to: '2026-10-31' }), {}, KEY);
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.ok(Array.isArray(ra.visits), 'visits array returned to the accountant');
  const rs = await handleField(a, base('list_field', 'Rani', '3333', { from: '2026-10-01', to: '2026-10-31' }), {}, KEY);
  assert.equal(rs.ok, false);
  assert.equal(rs.error, 'FORBIDDEN');
});

// ---- v31: route plan made before setting off (owner 2026-10-11) ----
const TODAY = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const plus = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const PLAN = (date) => ({ plan_date: date, start: { label: 'Jl. Raya Condet', lat: -6.2731, lng: 106.8582 }, note: 'pagi',
  stops: [{ ref: 'shop:S1', shop_id: 'S1', name: 'Toko A', lat: -6.2700, lng: 106.8600, src: 'shop' },
    { ref: 'osm:n42', name: 'Minimarket Baru', lat: -6.2750, lng: 106.8590, address: 'Jl. Raya Condet 12', type: 'minimarket', src: 'osm' }] });

test('field v31: generated == original for plan_save', async () => {
  const body = base('plan_save', 'Rani', '3333', PLAN(TODAY()));
  const nodes = await loadFieldNodes(sqliteAdapter(seed()), parseField(body, {}));
  const $ = makeAccessor(nodes);
  assert.deepEqual(frozen(() => runProcessField($, KEY)[0].json), frozen(() => origFieldFn($)[0].json));
});

test('field v31: plan_save stores the day plan; saving again replaces it; bootstrap returns it', async () => {
  const db = seed(); const a = sqliteAdapter(db);
  const r = await handleField(a, base('plan_save', 'Rani', '3333', PLAN(plus(TODAY(), 1))), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan.stops.length, 2);
  assert.equal(r.plan.stops[0].kind, 'shop');
  assert.equal(r.plan.stops[1].kind, 'place');
  assert.equal(r.plan.stops[1].type, 'minimarket');
  assert.equal(r.plan.start.label, 'Jl. Raya Condet');
  const p2 = PLAN(plus(TODAY(), 1)); p2.stops = p2.stops.slice(1);
  const r2 = await handleField(a, base('plan_save', 'Rani', '3333', p2), {}, KEY);
  assert.equal(r2.plan.plan_id, r.plan.plan_id, 'same plan id (replaced, not duplicated)');
  assert.equal(a.all('SELECT COUNT(*) AS n FROM pos_route_plans', [])[0].n, 1);
  const b = await handleField(a, base('field_bootstrap', 'Rani', '3333'), {}, KEY);
  assert.equal(b.plans.length, 1);
  assert.equal(b.plans[0].stops.length, 1);
});

test('field v31: an unknown shop_id becomes a place; bad date / position are refused', async () => {
  const a = sqliteAdapter(seed());
  const p = PLAN(TODAY()); p.stops[0].shop_id = 'NOPE';
  const r = await handleField(a, base('plan_save', 'Rani', '3333', p), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan.stops[0].kind, 'place');
  const old = await handleField(a, base('plan_save', 'Rani', '3333', PLAN(plus(TODAY(), -1))), {}, KEY);
  assert.equal(old.ok, false); assert.equal(old.error, 'INVALID');
  const far = await handleField(a, base('plan_save', 'Rani', '3333', PLAN(plus(TODAY(), 30))), {}, KEY);
  assert.equal(far.ok, false);
  const bad = PLAN(TODAY()); bad.stops[1].lat = 999;
  const rb = await handleField(a, base('plan_save', 'Rani', '3333', bad), {}, KEY);
  assert.equal(rb.ok, false); assert.equal(rb.error, 'INVALID');
});

test('field v31: the owner sees the rep plans in list_field; only a sales rep may save one', async () => {
  const a = sqliteAdapter(seed());
  await handleField(a, base('plan_save', 'Rani', '3333', PLAN(TODAY())), {}, KEY);
  const l = await handleField(a, base('list_field', 'Pemilik', '1234', { from: TODAY(), to: TODAY() }), {}, KEY);
  assert.equal(l.ok, true, JSON.stringify(l));
  assert.equal(l.plans.length, 1);
  assert.equal(l.plans[0].user, 'Rani');
  const o = await handleField(a, base('plan_save', 'Pemilik', '1234', PLAN(TODAY())), {}, KEY);
  assert.equal(o.ok, false); assert.equal(o.error, 'FORBIDDEN');
});

// ---- v31b: start + END point, work streets, shared "worked streets" map (owner 2026-10-11) ----
const STREET = { ref: 'st:jalan raya condet', name: 'Jalan Raya Condet', lines: [[[-6.2850, 106.8570], [-6.2731, 106.8582], [-6.2650, 106.8595]]] };

test('field v31b: the plan keeps the end point and the work streets (lines rounded, junk dropped)', async () => {
  const a = sqliteAdapter(seed());
  const p = PLAN(TODAY()); p.end = { label: 'Pasar Kramat Jati', lat: -6.2700, lng: 106.8650 };
  p.streets = [STREET, { name: '' }, { name: 'Jl. Bad', lines: [[[999, 1], [1, 2]]] }];
  const r = await handleField(a, base('plan_save', 'Rani', '3333', p), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan.end.label, 'Pasar Kramat Jati');
  assert.equal(r.plan.streets.length, 2, 'nameless street dropped');
  assert.equal(r.plan.streets[0].lines[0].length, 3);
  assert.equal(r.plan.streets[1].lines.length, 0, 'invalid points dropped');
});

test('field v31b: streets_worked shows every rep the streets other reps worked (latest per street + rep)', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 6, name: 'Budi', role: 'sales', pin_hash: h('Budi', '6666'), active: true });
  const a = sqliteAdapter(db);
  const p = PLAN(TODAY()); p.streets = [STREET];
  assert.equal((await handleField(a, base('plan_save', 'Rani', '3333', p), {}, KEY)).ok, true);
  const p2 = PLAN(plus(TODAY(), 1)); p2.streets = [STREET];
  assert.equal((await handleField(a, base('plan_save', 'Rani', '3333', p2), {}, KEY)).ok, true);
  const w = await handleField(a, base('streets_worked', 'Budi', '6666'), {}, KEY);
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.streets.length, 1, 'one entry per street and rep');
  assert.equal(w.streets[0].user, 'Rani');
  assert.equal(w.streets[0].plan_date, plus(TODAY(), 1), 'latest date wins');
  assert.equal(w.streets[0].status, 'planned');
  assert.equal(w.streets[0].lines[0].length, 3);
  const o = await handleField(a, base('streets_worked', 'Pemilik', '1234'), {}, KEY);
  assert.equal(o.ok, true);
});

// ---- v32: a work line drawn point by point + the kind of shop searched for along it (owner 2026-10-11) ----
test('field v32: a drawn work line keeps its flag and is its own entry on the shared map; a stop keeps its search kind', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 6, name: 'Budi', role: 'sales', pin_hash: h('Budi', '6666'), active: true });
  const a = sqliteAdapter(db);
  const line = n => ({ ref: 'ln:' + n, name: 'Garis kerja 1', drawn: true, lines: [[[-6.2800, 106.8500 + n / 100], [-6.2790, 106.8520 + n / 100]]] });
  const p = PLAN(TODAY()); p.streets = [line(1), STREET]; p.stops[1].cat = 'kurma'; p.stops[0].cat = 'Bad Kind!';
  const r = await handleField(a, base('plan_save', 'Rani', '3333', p), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan.streets[0].drawn, true);
  assert.equal(r.plan.streets[1].drawn, undefined, 'a named street stays a street');
  assert.equal(r.plan.stops[1].cat, 'kurma');
  assert.equal(r.plan.stops[0].cat, undefined, 'junk kind dropped');
  // two drawn lines with the same default name on different days are NOT merged into one (unlike a named street)
  const p2 = PLAN(plus(TODAY(), 1)); p2.streets = [line(2)];
  assert.equal((await handleField(a, base('plan_save', 'Rani', '3333', p2), {}, KEY)).ok, true);
  const w = await handleField(a, base('streets_worked', 'Budi', '6666'), {}, KEY);
  assert.equal(w.ok, true, JSON.stringify(w));
  const drawn = w.streets.filter(x => x.drawn);
  assert.equal(drawn.length, 2);
  assert.deepEqual(drawn.map(x => x.ref).sort(), ['ln:1', 'ln:2']);
  assert.equal(w.streets.filter(x => !x.drawn).length, 1);
});

// ---- v32: the shared streets map is KEPT FOREVER (owner 2026-10-11: "always, not only 60 days") ----
test('field v32: a street worked long ago still shows; a street taken out of a plan disappears; only the area around the rep is sent', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 6, name: 'Budi', role: 'sales', pin_hash: h('Budi', '6666'), active: true });
  const a = sqliteAdapter(db);
  // Rani worked Jalan Lama 200 days ago (far older than the old 60-day window)
  insert(db, 'pos_street_log', { id: 1, skey: 'st:jalan lama', user: 'Rani', name: 'Jalan Lama', plan_date: plus(TODAY(), -200), plan_id: 'RPOLD', drawn: 0, ref: 'st:jalan lama',
    lines: JSON.stringify([[[-6.2900, 106.8500], [-6.2910, 106.8510]]]), min_lat: -6.2910, max_lat: -6.2900, min_lng: 106.8500, max_lng: 106.8510, removed: 0, updated_at: '' });
  // ... and a street in Bandung (far away from Jakarta)
  insert(db, 'pos_street_log', { id: 2, skey: 'st:jalan braga', user: 'Rani', name: 'Jalan Braga', plan_date: plus(TODAY(), -10), plan_id: 'RPBDG', drawn: 0, ref: 'st:jalan braga',
    lines: JSON.stringify([[[-6.9170, 107.6090], [-6.9150, 107.6095]]]), min_lat: -6.9170, max_lat: -6.9150, min_lng: 107.6090, max_lng: 107.6095, removed: 0, updated_at: '' });
  const p = PLAN(plus(TODAY(), 1)); p.streets = [STREET, { ref: 'st:jalan b', name: 'Jalan B', lines: [[[-6.2600, 106.8600], [-6.2610, 106.8610]]] }];
  assert.equal((await handleField(a, base('plan_save', 'Rani', '3333', p), {}, KEY)).ok, true);
  const all = await handleField(a, base('streets_worked', 'Budi', '6666'), {}, KEY);
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.deepEqual(all.streets.map(x => x.name).sort(), ['Jalan B', 'Jalan Braga', 'Jalan Lama', 'Jalan Raya Condet']);
  assert.equal(all.streets.find(x => x.name === 'Jalan Lama').status, 'worked');
  // around the rep in Jakarta: Bandung is left out
  const near = await handleField(a, base('streets_worked', 'Budi', '6666', { lat: -6.2735, lng: 106.8580 }), {}, KEY);
  assert.deepEqual(near.streets.map(x => x.name).sort(), ['Jalan B', 'Jalan Lama', 'Jalan Raya Condet']);
  // Rani changes tomorrow's plan: Jalan B is no longer planned → gone from the map; the plan keeps one log row per street
  const p2 = PLAN(plus(TODAY(), 1)); p2.streets = [STREET];
  assert.equal((await handleField(a, base('plan_save', 'Rani', '3333', p2), {}, KEY)).ok, true);
  const after = await handleField(a, base('streets_worked', 'Budi', '6666', { lat: -6.2735, lng: 106.8580 }), {}, KEY);
  assert.deepEqual(after.streets.map(x => x.name).sort(), ['Jalan Lama', 'Jalan Raya Condet']);
  assert.equal(a.all("SELECT COUNT(*) AS n FROM pos_street_log WHERE skey = 'st:jalan raya condet'", [])[0].n, 1, 'saving again updates, not duplicates');
});

test('field v32: the streets of plans made before the log are copied into it once', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 6, name: 'Budi', role: 'sales', pin_hash: h('Budi', '6666'), active: true });
  const a = sqliteAdapter(db);
  insert(db, 'pos_route_plans', { id: 1, plan_id: 'RPV31', user: 'Rani', plan_date: plus(TODAY(), -90), start_label: '', start_lat: 0, start_lng: 0, stops: '[]', note: '',
    created_at: '', updated_at: '', end_label: '', end_lat: 0, end_lng: 0, streets: JSON.stringify([STREET, { name: '' }]) });
  for (const sql of FIELD_MIGRATIONS) { try { await a.run(sql, []); } catch (e) { /* already there */ } }
  for (const sql of FIELD_MIGRATIONS) { try { await a.run(sql, []); } catch (e) { /* second run: nothing copied twice */ } }
  assert.equal(a.all('SELECT COUNT(*) AS n FROM pos_street_log', [])[0].n, 1);
  const w = await handleField(a, base('streets_worked', 'Budi', '6666', { lat: -6.2735, lng: 106.8580 }), {}, KEY);
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.streets.length, 1);
  assert.equal(w.streets[0].name, 'Jalan Raya Condet');
  assert.equal(w.streets[0].lines[0].length, 3);
  assert.equal(w.streets[0].status, 'worked');
});

// ---- v32: visit result colours — black results (closed / not there / changed business) carry a photo of the place ----
test('field v32: the new black results are accepted; a photo of the place needs no owner consent for them (only for them)', async () => {
  const a = sqliteAdapter(seed());
  const PH = 'A'.repeat(400);
  const r = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'b1', shop_id: 'S1', lat: -6.26, lng: 106.86, acc: 10, outcome: 'ganti_usaha', photo_base64: PH, photo_place: true }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.visit.outcome, 'ganti_usaha');
  const v = a.all("SELECT * FROM pos_visits WHERE client_id = 'b1'", [])[0];
  assert.equal(v.photo_thumb, PH, 'place photo kept without consent');
  // the same flag on a non-black result does not bypass the consent rule
  const r2 = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'b2', shop_id: 'S1', lat: -6.26, lng: 106.86, acc: 10, outcome: 'tertarik', photo_base64: PH, photo_place: true }), {}, KEY);
  assert.equal(r2.ok, true);
  assert.equal(a.all("SELECT * FROM pos_visits WHERE client_id = 'b2'", [])[0].photo_thumb, '');
  // a black result without a photo (an old app copy) is still recorded, with a warning
  const r3 = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'b3', shop_id: 'S1', lat: -6.26, lng: 106.86, acc: 10, outcome: 'tidak_ada' }), {}, KEY);
  assert.equal(r3.ok, true);
  assert.equal(r3.visit.outcome, 'tidak_ada');
  assert.ok(r3.warnings.length >= 1);
});

// ---- v33: shop lists from Google Maps, sent by the office (manager / accountant / cashier) to a rep ----
const GPLACES = [
  { name: 'Toko Kurma Barokah', address: 'Jl. Raya Condet No.12', url: 'https://maps.app.goo.gl/AbC123', lat: null, lng: null },
  { name: 'Perlengkapan Haji Al-Amin', address: 'Jl. Raya Condet No.40', phone: '0812-3456-7890', url: 'https://www.google.com/maps/place/X/@-6.276,106.858,17z/data=!3d-6.27612!4d106.85871', lat: -6.27612, lng: 106.85871 },
  { name: '', address: 'no name: dropped' }, { name: 'Bad link', url: 'https://evil.example/x', lat: 999, lng: 1 }];
function officeDb() {
  const db = seed();
  insert(db, 'pos_users', { id: 7, name: 'Kasir1', role: 'kasir', pin_hash: h('Kasir1', '7777'), active: true });
  insert(db, 'pos_users', { id: 8, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '8888'), active: true });
  return db;
}
test('field v33: the cashier / accountant send a rep a shop list; it reaches the rep at bootstrap; the ack marks it received', async () => {
  const a = sqliteAdapter(officeDb());
  const reps = await handleField(a, base('list_reps', 'Kasir1', '7777'), {}, KEY);
  assert.deepEqual(reps.reps, ['Rani']);
  const r = await handleField(a, base('list_send', 'Kasir1', '7777', { to_user: 'rani', plan_date: plus(TODAY(), 1), street: 'Jalan Raya Condet', places: GPLACES, note: 'pagi' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.list.to_user, 'Rani');
  assert.equal(r.list.places.length, 3, 'nameless place dropped');
  assert.equal(r.list.places[2].url, '', 'only Google Maps links kept');
  assert.equal(r.list.places[2].lat, null, 'invalid position dropped');
  assert.equal(r.list.places[1].phone, '081234567890');
  const r2 = await handleField(a, base('list_send', 'Aqil', '8888', { to_user: 'Rani', plan_date: TODAY(), street: 'Jalan B', places: GPLACES.slice(1, 2) }), {}, KEY);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  // the rep's phone gets both at bootstrap
  const b = await handleField(a, base('field_bootstrap', 'Rani', '3333'), {}, KEY);
  assert.equal(b.lists.length, 2);
  assert.equal(b.lists.find(l => l.street === 'Jalan Raya Condet').from_user, 'Kasir1');
  const ack = await handleField(a, base('list_ack', 'Rani', '3333', { list_ids: [r.list.list_id] }), {}, KEY);
  assert.equal(ack.acked, 1);
  const b2 = await handleField(a, base('field_bootstrap', 'Rani', '3333'), {}, KEY);
  assert.deepEqual(b2.lists.map(l => l.street), ['Jalan B']);
  // the office sees what it sent and that it was received
  const sent = await handleField(a, base('lists_sent', 'Kasir1', '7777'), {}, KEY);
  assert.equal(sent.lists.length, 1);
  assert.equal(sent.lists[0].status, 'received');
  assert.equal(sent.lists[0].n, 3);
  const all = await handleField(a, base('lists_sent', 'Pemilik', '1234'), {}, KEY);
  assert.equal(all.lists.length, 2, 'the owner sees every list');
});
test('field v33: shop-list rules — only to a sales rep, a date today … +14, not by a rep; the kasir still cannot read the field report', async () => {
  const a = sqliteAdapter(officeDb());
  const toKasir = await handleField(a, base('list_send', 'Pemilik', '1234', { to_user: 'Kasir1', plan_date: TODAY(), places: GPLACES }), {}, KEY);
  assert.equal(toKasir.error, 'INVALID');
  const late = await handleField(a, base('list_send', 'Pemilik', '1234', { to_user: 'Rani', plan_date: plus(TODAY(), 30), places: GPLACES }), {}, KEY);
  assert.equal(late.error, 'INVALID');
  const empty = await handleField(a, base('list_send', 'Pemilik', '1234', { to_user: 'Rani', plan_date: TODAY(), places: [{ name: '' }] }), {}, KEY);
  assert.equal(empty.error, 'INVALID');
  const byRep = await handleField(a, base('list_send', 'Rani', '3333', { to_user: 'Rani', plan_date: TODAY(), places: GPLACES }), {}, KEY);
  assert.equal(byRep.error, 'FORBIDDEN');
  const kRead = await handleField(a, base('list_field', 'Kasir1', '7777', { from: TODAY(), to: TODAY() }), {}, KEY);
  assert.equal(kRead.error, 'FORBIDDEN');
  const kAck = await handleField(a, base('list_ack', 'Kasir1', '7777', { list_ids: ['x'] }), {}, KEY);
  assert.equal(kAck.error, 'FORBIDDEN');
});
test('field v33: resolve_links follows a Google Maps short link (redirects only) to the place position; other hosts are refused', async () => {
  const a = sqliteAdapter(officeDb());
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push([url, opts.redirect]);
    const hop = { 'https://maps.app.goo.gl/AbC123': 'https://www.google.com/maps/place/Toko+Kurma+Barokah/@-6.2741,106.8583,17z/data=!4m6!3m5!8m2!3d-6.27405!4d106.85834!16s',
      'https://maps.app.goo.gl/NoPos': 'https://maps.google.com/?q=Toko+Tanpa+Titik,+Jl.+Raya+Condet&ftid=0x1:0x2',
      'https://maps.app.goo.gl/Away': 'https://consent.example.com/?continue=x' }[url];
    return { status: hop ? 302 : 200, headers: { get: k => (k === 'location' ? hop || null : null) }, body: { cancel: async () => { } } };
  };
  const r = await handleField(a, base('resolve_links', 'Rani', '3333', { urls: ['https://maps.app.goo.gl/AbC123', 'https://maps.app.goo.gl/NoPos', 'https://maps.app.goo.gl/Away', 'https://evil.example/x'] }), {}, KEY, { fetch: fakeFetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.links.length, 3, 'the non-Google link is not followed');
  assert.deepEqual([r.links[0].lat, r.links[0].lng, r.links[0].exact, r.links[0].name], [-6.27405, 106.85834, true, 'Toko Kurma Barokah']);
  assert.equal(r.links[1].ok, false); assert.equal(r.links[1].name, 'Toko Tanpa Titik, Jl. Raya Condet'); // no position: the app looks the name up
  assert.equal(r.links[2].ok, false);
  assert.ok(calls.every(c => c[1] === 'manual'), 'redirects are followed by hand, no page is read');
  assert.ok(!calls.some(c => /evil|consent/.test(c[0])), 'never leaves Google Maps');
  const none = await handleField(a, base('resolve_links', 'Kasir1', '7777', { urls: ['https://evil.example/x'] }), {}, KEY, { fetch: fakeFetch });
  assert.equal(none.error, 'INVALID');
});

// ---- v34: Google Places search from the Worker, hard monthly cap (4,500 < Google's free 5,000) ----
test('field v34: Google Places — no key = nothing counted or called; along a drawn line; capped at 4,500 a month', async () => {
  const db = seed(); const a = sqliteAdapter(db);
  const calls = [];
  const gfetch = async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push({ url, body, mask: opts.headers['X-Goog-FieldMask'], key: opts.headers['X-Goog-Api-Key'] });
    if (body.searchAlongRouteParameters && body.textQuery === 'tolak rute') return { status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT' } }) };
    return { status: 200, json: async () => ({ places: [
      { id: 'g1', displayName: { text: 'Toko Kurma Al-Madinah' }, formattedAddress: 'Jl. Raya Condet No.5', location: { latitude: -6.2745, longitude: 106.8583 }, types: ['store'], primaryType: 'store', googleMapsUri: 'https://maps.google.com/?cid=1', businessStatus: 'OPERATIONAL' },
      { id: 'g2', displayName: { text: 'Toko Tutup Selamanya' }, location: { latitude: -6.275, longitude: 106.859 }, businessStatus: 'CLOSED_PERMANENTLY' }] }) };
  };
  const LINE = [[-6.2735, 106.8580], [-6.2765, 106.8585], [-6.2795, 106.8590]];
  const s0 = await handleField(a, base('places_status', 'Rani', '3333'), {}, KEY, { env: {} });
  assert.equal(s0.ok, true); assert.equal(s0.enabled, false); assert.equal(s0.cap, 4500);
  const nk = await handleField(a, base('places_search', 'Rani', '3333', { q: 'toko kurma', line: LINE }), {}, KEY, { env: {}, fetch: gfetch });
  assert.equal(nk.error, 'NO_KEY');
  assert.equal(calls.length, 0);
  assert.equal(a.all('SELECT COUNT(*) AS n FROM pos_api_usage', [])[0].n, 0, 'nothing counted without a key');
  const env = { GOOGLE_PLACES_KEY: 'AIza-test' };
  const r = await handleField(a, base('places_search', 'Rani', '3333', { q: 'toko kurma', line: LINE }), {}, KEY, { env, fetch: gfetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'route');
  assert.deepEqual(r.places.map(p => p.name), ['Toko Kurma Al-Madinah'], 'permanently closed places dropped');
  assert.equal(calls[0].key, 'AIza-test');
  assert.ok(calls[0].body.searchAlongRouteParameters.polyline.encodedPolyline.length > 5);
  assert.ok(!/Phone|rating|Hours|website/i.test(calls[0].mask), 'only the "Pro" fields (no phone / rating / hours) — the 5,000-free SKU');
  assert.equal(r.usage.n, 1);
  // Google refuses the line → one retry around it (a circle)
  const r2 = await handleField(a, base('places_search', 'Rani', '3333', { q: 'tolak rute', line: LINE }), {}, KEY, { env, fetch: gfetch });
  assert.equal(r2.mode, 'circle'); assert.ok(calls[2].body.locationBias.circle.radius >= 300);
  // the owner sees the month's count; at the cap nothing is called any more
  const st = await handleField(a, base('places_status', 'Pemilik', '1234'), {}, KEY, { env });
  assert.equal(st.enabled, true); assert.equal(st.n, 2);
  a.run("UPDATE pos_api_usage SET n = 4500", []);
  const before = calls.length;
  const capped = await handleField(a, base('places_search', 'Rani', '3333', { q: 'toko kurma', lat: -6.27, lng: 106.86 }), {}, KEY, { env, fetch: gfetch });
  assert.equal(capped.error, 'QUOTA');
  assert.equal(calls.length, before, 'no Google call over the cap');
  const kas = await handleField(a, base('places_search', 'Pemilik', '1234', { q: 'x' }), {}, KEY, { env, fetch: gfetch });
  assert.equal(kas.error, 'INVALID');
});

test('field v34b: a key pasted with spaces / quotes is cleaned; Google\'s own error words reach the owner (never the key)', async () => {
  const a = sqliteAdapter(seed());
  const seen = [];
  const gfetch = async (url, opts) => {
    seen.push(opts.headers['X-Goog-Api-Key']);
    const body = JSON.parse(opts.body);
    if (body.textQuery === 'salah') return { status: 400, json: async () => ({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key. (AIzaSyDUMMYDUMMYDUMMY)' } }) };
    assert.equal(body.pageSize, 20);
    return { status: 200, json: async () => ({ places: [] }) };
  };
  const env = { GOOGLE_PLACES_KEY: '  "AIza-clean-me"\n' };
  const ok = await handleField(a, base('places_search', 'Pemilik', '1234', { q: 'toko kurma', lat: -6.27, lng: 106.86 }), {}, KEY, { env, fetch: gfetch });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(seen[0], 'AIza-clean-me');
  const bad = await handleField(a, base('places_search', 'Pemilik', '1234', { q: 'salah', lat: -6.27, lng: 106.86 }), {}, KEY, { env, fetch: gfetch });
  assert.equal(bad.error, 'GOOGLE');
  assert.match(bad.message, /^Google: 400 INVALID_ARGUMENT — API key not valid/);
  assert.ok(!/AIzaSyDUMMY/.test(bad.message), 'a key in Google\'s message is hidden');
});

// ---- v36 (owner 2026-10-11): new shop = owner photo + shop photo + phone + address; accountant reads the field page;
//      every rep's orders on a map; go back to the best streets (return time set by the manager) ----
const PH = 'data:image/jpeg;base64,/9j/' + 'B'.repeat(400);
const SH = 'data:image/jpeg;base64,/9j/' + 'C'.repeat(500);
test('field v36: a new shop keeps the owner photo + the shop front photo; the shop names the visit; shop_photos reads them', async () => {
  const db = officeDb(); const a = sqliteAdapter(db);
  const r = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'ns1', lat: -6.27, lng: 106.86, acc: 8, outcome: 'tertarik', rating: 5,
    shop: { name: 'Toko Foto', owner_name: 'Bu Sari', phone: '0812 1111 2222', address: 'Jl. Raya Condet 7', type: 'toko' },
    photo_base64: PH, photo_consent: true, shop_photo_base64: SH }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.warnings, [], 'nothing missing');
  assert.equal(r.visit.photo_thumb, undefined, 'photos are not echoed back');
  assert.equal(r.visit.shop_photo, undefined);
  assert.equal(r.shop.photo_visit, r.visit.visit_id);
  const v = a.all("SELECT * FROM pos_visits WHERE client_id = 'ns1'", [])[0];
  assert.equal(v.shop_photo, '/9j/' + 'C'.repeat(500));
  assert.equal(v.photo_thumb, '/9j/' + 'B'.repeat(400));
  assert.equal(a.all('SELECT photo_visit FROM pos_shops WHERE shop_id = ?', [r.shop.shop_id])[0].photo_visit, r.visit.visit_id);
  // read when opened: the rep, the owner and the accountant; the cashier may not
  for (const [u, p] of [['Rani', '3333'], ['Pemilik', '1234'], ['Aqil', '8888']]) {
    const ph = await handleField(a, base('shop_photos', u, p, { shop_id: r.shop.shop_id }), {}, KEY);
    assert.equal(ph.ok, true, JSON.stringify(ph));
    assert.equal(ph.owner_photo, '/9j/' + 'B'.repeat(400));
    assert.equal(ph.shop_photo, '/9j/' + 'C'.repeat(500));
    assert.equal(ph.user, 'Rani');
  }
  assert.equal((await handleField(a, base('shop_photos', 'Kasir1', '7777', { shop_id: r.shop.shop_id }), {}, KEY)).error, 'FORBIDDEN');
  // the owner's ≤ 31-day report carries both photos; a long range carries none
  const l = await handleField(a, base('list_field', 'Aqil', '8888', { from: TODAY(), to: TODAY() }), {}, KEY);
  const lv = l.visits.find(x => x.client_id === 'ns1');
  assert.equal(lv.rating, 5); assert.ok(lv.shop_photo && lv.photo_thumb);
  const ll = await handleField(a, base('list_field', 'Pemilik', '1234', { from: plus(TODAY(), -100), to: TODAY() }), {}, KEY);
  assert.equal(ll.visits.find(x => x.client_id === 'ns1').shop_photo, undefined);
});
test('field v36: an old app copy (no phone / address / photos) is still accepted, with warnings; a refusal is noted', async () => {
  const a = sqliteAdapter(seed());
  const r = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'ns2', lat: -6.27, lng: 106.86, acc: 8, outcome: 'tertarik', shop: { name: 'Toko Lama', type: 'toko' } }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warnings.length, 4);
  const r2 = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'ns3', lat: -6.27, lng: 106.86, acc: 8, outcome: 'tertarik', owner_photo_refused: true, notes: 'ramah',
    shop: { name: 'Toko Malu', phone: '0812', address: 'Jl. X', type: 'toko' }, shop_photo_base64: SH }), {}, KEY);
  assert.deepEqual(r2.warnings, []);
  assert.match(a.all("SELECT notes FROM pos_visits WHERE client_id = 'ns3'", [])[0].notes, /^\[Pemilik tidak bersedia difoto\] ramah$/);
});
test('field v36: migrations add the photo columns to an older database (idempotent)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE pos_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, visit_id TEXT, shop_id TEXT, photo_thumb TEXT); CREATE TABLE pos_shops (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id TEXT); CREATE TABLE pos_field_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT); CREATE TABLE pos_route_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, user TEXT, plan_date TEXT, start_label TEXT, start_lat REAL, start_lng REAL, stops TEXT, note TEXT, created_at TEXT, updated_at TEXT)');
  const a = sqliteAdapter(db);
  for (let k = 0; k < 2; k++) for (const sql of FIELD_MIGRATIONS) { try { await a.run(sql, []); } catch (e) { /* already there */ } }
  const cols = t => a.all(`PRAGMA table_info(${t})`, []).map(c => c.name);
  assert.ok(cols('pos_visits').includes('shop_photo'));
  assert.ok(cols('pos_shops').includes('photo_visit'));
});

test('field v36: orders_map — every rep\'s accepted orders, oldest first, with the shop position and area; not for a rep', async () => {
  const db = officeDb();
  insert(db, 'pos_shops', { id: 2, shop_id: 'S2', name: 'Toko B', area: 'Cililitan', type: 'toko', status: 'pelanggan', visits: 1, lat: -6.26, lng: 106.87 });
  insert(db, 'pos_shops', { id: 3, shop_id: 'S3', name: 'Toko C', area: '', type: 'toko', status: 'prospek', visits: 1 });
  const D = TODAY();
  insert(db, 'pos_field_orders', { order_id: 'O2', client_id: 'c2', user: 'Budi', order_date: D, order_time: D + 'T03:10:00.000Z', shop_id: 'S2', shop_name: 'Toko B', items: '[]', total: 50000, status: 'baru' });
  insert(db, 'pos_field_orders', { order_id: 'O1', client_id: 'c1', user: 'Rani', order_date: D, order_time: D + 'T02:00:00.000Z', shop_id: 'S2', shop_name: 'Toko B', items: '[]', total: 75000, status: 'diproses' });
  insert(db, 'pos_field_orders', { order_id: 'O3', client_id: 'c3', user: 'Rani', order_date: D, order_time: D + 'T04:00:00.000Z', shop_id: 'S3', shop_name: 'Toko C', items: '[]', total: 10000, status: 'baru' });
  insert(db, 'pos_field_orders', { order_id: 'OX', client_id: 'cx', user: 'Rani', order_date: D, order_time: D + 'T01:00:00.000Z', shop_id: 'S2', shop_name: 'Toko B', items: '[]', total: 1, status: 'batal' });
  insert(db, 'pos_field_orders', { order_id: 'OOLD', client_id: 'co', user: 'Rani', order_date: plus(D, -40), order_time: '', shop_id: 'S2', shop_name: 'Toko B', items: '[]', total: 1, status: 'dikirim' });
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('orders_map', 'Aqil', '8888', { from: plus(D, -6), to: D }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.orders.map(o => o.order_id), ['O1', 'O2', 'O3'], 'cancelled and out-of-range left out; acceptance order');
  assert.deepEqual([r.orders[0].lat, r.orders[0].lng, r.orders[0].area], [-6.26, 106.87, 'Cililitan']);
  assert.equal(r.orders[2].lat, null, 'a shop without a position has no pin');
  const one = await handleField(a, base('orders_map', 'Pemilik', '1234', { from: plus(D, -6), to: D, user: 'budi' }), {}, KEY);
  assert.deepEqual(one.orders.map(o => o.order_id), ['O2']);
  assert.equal((await handleField(a, base('orders_map', 'Rani', '3333', { from: D, to: D }), {}, KEY)).error, 'FORBIDDEN');
  assert.equal((await handleField(a, base('orders_map', 'Pemilik', '1234', { from: plus(D, -200), to: D }), {}, KEY)).error, 'INVALID');
});

const SLINE = [[-6.2700, 106.8600], [-6.2750, 106.8600], [-6.2800, 106.8600]];
function streetsDb() {
  const db = officeDb();
  insert(db, 'pos_users', { id: 6, name: 'Budi', role: 'sales', pin_hash: h('Budi', '6666'), active: true });
  const D = TODAY();
  const log = (skey, user, name, date, lines, extra = {}) => insert(db, 'pos_street_log', Object.assign({ skey, user, name, plan_date: date, plan_id: 'P' + date + user, drawn: 0, ref: skey, lines: JSON.stringify(lines), min_lat: -90, max_lat: 90, min_lng: -180, max_lng: 180, removed: 0, updated_at: '' }, extra));
  log('st:jalan bagus', 'Rani', 'Jalan Bagus', plus(D, -30), [SLINE]);
  log('st:jalan bagus', 'Rani', 'Jalan Bagus', plus(D, -20), [SLINE]);          // the latest work: 20 days ago → due (14)
  log('st:jalan sepi', 'Rani', 'Jalan Sepi', plus(D, -25), [[[-6.30, 106.90], [-6.31, 106.90]]]); // no shop along it → not good
  log('st:jalan baru', 'Budi', 'Jalan Baru', plus(D, -3), [[[-6.2600, 106.8700], [-6.2650, 106.8700]]]); // good, not due yet
  log('st:jalan lagi', 'Budi', 'Jalan Lagi', plus(D, -40), [[[-6.2500, 106.8800], [-6.2550, 106.8800]]]); // good + due but planned again →
  log('st:jalan lagi', 'Budi', 'Jalan Lagi', plus(D, 2), [[[-6.2500, 106.8800], [-6.2550, 106.8800]]]);  // … not due
  log('st:jalan raya condet', 'Rani', 'Jalan Raya Condet', plus(D, -16), []);    // no line: shops by their address
  log('st:jalan hapus', 'Rani', 'Jalan Hapus', plus(D, -30), [SLINE], { removed: 1 }); // taken out of the plan: not worked
  // shops along the streets (≤ 60 m), one far away
  insert(db, 'pos_shops', { shop_id: 'B1', name: 'Bagus 1', status: 'pelanggan', customer_id: 7, lat: -6.2740, lng: 106.8603, address: '' });
  insert(db, 'pos_shops', { shop_id: 'B2', name: 'Bagus 2', status: 'prospek', lat: -6.2760, lng: 106.8596, address: '' });
  insert(db, 'pos_shops', { shop_id: 'FAR', name: 'Jauh', status: 'pelanggan', lat: -6.2750, lng: 106.8650, address: '' });
  insert(db, 'pos_shops', { shop_id: 'N1', name: 'Baru 1', status: 'pelanggan', lat: -6.2620, lng: 106.8701, address: '' });
  insert(db, 'pos_shops', { shop_id: 'L1', name: 'Lagi 1', status: 'pelanggan', lat: -6.2520, lng: 106.8800, address: '' });
  insert(db, 'pos_shops', { shop_id: 'A1', name: 'Alamat 1', status: 'prospek', address: 'Jl. Raya Condet No. 12' });
  insert(db, 'pos_visits', { visit_id: 'V1', client_id: 'v1', user: 'Rani', visit_date: plus(D, -20), shop_id: 'B2', outcome: 'tertarik', rating: 4 });
  insert(db, 'pos_visits', { visit_id: 'V2', client_id: 'v2', user: 'Rani', visit_date: plus(D, -16), shop_id: 'A1', outcome: 'tertarik', rating: 0 });
  insert(db, 'pos_visits', { visit_id: 'V3', client_id: 'v3', user: 'Rani', visit_date: plus(D, -16), shop_id: 'A1', outcome: 'order', rating: 5 });
  insert(db, 'pos_field_orders', { order_id: 'BO1', client_id: 'bo1', user: 'Rani', order_date: plus(D, -20), shop_id: 'B1', items: '[]', total: 2500000, status: 'dikirim' });
  insert(db, 'pos_field_orders', { order_id: 'BO2', client_id: 'bo2', user: 'Rani', order_date: plus(D, -20), shop_id: 'B1', items: '[]', total: 100, status: 'batal' });
  return db;
}
test('field v36: street_returns scores the worked streets and lists the good ones due again (rep: his own, with the line)', async () => {
  const a = sqliteAdapter(streetsDb());
  const o = await handleField(a, base('street_returns', 'Pemilik', '1234'), {}, KEY);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.days, 14);
  const by = Object.fromEntries(o.streets.map(s => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ['Jalan Bagus', 'Jalan Baru', 'Jalan Lagi', 'Jalan Raya Condet'], 'the street with no shop / taken out is not listed');
  assert.deepEqual(o.streets.filter(s => s.due).map(s => s.name), ['Jalan Bagus', 'Jalan Raya Condet'], 'most overdue first');
  const b = by['Jalan Bagus'];
  assert.equal(b.last_date, plus(TODAY(), -20)); assert.equal(b.due_date, plus(TODAY(), -6)); assert.equal(b.overdue, 6);
  assert.deepEqual([b.shops, b.customers, b.orders, b.value, b.interested, b.rating], [2, 1, 1, 2500000, 1, 4], 'far shop and cancelled order left out');
  assert.equal(b.score, 1 * 3 + 1 * 2 + 1 + 2);
  assert.equal(b.lines, undefined, 'the office list carries no lines');
  assert.equal(by['Jalan Lagi'].due, false); assert.equal(by['Jalan Lagi'].next_date, plus(TODAY(), 2));
  assert.equal(by['Jalan Baru'].due, false);
  assert.deepEqual([by['Jalan Raya Condet'].shops, by['Jalan Raya Condet'].interested], [1, 2], 'matched by the shop address');
  // the rep sees only his own, with the line to put in his plan
  const r = await handleField(a, base('street_returns', 'Rani', '3333'), {}, KEY);
  assert.deepEqual(r.streets.map(s => s.name).sort(), ['Jalan Bagus', 'Jalan Raya Condet']);
  assert.deepEqual(r.streets.find(s => s.name === 'Jalan Bagus').lines, [SLINE]);
  // the accountant reads; the cashier cannot
  assert.equal((await handleField(a, base('street_returns', 'Aqil', '8888'), {}, KEY)).streets.length, 4);
  assert.equal((await handleField(a, base('street_returns', 'Kasir1', '7777'), {}, KEY)).error, 'FORBIDDEN');
});
test('field v36: the return time is set by the manager / owner (3–90 days) and moves the due date', async () => {
  const db = streetsDb();
  insert(db, 'pos_users', { id: 9, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '9999'), active: true });
  const a = sqliteAdapter(db);
  assert.equal((await handleField(a, base('street_return_set', 'Rani', '3333', { days: 30 }), {}, KEY)).error, 'FORBIDDEN');
  assert.equal((await handleField(a, base('street_return_set', 'Aqil', '8888', { days: 30 }), {}, KEY)).error, 'FORBIDDEN');
  assert.equal((await handleField(a, base('street_return_set', 'Jihan', '9999', { days: 2 }), {}, KEY)).error, 'INVALID');
  const s = await handleField(a, base('street_return_set', 'Jihan', '9999', { days: 30 }), {}, KEY);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(JSON.parse(a.all("SELECT svalue FROM pos_settings WHERE skey = 'street_return_days'", [])[0].svalue), 30);
  await handleField(a, base('street_return_set', 'Pemilik', '1234', { days: 18 }), {}, KEY);
  assert.equal(a.all("SELECT COUNT(*) AS n FROM pos_settings WHERE skey = 'street_return_days'", [])[0].n, 1, 'updated, not duplicated');
  const o = await handleField(a, base('street_returns', 'Pemilik', '1234'), {}, KEY);
  assert.equal(o.days, 18);
  assert.deepEqual(o.streets.filter(x => x.due).map(x => x.name), ['Jalan Bagus'], '20 days ago is due at 18 days; 16 days ago is not');
});
test('field v36: generated == original for the new actions', async () => {
  for (const body of [base('street_returns', 'Pemilik', '1234'), base('orders_map', 'Pemilik', '1234', { from: plus(TODAY(), -6), to: TODAY() }), base('shop_photos', 'Rani', '3333', { shop_id: 'B1' })]) {
    const nodes = await loadFieldNodes(sqliteAdapter(streetsDb()), parseField(body, {}));
    const $ = makeAccessor(nodes);
    assert.deepEqual(frozen(() => runProcessField($, KEY)[0].json), frozen(() => origFieldFn($)[0].json), body.action);
  }
});
