// Attendance API — replaces the n8n "Khair Mart POS – Absensi" workflow
// (POST .../webhook/khair-att). Loaders: users/settings/workers/seals (all) + records
// (att_date >= load_from). Process = att-core.js + process-att.js (own pure-JS sha256 for
// the tamper-proof hash chain — no crypto dependency). Writers upsert pos_workers /
// pos_attendance / pos_att_seals / pos_settings. No Finalize.
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_ATT } from '../tables.js';
import { runProcessAtt } from './generated/process-att.gen.js';

// Port of the live "Parse Att" code node.
export function parseAtt(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const back = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
  const action = String(body.action || '');
  let from = back(today, 7);
  if (action === 'att_report' && isDate(data.from) && data.from < from) from = data.from;
  return {
    action,
    key: String(body.key || ''),
    user: String(body.user || ''),
    pin_hash: String(body.pin_hash || ''),
    data,
    load_from: from,
    load_to: today,
  };
}

export async function loadAttNodes(adapter, req) {
  const nodes = await execSpecs(adapter, {
    'Get Users': Q.all('pos_users'),
    'Get Settings': Q.all('pos_settings'),
    'Get Workers': Q.all('pos_workers'),
    'Get Records': Q.gte('pos_attendance', 'att_date', req.load_from),
    'Get Seals': Q.all('pos_att_seals'),
  });
  nodes['Parse Att'] = [req];
  return nodes;
}

export async function handleAtt(adapter, body, headers, STORE_KEY) {
  const req = parseAtt(body);
  const nodes = await loadAttNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const out = runProcessAtt($, STORE_KEY)[0].json; // { response, ops }
  await applyOps(adapter, out.ops || {}, OPS_TABLE_ATT);
  return out.response;
}
