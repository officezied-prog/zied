// Khair Order Brad API (v60, owner 2026-10-18: «انطلق بالمرحلة الاولى و الاحسن في تطبيق اخر الان منفصل حتى نتأكد منه قبل دمجه مع القديم»)
// — POST .../webhook/khair-brad. The cold-store order process as its own app until it is proven: its own table
// (brad_orders) and settings (pos_settings brad_*); the gudang tables are read for the stock, and written only when a car
// leaves (OUT movements in cold_movements). Same pipeline as the other workflows (Parse → load → pure core → write).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_BRAD, TABLES } from '../tables.js';
import { runProcessBrad } from './generated/process-brad.gen.js';
import { waReady, sendTemplate, createTemplates, listTemplates, signatureOk, waCount, waAddCount } from './wa.js';
import { lalaReady, lalaEnv, lalaMarket, lalaCity, cities, pickCity, quote, place, getOrder, getDriver, cancelOrder } from './lalamove.js';
import { resolveMapsLinks } from './gmaps.js';

export function parseBrad(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  return {
    action: String(body.action || '').slice(0, 40),
    key: String(body.key || ''),
    user: String(body.user || '').slice(0, 60),
    pin_hash: String(body.pin_hash || '').slice(0, 64),
    data: body.data && typeof body.data === 'object' ? body.data : {},
  };
}

// v61: the WhatsApp messages of the last 14 days (the app shows them on the orders); the light poll reads only what it needs.
const since = (days) => new Date(Date.now() - days * 86400000).toISOString();
export async function loadBradNodes(adapter, req) {
  if (req.action === 'poll') {
    const n = await execSpecs(adapter, { 'Get Users': Q.all('pos_users'), 'Get Settings': Q.all('pos_settings'), 'Get Orders': Q.all('brad_orders'), 'Get WA Log': Q.gte('brad_wa_log', 'at', since(14)) });
    n['Parse Brad'] = [req];
    return n;
  }
  const nodes = await execSpecs(adapter, {
    'Get WA Log': Q.gte('brad_wa_log', 'at', since(14)),
    'Get Users': Q.all('pos_users'),
    'Get Settings': Q.all('pos_settings'),
    'Get Warehouses': Q.all('cold_warehouses'),
    'Get Products': Q.all('cold_products'),
    'Get Pallets': Q.all('cold_pallets'),
    'Get Movements': Q.all('cold_movements'),
    'Get Cold Orders': Q.all('cold_orders'), // the gudang app's running orders hold their pallets too
    'Get Customers': Q.all('pos_customers'),
    'Get Orders': Q.all('brad_orders'),
  });
  nodes['Parse Brad'] = [req];
  return nodes;
}

// brad_orders is new; the gudang tables it reads exist since Batch C (created here too on a fresh database). CREATE TABLE
// IF NOT EXISTS is idempotent and never destructive; the module flag keeps the ongoing cost nil. Derived from tables.js.
const SQL_TYPE = { string: 'TEXT', number: 'REAL', boolean: 'INTEGER' };
const BRAD_TABLES = ['brad_orders', 'brad_wa_log', 'cold_warehouses', 'cold_products', 'cold_pallets', 'cold_movements', 'cold_orders'];
const BRAD_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_brad_wa_log_wamid ON brad_wa_log (wamid)',
  'CREATE INDEX IF NOT EXISTS idx_brad_wa_log_at ON brad_wa_log (at)',
  'CREATE INDEX IF NOT EXISTS idx_brad_orders_status ON brad_orders (status)',
  'CREATE INDEX IF NOT EXISTS idx_brad_orders_order_date ON brad_orders (order_date)',
];
// v63: columns added after the table was made (ALTER fails harmlessly once the column is there), the booking lock table
const BRAD_MIGRATIONS = [
  'ALTER TABLE brad_orders ADD COLUMN dest_lat REAL', // where the goods go, for Lalamove
  'ALTER TABLE brad_orders ADD COLUMN dest_lng REAL',
  // one Lalamove booking at a time per order: two taps (or two phones) never book two cars
  'CREATE TABLE IF NOT EXISTS brad_lala_locks (order_no TEXT PRIMARY KEY, at TEXT)',
];
function createSql(table) {
  const cols = ['id INTEGER PRIMARY KEY AUTOINCREMENT'];
  for (const [c, t] of Object.entries(TABLES[table])) cols.push(`${c} ${SQL_TYPE[t]}`);
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')})`;
}
let bradSchemaEnsured = false;
export async function ensureBradSchema(adapter) {
  if (bradSchemaEnsured) return;
  for (const t of BRAD_TABLES) { try { await adapter.run(createSql(t), []); } catch (e) { /* exists */ } }
  for (const sql of BRAD_INDEXES) { try { await adapter.run(sql, []); } catch (e) { /* exists */ } }
  for (const sql of BRAD_MIGRATIONS) { try { await adapter.run(sql, []); } catch (e) { /* already there */ } }
  bradSchemaEnsured = true;
}
export function _resetBradSchemaForTests() { bradSchemaEnsured = false; }

