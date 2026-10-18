// Khair Order Brad API (v60, owner 2026-10-18: «انطلق بالمرحلة الاولى و الاحسن في تطبيق اخر الان منفصل حتى نتأكد منه قبل دمجه مع القديم»)
// — POST .../webhook/khair-brad. The cold-store order process as its own app until it is proven: its own table
// (brad_orders) and settings (pos_settings brad_*); the gudang tables are read for the stock, and written only when a car
// leaves (OUT movements in cold_movements). Same pipeline as the other workflows (Parse → load → pure core → write).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_BRAD, TABLES } from '../tables.js';
import { runProcessBrad } from './generated/process-brad.gen.js';

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

export async function loadBradNodes(adapter, req) {
  const nodes = await execSpecs(adapter, {
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
const BRAD_TABLES = ['brad_orders', 'cold_warehouses', 'cold_products', 'cold_pallets', 'cold_movements', 'cold_orders'];
const BRAD_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_brad_orders_status ON brad_orders (status)',
  'CREATE INDEX IF NOT EXISTS idx_brad_orders_order_date ON brad_orders (order_date)',
];
function createSql(table) {
  const cols = ['id INTEGER PRIMARY KEY AUTOINCREMENT'];
  for (const [c, t] of Object.entries(TABLES[table])) cols.push(`${c} ${SQL_TYPE[t]}`);
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')})`;
}
let bradSchemaEnsured = false;
async function ensureBradSchema(adapter) {
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

export async function handleBrad(adapter, body, headers, STORE_KEY, opts = {}) {
  await ensureBradSchema(adapter);
  const req = parseBrad(body), env = (opts && opts.env) || {};
  const nodes = await loadBradNodes(adapter, req);
  nodes['Check Key'] = [{ key_ok: req.key === STORE_KEY }];
  if (req.action === 'order_read') return readOrder(nodes, req, env); // reads only, writes nothing
  const out = runProcessBrad(makeAccessor(nodes))[0].json; // { response, ops }
  await applyOps(adapter, out.ops || {}, OPS_TABLE_BRAD);
  // the order form says at once whether photos can be read (the owner adds ANTHROPIC_API_KEY)
  if (req.action === 'bootstrap' && out.response && out.response.ok === true) out.response.ai_reader = !!env.ANTHROPIC_API_KEY;
  return out.response;
}
