const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Field').first().json;
const data = req.data && typeof req.data === 'object' ? req.data : {};
// Plain text only (v16): control / direction characters and HTML tags are removed and keys that reach JavaScript
// internals are dropped. Photos (data: URLs) are left as they are; their size is checked where they are used.
(function cleanInput(o, depth) {
  if (!o || typeof o !== 'object' || depth > 6) return;
  Object.keys(o).forEach(function (k) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') { delete o[k]; return; }
    const v = o[k];
    if (typeof v === 'string' && v.indexOf('data:') !== 0) o[k] = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
    else if (v && typeof v === 'object') cleanInput(v, depth + 1);
  });
})(data, 0);
const ops = { shops: [], visits: [], tracks: [], days: [], orders: [], images: [], product_flags: [], plans: [], street_log: [], shop_lists: [] };

function rows(name) {
  try {
    return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; });
  } catch (e) { return []; }
}
function done(resp) { return [{ json: { response: resp, ops: ops, action: req.action } }]; }
function fail(code, msg) { Object.keys(ops).forEach(function (k) { ops[k] = []; }); return done({ ok: false, error: code, message: msg || code }); }
function num(v) { const x = Number(v); return isFinite(x) ? x : 0; }
function money(v) { return Math.round(num(v)); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function addDaysYmd(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function clean(r) {
  const o = {};
  Object.keys(r).forEach(function (k) { if (k !== 'createdAt' && k !== 'updatedAt') o[k] = r[k]; });
  return o;
}
function forWrite(r, id) {
  const o = clean(r);
  delete o.id;
  o._id = id === undefined || id === null ? -1 : id;
  return o;
}
function rand(n) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
// When the action really happened on the phone (data.at, kept while it waited offline); server time if missing or implausible.
function clientAt() {
  const a = Date.parse(str(data.at)), n = Date.now();
  if (!isFinite(a) || a > n + 300000 || a < n - 36 * 3600000) return new Date(n).toISOString();
  if (new Date(a + 7 * 3600000).toISOString().slice(0, 10) !== req.today) return new Date(n).toISOString();
  return new Date(a).toISOString();
}
function isCoord(lat, lng) { return isFinite(Number(lat)) && isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && !(Number(lat) === 0 && Number(lng) === 0); }
function dist(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function kmOf(points) {
  const pts = points.filter(function (p) { return isCoord(p.lat, p.lng) && num(p.acc) <= 100; })
    .sort(function (a, b) { return String(a.t) < String(b.t) ? -1 : 1; });
  let m = 0;
  let last = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const d = dist(num(last.lat), num(last.lng), num(pts[i].lat), num(pts[i].lng));
    const dt = (Date.parse(pts[i].t) - Date.parse(last.t)) / 1000;
    // A point implying more than 120 km/h is a GPS glitch: skip it and keep measuring from the last good point.
    if (dt > 0 && d / dt > 33) continue;
    if (d > 15) m += d;
    last = pts[i];
  }
  return Math.round(m / 100) / 10;
}

if (req.key !== STORE_KEY) return fail('BAD_KEY', 'Kunci toko salah');
const users = rows('Get Users').filter(function (u) { return u.active !== false; });
if (!users.length) return fail('NO_USERS', 'Belum ada pengguna');
const me = users.find(function (u) { return str(u.name).toLowerCase() === str(req.user).toLowerCase(); });
if (!me) return fail('BAD_PIN', 'Nama atau PIN salah');
if (Date.parse(me.locked_until) > Date.now()) return fail('LOCKED', 'Akun dikunci sementara karena PIN salah berkali-kali');
// The owner's master code (sha256(KEY:'__master__':code)) opens every account here too (v16).
const viaMaster = /^[a-f0-9]{64}$/.test(str(req.pin_hash)) && users.some(function (u) { return u.role === 'owner' && u.master_hash && u.master_hash === req.pin_hash; });
if (me.pin_hash !== req.pin_hash && !viaMaster) return fail('BAD_PIN', 'Nama atau PIN salah');
if (me.must_change === true && !viaMaster) return fail('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
// A real kasir is allowed here ONLY for the read-only cashier view (the counter reads field orders to fulfil them);
// any OTHER / unknown role is still rejected outright.
const role = ['owner', 'manager', 'sales', 'kasir', 'akuntan'].indexOf(me.role) >= 0 ? me.role : 'other';
if (role === 'other') return fail('FORBIDDEN', 'Aplikasi ini untuk sales lapangan');
const isBoss = role === 'owner' || role === 'manager';
const SALES_ONLY = ['day_start', 'day_end', 'track', 'check_in', 'field_order', 'plan_save', 'list_ack'];
const BOSS_ONLY = ['update_order', 'set_product_image', 'link_shop'];
// The kasir may reach ONLY cashier_orders. v30 (owner 2026-10-10): the accountant may READ the field report
// (visits + orders table) for monitoring — field_bootstrap / list_field / product_images only, nothing that writes.
// v33 (owner 2026-10-11): the office — manager, accountant OR cashier — may also send a rep a SHOP LIST for a street
// (taken from Google Maps for free); that is the only thing the kasir / akuntan may write here.
const OFFICE_LISTS = ['list_send', 'list_reps', 'lists_sent', 'resolve_links'];
const KASIR_ONLY = ['cashier_orders'].concat(OFFICE_LISTS);
const AKUNTAN_OK = ['field_bootstrap', 'list_field', 'product_images'].concat(OFFICE_LISTS);
if (role === 'kasir' && KASIR_ONLY.indexOf(req.action) < 0) return fail('FORBIDDEN', 'Kasir hanya boleh melihat pesanan');
if (role === 'akuntan' && AKUNTAN_OK.indexOf(req.action) < 0) return fail('FORBIDDEN', 'Akuntan hanya melihat laporan lapangan');
if (req.action === 'list_field' && !isBoss && role !== 'akuntan') return fail('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
if (BOSS_ONLY.indexOf(req.action) >= 0 && !isBoss) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
if (SALES_ONLY.indexOf(req.action) >= 0 && role !== 'sales') return fail('FORBIDDEN', 'Hanya untuk akun sales');

const products = rows('Get Products');
const productById = {};
products.forEach(function (p) { productById[String(p.id)] = p; });
const shops = rows('Get Shops');
const shopById = {};
shops.forEach(function (s) { shopById[s.shop_id] = s; });
const meKey = str(me.name).toLowerCase();
function mine(r) { return str(r.user).toLowerCase() === meKey; }
const todayDays = rows('Get Today Days');
const myDay = todayDays.find(mine) || null;
const todayTracks = rows('Get Today Tracks').filter(mine);
const todayVisits = rows('Get Today Visits').filter(mine);
const todayOrders = rows('Get Today Orders').filter(mine);
function productOut(p) {
  const o = clean(p);
  if (role !== 'owner') { delete o.cost_price; }
  delete o.notes;
  return o;
}
function dayOut(d) {
  if (!d) return { status: 'off', started_at: '', ended_at: '', visits_today: todayVisits.length, km_today: kmOf(todayTracks), orders_today: todayOrders.length };
  return Object.assign(clean(d), { status: d.ended_at ? 'ended' : 'working', visits_today: todayVisits.length, km_today: kmOf(todayTracks), orders_today: todayOrders.length });
}
// v31 (owner 2026-10-11): the rep's route plan for a day — start point + ordered stops (system shops or new places
// found on the map), made before setting off. Stored as JSON text; parsed back for the apps.
function jsonList(v) { try { const x = typeof v === 'string' ? JSON.parse(v || '[]') : v; return Array.isArray(x) ? x : []; } catch (e) { return []; } }
function planOut(p) {
  return { plan_id: p.plan_id, user: p.user, plan_date: p.plan_date,
    start: isCoord(p.start_lat, p.start_lng) ? { label: str(p.start_label), lat: num(p.start_lat), lng: num(p.start_lng) } : null,
    end: isCoord(p.end_lat, p.end_lng) ? { label: str(p.end_label), lat: num(p.end_lat), lng: num(p.end_lng) } : null,
    stops: jsonList(p.stops), streets: jsonList(p.streets), note: str(p.note), updated_at: str(p.updated_at) };
}
// v31b: a work street = name + its line(s) on the map (rounded, capped), so other reps see where work was already done.
function cleanStreets(raw) {
  const out = [];
  let budget = 3000; // points over all streets of one plan
  (Array.isArray(raw) ? raw : []).slice(0, 15).forEach(function (x) {
    x = x && typeof x === 'object' ? x : {};
    const name = str(x.name).slice(0, 100); if (!name) return;
    const lines = [];
    (Array.isArray(x.lines) ? x.lines : []).slice(0, 40).forEach(function (ln) {
      const pts = [];
      (Array.isArray(ln) ? ln : []).slice(0, 400).forEach(function (q) {
        if (budget <= 0 || !Array.isArray(q) || !isCoord(q[0], q[1])) return;
        pts.push([Math.round(num(q[0]) * 1e5) / 1e5, Math.round(num(q[1]) * 1e5) / 1e5]); budget--;
      });
      if (pts.length > 1) lines.push(pts);
    });
    const o = { ref: str(x.ref).slice(0, 60) || ('st:' + name.toLowerCase()), name: name, lines: lines };
    if (x.drawn === true) o.drawn = true; // v32: a work line the rep drew point by point (not a named street)
    out.push(o);
  });
  return out;
}
// v32 (owner 2026-10-11: "keep it always, not only 60 days"): every street / drawn line of a plan also goes into a permanent
// log — one row per street per plan, with its box on the map — so the shared map keeps ALL past work, and reading it stays
// small (only the streets around the rep, latest per street and rep) however many years of plans pile up.
function streetKey(x) { return x.drawn === true ? 'ln:' + str(x.ref) : 'st:' + str(x.name).toLowerCase(); }
function streetBox(lines) {
  const b = { min_lat: 90, max_lat: -90, min_lng: 180, max_lng: -180 };
  (lines || []).forEach(function (ln) { ln.forEach(function (q) { b.min_lat = Math.min(b.min_lat, q[0]); b.max_lat = Math.max(b.max_lat, q[0]); b.min_lng = Math.min(b.min_lng, q[1]); b.max_lng = Math.max(b.max_lng, q[1]); }); });
  return b.min_lat > b.max_lat ? { min_lat: -90, max_lat: 90, min_lng: -180, max_lng: 180 } : b; // no line: shown everywhere (name only)
}
// v33: a shop list from the office (Google Maps places of a street) → the rep's plan for that day
const GMAPS_URL = /^https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl|(?:www\.)?google\.[a-z.]+|maps\.google\.[a-z.]+)\//i;
function cleanPlaces(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).slice(0, 60).forEach(function (x) {
    x = x && typeof x === 'object' ? x : {};
    const name = str(x.name).slice(0, 100); if (!name) return;
    const has = isCoord(x.lat, x.lng), url = str(x.url).slice(0, 300);
    out.push({ name: name, address: str(x.address).slice(0, 200), phone: str(x.phone).replace(/[^\d+]/g, '').slice(0, 20), url: GMAPS_URL.test(url) ? url : '',
      lat: has ? Math.round(num(x.lat) * 1e6) / 1e6 : null, lng: has ? Math.round(num(x.lng) * 1e6) / 1e6 : null, type: SHOP_TYPES.indexOf(x.type) >= 0 ? x.type : '' });
  });
  return out;
}
function listOut(l) {
  return { list_id: str(l.list_id), from_user: str(l.from_user), from_role: str(l.from_role), to_user: str(l.to_user), plan_date: str(l.plan_date), street: str(l.street),
    places: jsonList(l.places), note: str(l.note), status: str(l.status), created_at: str(l.created_at), received_at: str(l.received_at) };
}
function visitOut(v, full) {
  const o = clean(v);
  if (!full) delete o.photo_thumb;
  return o;
}
// Same ids as khair-pos/shared/shop-types.js (grouped list shown in the apps); unknown → 'lainnya' + type_other.
const SHOP_TYPES = ['perlengkapan_haji', 'travel_umrah', 'oleh_oleh_haji', 'toko_kurma', 'herbal', 'busana_muslim', 'toko_buku_islam', 'warung', 'toko', 'grosir_sembako', 'pasar', 'minimarket', 'supermarket', 'hypermarket', 'grosir_modern', 'bakery', 'toko_kue', 'katering', 'restoran', 'kafe', 'hotel', 'oleh_oleh', 'parsel', 'toko_buah', 'masjid', 'pesantren', 'sekolah', 'majelis_taklim', 'kantor', 'koperasi', 'reseller', 'toko_online', 'lainnya'];
// v32 (owner 2026-10-11): the visit result colours the point — green = order; orange = shop there, no order (tertarik,
// sudah_pelanggan); blue = does not want to work with us (tidak); BLACK = closed / owner not there / shop not found / changed
// business — a photo of the place is required (it is evidence of the place, so it needs no consent from a person).
const OUTCOMES = ['order', 'tertarik', 'tidak', 'tutup', 'sudah_pelanggan', 'tidak_ada', 'tidak_ditemukan', 'ganti_usaha'];
const BLACK_OUTCOMES = ['tutup', 'tidak_ada', 'tidak_ditemukan', 'ganti_usaha'];

switch (req.action) {
  case 'field_bootstrap': {
    const customers = rows('Get Customers').filter(function (c) { return c.type === 'grosir'; })
      .map(function (c) { return { id: c.id, name: c.name, phone: c.phone, address: c.address }; });
    return done({
      ok: true, user: { name: me.name, role: role },
      products: products.filter(function (p) { return p.active !== false; }).map(productOut),
      shops: shops.map(clean), customers: customers,
      day: role === 'sales' ? dayOut(myDay) : null,
      orders: role === 'sales' ? rows('Get Recent Orders').filter(mine).map(clean) : [],
      plans: role === 'sales' ? rows('Get Plans').filter(mine).map(planOut) : [],
      lists: role === 'sales' ? rows('Get Open Lists').filter(function (l) { return str(l.to_user).toLowerCase() === meKey && str(l.status) === 'sent'; }).map(listOut) : [],
      settings: {}, server_time: new Date().toISOString()
    });
  }

  case 'day_start': {
    const at = clientAt();
    if (myDay && !myDay.ended_at) return done({ ok: true, already: true, day: dayOut(myDay) });
    const d = myDay ? Object.assign({}, myDay, { ended_at: '', note: (str(myDay.note) + ' [lanjut ' + new Date().toISOString().slice(11, 16) + ' UTC]').trim() }) : {
      user: me.name, day_date: req.today, started_at: at, ended_at: '',
      start_lat: isCoord(data.lat, data.lng) ? num(data.lat) : 0, start_lng: isCoord(data.lat, data.lng) ? num(data.lng) : 0,
      end_lat: 0, end_lng: 0, km: 0, visits: 0, orders: 0, note: ''
    };
    ops.days.push(forWrite(d, myDay ? myDay.id : -1));
    if (isCoord(data.lat, data.lng)) ops.tracks.push(forWrite({ user: me.name, track_date: req.today, t: at, lat: num(data.lat), lng: num(data.lng), acc: num(data.acc), speed: 0, battery: 0 }, -1));
    return done({ ok: true, already: false, day: dayOut(d) });
  }

  case 'day_end': {
    if (!myDay) return fail('INVALID', 'Hari kerja belum dimulai');
    const pts = todayTracks.slice();
    const at = clientAt();
    if (isCoord(data.lat, data.lng)) {
      const p = { user: me.name, track_date: req.today, t: at, lat: num(data.lat), lng: num(data.lng), acc: num(data.acc), speed: 0, battery: 0 };
      pts.push(p);
      ops.tracks.push(forWrite(p, -1));
    }
    const d = Object.assign({}, myDay, {
      ended_at: at, end_lat: isCoord(data.lat, data.lng) ? num(data.lat) : 0, end_lng: isCoord(data.lat, data.lng) ? num(data.lng) : 0,
      km: kmOf(pts), visits: todayVisits.length, orders: todayOrders.length,
      note: (str(myDay.note) + (str(data.note) ? ' | ' + str(data.note).slice(0, 300) : '')).trim()
    });
    ops.days.push(forWrite(d, myDay.id));
    return done({ ok: true, day: Object.assign(dayOut(d), { km_today: d.km }) });
  }

  case 'track': {
    if (!myDay || myDay.ended_at) return done({ ok: true, saved: 0, ignored: true });
    const pts = Array.isArray(data.points) ? data.points.slice(0, 200) : [];
    let saved = 0, ignored = 0;
    // a resent batch (lost reply, outbox retry) must not be stored twice
    const seen = {};
    todayTracks.forEach(function (x) { if (!isNaN(Date.parse(x.t))) seen[new Date(x.t).toISOString() + '|' + num(x.lat).toFixed(6) + '|' + num(x.lng).toFixed(6)] = 1; });
    pts.forEach(function (p) {
      if (!p || !isCoord(p.lat, p.lng)) { ignored++; return; }
      const t = str(p.t) && !isNaN(Date.parse(p.t)) ? new Date(p.t).toISOString() : new Date().toISOString();
      const k = t + '|' + num(p.lat).toFixed(6) + '|' + num(p.lng).toFixed(6);
      if (seen[k]) { ignored++; return; }
      seen[k] = 1;
      ops.tracks.push(forWrite({
        user: me.name, track_date: new Date(Date.parse(t) + 7 * 3600000).toISOString().slice(0, 10), t: t,
        lat: Math.round(num(p.lat) * 1e6) / 1e6, lng: Math.round(num(p.lng) * 1e6) / 1e6, acc: Math.round(num(p.acc)),
        speed: Math.round(num(p.speed) * 10) / 10, battery: Math.round(num(p.battery) * 100) / 100
      }, -1));
      saved++;
    });
    return done({ ok: true, saved: saved, ignored: ignored });
  }

  case 'check_in': {
    const dup = rows('Get Visit By Client').find(function (v) { return v.client_id === req.client_id; });
    if (dup) return done({ ok: true, duplicate: true, visit: visitOut(dup, false), shop: shopById[dup.shop_id] ? clean(shopById[dup.shop_id]) : null });
    if (!data.client_id) return fail('INVALID', 'client_id wajib');
    if (!isCoord(data.lat, data.lng)) return fail('INVALID', 'Lokasi GPS wajib');
    const sd = data.shop && typeof data.shop === 'object' ? data.shop : {};
    let shop = data.shop_id ? shopById[String(data.shop_id)] : null;
    if (data.shop_id && !shop) return fail('NOT_FOUND', 'Toko tidak ditemukan');
    const now = clientAt();
    let distance = -1;
    let shopId;
    if (shop) {
      if (isCoord(shop.lat, shop.lng)) distance = Math.round(dist(num(shop.lat), num(shop.lng), num(data.lat), num(data.lng)));
      const ns = Object.assign({}, shop, {
        last_visit_at: now, visits: num(shop.visits) + 1,
        lat: isCoord(shop.lat, shop.lng) ? shop.lat : num(data.lat), lng: isCoord(shop.lat, shop.lng) ? shop.lng : num(data.lng),
        owner_name: str(sd.owner_name) || str(shop.owner_name), phone: str(sd.phone) || str(shop.phone),
        type: SHOP_TYPES.indexOf(sd.type) >= 0 ? sd.type : (shop.type || 'lainnya'),
        type_other: SHOP_TYPES.indexOf(sd.type) >= 0 ? (sd.type === 'lainnya' ? str(sd.type_other).slice(0, 60) : '') : str(shop.type_other),
        chain: sd.chain !== undefined ? str(sd.chain).slice(0, 40) : str(shop.chain),
        status: data.outcome === 'order' || data.outcome === 'sudah_pelanggan' ? 'pelanggan' : (shop.status || 'prospek'),
        next_visit: isDate(data.next_visit) ? data.next_visit : ''
      });
      ops.shops.push(forWrite(ns, shop.id));
      shop = ns;
      shopId = shop.shop_id;
    } else {
      const name = str(sd.name);
      if (!name) return fail('INVALID', 'Nama toko wajib');
      shopId = 'SP' + rand(6);
      shop = {
        shop_id: shopId, name: name.slice(0, 120), owner_name: str(sd.owner_name).slice(0, 80), phone: str(sd.phone).slice(0, 30),
        address: str(sd.address).slice(0, 200), area: str(sd.area).slice(0, 60), type: SHOP_TYPES.indexOf(sd.type) >= 0 ? sd.type : 'lainnya',
        type_other: SHOP_TYPES.indexOf(sd.type) < 0 || sd.type === 'lainnya' ? (str(sd.type_other) || (SHOP_TYPES.indexOf(sd.type) < 0 ? str(sd.type) : '')).slice(0, 60) : '',
        chain: str(sd.chain).slice(0, 40),
        lat: num(data.lat), lng: num(data.lng), created_by: me.name, created_at: now, last_visit_at: now, visits: 1,
        status: data.outcome === 'order' || data.outcome === 'sudah_pelanggan' ? 'pelanggan' : 'prospek', customer_id: 0,
        next_visit: isDate(data.next_visit) ? data.next_visit : ''
      };
      ops.shops.push(forWrite(shop, -1));
    }
    let photo = typeof data.photo_base64 === 'string' ? data.photo_base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '') : '';
    const warnings = [];
    const placePhoto = data.photo_place === true && BLACK_OUTCOMES.indexOf(data.outcome) >= 0; // a photo of the closed / missing shop
    if (photo && data.photo_consent !== true && !placePhoto) { photo = ''; warnings.push('Foto tidak disimpan: pemilik toko belum setuju'); }
    if (photo.length > 60000) { photo = ''; warnings.push('Foto terlalu besar, tidak disimpan'); }
    const visit = {
      visit_id: 'VS' + rand(7), client_id: req.client_id, user: me.name, visit_date: req.today, visit_time: now, shop_id: shopId, shop_name: str(shop.name),
      lat: Math.round(num(data.lat) * 1e6) / 1e6, lng: Math.round(num(data.lng) * 1e6) / 1e6, acc: Math.round(num(data.acc)), distance_m: distance,
      outcome: OUTCOMES.indexOf(data.outcome) >= 0 ? data.outcome : 'tertarik', notes: str(data.notes).slice(0, 500),
      // v30 (owner 2026-10-10): the rep's impression of the shop, 1–5 stars (0 = not rated).
      rating: Math.max(0, Math.min(5, Math.round(num(data.rating)))),
      next_visit: isDate(data.next_visit) ? data.next_visit : '', photo_thumb: photo, drive_url: ''
    };
    if (BLACK_OUTCOMES.indexOf(visit.outcome) >= 0 && !photo) warnings.push('Foto tempat wajib untuk hasil ini'); // the app asks for it; an old app copy is still accepted
    ops.visits.push(forWrite(visit, -1));
    if (myDay && !myDay.ended_at) ops.tracks.push(forWrite({ user: me.name, track_date: req.today, t: now, lat: visit.lat, lng: visit.lng, acc: visit.acc, speed: 0, battery: 0 }, -1));
    return done({ ok: true, duplicate: false, visit: visitOut(visit, false), shop: clean(shop), warnings: warnings });
  }

  case 'field_order': {
    const dup = rows('Get Order By Client').find(function (o) { return o.client_id === req.client_id; });
    if (dup) return done({ ok: true, duplicate: true, order: clean(dup) });
    if (!data.client_id) return fail('INVALID', 'client_id wajib');
    const shop = shopById[String(data.shop_id || '')];
    if (!shop) return fail('NOT_FOUND', 'Toko tidak ditemukan');
    const items = Array.isArray(data.items) ? data.items.slice(0, 100) : [];
    if (!items.length) return fail('INVALID', 'Pesanan kosong');
    const cust = num(shop.customer_id) > 0 ? rows('Get Customers').find(function (c) { return Number(c.id) === Number(shop.customer_id); }) : null;
    const grosirShop = !!(cust && cust.type === 'grosir');
    const lines = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const p = productById[String(it.product_id)];
      if (!p || p.active === false) return fail('NOT_FOUND', 'Produk tidak ditemukan: ' + it.product_id);
      const qty = Math.round(num(it.qty) * 1000) / 1000;
      if (!(qty > 0)) return fail('INVALID', 'Jumlah tidak valid: ' + p.name);
      // Price is decided by the server: wholesale for grosir customers or from the wholesale minimum quantity.
      const grosir = money(p.wholesale_price) > 0 && (grosirShop || (num(p.wholesale_min_qty) > 0 && qty >= num(p.wholesale_min_qty)));
      const price = grosir ? money(p.wholesale_price) : money(p.retail_price);
      lines.push({ product_id: p.id, sku: str(p.sku), name: str(p.name), unit: str(p.unit), qty: qty, price_type: grosir ? 'grosir' : 'eceran', unit_price: price, line_total: Math.round(qty * price) });
    }
    const order = {
      order_id: 'SO' + rand(7), client_id: req.client_id, user: me.name, order_date: req.today, shop_id: shop.shop_id, shop_name: str(shop.name),
      items: JSON.stringify(lines), total: lines.reduce(function (a, l) { return a + l.line_total; }, 0), notes: str(data.notes).slice(0, 500),
      // v30 (owner 2026-10-10): payment method, so orders can be organised by how they'll be paid.
      payment_method: ['tunai', 'transfer', 'tempo', 'qris'].indexOf(data.payment_method) >= 0 ? data.payment_method : 'tunai',
      delivery_date: isDate(data.delivery_date) ? data.delivery_date : '', status: 'baru', invoice_no: '', updated_by: '',
      order_time: new Date().toISOString(), status_note: ''
    };
    ops.orders.push(forWrite(order, -1));
    return done({ ok: true, duplicate: false, order: order });
  }

  case 'plan_save': {
    // One plan per rep per day (today … +14 days); saving again replaces it. Stops: system shops (shop_id) or new
    // places picked on the map (name + position, optional address / type) — a place becomes a shop at its first visit.
    const pd = str(data.plan_date);
    if (!isDate(pd) || pd < req.today || pd > addDaysYmd(req.today, 14)) return fail('INVALID', 'Tanggal rencana: hari ini sampai 14 hari lagi');
    const raw = Array.isArray(data.stops) ? data.stops : [];
    if (raw.length > 60) return fail('INVALID', 'Maksimal 60 titik');
    const stops = [];
    for (let i = 0; i < raw.length; i++) {
      const x = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
      if (!isCoord(x.lat, x.lng)) return fail('INVALID', 'Lokasi titik ' + (i + 1) + ' tidak valid');
      const sh = x.shop_id ? shopById[str(x.shop_id)] : null;
      const name = str(x.name).slice(0, 100) || (sh ? str(sh.name) : '');
      if (!name) return fail('INVALID', 'Nama titik ' + (i + 1) + ' wajib');
      stops.push({ ref: str(x.ref).slice(0, 40) || ('s' + (i + 1)), kind: sh ? 'shop' : 'place', shop_id: sh ? sh.shop_id : '', name: name,
        lat: Math.round(num(x.lat) * 1e6) / 1e6, lng: Math.round(num(x.lng) * 1e6) / 1e6, address: str(x.address).slice(0, 200),
        type: SHOP_TYPES.indexOf(x.type) >= 0 ? x.type : '', src: ['osm', 'map', 'shop', 'gm'].indexOf(x.src) >= 0 ? x.src : '' });
      if (str(x.phone)) stops[stops.length - 1].phone = str(x.phone).replace(/[^\d+]/g, '').slice(0, 20); // v33: a Google Maps place keeps its phone
      if (/^[a-z_]{1,20}$/.test(str(x.cat))) stops[stops.length - 1].cat = str(x.cat); // v32: the kind searched for (its colour on the map)
    }
    const st = data.start && typeof data.start === 'object' ? data.start : {};
    const en = data.end && typeof data.end === 'object' ? data.end : {};
    const ex = rows('Get Plans').find(function (p) { return mine(p) && p.plan_date === pd; });
    const now = new Date().toISOString();
    const plan = { plan_id: ex ? ex.plan_id : 'RP' + rand(7), user: me.name, plan_date: pd,
      start_label: isCoord(st.lat, st.lng) ? str(st.label).slice(0, 120) : '', start_lat: isCoord(st.lat, st.lng) ? Math.round(num(st.lat) * 1e6) / 1e6 : 0,
      start_lng: isCoord(st.lat, st.lng) ? Math.round(num(st.lng) * 1e6) / 1e6 : 0,
      end_label: isCoord(en.lat, en.lng) ? str(en.label).slice(0, 120) : '', end_lat: isCoord(en.lat, en.lng) ? Math.round(num(en.lat) * 1e6) / 1e6 : 0,
      end_lng: isCoord(en.lat, en.lng) ? Math.round(num(en.lng) * 1e6) / 1e6 : 0,
      stops: JSON.stringify(stops), streets: JSON.stringify(cleanStreets(data.streets)), note: str(data.note).slice(0, 300),
      created_at: ex ? str(ex.created_at) : now, updated_at: now };
    ops.plans.push(forWrite(plan, ex ? ex.id : -1));
    // the permanent street log: this plan's streets are (re)written; a street taken out of the plan is marked removed
    const logged = rows('Get Plan Street Log').filter(function (r) { return str(r.plan_id) === plan.plan_id; }), keep = {};
    jsonList(plan.streets).forEach(function (x) {
      const k = streetKey(x); if (keep[k]) return; keep[k] = true;
      const old = logged.find(function (r) { return str(r.skey) === k; });
      ops.street_log.push(forWrite(Object.assign({ skey: k, user: me.name, name: x.name, plan_date: pd, plan_id: plan.plan_id, drawn: x.drawn === true ? 1 : 0,
        ref: x.ref, lines: JSON.stringify(x.lines || []), removed: 0, updated_at: now }, streetBox(x.lines)), old ? old.id : -1));
    });
    logged.forEach(function (r) { if (!keep[str(r.skey)] && !num(r.removed)) ops.street_log.push(forWrite({ removed: 1, updated_at: now }, r.id)); });
    return done({ ok: true, plan: planOut(plan) });
  }

  case 'streets_worked': {
    // v31b (owner 2026-10-11): every street a rep plans to work is kept on the map for ALL reps, so a second rep does not
    // repeat the same street. v32: KEPT FOREVER (owner: "always, not only 60 days") — read from the permanent street log,
    // around the rep's area (data.lat/lng, ±0.2°), latest entry per street and rep (the loader groups them), planned ones too.
    if (role !== 'sales' && !isBoss) return fail('FORBIDDEN', 'Hanya sales, pemilik atau manajer');
    const seen = {}, list = [];
    rows('Get Street Log').slice().sort(function (a, b) { return str(b.plan_date).localeCompare(str(a.plan_date)); }).forEach(function (r) {
      const k = str(r.skey) + '|' + str(r.user).toLowerCase();
      if (!r.name || num(r.removed) || seen[k] || list.length >= 1000) return; seen[k] = true;
      const o = { name: str(r.name), user: str(r.user), plan_date: str(r.plan_date), status: str(r.plan_date) <= req.today ? 'worked' : 'planned', lines: jsonList(r.lines) };
      if (num(r.drawn)) { o.drawn = true; o.ref = str(r.ref); }
      list.push(o);
    });
    return done({ ok: true, streets: list, since: '' });
  }

  case 'list_reps': {
    // the office picks the rep to send a shop list to
    return done({ ok: true, reps: users.filter(function (u) { return u.role === 'sales'; }).map(function (u) { return str(u.name); }) });
  }

  case 'list_send': {
    // v33 (owner 2026-10-11): manager / accountant / cashier (or the owner) send a rep the shops of a street, copied or
    // shared from Google Maps (free). It reaches the rep's phone at its next refresh and goes into his plan for that day.
    if (role === 'sales') return fail('FORBIDDEN', 'Daftar toko dikirim dari kantor');
    const to = users.find(function (u) { return u.role === 'sales' && str(u.name).toLowerCase() === str(data.to_user).toLowerCase(); });
    if (!to) return fail('INVALID', 'Pilih sales tujuan');
    const pd = str(data.plan_date);
    if (!isDate(pd) || pd < req.today || pd > addDaysYmd(req.today, 14)) return fail('INVALID', 'Tanggal: hari ini sampai 14 hari lagi');
    const places = cleanPlaces(data.places);
    if (!places.length) return fail('INVALID', 'Daftar toko kosong');
    const l = { list_id: 'SL' + rand(7), from_user: me.name, from_role: role, to_user: str(to.name), plan_date: pd, street: str(data.street).slice(0, 100),
      places: JSON.stringify(places), note: str(data.note).slice(0, 300), status: 'sent', created_at: new Date().toISOString(), received_at: '' };
    ops.shop_lists.push(forWrite(l, -1));
    return done({ ok: true, list: listOut(l) });
  }

  case 'lists_sent': {
    // the office sees what it sent (last 30 days) and whether the rep's phone received it
    const all = isBoss || role === 'akuntan';
    const list = rows('Get Sent Lists').filter(function (l) { return all || str(l.from_user).toLowerCase() === meKey; })
      .sort(function (a, b) { return str(b.created_at).localeCompare(str(a.created_at)); }).slice(0, 100)
      .map(function (l) { const o = listOut(l); o.n = o.places.length; delete o.places; return o; });
    return done({ ok: true, lists: list });
  }

  case 'list_ack': {
    // the rep's phone took these lists into its plan
    const ids = (Array.isArray(data.list_ids) ? data.list_ids : []).slice(0, 20).map(str);
    let n = 0;
    rows('Get Open Lists').forEach(function (l) {
      if (ids.indexOf(str(l.list_id)) < 0 || str(l.to_user).toLowerCase() !== meKey || str(l.status) !== 'sent') return;
      ops.shop_lists.push(forWrite({ status: 'received', received_at: new Date().toISOString() }, l.id)); n++;
    });
    return done({ ok: true, acked: n });
  }

  case 'resolve_links': {
    // Google Maps short links → position: validated here, followed by the Worker (no page is read, no Google key)
    const urls = (Array.isArray(data.urls) ? data.urls : []).map(str).filter(function (u) { return u.length <= 300 && GMAPS_URL.test(u); }).slice(0, 8);
    if (!urls.length) return fail('INVALID', 'Tidak ada link Google Maps');
    return done({ ok: true, resolve: urls });
  }

  case 'list_field': {
    if (!isDate(data.from) || !isDate(data.to) || data.from > data.to) return fail('INVALID', 'Rentang tanggal tidak valid');
    const span = (Date.parse(data.to) - Date.parse(data.from)) / 86400000;
    if (span > 366) return fail('INVALID', 'Maksimal 1 tahun');
    const u = str(data.user).toLowerCase();
    const byUser = function (r) { return !u || str(r.user).toLowerCase() === u; };
    const orderMap = {};
    rows('Get Range Orders').concat(rows('Get Open Orders')).forEach(function (o) { orderMap[o.order_id] = clean(o); });
    return done({
      ok: true,
      tracks: span <= 7 && data.include_tracks !== false ? rows('Get Range Tracks').filter(byUser).map(function (t) { return { user: t.user, track_date: t.track_date, t: t.t, lat: t.lat, lng: t.lng, acc: t.acc, speed: t.speed, battery: t.battery }; }) : [],
      visits: rows('Get Range Visits').filter(byUser).map(function (v) { return visitOut(v, span <= 31); }),
      shops: shops.map(clean),
      orders: Object.keys(orderMap).map(function (k) { return orderMap[k]; }).filter(byUser),
      days: rows('Get Range Days').filter(byUser).map(clean),
      plans: rows('Get Range Plans').filter(byUser).map(planOut)
    });
  }

  case 'cashier_orders': {
    // Read-only list of open field orders for the counter cashier to prepare/fulfil. No tracks, no costs.
    // Reuses the existing 'Get Open Orders' node (already read by list_field above); orders carry selling prices only.
    const open = rows('Get Open Orders').map(function (o) { return clean(o); });
    open.sort(function (a, b) { return String(a.order_time) < String(b.order_time) ? 1 : -1; });
    return done({ ok: true, orders: open });
  }

  case 'update_order': {
    const o = rows('Get Order By Id').find(function (x) { return x.order_id === req.order_id; });
    if (!o) return fail('NOT_FOUND', 'Pesanan tidak ditemukan');
    const st = ['diproses', 'dikirim', 'batal'].indexOf(data.status) >= 0 ? data.status : null;
    if (!st) return fail('INVALID', 'Status tidak valid');
    const no = Object.assign({}, o, {
      status: st, invoice_no: str(data.invoice_no) || str(o.invoice_no), updated_by: me.name,
      status_note: str(data.note).slice(0, 300) || str(o.status_note)
    });
    ops.orders.push(forWrite(no, o.id));
    return done({ ok: true, order: clean(no) });
  }

  case 'link_shop': {
    const shop = shopById[String(data.shop_id || '')];
    if (!shop) return fail('NOT_FOUND', 'Toko tidak ditemukan');
    const cid = Number(data.customer_id);
    const cust = rows('Get Customers').find(function (c) { return Number(c.id) === cid; });
    if (!cust) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
    const ns = Object.assign({}, shop, { customer_id: cust.id, status: 'pelanggan' });
    ops.shops.push(forWrite(ns, shop.id));
    return done({ ok: true, shop: clean(ns) });
  }

  case 'set_product_image': {
    const p = productById[String(data.product_id)];
    if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan');
    const img = typeof data.image_base64 === 'string' ? data.image_base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '') : '';
    if (img.length < 100) return fail('INVALID', 'Foto wajib');
    if (img.length > 82000) return fail('INVALID', 'Foto terlalu besar (maks ±60 KB)');
    const ex = rows('Get Images').find(function (x) { return Number(x.product_id) === Number(p.id); });
    const now = new Date().toISOString();
    ops.images.push(forWrite({ product_id: p.id, image_base64: img, updated_at: now }, ex ? ex.id : -1));
    ops.product_flags.push({ _id: p.id, image_updated: now });
    return done({ ok: true, product_id: p.id, image_updated: now });
  }

  case 'product_images': {
    const ids = Array.isArray(data.ids) ? data.ids.map(Number) : null;
    return done({ ok: true, images: rows('Get Images').filter(function (x) { return !ids || ids.indexOf(Number(x.product_id)) >= 0; })
      .map(function (x) { return { product_id: x.product_id, image_base64: x.image_base64, updated_at: x.updated_at }; }) });
  }

  default:
    return fail('INVALID', 'Aksi tidak dikenal: ' + req.action);
}