// The order read from a photo of the written sheet or a customer's message. The core checks the user and builds the
// prompt (pass 1); the AI only READS (claude-haiku-5-5 — a photo with unclear or unmatched lines, or one it could not read,
// is read once more by claude-sonnet-5-5); the core turns the reading into a draft (pass 2) with fixed rules (the pallet as
// written, else FEFO). Nothing is saved. No key, or an AI failure on a typed message → the core reads it by fixed rules.
// A client's own `_ai` is never forwarded.
export const READ_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
async function readAI(env, prompt, img, mime, text, model, effort) {
  try {
    const content = [];
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: img } });
    content.push({ type: 'text', text: prompt.catalog + '\n\n' + (text ? 'The order (message):\n' + text : 'The order is in the photo.') });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8000, system: prompt.system, output_config: { effort }, messages: [{ role: 'user', content }] }),
    });
    if (!r.ok) return { error: 'AI HTTP ' + r.status };
    const j = await r.json();
    if (j && j.stop_reason === 'max_tokens') return { error: 'AI_CUT_OFF' };
    if (j && j.stop_reason === 'refusal') return { error: 'AI_REFUSED' };
    const out = (j && Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    return out ? { text: out, model } : { error: 'AI_EMPTY' };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e).slice(0, 80) };
  }
}
async function readOrder(nodes, req, env) {
  const d = req.data || {};
  const img = typeof d.image_base64 === 'string' ? d.image_base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '') : '';
  if (img.length > 8000000 || (img && !/^[A-Za-z0-9+/]+=*$/.test(img))) return { ok: false, error: 'INVALID', message: 'Foto terlalu besar atau rusak' };
  const mime = /^image\/(jpeg|png|webp)$/.test(String(d.mime || '')) ? d.mime : 'image/jpeg';
  const base = { text: typeof d.text === 'string' ? d.text.slice(0, 4000) : '', warehouse: String(d.warehouse || '').slice(0, 30), has_image: !!img, ai_on: !!(env && env.ANTHROPIC_API_KEY) };
  const run = (data) => { nodes['Parse Brad'] = [{ ...req, data }]; return runProcessBrad(makeAccessor(nodes))[0].json.response; };
  const first = run(base);
  if (!first || first.ok !== true || !first.need_ai) return first; // refused, or read by the rules (no key)
  let res = run({ ...base, _ai: await readAI(env, first.prompt, img, mime, base.text, READ_MODELS[0], 'low') });
  if (img && (res.ok !== true || (res.draft && res.draft.unclear > 0))) {
    const ai2 = await readAI(env, first.prompt, img, mime, base.text, READ_MODELS[1], 'medium');
    if (!ai2.error) {
      const res2 = run({ ...base, _ai: ai2 });
      if (res2.ok === true && (res.ok !== true || res2.draft.unclear <= res.draft.unclear)) res = res2;
    }
  }
  return res;
}

// ---- v61 (stage 2): the step's WhatsApp messages go out from here, when WhatsApp is set up and under the month's cap --------
function settingOf(nodes, key) {
  const r = (nodes['Get Settings'] || []).find((x) => x.skey === key);
  if (!r) return undefined;
  try { return JSON.parse(r.svalue); } catch (e) { return r.svalue; }
}
const capOf = (nodes) => { const v = Number(settingOf(nodes, 'brad_wa_cap')); return isFinite(v) && v >= 0 && settingOf(nodes, 'brad_wa_cap') !== undefined ? v : 3000; };
/** msgs from the core → sent one by one (logged with Meta's message id) → [{ kind, ok, error }]. Never throws: the app falls
    back to the hand-sent message for anything not ok. */
