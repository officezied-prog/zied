// One request, end to end — the same pipeline the n8n workflow ran, used by both the
// Worker (src/index.js) and the local parity tests so what we test is what deploys:
//   parse → load loaders → runProcess (the n8n logic) → apply upserts → finalize.
import { parseRequest } from './parse.js';
import { loadNodes, makeAccessor, applyOps } from './db.js';
import { finalize } from './finalize.js';
import { runProcess } from './generated/process.gen.js';

// v36 self-migration (same pattern as field.js): the live D1 predates the expense-check and new-product-review
// columns. The Worker adds them itself on the first POS request per isolate — ADD COLUMN / CREATE INDEX only,
// idempotent (a duplicate-column error is swallowed), so there is no separate migration step to forget.
let posSchemaEnsured = false;
export const POS_MIGRATIONS = [
  'ALTER TABLE pos_expenses ADD COLUMN lines TEXT',
  'ALTER TABLE pos_expenses ADD COLUMN check_status TEXT',
  'ALTER TABLE pos_expenses ADD COLUMN request_id TEXT',
  'ALTER TABLE pos_expenses ADD COLUMN checked_by TEXT',
  'CREATE INDEX IF NOT EXISTS idx_pos_expenses_request_id ON pos_expenses (request_id)',
  'ALTER TABLE pos_products ADD COLUMN review TEXT',
];
export async function ensurePosSchema(adapter) {
  if (posSchemaEnsured) return;
  for (const sql of POS_MIGRATIONS) {
    try { await adapter.run(sql, []); } catch (e) { /* column already exists — already migrated */ }
  }
  posSchemaEnsured = true;
}
export function _resetPosSchemaForTests() { posSchemaEnsured = false; }

export async function handleRequest(adapter, body, headers, STORE_KEY) {
  await ensurePosSchema(adapter); // before loading: 'Get Expense By Request' reads pos_expenses.request_id
  const req = parseRequest(body, headers);
  const nodes = await loadNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const out = runProcess($, STORE_KEY)[0].json; // { response, ops, action }
  const upserts = await applyOps(adapter, out.ops || {});
  return finalize(out.response, upserts);
}
