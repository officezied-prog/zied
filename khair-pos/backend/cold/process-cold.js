// Code node "Process Cold" = cold-parsers.js + cold-core.js + this file (no key here: "Check Key" holds it).
// Feeds the core with the loaded rows (POS users, pos_settings, cold_* tables) and returns { response, ops } for the write nodes.
const req = $('Parse Cold').first().json;
function rows(name) {
  try { return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; }); } catch (e) { return []; }
}
const TABLES = ['warehouses', 'products', 'containers', 'pallets', 'movements', 'checks', 'orders'];
function out(o, ops) { const e = { settings: [] }; TABLES.forEach(function (t) { e[t] = []; }); return [{ json: { response: o, ops: ops || e } }]; }
if ($('Check Key').first().json.key_ok !== true) return out({ ok: false, error: 'BAD_KEY', message: 'Kunci toko salah' });
const settings = {}, settingId = {};
rows('Get Settings').forEach(function (r) { settingId[r.skey] = r.id; try { settings[r.skey] = JSON.parse(r.svalue); } catch (e) { settings[r.skey] = r.svalue; } });
const state = { users: rows('Get Users'), settings: settings };
TABLES.forEach(function (t) { state[t] = rows('Get ' + t[0].toUpperCase() + t.slice(1)); });
const res = KCold.core(state, req, new Date().toISOString());
const ops = { settings: [] };
TABLES.forEach(function (t) { ops[t] = []; });
res.writes.forEach(function (w) {
  if (w.table === 'settings') { ops.settings.push({ _id: settingId[w.row.skey] !== undefined ? settingId[w.row.skey] : -1, skey: w.row.skey, svalue: w.row.svalue }); return; }
  const o = Object.assign({}, w.row); o._id = o.id !== undefined ? o.id : -1; delete o.id; delete o.createdAt; delete o.updatedAt;
  ops[w.table].push(o);
});
// one write per row: the last version wins (a row can be written twice in one call, e.g. a new product then its pallet)
TABLES.forEach(function (t) {
  const seen = {}, list = [];
  for (let i = ops[t].length - 1; i >= 0; i--) { const r = ops[t][i], k = r._id === -1 ? 'n' + i : 'i' + r._id; if (!seen[k]) { seen[k] = true; list.unshift(r); } }
  ops[t] = list;
});
return out(res.response, ops);
