// Khair Order Brad API (v60, owner 2026-10-18: «انطلق بالمرحلة الاولى و الاحسن في تطبيق اخر الان منفصل حتى نتأكد منه قبل دمجه مع القديم»)
// — POST .../webhook/khair-brad. The cold-store order process as its own app until it is proven: its own table
// (brad_orders) and settings (pos_settings brad_*); the gudang tables are read for the stock, and written only when a car
// leaves (OUT movements in cold_movements). Same pipeline as the other workflows (Parse → load → pure core → write).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_BRAD, TABLES } from '../tables.js';
import { runProcessBrad } from './generated/process-brad.gen.js';
import { waReady, sendTemplate, createTemplates, listTemplates, signatureOk, waCount, waAddCount } from './wa.js';

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
  bradSchemaEnsured = true;
}

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
  const nodes = await loadBradNodes(adapter, req);
  nodes['Check Key'] = [{ key_ok: req.key === STORE_KEY }];
  if (req.action === 'order_read') return readOrder(nodes, req, env); // reads only, writes nothing
  const out = runProcessBrad(makeAccessor(nodes))[0].json; // { response, ops }
  await applyOps(adapter, out.ops || {}, OPS_TABLE_BRAD);
  const resp = out.response;
  if (!resp || resp.ok !== true) return resp;
  // the order form says at once whether photos can be read (the owner adds ANTHROPIC_API_KEY); the WhatsApp state for the app
  if (req.action === 'bootstrap') {
    resp.ai_reader = !!env.ANTHROPIC_API_KEY;
    let count = 0; try { count = await waCount(adapter); } catch (e) { count = 0; }
    resp.wa = { on: waReady(env), count, cap: capOf(nodes) };
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
