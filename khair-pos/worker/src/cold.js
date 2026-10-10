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
// One-time cut-over bootstrap: the live n8n cold tables held only the initial setup — 3 coolers and
// 1 product, with NO stock/pallets/movements/orders/checks (verified 2026-10-10). Rather than ask the
// owner to re-enter them, seed those rows into the fresh D1. Each insert is guarded (WHERE NOT EXISTS by
// code) so it is idempotent and race-safe, and never runs again once a warehouse/product exists.
// Safe to delete once the cold app is live and the owner has started entering stock.
const COLD_SEED_WH = [
  { code: 'DPP', name: 'DPP', rate_unit: 'day', parser: 'generic', active: 1, created_at: '2026-10-07T11:30:51.451Z', created_by: 'zied salah', rate_frozen: 9500, rate_chiller: 8000, rate_dry: 6500 },
  { code: 'BOSKO', name: 'BOSKO', rate_unit: 'day', parser: 'generic', active: 1, created_at: '2026-10-07T11:59:58.658Z', created_by: 'zied salah', rate_frozen: 9500, rate_chiller: 8500, rate_dry: 7000 },
  { code: 'KAWANISHI', name: 'KAWANISHI', rate_unit: 'day', parser: 'generic', active: 1, created_at: '2026-10-07T12:00:47.340Z', created_by: 'zied salah', rate_frozen: 8500, rate_chiller: 6500, rate_dry: 5000 },
];
const COLD_SEED_PR = [
  { code: 'P1', name: 'تمر عجوة', kg_per_ctn: 5, ctn_per_pallet: 125, aliases: '', active: 1, created_at: '2026-10-07T11:31:45.555Z', created_by: 'zied salah' },
];
async function seedRow(adapter, table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${cols.map(() => '?').join(', ')} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE code = ?)`;
  try { await adapter.run(sql, [...cols.map((c) => row[c]), row.code]); } catch (e) { /* ignore */ }
}
let coldSchemaEnsured = false;
async function ensureColdSchema(adapter) {
  if (coldSchemaEnsured) return;
  for (const t of COLD_TABLES) { try { await adapter.run(createSql(t), []); } catch (e) { /* exists */ } }
  for (const sql of COLD_INDEXES) { try { await adapter.run(sql, []); } catch (e) { /* exists */ } }
  // Seed the cut-over setup ONLY into a fresh (empty) cold DB — never once any cooler exists.
  try {
    const any = await adapter.all('SELECT 1 FROM cold_warehouses LIMIT 1', []);
    if (!any.length) {
      for (const w of COLD_SEED_WH) await seedRow(adapter, 'cold_warehouses', w);
      for (const p of COLD_SEED_PR) await seedRow(adapter, 'cold_products', p);
    }
  } catch (e) { /* ignore */ }
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