async function sendAll(adapter, env, msgs, cap, fetchImpl) {
  if (!msgs || !msgs.length) return [];
  if (!waReady(env)) return msgs.map((m) => ({ kind: m.kind, ok: false, error: 'WA_OFF' }));
  const res = [], logs = [], now = new Date().toISOString();
  let count = 0, sent = 0;
  try { count = await waCount(adapter); } catch (e) { count = 0; }
  for (const m of msgs) {
    if (count + sent >= cap) {
      res.push({ kind: m.kind, ok: false, error: 'WA_CAP' });
      logs.push({ _id: -1, wamid: '', dir: 'out', peer: m.to, order_no: m.order_no, kind: m.kind, template: m.template, text: m.params.join(' · ').slice(0, 300), status: 'not_sent', error: 'Batas bulan ini (' + cap + ') tercapai', applied: '', at: now, updated_at: now });
      continue;
    }
    const r = await sendTemplate(env, m, fetchImpl);
    if (r.ok) sent++;
    res.push({ kind: m.kind, ok: r.ok, error: r.error || '' });
    logs.push({ _id: -1, wamid: r.wamid || '', dir: 'out', peer: m.to, order_no: m.order_no, kind: m.kind, template: m.template, text: m.params.join(' · ').slice(0, 300), status: r.ok ? 'accepted' : 'failed', error: r.error || '', applied: '', at: now, updated_at: now });
  }
  try {
    if (sent) await waAddCount(adapter, sent);
    await applyOps(adapter, { log: logs }, { log: 'brad_wa_log' });
  } catch (e) { /* a lost log line never fails the step itself */ }
  return res;
}

export async function handleBrad(adapter, body, headers, STORE_KEY, opts = {}) {
  await ensureBradSchema(adapter);
  const req = parseBrad(body), env = (opts && opts.env) || {}, fetchImpl = opts.fetch || fetch;
  if (req.key === STORE_KEY) await resolveGeoLinks(req, fetchImpl); // v63: a short Maps link → its position (only when there is one)
  let nodes = await loadBradNodes(adapter, req);
  nodes['Check Key'] = [{ key_ok: req.key === STORE_KEY }];
  if (req.action === 'order_read') return readOrder(nodes, req, env); // reads only, writes nothing
  if (LALA_STAFF[req.action]) return lalaStaff(adapter, nodes, req, env, fetchImpl); // v63: Lalamove around the core
  const out = runProcessBrad(makeAccessor(nodes))[0].json; // { response, ops }
  await applyOps(adapter, out.ops || {}, OPS_TABLE_BRAD);
  let resp = out.response;
  if (!resp || resp.ok !== true) return resp;
  // v63: the open Lalamove trips not looked at for 90 s are read again now (at most 5; the cron does it too, every 2 minutes) —
  // then the answer is made again from the fresh rows. Lalamove not set up / no open trip → nothing more than before.
  if (Array.isArray(resp.lala_due)) {
    const due = resp.lala_due;
    delete resp.lala_due;
    if (due.length && lalaReady(env)) {
      try {
        const full = req.action === 'poll' ? await loadBradNodes(adapter, { ...req, action: 'bootstrap' }) : nodes;
        full['Check Key'] = nodes['Check Key'];
        await lalaSync(adapter, full, due, env, fetchImpl);
        nodes = await loadBradNodes(adapter, req);
        nodes['Check Key'] = full['Check Key'];
        const again = runProcessBrad(makeAccessor(nodes))[0].json.response;
        if (again && again.ok === true) { delete again.lala_due; resp = again; }
      } catch (e) { /* a look that fails never fails the app's request: the next one tries again */ }
    }
  }
  // the order form says at once whether photos can be read (the owner adds ANTHROPIC_API_KEY); the WhatsApp state for the app
  if (req.action === 'bootstrap') {
    resp.ai_reader = !!env.ANTHROPIC_API_KEY;
    let count = 0; try { count = await waCount(adapter); } catch (e) { count = 0; }
    resp.wa = { on: waReady(env), count, cap: capOf(nodes) };
    resp.lala = { ...(resp.lala || {}), ...lalaState(env) }; // v63: on / sandbox / production (the keys themselves never leave the Worker)
  }
  if (Array.isArray(resp.wa)) { // a step (or the owner's test) that sends
    resp.wa_sent = await sendAll(adapter, env, resp.wa, capOf(nodes), fetchImpl);
    delete resp.wa;
  }
  if (resp.wa_admin === 'status') {
    let count = 0; try { count = await waCount(adapter); } catch (e) { count = 0; }
    const list = await listTemplates(env, fetchImpl);
    Object.assign(resp, { on: waReady(env), set: { token: !!env.WA_TOKEN, phone: !!env.WA_PHONE_ID, waba: !!env.WA_WABA_ID, secret: !!env.WA_APP_SECRET, verify: !!env.WA_VERIFY_TOKEN },
      count, cap: capOf(nodes), templates: list.templates || [], templates_error: list.ok ? '' : list.error });
  }
  if (resp.wa_admin === 'templates') {
    const r = await createTemplates(env, resp.defs || [], fetchImpl);
    delete resp.defs;
    if (!r.ok) return { ok: false, error: r.error, message: 'WhatsApp belum disiapkan: isi WA_TOKEN dan WA_WABA_ID di Cloudflare dulu' };
    resp.templates = r.templates;
  }
  return resp;
}

