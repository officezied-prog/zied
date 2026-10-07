// Code node "Process Chat" (workflow "Khair Mart POS – Chat") = chat-core.js + this file.
// __STORE_KEY__ is replaced by the real store key inside n8n only (never committed), exactly like the POS Process node.
// Reads the loaded rows, runs KChat.core, and emits ops for the upserts.
var STORE_KEY = '__STORE_KEY__';
var req = $('Parse Chat').first().json;
var keyOk = !/^__.*__$/.test(STORE_KEY) && req.key === STORE_KEY;
function rowsOf(node, keep) {
  var out = [];
  try { $(node).all().forEach(function (i) { var r = i.json; if (r && keep(r)) out.push(r); }); } catch (e) { }
  return out;
}
var state = {
  key_ok: keyOk,
  users: rowsOf('Get Users', function (r) { return r.name !== undefined && r.name !== null && r.name !== ''; }),
  settings: rowsOf('Get Settings', function (r) { return r.skey !== undefined && r.skey !== null && r.skey !== ''; }),
  chat: rowsOf('Get Chat', function (r) { return r.channel || r.cid || r.created_at; })
};
var result = KChat.core(state, { action: req.action, user: req.user, pin_hash: req.pin_hash, data: req.data || {} }, new Date().toISOString());
var ops = { chat: [], settings: [] };
(result.writes || []).forEach(function (w) {
  var row = {}; Object.keys(w.row).forEach(function (k) { row[k] = w.row[k]; });
  if (row._id === undefined) { row._id = (row.id !== undefined && row.id !== null) ? row.id : -1; }
  delete row.id;
  (ops[w.table] = ops[w.table] || []).push(row);
});
return [{ json: { response: result.response, ops: ops } }];
