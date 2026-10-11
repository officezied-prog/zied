// Field (sales-lapangan) API — replaces the n8n "Khair Mart POS – Field" workflow
// (POST .../webhook/khair-field). Same pipeline as POS but its own Parse/loaders/process
// and no Finalize node (the live Respond returns the Process Field response directly).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_FIELD } from '../tables.js';
import { runProcessField } from './generated/process-field.gen.js';

// ±0.2° (≈ 22 km) around the rep's position / plan start; without one, everywhere.
function streetBox(data) {
  const lat = Number(data.lat), lng = Number(data.lng), ok = isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  return ok ? [lat - 0.2, lat + 0.2, lng - 0.2, lng + 0.2] : [-90, 90, -180, 180];
}

// Port of the live "Parse Field" code node.
export function parseField(body, headers) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const action = String(body.action || '');
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const pid = Number(data.product_id);
  const since30 = new Date(Date.now() + 7 * 3600000 - 30 * 86400000).toISOString().slice(0, 10);
  return {
    action,
    key: String(body.key || ''),
    user: String(body.user || ''),
    pin_hash: String(body.pin_hash || ''),
    data,
    today,
    client_id: (action === 'check_in' || action === 'field_order') && data.client_id ? String(data.client_id) : '__none__',
    order_id: action === 'update_order' && data.order_id ? String(data.order_id) : '__none__',
    from: action === 'list_field' && isDate(data.from) ? data.from : '9999-12-31',
    to: action === 'list_field' && isDate(data.to) ? data.to : '0000-01-01',
    recent_from: action === 'field_bootstrap' ? since30 : '9999-12-31',
    plans_from: action === 'field_bootstrap' || action === 'plan_save' ? today : '9999-12-31',
    // v32: the shared streets map reads the permanent street log around the rep (no date limit); plan_save reads that day's rows
    street_box: action === 'streets_worked' ? streetBox(data) : null,
    log_date: action === 'plan_save' && isDate(data.plan_date) ? data.plan_date : '__none__',
    img_lo: action === 'product_images' ? 0 : (action === 'set_product_image' && pid > 0 ? pid : 1),
    img_hi: action === 'product_images' ? 1000000000 : (action === 'set_product_image' && pid > 0 ? pid : 0),
  };
}

function fieldSpecs(req) {
  return {
    'Get Users': Q.all('pos_users'),
    'Get Products': Q.all('pos_products'),
    'Get Shops': Q.all('pos_shops'),
    'Get Customers': Q.all('pos_customers'),
    'Get Today Days': Q.eq('pos_field_days', 'day_date', req.today),
    'Get Today Tracks': Q.eq('pos_tracks', 'track_date', req.today),
    'Get Today Visits': Q.eq('pos_visits', 'visit_date', req.today),
    'Get Today Orders': Q.eq('pos_field_orders', 'order_date', req.today),
    'Get Visit By Client': Q.eq('pos_visits', 'client_id', req.client_id),
    'Get Order By Client': Q.eq('pos_field_orders', 'client_id', req.client_id),
    'Get Order By Id': Q.eq('pos_field_orders', 'order_id', req.order_id),
    'Get Range Tracks': Q.range('pos_tracks', 'track_date', req.from, req.to),
    'Get Range Visits': Q.range('pos_visits', 'visit_date', req.from, req.to),
    'Get Range Orders': Q.range('pos_field_orders', 'order_date', req.from, req.to),
    'Get Open Orders': Q.eq('pos_field_orders', 'status', 'baru'),
    'Get Range Days': Q.range('pos_field_days', 'day_date', req.from, req.to),
    'Get Images': Q.range('pos_product_images', 'product_id', req.img_lo, req.img_hi),
    'Get Recent Orders': Q.gte('pos_field_orders', 'order_date', req.recent_from),
    'Get Plans': Q.gte('pos_route_plans', 'plan_date', req.plans_from),
    'Get Range Plans': Q.range('pos_route_plans', 'plan_date', req.from, req.to),
    'Get Plan Street Log': Q.eq('pos_street_log', 'plan_date', req.log_date),
    // latest row per street and rep (SQLite keeps the bare columns of the MAX row), only streets crossing the area box
    'Get Street Log': req.street_box
      ? { table: 'pos_street_log', sql: 'SELECT *, MAX(plan_date) AS last_date FROM pos_street_log WHERE removed = 0 AND max_lat >= ? AND min_lat <= ? AND max_lng >= ? AND min_lng <= ? GROUP BY skey, user ORDER BY last_date DESC LIMIT 1000', params: [req.street_box[0], req.street_box[1], req.street_box[2], req.street_box[3]] }
      : Q.eq('pos_street_log', 'skey', '__none__'),
  };
}

