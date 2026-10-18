// Code "Process Brad" = cold-parsers.js + cold-core.js + brad-core.js + this file (no key here: "Check Key" holds it).
// Feeds the core with the loaded rows (POS users, pos_settings, the gudang tables read-only, brad_orders, the WhatsApp log)
// and returns { response, ops } for the writers: brad_orders, the brad_* settings, the WhatsApp log and — only when a car
// leaves — cold_movements (OUT). An incoming WhatsApp message (stage 2) comes as req.__wa, set only by the Worker after it
// has checked Meta's signature (a client's request can never carry it: parseBrad keeps only action/key/user/pin_hash/data).
const req = $('Parse Brad').first().json;
function rows(name) {
  try { return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; }); } catch (e) { return []; }
}
const LOAD = { warehouses: 'Get Warehouses', products: 'Get Products', pallets: 'Get Pallets', movements: 'Get Movements', cold_orders: 'Get Cold Orders', customers: 'Get Customers', orders: 'Get Orders', wa_log: 'Get WA Log' };
const WRITE = ['orders', 'movements', 'log'];
function out(o, ops) { const e = { settings: [] }; WRITE.forEach(function (t) { e[t] = []; }); return [{ json: { response: o, ops: ops || e } }]; }
if ($('Check Key').first().json.key_ok !== true) return out({ ok: false, error: 'BAD_KEY', message: 'Kunci toko salah' });
const settings = {}, settingId = {};
rows('Get Settings').forEach(function (r) { settingId[r.skey] = r.id; try { settings[r.skey] = JSON.parse(r.svalue); } catch (e) { settings[r.skey] = r.svalue; } });
const state = { users: rows('Get Users'), settings: settings };
Object.keys(LOAD).forEach(function (t) { state[t] = rows(LOAD[t]); });
const res = req.__wa ? KBrad.waEvent(state, req.__wa, new Date().toISOString()) : KBrad.core(state, req, new Date().toISOString());
const ops = { settings: [] };
WRITE.forEach(function (t) { ops[t] = []; });
res.writes.forEach(function (w) {
  if (w.table === 'settings') { ops.settings.push({ _id: settingId[w.row.skey] !== undefined ? settingId[w.row.skey] : -1, skey: w.row.skey, svalue: w.row.svalue }); return; }
  if (WRITE.indexOf(w.table) < 0) return; // the gudang tables are read-only here (movements excepted: the goods out at departure)
  const o = Object.assign({}, w.row); o._id = o.id !== undefined ? o.id : -1; delete o.id; delete o.createdAt; delete o.updatedAt;
  ops[w.table].push(o);
});
// one write per row: the last version wins
WRITE.forEach(function (t) {
  const seen = {}, list = [];
  for (let i = ops[t].length - 1; i >= 0; i--) { const r = ops[t][i], k = r._id === -1 ? 'n' + i : 'i' + r._id; if (!seen[k]) { seen[k] = true; list.unshift(r); } }
  ops[t] = list;
});
// settings: one row per key, the last write wins
const sk = {};
ops.settings = ops.settings.slice().reverse().filter(function (r) { if (sk[r.skey]) return false; sk[r.skey] = true; return true; }).reverse();
return out(res.response, ops);