// ---- v63 (stage 3, owner 2026-10-20: «ابدأ المرحلة الثالثة: طلب سيارة لالاموف تلقائيًا»): the Lalamove car, booked by the server ----------
// The core decides (KBrad lala_plan / lala_booked / lala_sync / lala_cancel …, no network); this part only talks to Lalamove
// (src/lalamove.js) and tells the core what it said, as a system request (__sys) no client can send. Staff actions:
//   lala_quote  the plan → Lalamove's price (shown with its expiry);
//   lala_book   priced again (PRICE_CHANGED when > 5 % above what staff saw; the cap) → booked → kept (lala_booked);
//   lala_cancel cancelled at Lalamove → back to "book a car" (lala_cancelled); unreachable → staff may cancel in Lalamove's app;
//   lala_admin  status, "Tes koneksi" (the cities → the vehicles of ours, cached for the car form).
const LALA_STAFF = { lala_quote: 1, lala_book: 1, lala_cancel: 1, lala_admin: 1 };
const LALA_GONE = ['CANCELED', 'REJECTED', 'EXPIRED'], LALA_FINAL = ['COMPLETED', ...LALA_GONE];
const lalaState = (env) => ({ on: lalaReady(env), env: lalaEnv(env), market: lalaMarket(env), city: lalaCity(env), set: { key: !!(env && env.LALAMOVE_KEY), secret: !!(env && env.LALAMOVE_SECRET) } });
const lalaOff = (extra = {}) => ({ ok: false, error: 'LALA_OFF', message: 'Lalamove otomatis belum aktif: pesan mobil dengan cara manual (pemilik: Pengaturan → Lalamove otomatis)', ...extra });
const lalaFail = (r, extra = {}) => ({ ok: false, error: r.error || 'LALA_ERROR', message: 'Lalamove: ' + (r.message || r.error), ...extra });
function runOn(nodes, r) { nodes['Parse Brad'] = [r]; return runProcessBrad(makeAccessor(nodes))[0].json; }
const sysReq = (action, data) => ({ __sys: 'lalamove', action, data });