export async function loadFieldNodes(adapter, req) {
  const nodes = await execSpecs(adapter, fieldSpecs(req));
  nodes['Parse Field'] = [req];
  return nodes;
}

// v30 self-migration: the live D1 predates the rating / payment_method columns. Rather than a separate
// one-off `wrangler d1 execute` (blocked for an unattended deploy), the Worker adds the columns itself on the
// first field request after this version ships — idempotent (a duplicate-column error is swallowed) and run
// at most once per isolate via the module flag, so the ongoing cost is nil. These are ADD COLUMN only, never
// destructive. Remove once the columns are known-present everywhere.
// v31: the route-plan table is new to D1, and the loaders read it on every request (bootstrap) — so the schema is
// now ensured BEFORE loading (once per isolate), not only before a write.
let fieldSchemaEnsured = false;
export const FIELD_MIGRATIONS = [
  "ALTER TABLE pos_visits ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE pos_field_orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'tunai'",
  "CREATE TABLE IF NOT EXISTS pos_route_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, user TEXT, plan_date TEXT, start_label TEXT, start_lat REAL, start_lng REAL, stops TEXT, note TEXT, created_at TEXT, updated_at TEXT, end_label TEXT, end_lat REAL, end_lng REAL, streets TEXT)",
  // no-ops on a table created by the line above; they only matter if an older copy of the table exists
  "ALTER TABLE pos_route_plans ADD COLUMN end_label TEXT", "ALTER TABLE pos_route_plans ADD COLUMN end_lat REAL",
  "ALTER TABLE pos_route_plans ADD COLUMN end_lng REAL", "ALTER TABLE pos_route_plans ADD COLUMN streets TEXT",
  "CREATE INDEX IF NOT EXISTS idx_pos_route_plans_plan_date ON pos_route_plans (plan_date)",
  // v32: the permanent street log (shared map, kept forever) + a one-time copy of the streets of the plans made before it
  "CREATE TABLE IF NOT EXISTS pos_street_log (id INTEGER PRIMARY KEY AUTOINCREMENT, skey TEXT, user TEXT, name TEXT, plan_date TEXT, plan_id TEXT, drawn INTEGER NOT NULL DEFAULT 0, ref TEXT, lines TEXT, min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL, removed INTEGER NOT NULL DEFAULT 0, updated_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_pos_street_log_plan_date ON pos_street_log (plan_date)",
  "INSERT INTO pos_street_log (skey, user, name, plan_date, plan_id, drawn, ref, lines, min_lat, max_lat, min_lng, max_lng, removed, updated_at) "
    + "SELECT 'st:' || lower(trim(json_extract(s.value, '$.name'))), p.user, trim(json_extract(s.value, '$.name')), p.plan_date, p.plan_id, 0, json_extract(s.value, '$.ref'), "
    + "COALESCE(json_extract(s.value, '$.lines'), '[]'), -90, 90, -180, 180, 0, p.updated_at "
    + "FROM pos_route_plans p, json_each(CASE WHEN json_valid(p.streets) THEN p.streets ELSE '[]' END) s "
    + "WHERE trim(COALESCE(json_extract(s.value, '$.name'), '')) <> '' AND NOT EXISTS (SELECT 1 FROM pos_street_log)",
];
async function ensureFieldSchema(adapter) {
  if (fieldSchemaEnsured) return;
  for (const sql of FIELD_MIGRATIONS) {
    try { await adapter.run(sql, []); } catch (e) { /* column already exists — already migrated */ }
  }
  fieldSchemaEnsured = true;
}

export async function handleField(adapter, body, headers, STORE_KEY) {
  const req = parseField(body, headers);
  await ensureFieldSchema(adapter); // before loading: 'Get Plans' reads pos_route_plans
  const nodes = await loadFieldNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const out = runProcessField($, STORE_KEY)[0].json; // { response, ops, action }
  const ops = out.ops || {};
  await applyOps(adapter, ops, OPS_TABLE_FIELD);
  return out.response; // field workflow has no Finalize node
}
