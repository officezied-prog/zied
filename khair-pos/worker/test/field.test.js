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