// A short Google Maps link (maps.app.goo.gl/…) carries no position: followed here (src/gmaps.js, the field app's resolver) and
// replaced by "lat,lng" before the core reads the place. Only the location fields, only when such a link is there.
const SHORT_MAPS = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl)\/[^\s<>"']+/i;
async function resolveGeoLinks(req, fetchImpl) {
  const d = req.data || {}, refs = [];
  const add = (obj, k) => { const m = typeof obj[k] === 'string' ? obj[k].match(SHORT_MAPS) : null; if (m) refs.push({ obj, k, url: m[0] }); };
  if (['order_save', 'lala_plan', 'lala_quote', 'lala_book'].includes(req.action)) add(d, 'dest_geo');
  if (req.action === 'settings_save') {
    add(d, 'store_geo');
    if (d.cooler_geo && typeof d.cooler_geo === 'object') Object.keys(d.cooler_geo).slice(0, 7).forEach((k) => add(d.cooler_geo, k));
  }
  if (!refs.length) return;
  try {
    const got = await resolveMapsLinks(refs.map((r) => r.url), fetchImpl);
    got.forEach((x, i) => { if (x && x.ok) refs[i].obj[refs[i].k] = x.lat + ',' + x.lng; });
  } catch (e) { /* unresolved: the core says the place cannot be read */ }
}
/** What staff see of a price: Lalamove's total, how long it holds, the distance, and the plan's arrival time. */
const quoteOut = (plan, q) => ({ price: q.price, currency: q.currency, expires_at: q.expiresAt, distance_m: q.distance_m, service: plan.service, service_name: plan.service_name,
  schedule_at: plan.schedule_at, eta_at: plan.eta_at, warn: plan.warn, kg: plan.kg, spent: plan.spent, cap: plan.cap, from: plan.quote.stops[0].address, to: plan.dest.address });

// One booking at a time per order (brad_lala_locks): a second tap / phone waits; a lock older than a minute is taken over.
async function lalaLock(adapter, orderNo) {
  const at = new Date().toISOString() + Math.random().toString(36).slice(2, 6), stale = new Date(Date.now() - 60000).toISOString();
  try {
    const r = await adapter.run('INSERT INTO brad_lala_locks (order_no, at) VALUES (?, ?) ON CONFLICT(order_no) DO UPDATE SET at = excluded.at WHERE brad_lala_locks.at < ?', [orderNo, at, stale]);
    return Number(r && r.changes) > 0 ? at : '';
  } catch (e) { return at; } // no lock table: the core still refuses a second trip on the same order
}
async function lalaUnlock(adapter, orderNo, at) { try { await adapter.run('DELETE FROM brad_lala_locks WHERE order_no = ? AND at = ?', [orderNo, at]); } catch (e) { /* expires in a minute */ } }

async function lalaStaff(adapter, nodes, req, env, fetchImpl) {
  const data = { ...(req.data || {}) };
  Object.keys(data).forEach((k) => { if (k.charAt(0) === '_') delete data[k]; }); // `_price` is the Worker's own, never the client's
  const A = req.action;
  if (A === 'lala_admin') {
    const a = runOn(nodes, { ...req, data }).response;
    if (!a || a.ok !== true) return a;
    if (a.lala_admin === 'status') return { ...a, ...lalaState(env) };
    if (!lalaReady(env)) return lalaOff(lalaState(env));
    const c = await cities(env, fetchImpl);
    if (!c.ok) return lalaFail(c, lalaState(env));
    const city = pickCity(c.cities, env);
    const sv = runOn(nodes, sysReq('lala_services', { city: city ? { locode: city.locode, name: city.name } : null, services: city ? city.services : [] }));
    await applyOps(adapter, sv.ops || {}, OPS_TABLE_BRAD);
    return { ...a, ...lalaState(env), lala: sv.response.lala, cities: c.cities.map((x) => ({ locode: x.locode, name: x.name, n: x.services.length })), picked: city ? city.locode : '' };
  }
  if (A === 'lala_cancel') {
    const c1 = runOn(nodes, { ...req, data }).response;
    if (!c1 || c1.ok !== true) return c1;
    const cx = c1.cancel;
    if (!lalaReady(env)) return lalaOff({ manual: true });
    const d = await cancelOrder(env, cx.lala_order_id, fetchImpl);
    if (!d.ok) { // already cancelled / expired on Lalamove's side → go on; else staff are told (and may cancel it in Lalamove's app)
      const g = await getOrder(env, cx.lala_order_id, fetchImpl);
      if (!(g.ok && LALA_GONE.includes(g.status))) return lalaFail(d, { manual: true });
    }
    const c2 = runOn(nodes, sysReq('lala_cancelled', { order_no: cx.order_no, lala_order_id: cx.lala_order_id, reason: cx.reason, by: cx.by }));
    await applyOps(adapter, c2.ops || {}, OPS_TABLE_BRAD);
    return c2.response;
  }
  // lala_quote / lala_book: the plan (checks, no network) → Lalamove's price → the plan again with that price (the cap, a rise)
  const p1 = runOn(nodes, { ...req, action: 'lala_plan', data }).response;
  if (!p1 || p1.ok !== true) return p1;
  if (!lalaReady(env)) return lalaOff();
  if (A === 'lala_book' && !(Number(data.seen_price) > 0)) return { ok: false, error: 'INVALID', message: 'Cek harga dulu' };
  const q = await quote(env, p1.plan.quote, fetchImpl);
  if (!q.ok) return lalaFail(q);
  const p2 = runOn(nodes, { ...req, action: 'lala_plan', data: { ...data, _price: q.price } }).response;
  if (!p2 || p2.ok !== true) return { ...p2, price: q.price };
  const plan = p2.plan;
  if (A === 'lala_quote') return { ok: true, quote: quoteOut(plan, q) };
  const lock = await lalaLock(adapter, plan.order_no);
  if (!lock) return { ok: false, error: 'BUSY', message: 'Mobil untuk order ini sedang dipesan (orang lain / ketukan kedua) — tunggu sebentar' };
  let placed = null;
  try {
    // read the order once more just before paying: another phone may have booked it a moment ago (the core says the same)
    const fresh = await adapter.all('SELECT car FROM brad_orders WHERE order_no = ? LIMIT 1', [plan.order_no]);
    let fc = null; try { fc = JSON.parse((fresh && fresh[0] && fresh[0].car) || 'null'); } catch (e) { fc = null; }
    if (fc && fc.via === 'lalamove_api' && fc.lala_order_id && !LALA_FINAL.includes(String(fc.lala_status || ''))) return { ok: false, error: 'LALA_ACTIVE', message: 'Mobil Lalamove sudah dipesan untuk order ini' };
    const o = plan.order;
    const pl = await place(env, { quotationId: q.quotationId, sender: { stopId: q.stops[0].stopId, ...o.sender }, recipients: o.recipients.map((x, i) => ({ stopId: q.stops[i + 1].stopId, ...x })),
      isPODEnabled: o.isPODEnabled === true, metadata: o.metadata }, fetchImpl);
    if (!pl.ok) return lalaFail(pl);
    placed = pl;
    // the order as it is now (changed by someone else while Lalamove answered? the core refuses and the car is cancelled)
    const now = await adapter.all('SELECT * FROM brad_orders WHERE order_no = ? LIMIT 1', [plan.order_no]);
    if (now && now[0]) nodes['Get Orders'] = (nodes['Get Orders'] || []).map((x) => (x.id === now[0].id ? now[0] : x));
    const bk = runOn(nodes, sysReq('lala_booked', { order_no: plan.order_no, by: plan.by, service: plan.service, service_name: plan.service_name, schedule_at: plan.schedule_at,
      eta_at: plan.eta_at, eta_min: plan.eta_min, accept_ot: plan.accept_ot, dest: plan.dest,
      quote: { id: q.quotationId, price: q.price, currency: q.currency, distance_m: q.distance_m }, placed: { order_id: pl.orderId, share_link: pl.shareLink, status: pl.status, price: pl.price || q.price } }));
    if (!bk.response || bk.response.ok !== true) { await cancelOrder(env, pl.orderId, fetchImpl); return bk.response; } // never a car nobody records
    await applyOps(adapter, bk.ops || {}, OPS_TABLE_BRAD);
    placed = null;
    return { ...bk.response, quote: quoteOut(plan, q) };
  } catch (e) {
    if (placed) { try { await cancelOrder(env, placed.orderId, fetchImpl); } catch (x) { /* shown on Lalamove's side */ } }
    throw e;
  } finally { await lalaUnlock(adapter, plan.order_no, lock); }
}

/** due [{ order_no, lala_order_id, driver_id }] → what Lalamove says of each (the driver read once, when Lalamove names a new one). */
async function lalaRead(env, due, fetchImpl) {
  return Promise.all(due.map(async (d) => {
    const g = await getOrder(env, d.lala_order_id, fetchImpl);
    if (!g.ok) return { order_no: d.order_no, lala_order_id: d.lala_order_id, ok: false, error: g.message || g.error };
    let driver = null;
    if (g.driverId && g.driverId !== d.driver_id) {
      const dr = await getDriver(env, d.lala_order_id, g.driverId, fetchImpl);
      if (dr.ok) driver = { name: dr.name, phone: dr.phone, plate: dr.plateNumber };
    }
    return { order_no: d.order_no, lala_order_id: d.lala_order_id, ok: true, status: g.status, driver_id: g.driverId, driver, share_link: g.shareLink, price: g.price };
  }));
}
/** Read the due trips, let the core follow (lala_sync), write, and send its WhatsApp (the car to the cold store, the departure).
    Each trip is claimed first (its time of the last look, changed only if nobody changed it since): the cron, a webhook and an
    app's refresh at the same second never read it twice — so a departure never writes its goods out twice. */
async function lalaSync(adapter, nodes, due, env, fetchImpl) {
  const mine = [], at = new Date().toISOString();
  for (const d of due) {
    try {
      const r = await adapter.run("UPDATE brad_orders SET car = json_set(car, '$.lala_synced_at', ?) WHERE order_no = ? AND COALESCE(json_extract(car, '$.lala_synced_at'), '') = ?", [at, d.order_no, d.synced_at || '']);
      if (Number(r && r.changes) > 0) mine.push(d);
    } catch (e) { /* not claimed: the next look */ }
  }
  if (!mine.length) return [];
  const items = await lalaRead(env, mine, fetchImpl);
  const out = runOn(nodes, sysReq('lala_sync', { items }));
  await applyOps(adapter, out.ops || {}, OPS_TABLE_BRAD);
  const resp = out.response || {};
  if (Array.isArray(resp.wa) && resp.wa.length) await sendAll(adapter, env, resp.wa, capOf(nodes), fetchImpl);
  return resp.applied || [];
}
/** Every 2 minutes (wrangler.toml [triggers], src/index.js scheduled) and on Lalamove's webhook: the open trips read again.
    Without the Lalamove keys nothing at all; with them and no open trip, one small D1 read. */
export async function handleLalaCron(adapter, env, fetchImpl = fetch, opts = {}) {
  if (!lalaReady(env)) return { ok: true, synced: 0, skipped: 'LALA_OFF' };
  let rows = [];
  try {
    rows = opts.lala_order_id
      // (a webhook: only a trip of ours not read in the last 15 s — anything else costs one small read, never the whole load)
      ? await adapter.all("SELECT id FROM brad_orders WHERE car LIKE ? AND COALESCE(json_extract(car, '$.lala_synced_at'), '') < ? LIMIT 1",
        ['%"lala_order_id":"' + opts.lala_order_id + '"%', new Date(Date.now() - (opts.max_age || 15) * 1000).toISOString()])
      : await adapter.all("SELECT id FROM brad_orders WHERE status IN ('car', 'arrived', 'door', 'loading', 'departed') AND car LIKE '%lalamove_api%' LIMIT 1", []);
  } catch (e) { return { ok: true, synced: 0, skipped: 'NO_TABLE' }; }
  if (!rows || !rows.length) return { ok: true, synced: 0 };
  await ensureBradSchema(adapter);
  const nodes = await loadBradNodes(adapter, { action: 'bootstrap', data: {} });
  nodes['Check Key'] = [{ key_ok: true }]; // the Worker itself (no store key: nothing comes from outside)
  const due = (runOn(nodes, sysReq('lala_due', { max_age: opts.max_age || 90, max: 5, lala_order_id: opts.lala_order_id || '' })).response || {}).due || [];
  if (!due.length) return { ok: true, synced: 0 };
  const applied = await lalaSync(adapter, nodes, due, env, fetchImpl);
  return { ok: true, synced: due.length, applied };
}
/** POST …/webhook/lalamove: Lalamove says an order changed. Its signature format is not confirmed, so NOTHING in the body is
    trusted: only the order id is taken, and that order is read from Lalamove's API itself (signed with our key) — at most once
    in 15 s. A body that names no trip of ours does nothing. */
export async function handleLalaWebhook(adapter, raw, env, fetchImpl = fetch) {
  if (!lalaReady(env)) return { ok: true, synced: 0, skipped: 'LALA_OFF' };
  let b = null; try { b = JSON.parse(String(raw || '').slice(0, 65536)); } catch (e) { return { ok: true, synced: 0 }; }
  const d = (b && b.data) || {}, o = d.order || {};
  const id = String(o.orderId || d.orderId || (b && b.orderId) || '').trim();
  if (!/^[0-9A-Za-z-]{4,64}$/.test(id)) return { ok: true, synced: 0 };
  return handleLalaCron(adapter, env, fetchImpl, { lala_order_id: id, max_age: 15 });
}

// ---- v61: Meta's webhook (…/webhook/wa) — the cold store's buttons and replies, and the fate of every message sent --------
// GET = Meta's one-time handshake (hub.verify_token must equal WA_VERIFY_TOKEN). POST = events, accepted ONLY with a valid
// X-Hub-Signature-256 (WA_APP_SECRET): nobody else can move an order by posting here. Always answers 200 once signed (Meta
// retries anything else); a message already seen (same wamid) is skipped.
const RANK = { not_sent: 0, failed: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
async function waStatus(adapter, s) {
  const rows = await adapter.all('SELECT id, status FROM brad_wa_log WHERE wamid = ? AND dir = ? ORDER BY id LIMIT 1', [String(s.id || ''), 'out']);
  const row = rows && rows[0]; if (!row) return;
  const st = String(s.status || ''), err = (s.errors && s.errors[0]) || null;
  if (st !== 'failed' && (RANK[st] || 0) <= (RANK[row.status] || 0)) return; // an older status arriving late
  await applyOps(adapter, { log: [{ _id: row.id, status: st, error: err ? String('#' + (err.code || '') + ' ' + (err.title || err.message || '')).slice(0, 160) : '', updated_at: new Date().toISOString() }] }, { log: 'brad_wa_log' });
}
async function waIncoming(adapter, msg, env, fetchImpl) {
  const id = String(msg.id || '');
  if (!id) return;
  const seen = await adapter.all('SELECT id FROM brad_wa_log WHERE wamid = ? LIMIT 1', [id]);
  if (seen && seen.length) return;
  let ctxOrder = '';
  if (msg.context && msg.context.id) {
    const c = await adapter.all('SELECT order_no FROM brad_wa_log WHERE wamid = ? AND dir = ? LIMIT 1', [String(msg.context.id), 'out']);
    ctxOrder = c && c[0] ? String(c[0].order_no || '') : '';
  }
  const ir = (msg.interactive && (msg.interactive.button_reply || msg.interactive.list_reply)) || null;
  const ev = { id, from: String(msg.from || ''), type: String(msg.type || ''), ctx_order_no: ctxOrder,
    text: (msg.text && msg.text.body) || (msg.button && msg.button.text) || (ir && ir.title) || '',
    payload: (msg.button && msg.button.payload) || (ir && ir.id) || '' };
  const nodes = await execSpecs(adapter, { 'Get Settings': Q.all('pos_settings'), 'Get Warehouses': Q.all('cold_warehouses'), 'Get Orders': Q.all('brad_orders') });
  nodes['Check Key'] = [{ key_ok: true }]; // the signature took the store key's place
  nodes['Parse Brad'] = [{ __wa: ev }];
  const out = runProcessBrad(makeAccessor(nodes))[0].json;
  await applyOps(adapter, out.ops || {}, OPS_TABLE_BRAD);
  // the door the cold store gave goes on to the driver at once (the same template as the app's step 7)
  if (out.response && Array.isArray(out.response.wa) && out.response.wa.length) await sendAll(adapter, env, out.response.wa, capOf(nodes), fetchImpl);
}
export async function handleWaWebhook(adapter, method, url, raw, headers, env, fetchImpl = fetch) {
  if (method === 'GET') {
    const p = url.searchParams;
    if (p.get('hub.mode') === 'subscribe' && env && env.WA_VERIFY_TOKEN && p.get('hub.verify_token') === env.WA_VERIFY_TOKEN) return { status: 200, text: String(p.get('hub.challenge') || '') };
    return { status: 403, text: 'forbidden' };
  }
  if (!(await signatureOk(env && env.WA_APP_SECRET, raw, headers['x-hub-signature-256']))) return { status: 401, text: 'bad signature' };
  let body = null;
  try { body = JSON.parse(raw); } catch (e) { return { status: 200, text: 'ok' }; }
  await ensureBradSchema(adapter);
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = (ch && ch.value) || {};
      for (const s of v.statuses || []) { try { await waStatus(adapter, s); } catch (e) { /* next */ } }
      for (const m of v.messages || []) { try { await waIncoming(adapter, m, env, fetchImpl); } catch (e) { /* next */ } }
    }
  }
  return { status: 200, text: 'ok' };
}
