// Code node "Process Att" = backend/attendance/att-core.js followed by this file. Checks the store key and the user's PIN
// (same rules as the photo workflow), feeds the core with the loaded rows and returns { response, ops } for the write nodes.
const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Att').first().json;
function rows(name) {
  try { return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; }); } catch (e) { return []; }
}
function s(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function out(o, ops) { return [{ json: { response: o, ops: ops || { workers: [], records: [], seals: [], settings: [] } } }]; }
function deny(code, msg) { return out({ ok: false, error: code, message: msg || code }); }
if (req.key !== STORE_KEY) return deny('BAD_KEY', 'Kunci toko salah');
const users = rows('Get Users').filter(function (u) { return u.active !== false; });
const me = users.find(function (u) { return s(u.name).toLowerCase() === s(req.user).toLowerCase(); });
if (!me) return deny('BAD_PIN', 'Nama atau PIN salah');
if (Date.parse(me.locked_until) > Date.now()) return deny('LOCKED', 'Akun dikunci sementara karena PIN salah berkali-kali');
const viaMaster = /^[a-f0-9]{64}$/.test(s(req.pin_hash)) && users.some(function (u) { return u.role === 'owner' && u.master_hash && u.master_hash === req.pin_hash; });
if (me.pin_hash !== req.pin_hash && !viaMaster) return deny('BAD_PIN', 'Nama atau PIN salah');
if (me.must_change === true && !viaMaster) return deny('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');

const settingRows = rows('Get Settings');
const settings = {}, settingId = {};
settingRows.forEach(function (r) { settingId[r.skey] = r.id; try { settings[r.skey] = JSON.parse(r.svalue); } catch (e) { settings[r.skey] = r.svalue; } });
const head = settings.att_head && typeof settings.att_head === 'object' ? settings.att_head : null;
const res = KAtt.core({
  action: req.action, data: req.data, me: { name: me.name, role: s(me.role) }, now: new Date(),
  settings: settings, store: { lat: Number(settings.store_lat) || 0, lng: Number(settings.store_lng) || 0 },
  workers: rows('Get Workers'), records: rows('Get Records'), seals: rows('Get Seals'), head: head
});
const ops = res.ops;
ops.workers = ops.workers.map(function (w) { const o = Object.assign({}, w); delete o.id; if (o._id === undefined) o._id = -1; return o; });
ops.records = ops.records.map(function (r) { const o = Object.assign({}, r); o._id = -1; return o; });
ops.seals = ops.seals.map(function (x) { const o = Object.assign({}, x); o._id = -1; return o; });
// one row per key: the last value wins (att_head can be written once per call)
const byKey = {};
ops.settings.forEach(function (x) { byKey[x.skey] = x; });
ops.settings = Object.keys(byKey).map(function (k) { return { _id: settingId[k] !== undefined ? settingId[k] : -1, skey: k, svalue: byKey[k].svalue }; });
return out(res.response, ops);
