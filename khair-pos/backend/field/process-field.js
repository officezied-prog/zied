const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Field').first().json;
const data = req.data || {};
const ops = { shops: [], visits: [], tracks: [], days: [], orders: [], images: [], product_flags: [] };

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
const me = users.find(function (u) { return str(u.name).toLowerCase() === req.user.trim().toLowerCase(); });
if (!me || me.pin_hash !== req.pin_hash) return fail('BAD_PIN', 'Nama atau PIN salah');
const role = ['owner', 'manager', 'sales'].indexOf(me.role) >= 0 ? me.role : 'kasir';
if (role === 'kasir') return fail('FORBIDDEN', 'Aplikasi ini untuk sales lapangan');
const isBoss = role === 'owner' || role === 'manager';
const SALES_ONLY = ['day_start', 'day_end', 'track', 'check_in', 'field_order'];
const BOSS_ONLY = ['list_field', 'update_order', 'set_product_image', 'link_shop'];
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
function visitOut(v, full) {
  const o = clean(v);
  if (!full) delete o.photo_thumb;
  return o;
}
const SHOP_TYPES = ['warung', 'toko', 'minimarket', 'bakery', 'katering', 'restoran', 'masjid', 'lainnya'];
const OUTCOMES = ['order', 'tertarik', 'tidak', 'tutup', 'sudah_pelanggan'];

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
        lat: num(data.lat), lng: num(data.lng), created_by: me.name, created_at: now, last_visit_at: now, visits: 1,
        status: data.outcome === 'order' || data.outcome === 'sudah_pelanggan' ? 'pelanggan' : 'prospek', customer_id: 0,
        next_visit: isDate(data.next_visit) ? data.next_visit : ''
      };
      ops.shops.push(forWrite(shop, -1));
    }
    let photo = typeof data.photo_base64 === 'string' ? data.photo_base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '') : '';
    const warnings = [];
    if (photo && data.photo_consent !== true) { photo = ''; warnings.push('Foto tidak disimpan: pemilik toko belum setuju'); }
    if (photo.length > 60000) { photo = ''; warnings.push('Foto terlalu besar, tidak disimpan'); }
    const visit = {
      visit_id: 'VS' + rand(7), client_id: req.client_id, user: me.name, visit_date: req.today, visit_time: now, shop_id: shopId, shop_name: str(shop.name),
      lat: Math.round(num(data.lat) * 1e6) / 1e6, lng: Math.round(num(data.lng) * 1e6) / 1e6, acc: Math.round(num(data.acc)), distance_m: distance,
      outcome: OUTCOMES.indexOf(data.outcome) >= 0 ? data.outcome : 'tertarik', notes: str(data.notes).slice(0, 500),
      next_visit: isDate(data.next_visit) ? data.next_visit : '', photo_thumb: photo, drive_url: ''
    };
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
      delivery_date: isDate(data.delivery_date) ? data.delivery_date : '', status: 'baru', invoice_no: '', updated_by: '',
      order_time: new Date().toISOString(), status_note: ''
    };
    ops.orders.push(forWrite(order, -1));
    return done({ ok: true, duplicate: false, order: order });
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
      days: rows('Get Range Days').filter(byUser).map(clean)
    });
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
