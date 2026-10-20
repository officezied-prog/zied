// One request, end to end — the same pipeline the n8n workflow ran, used by both the
// Worker (src/index.js) and the local parity tests so what we test is what deploys:
//   parse → load loaders → runProcess (the n8n logic) → apply upserts → finalize.
import { parseRequest } from './parse.js';
import { loadNodes, makeAccessor, applyOps } from './db.js';
import { finalize } from './finalize.js';
import { OPS_TABLE } from '../tables.js';
import { runProcess } from './generated/process.gen.js';

// v36 self-migration (same pattern as field.js): the live D1 predates the expense-check / new-product-review columns and
// pos_tamper_shots. The Worker adds them itself on the first POS request per isolate — ADD COLUMN / CREATE … IF NOT EXISTS
// only, idempotent (a duplicate-column error is swallowed), so there is no separate migration step to forget.
let posSchemaEnsured = false;
export const POS_MIGRATIONS = [
  'ALTER TABLE pos_expenses ADD COLUMN lines TEXT',
  'ALTER TABLE pos_expenses ADD COLUMN check_status TEXT',
  'ALTER TABLE pos_expenses ADD COLUMN request_id TEXT',
  'ALTER TABLE pos_expenses ADD COLUMN checked_by TEXT',
  'CREATE INDEX IF NOT EXISTS idx_pos_expenses_request_id ON pos_expenses (request_id)',
  'ALTER TABLE pos_products ADD COLUMN review TEXT',
  'CREATE TABLE IF NOT EXISTS pos_tamper_shots (id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id TEXT, at TEXT, shot_date TEXT, user TEXT, role TEXT, place TEXT, kind TEXT, sample TEXT, photo TEXT, photo_status TEXT, device TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_pos_tamper_shots_shot_id ON pos_tamper_shots (shot_id)',
  // v37 (owner 2026-10-12: "تم تغيير فاتورة … ومن قام بتغييرها ومن طلب تغييرها"): the structured invoice-change record
  // (kind 'ubah_faktur') rides on the activity row; the audit list reads activity by kind.
  'ALTER TABLE pos_activity ADD COLUMN detail TEXT',
  'CREATE INDEX IF NOT EXISTS idx_pos_activity_kind ON pos_activity (kind)',
  // v38 (owner 2026-10-12: «والكاشير هو الذي يطلب القيام بها»): a repack made on a cashier's request records who asked and who
  // approved it (and the request); request_repack finds a resent request by its client id.
  'ALTER TABLE pos_repacks ADD COLUMN requested_by TEXT',
  'ALTER TABLE pos_repacks ADD COLUMN approved_by TEXT',
  'ALTER TABLE pos_repacks ADD COLUMN request_id TEXT',
  'CREATE INDEX IF NOT EXISTS idx_pos_approvals_client_id ON pos_approvals (client_id)',
  // v39 (owner 2026-10-12: «طلب التعليب لا يحتاج إلى موافقات»): the cashier repacks directly; the form's client id makes a resend
  // record nothing twice.
  'ALTER TABLE pos_repacks ADD COLUMN client_id TEXT',
  // v48 (owner 2026-10-14: «اجعل للمدير له خانات يمكن ان يضيفها للتكلفة التعبية»): a pack's materials with their cost per pack,
  // and how much of a repack's packaging cost they were.
  'ALTER TABLE pos_products ADD COLUMN repack_costs TEXT',
  'ALTER TABLE pos_repacks ADD COLUMN materials_cost REAL',
  // v50 (owner 2026-10-15: «وبعد عملية التعليب تقع الموافقة على الكمية التي تمت عن طريق المدير»): a repack is started, then the manager
  // confirms what it gave — its state, the plan, the bulk left over and who confirmed.
  'ALTER TABLE pos_repacks ADD COLUMN status TEXT',
  'ALTER TABLE pos_repacks ADD COLUMN planned_qty REAL',
  'ALTER TABLE pos_repacks ADD COLUMN planned_from_qty REAL',
  'ALTER TABLE pos_repacks ADD COLUMN remaining_qty REAL',
  'ALTER TABLE pos_repacks ADD COLUMN bulk_cost REAL',
  'ALTER TABLE pos_repacks ADD COLUMN started_by TEXT',
  'ALTER TABLE pos_repacks ADD COLUMN started_at TEXT',
  'ALTER TABLE pos_repacks ADD COLUMN confirmed_by TEXT',
  'ALTER TABLE pos_repacks ADD COLUMN confirmed_at TEXT',
  'CREATE INDEX IF NOT EXISTS idx_pos_repacks_status ON pos_repacks (status)',
  'CREATE INDEX IF NOT EXISTS idx_pos_repacks_repack_id ON pos_repacks (repack_id)',
  // v51 (owner 2026-10-15: «تجزئة الدفع حسب عدة أنواع طرق للدفع»): a sale paid by several methods keeps its parts.
  'ALTER TABLE pos_sales ADD COLUMN pay_parts TEXT',
  // v52 (owner 2026-10-15: «الشوكولاتة الزبيب اللوز بعض التمور … تختار الزبون 250 غرام»): a product shown loose, sold by weight.
  'ALTER TABLE pos_products ADD COLUMN loose INTEGER',
  // v53 (owner 2026-10-15: «اضف امكانية الدفع بالبطاقة»): a shift's card (EDC) sales.
  'ALTER TABLE pos_shifts ADD COLUMN card_sales REAL',
  // v57 (owner 2026-10-15: «إمكانية اختيار كتابة التحويل لأي بنك تمت … والتطبيق مباشرة يتعرف على أي نوع البنك ويصنفها حسب الصورة»): a sale
  // paid by transfer names the store account it went to (+ the sender's bank, transfer no., slip photo); a transfer out keeps its payee.
  'ALTER TABLE pos_sales ADD COLUMN account_id TEXT',
  'ALTER TABLE pos_sales ADD COLUMN bank TEXT',
  'ALTER TABLE pos_sales ADD COLUMN transfer_ref TEXT',
  'ALTER TABLE pos_sales ADD COLUMN proof_photo_id TEXT',
  'ALTER TABLE pos_payments ADD COLUMN payee TEXT',
  // v63 (owner 2026-10-20): a packaging material received at goods-in says which packs it is used for
  'ALTER TABLE pos_products ADD COLUMN use_for TEXT',
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
  const ops = out.ops || {};
  const guards = Array.isArray(ops.guard) ? ops.guard : [];
  if (!guards.length) return finalize(out.response, await applyOps(adapter, ops));
  // v38 (owner 2026-10-12: «ممكن 2 كاشير يقوم بنفس الطلب والتعليب، انتبه منها»): race guards around the writes. process.js checked
  // the rows it LOADED; two requests a few milliseconds apart load the same rows, so the deciding step happens here, on the
  // database itself (D1 runs each statement on one primary, in order):
  //  - 'decide': a pending approval is claimed with one conditional UPDATE (pending → deciding); only the first of two simultaneous
  //    decisions (manager + accountant, or a cancel) gets it, the other is told and writes nothing;
  //  - 'repack_lock': the new repack request is written first; if an EARLIER pending request for the same bulk product exists
  //    (two cashiers at the same second), this one is cancelled at once and nothing else of it is written.
  const claimed = [];
  for (const g of guards) {
    if (g.type !== 'decide') continue;
    const r = await adapter.run("UPDATE pos_approvals SET status = 'deciding' WHERE request_id = ? AND status = 'pending'", [String(g.request_id)]);
    if (!(Number(r && r.changes) > 0)) {
      for (const id of claimed) await adapter.run("UPDATE pos_approvals SET status = 'pending' WHERE request_id = ? AND status = 'deciding'", [id]);
      const now = (await adapter.all('SELECT status, decided_by FROM pos_approvals WHERE request_id = ?', [String(g.request_id)]))[0] || {};
      return { ok: false, error: 'INVALID', message: 'Permintaan sudah diputuskan' + (now.decided_by ? ' oleh ' + now.decided_by : ' orang lain barusan') + (now.status && now.status !== 'deciding' ? ': ' + now.status : '') };
    }
    claimed.push(String(g.request_id));
  }
  // v50 'repack_close': a started repack is confirmed once — two managers confirming it at the same second: only the first gets it
  // (proses → menutup with one conditional UPDATE; the write then stores selesai / batal), the other is told and writes nothing.
  const closed = [];
  const undoClosed = async () => { for (const id of closed) { try { await adapter.run("UPDATE pos_repacks SET status = 'proses' WHERE repack_id = ? AND status = 'menutup'", [id]); } catch (e2) { /* keep the first error */ } } };
  for (const g of guards) {
    if (g.type !== 'repack_close') continue;
    const r = await adapter.run("UPDATE pos_repacks SET status = 'menutup' WHERE repack_id = ? AND status = 'proses'", [String(g.repack_id)]);
    if (!(Number(r && r.changes) > 0)) {
      await undoClosed();
      for (const id of claimed) await adapter.run("UPDATE pos_approvals SET status = 'pending' WHERE request_id = ? AND status = 'deciding'", [id]);
      const now = (await adapter.all('SELECT status, confirmed_by FROM pos_repacks WHERE repack_id = ?', [String(g.repack_id)]))[0] || {};
      return { ok: false, error: 'INVALID', message: 'Kemas ulang ini sudah ' + (now.status === 'batal' ? 'dibatalkan' : 'dikonfirmasi') + (now.confirmed_by ? ' oleh ' + now.confirmed_by : ' orang lain barusan') };
    }
    closed.push(String(g.repack_id));
  }
  // v39 'stock_claim' (a direct repack): the bulk stock moves from the value process.js read to the new one with ONE conditional
  // UPDATE; if two cashiers record a repack of the same bulk at the same second, only the first gets it — the second writes nothing
  // and is shown the repack that just happened (so the same work is never recorded twice and no stock change is lost).
  const stockClaims = [];
  const undoClaims = async () => { for (const c of stockClaims) { try { await adapter.run('UPDATE pos_products SET stock = ? WHERE id = ? AND stock = ?', [c.from, c.product_id, c.to]); } catch (e2) { /* keep the first error */ } } };
  for (const g of guards) {
    if (g.type !== 'stock_claim') continue;
    const r = await adapter.run('UPDATE pos_products SET stock = ? WHERE id = ? AND stock = ?', [Number(g.to), Number(g.product_id), Number(g.from)]);
    if (!(Number(r && r.changes) > 0)) {
      await undoClaims();
      await undoClosed();
      for (const id of claimed) await adapter.run("UPDATE pos_approvals SET status = 'pending' WHERE request_id = ? AND status = 'deciding'", [id]);
      const last = (await adapter.all('SELECT * FROM pos_repacks WHERE from_product_id = ? ORDER BY id DESC LIMIT 1', [Number(g.product_id)]))[0];
      const wib = (iso) => { const t0 = Date.parse(iso); return isFinite(t0) ? new Date(t0 + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' WIB' : ''; };
      if (!g.plain && last && Date.now() - Date.parse(last.repack_time) < 2 * 3600000) {
        return { ok: false, error: 'REPACK_RECENT',
          message: last.user + ' baru saja mengemas ulang ' + last.from_name + ' ' + Number(last.from_qty) + ' ' + (last.from_unit || '') + ' → ' + last.to_name + ' x' + Number(last.to_qty) + ' pada ' + wib(last.repack_time) + ' (' + last.repack_id + '). Kalau ini kemas ulang lain (bukan yang sama), tekan "Ya, ini kemas ulang baru".',
          recent: { repack_id: last.repack_id, user: last.user, at: last.repack_time, from_name: last.from_name, from_qty: Number(last.from_qty), from_unit: last.from_unit || '', to_name: last.to_name, to_qty: Number(last.to_qty) } };
      }
      return { ok: false, error: 'STOCK_CHANGED', message: 'Stok ' + (g.from_name || '') + ' baru saja berubah. Buka lagi dan cek, lalu simpan ulang.' };
    }
    stockClaims.push({ product_id: Number(g.product_id), from: Number(g.from), to: Number(g.to) });
  }
  try {
    const lock = guards.find((g) => g.type === 'repack_lock');
    let upserts;
    if (lock) {
      const first = await applyOps(adapter, { approvals: ops.approvals || [] }, { approvals: 'pos_approvals' });
      const mine = (first.approvals || []).find((x) => x.request_id === lock.request_id);
      const pend = await adapter.all("SELECT * FROM pos_approvals WHERE kind = 'repack' AND status = 'pending' AND ref = ? ORDER BY id", [String(lock.ref)]);
      const win = pend[0];
      if (mine && win && Number(win.id) !== Number(mine.id)) {
        await adapter.run("UPDATE pos_approvals SET status = 'cancelled', decided_by = 'Sistem', decided_at = ?, note = ? WHERE id = ?", [new Date().toISOString(), 'permintaan ganda — ' + win.request_id + ' lebih dulu', mine.id]);
        const wib = (iso) => { const t0 = Date.parse(iso); return isFinite(t0) ? new Date(t0 + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' WIB' : ''; };
        let pl = {};
        try { pl = JSON.parse(win.payload || '{}') || {}; } catch (e) { pl = {}; }
        return { ok: false, error: 'REPACK_PENDING',
          message: 'Sudah ada permintaan kemas ulang ' + (pl.from_name || lock.from_name || '') + ' oleh ' + win.cashier + ' (' + wib(win.created_at) + ', ' + win.request_id + ': ' + (pl.to_name || '') + ' x' + (pl.to_qty || '') + ') yang menunggu persetujuan manajer/akuntan. Tunggu keputusannya atau hubungi manajer/akuntan.',
          pending: { request_id: win.request_id, cashier: win.cashier, created_at: win.created_at, from_name: pl.from_name || lock.from_name || '', to_name: pl.to_name || '', to_qty: Number(pl.to_qty) || 0, stale: false } };
      }
      const rest = {};
      for (const [k, tbl] of Object.entries(OPS_TABLE)) if (k !== 'approvals') rest[k] = tbl;
      upserts = Object.assign(await applyOps(adapter, ops, rest), first);
    } else upserts = await applyOps(adapter, ops);
    return finalize(out.response, upserts);
  } catch (e) {
    // a failed write never leaves an approval stuck in 'deciding'
    await undoClaims();
    await undoClosed();
    for (const id of claimed) { try { await adapter.run("UPDATE pos_approvals SET status = 'pending' WHERE request_id = ? AND status = 'deciding'", [id]); } catch (e2) { /* keep the first error */ } }
    throw e;
  }
}
