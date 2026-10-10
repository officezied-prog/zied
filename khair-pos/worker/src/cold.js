// Cold-storage (gudang) API — replaces the n8n "Khair Gudang Dingin" workflow
// (POST .../webhook/khair-cold). Same pipeline as the other workflows, but the store-key check
// is a SEPARATE node in n8n (check-key.js) — here handleCold feeds a synthetic 'Check Key' node,
// so the wrapped runProcessCold needs only `$`. Cold reuses pos_users + pos_settings and keeps
// its own cold_* tables; nothing is ever deleted (the ledger is append-only).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_COLD, TABLES } from '../tables.js';
import { runProcessCold } from './generated/process-cold.gen.js';

// Port of the live "Parse Cold" code node (the Worker receives the POST body as text, so there
// is no n8n `.body` wrapper to unwrap — parse the text directly, like parseField).
export function parseCold(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const back = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
  return {
    action: String(body.action || '').slice(0, 40),
    key: String(body.key || ''),
    user: String(body.user || '').slice(0, 60),
    pin_hash: String(body.pin_hash || '').slice(0, 64),
    data: body.data && typeof body.data === 'object' ? body.data : {},
    checks_from: back(today, 120), // daily checks hold the pasted text: only the last 120 days
  };
}

function coldSpecs() {
  return {
    'Get Users': Q.all('pos_users'),
    'Get Settings': Q.all('pos_settings'),
    'Get Warehouses': Q.all('cold_warehouses'),
    'Get Products': Q.all('cold_products'),
    'Get Containers': Q.all('cold_containers'),
    'Get Pallets': Q.all('cold_pallets'),
    'Get Movements': Q.all('cold_movements'),
    'Get Checks': Q.all('cold_checks'), // the core itself only keeps recent checks; full load is fine on D1
    'Get Orders': Q.all('cold_orders'),
    'Get Customers': Q.all('pos_customers'), // Batch C: the reusable customer registry (shared table)
  };
}

export async function loadColdNodes(adapter, req) {
  const nodes = await execSpecs(adapter, coldSpecs());
  nodes['Parse Cold'] = [req];
  return nodes;
}

// The cold_* tables are new to this D1 (every other workflow's tables were created at the Phase-1
// cut-over; cold moves now). `wrangler d1 execute --remote` is blocked for an unattended deploy,
// so the Worker creates them itself on the first cold request per isolate — CREATE TABLE IF NOT
// EXISTS is idempotent, never destructive, and the module flag keeps the ongoing cost nil.
// Derived from tables.js so the runtime schema never drifts from schema.sql.
const SQL_TYPE = { string: 'TEXT', number: 'REAL', boolean: 'INTEGER' };
const COLD_TABLES = ['cold_warehouses', 'cold_products', 'cold_containers', 'cold_pallets', 'cold_movements', 'cold_checks', 'cold_orders'];
const COLD_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_cold_checks_check_date ON cold_checks (check_date)',
  'CREATE INDEX IF NOT EXISTS idx_cold_movements_pallet_code ON cold_movements (pallet_code)',
  'CREATE INDEX IF NOT EXISTS idx_cold_pallets_warehouse ON cold_pallets (warehouse)',
  'CREATE INDEX IF NOT EXISTS idx_cold_orders_status ON cold_orders (status)',
];
function createSql(table) {
  const cols = ['id INTEGER PRIMARY KEY AUTOINCREMENT'];
  for (const [c, t] of Object.entries(TABLES[table])) cols.push(`${c} ${SQL_TYPE[t]}`);
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')})`;
}
let coldSchemaEnsured = false;
async function ensureColdSchema(adapter) {
  if (coldSchemaEnsured) return;
  for (const t of COLD_TABLES) { try { await adapter.run(createSql(t), []); } catch (e) { /* exists */ } }
  for (const sql of COLD_INDEXES) { try { await adapter.run(sql, []); } catch (e) { /* exists */ } }
  coldSchemaEnsured = true;
}

export async function handleCold(adapter, body, headers, STORE_KEY) {
  await ensureColdSchema(adapter); // reads need the tables to exist, so ensure before loading
  const req = parseCold(body);
  const nodes = await loadColdNodes(adapter, req);
  nodes['Check Key'] = [{ key_ok: req.key === STORE_KEY }]; // the separate n8n "Check Key" node
  const $ = makeAccessor(nodes);
  const out = runProcessCold($)[0].json; // { response, ops }
  await applyOps(adapter, out.ops || {}, OPS_TABLE_COLD);
  return out.response; // cold workflow has no Finalize node
}
