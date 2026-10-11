// One request, end to end — the same pipeline the n8n workflow ran, used by both the
// Worker (src/index.js) and the local parity tests so what we test is what deploys:
//   parse → load loaders → runProcess (the n8n logic) → apply upserts → finalize.
import { parseRequest } from './parse.js';
import { loadNodes, makeAccessor, applyOps } from './db.js';
import { finalize } from './finalize.js';
import { runProcess } from './generated/process.gen.js';

// v36 self-migration (same pattern as field.js): the live D1 predates pos_tamper_shots. Only the two actions that use it
// ensure it (once per isolate), so ordinary requests cost nothing extra. CREATE … IF NOT EXISTS only, never destructive.
export const POS_MIGRATIONS = [
  'CREATE TABLE IF NOT EXISTS pos_tamper_shots (id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id TEXT, at TEXT, shot_date TEXT, user TEXT, role TEXT, place TEXT, kind TEXT, sample TEXT, photo TEXT, photo_status TEXT, device TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_pos_tamper_shots_shot_id ON pos_tamper_shots (shot_id)',
];
const TAMPER_ACTIONS = ['report_tamper', 'list_tamper_shots'];
let posSchemaEnsured = false;
async function ensurePosSchema(adapter) {
  if (posSchemaEnsured) return;
  for (const sql of POS_MIGRATIONS) {
    try { await adapter.run(sql, []); } catch (e) { /* already there */ }
  }
  posSchemaEnsured = true;
}

export async function handleRequest(adapter, body, headers, STORE_KEY) {
  const req = parseRequest(body, headers);
  if (TAMPER_ACTIONS.indexOf(req.action) >= 0) await ensurePosSchema(adapter);
  const nodes = await loadNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const out = runProcess($, STORE_KEY)[0].json; // { response, ops, action }
  const upserts = await applyOps(adapter, out.ops || {});
  return finalize(out.response, upserts);
}
