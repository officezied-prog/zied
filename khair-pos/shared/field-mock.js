/* Khair Sales (v8) — mock of the field-sales workflow (POST …/webhook/khair-field), for ?mock=1.
 *
 * Plain script, self-contained, exposes only window.KhairFieldMock:
 *   actions                      list of the v8 action names
 *   handle(action, data, user, db, helpers)
 *                                user = {name, role} (already authenticated by the main mock);
 *                                db   = the kmock.db object (mutated in place, the caller saves it);
 *                                helpers (optional) = {now(): Date, jktDate(d), jktISO(d)} overrides;
 *                                returns the response object WITHOUT `ok` (the caller adds it),
 *                                or throws {code, message} (BAD codes as in API.md).
 *   seed(db)                     idempotent: adds the demo rep Ahmad (sales, PIN 4444) if missing and,
 *                                only when db.shops is missing, ~14 days of field data around
 *                                Condet / Kramat Jati / Cililitan. Returns true when it changed db.
 *
 * Tables inside kmock.db: shops, visits, tracks, field_days, field_orders, product_images
 * (+ products[].image_updated). Shapes follow API.md "Field sales: Khair Sales (v8)".
 * Mock-only extras: field_bootstrap.orders (the rep's orders, last 30 days), product_images[].image_updated,
 * list_field.include_tracks/include_photos (echo of the applied rules), settings.field_* tracking parameters.
 */
(function () {
  'use strict';
  var ACTIONS = ['field_bootstrap', 'day_start', 'day_end', 'track', 'check_in', 'field_order', 'list_field', 'update_order', 'set_product_image', 'product_images', 'link_shop'];
  var SHOP_TYPES = ['warung', 'toko', 'minimarket', 'bakery', 'katering', 'restoran', 'masjid', 'lainnya'];
  var OUTCOMES = ['order', 'tertarik', 'tidak', 'tutup', 'sudah_pelanggan'];
  var ORDER_STATUS = ['baru', 'diproses', 'dikirim', 'batal'];
  var COST_KEYS = ['cost_price', 'total_cost', 'profit', 'line_profit', 'cost'];
  var MAX_PHOTO_B64 = 45 * 1024, MAX_IMAGE_B64 = 60 * 1024, MAX_POINTS = 200, MAX_ACC = 100;
  var STORE = { lat: -6.2655, lng: 106.8605 }; // Khair Mart, Condet (seed start/end point)

  /* ---------- small utilities (no globals) ---------- */
  function E(code, message) { return { code: code, message: message || code }; }
  function int(v) { var n = Math.round(Number(v)); return isFinite(n) ? n : 0; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function H(helpers) {
    helpers = helpers || {};
    var now = typeof helpers.now === 'function' ? helpers.now : function () { return new Date(); };
    var jktDate = helpers.jktDate || function (d) { return new Date(new Date(d == null ? now() : d).getTime() + 7 * 3600000).toISOString().slice(0, 10); };
    var jktISO = helpers.jktISO || function (d) { return new Date(new Date(d == null ? now() : d).getTime() + 7 * 3600000).toISOString().slice(0, 19) + '+07:00'; };
    return { now: now, jktDate: jktDate, jktISO: jktISO };
  }
  function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function validLatLng(lat, lng) { return isFinite(Number(lat)) && isFinite(Number(lng)) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Number(lat) === 0 && Number(lng) === 0); }
  function haversine(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  /** km of a track: sorted by time, accuracy ≤ 100 m, ignores jitter < 15 m and jumps > 150 km/h. */
  function trackKm(points) {
    var p = points.filter(function (x) { return num(x.acc) <= MAX_ACC; }).slice().sort(function (a, b) { return String(a.t).localeCompare(String(b.t)); });
    var m = 0, last = null;
    for (var i = 0; i < p.length; i++) {
      if (!last) { last = p[i]; continue; }
      var d = haversine(last, p[i]), dt = Math.max(1, (Date.parse(p[i].t) - Date.parse(last.t)) / 1000);
      if (d < 15) continue;
      if (d > 300 && d / dt > 42) continue; // > 300 m at > ~150 km/h: GPS jump
      m += d; last = p[i];
    }
    return Math.round(m / 100) / 10;
  }
  function nextId(db, k) { db.seq = db.seq || {}; db.seq[k] = (db.seq[k] || 0) + 1; return db.seq[k]; }
  function ensureTables(db) {
    ['shops', 'visits', 'tracks', 'field_days', 'field_orders', 'product_images'].forEach(function (k) { if (!Array.isArray(db[k])) db[k] = []; });
  }
  function noCost(p) { var o = {}; for (var k in p) if (COST_KEYS.indexOf(k) < 0) o[k] = p[k]; return o; }
  function needRole(user, roles) { if (roles.indexOf(user.role) < 0) throw E('FORBIDDEN', 'Role ' + user.role + ' not allowed'); }
  function sameUser(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }
  // when the action really happened on the phone (sent as data.at, kept while queued offline); server time if missing or implausible
  function clientAt(data, h, today) {
    var a = data && data.at ? Date.parse(data.at) : NaN, n = h.now().getTime();
    if (!isFinite(a) || a > n + 300000 || a < n - 36 * 3600000 || h.jktDate(a) !== today) return h.jktISO();
    return h.jktISO(a);
  }
  function dayRow(db, user, date) { return db.field_days.find(function (d) { return sameUser(d.user, user) && d.day_date === date; }) || null; }
  function dayStatus(d) { return !d ? 'off' : d.ended_at ? 'ended' : 'working'; }
  function dayOut(db, user, date) {
    var d = dayRow(db, user, date);
    var visits = db.visits.filter(function (v) { return sameUser(v.user, user) && v.visit_date === date; }).length;
    var orders = db.field_orders.filter(function (o) { return sameUser(o.user, user) && o.order_date === date && o.status !== 'batal'; }).length;
    var km = d && d.ended_at ? num(d.km) : trackKm(db.tracks.filter(function (x) { return sameUser(x.user, user) && x.track_date === date; }));
    return { status: dayStatus(d), day_date: date, started_at: d ? d.started_at : '', ended_at: d ? d.ended_at : '', visits_today: visits, km_today: km, orders_today: orders, note: d ? d.note || '' : '' };
  }
  function shopsFor(db, user) {
    if (user.role !== 'sales') return db.shops;
    var visited = {};
    db.visits.forEach(function (v) { if (sameUser(v.user, user.name)) visited[v.shop_id] = true; });
    return db.shops.filter(function (s) { return sameUser(s.created_by, user.name) || visited[s.shop_id]; });
  }
  function imagesVersion(db) {
    var v = '';
    db.products.forEach(function (p) { if (p.image_updated && p.image_updated > v) v = p.image_updated; });
    return v ? v + '#' + db.product_images.length : '0';
  }
  function priceLine(db, shop, it) {
    var p = db.products.find(function (x) { return x.id === Number(it.product_id); });
    if (!p) throw E('NOT_FOUND', 'product ' + it.product_id);
    if (p.active === false) throw E('INVALID', 'product inactive: ' + p.name);
    var qty = Math.round(num(it.qty) * 1000) / 1000;
    if (!(qty > 0)) throw E('INVALID', 'qty must be > 0');
    var cust = shop && shop.customer_id ? db.customers.find(function (c) { return c.id === shop.customer_id; }) : null;
    var wmin = num(p.wholesale_min_qty), hasW = int(p.wholesale_price) > 0;
    // Server rule: wholesale when the quantity reaches wholesale_min_qty or the shop is a grosir customer.
    var grosir = hasW && ((wmin > 0 && qty >= wmin) || (cust && cust.type === 'grosir'));
    var unit_price = grosir ? int(p.wholesale_price) : int(p.retail_price);
    return { product_id: p.id, sku: p.sku || '', name: p.name, unit: p.unit || '', qty: qty, unit_price: unit_price, price_type: grosir ? 'grosir' : 'eceran', line_total: Math.round(qty * unit_price) };
  }
  function addTrack(db, user, pt, h) {
    db.tracks.push({ user: user, track_date: h.jktDate(pt.t), t: pt.t, lat: Number(pt.lat), lng: Number(pt.lng), acc: Math.round(num(pt.acc)), speed: pt.speed == null ? null : num(pt.speed), battery: pt.battery == null ? null : num(pt.battery) });
  }

  /* ---------- actions ---------- */
  function handle(action, data, user, db, helpers) {
    data = data || {};
    if (!user || !user.name) throw E('BAD_PIN', 'Login required');
    ensureTables(db);
    var h = H(helpers), today = h.jktDate();
    switch (action) {
      case 'field_bootstrap': {
        needRole(user, ['sales', 'owner', 'manager']);
        var st = db.settings || {};
        return {
          user: { name: user.name, role: user.role },
          products: db.products.map(noCost),
          images_version: imagesVersion(db),
          shops: clone(shopsFor(db, user)),
          customers: db.customers.filter(function (c) { return c.type === 'grosir'; }).map(function (c) { return { id: c.id, name: c.name, phone: c.phone, type: c.type, address: c.address }; }),
          day: user.role === 'sales' ? dayOut(db, user.name, today) : { status: 'off', started_at: '', ended_at: '', visits_today: 0, km_today: 0, orders_today: 0 },
          // mock extension (not in API.md yet): the rep's own orders of the last 30 days, so the app can show their status
          orders: user.role === 'sales' ? clone(db.field_orders.filter(function (o) { return sameUser(o.user, user.name) && o.order_date >= h.jktDate(h.now().getTime() - 30 * 86400000); })) : [],
          settings: { store_name: st.store_name, address: st.address, phone: st.phone, field_min_move_m: st.field_min_move_m || 30, field_interval_s: st.field_interval_s || 180, field_batch_min: st.field_batch_min || 10, field_max_acc_m: st.field_max_acc_m || MAX_ACC }
        };
      }
      case 'day_start': {
        needRole(user, ['sales']);
        var d = dayRow(db, user.name, today);
        var now = clientAt(data, h, today);
        if (!d) {
          d = { user: user.name, day_date: today, started_at: now, ended_at: '', start_lat: validLatLng(data.lat, data.lng) ? Number(data.lat) : null, start_lng: validLatLng(data.lat, data.lng) ? Number(data.lng) : null, end_lat: null, end_lng: null, km: 0, visits: 0, orders: 0, note: '' };
          db.field_days.push(d);
        } else if (d.ended_at) { d.ended_at = ''; d.end_lat = null; d.end_lng = null; } // re-open the same day
        if (validLatLng(data.lat, data.lng)) addTrack(db, user.name, { lat: data.lat, lng: data.lng, acc: data.acc, t: now }, h);
        return { day: dayOut(db, user.name, today) };
      }
      case 'day_end': {
        needRole(user, ['sales']);
        var de = dayRow(db, user.name, today);
        if (!de || de.ended_at) throw E('INVALID', 'Day not started');
        var t = clientAt(data, h, today);
        if (validLatLng(data.lat, data.lng)) addTrack(db, user.name, { lat: data.lat, lng: data.lng, acc: data.acc, t: t }, h);
        var o = dayOut(db, user.name, today);
        de.ended_at = t; de.end_lat = validLatLng(data.lat, data.lng) ? Number(data.lat) : null; de.end_lng = validLatLng(data.lat, data.lng) ? Number(data.lng) : null;
        de.km = o.km_today; de.visits = o.visits_today; de.orders = o.orders_today; de.note = String(data.note || '');
        return { day: dayOut(db, user.name, today) };
      }
      case 'track': {
        needRole(user, ['sales']);
        var pts = Array.isArray(data.points) ? data.points : null;
        if (!pts) throw E('INVALID', 'points required');
        if (pts.length > MAX_POINTS) throw E('INVALID', 'max ' + MAX_POINTS + ' points per call');
        var saved = 0, ignored = 0;
        pts.forEach(function (p) {
          var t = p && p.t && !isNaN(Date.parse(p.t)) ? p.t : null;
          if (!t || !validLatLng(p.lat, p.lng)) { ignored++; return; }
          var dd = dayRow(db, user.name, h.jktDate(t));
          // only between day_start and day_end of that day
          var ts = Date.parse(t);
          if (!dd || ts < Date.parse(dd.started_at) - 60000 || (dd.ended_at && ts > Date.parse(dd.ended_at) + 60000)) { ignored++; return; }
          if (db.tracks.some(function (x) { return sameUser(x.user, user.name) && x.t === t && x.lat === Number(p.lat) && x.lng === Number(p.lng); })) { ignored++; return; } // resent batch
          addTrack(db, user.name, p, h); saved++;
        });
        return { saved: saved, ignored: ignored };
      }
      case 'check_in': {
        needRole(user, ['sales']);
        var cid = String(data.client_id || '');
        if (!cid) throw E('INVALID', 'client_id required');
        var ex = db.visits.find(function (v) { return v.client_id === cid; });
        if (ex) return { visit: clone(ex), shop: clone(db.shops.find(function (s) { return s.shop_id === ex.shop_id; }) || null), duplicate: true };
        if (!validLatLng(data.lat, data.lng)) throw E('INVALID', 'lat/lng required');
        var outcome = String(data.outcome || '');
        if (OUTCOMES.indexOf(outcome) < 0) throw E('INVALID', 'outcome');
        var photo = String(data.photo_base64 || '').replace(/^data:[^,]*,/, '');
        if (photo) {
          if (data.photo_consent !== true) throw E('INVALID', 'photo_consent required to store a photo');
          if (photo.length > MAX_PHOTO_B64) throw E('INVALID', 'photo too large (max 45 KB base64)');
        }
        if (data.next_visit && !isYmd(data.next_visit)) throw E('INVALID', 'next_visit');
        var shop;
        var vt = clientAt(data, h, today);
        if (data.shop_id) {
          shop = db.shops.find(function (s) { return s.shop_id === data.shop_id; });
          if (!shop) throw E('NOT_FOUND', 'shop');
        } else {
          var sd = data.shop || {};
          var name = String(sd.name || '').trim();
          if (!name) throw E('INVALID', 'shop.name required');
          shop = {
            shop_id: 'TK-' + pad(nextId(db, 'shop'), 4), name: name, owner_name: String(sd.owner_name || '').trim(), phone: String(sd.phone || '').trim(),
            address: String(sd.address || '').trim(), area: String(sd.area || '').trim(), type: SHOP_TYPES.indexOf(sd.type) >= 0 ? sd.type : 'lainnya',
            lat: Number(data.lat), lng: Number(data.lng), created_by: user.name, created_at: vt, last_visit_at: '', visits: 0, status: 'prospek', customer_id: null, next_visit: ''
          };
          db.shops.push(shop);
        }
        var dist = validLatLng(shop.lat, shop.lng) ? Math.round(haversine({ lat: Number(data.lat), lng: Number(data.lng) }, shop)) : null;
        var visit = {
          visit_id: 'KV-' + pad(nextId(db, 'visit'), 5), client_id: cid, user: user.name, visit_date: today, visit_time: vt, shop_id: shop.shop_id, shop_name: shop.name,
          lat: Number(data.lat), lng: Number(data.lng), acc: Math.round(num(data.acc)), distance_m: dist, outcome: outcome, notes: String(data.notes || ''),
          next_visit: data.next_visit || '', photo_thumb: photo, photo_consent: !!(photo && data.photo_consent === true), drive_url: ''
        };
        db.visits.push(visit);
        shop.last_visit_at = vt; shop.visits = int(shop.visits) + 1;
        if (data.next_visit) shop.next_visit = data.next_visit;
        if (outcome === 'order' || outcome === 'sudah_pelanggan') shop.status = 'pelanggan';
        var dw = dayRow(db, user.name, today);
        if (dw && !dw.ended_at) addTrack(db, user.name, { lat: data.lat, lng: data.lng, acc: data.acc, t: vt }, h); // a point at every check-in (working hours only)
        return { visit: clone(visit), shop: clone(shop), duplicate: false };
      }
      case 'field_order': {
        needRole(user, ['sales']);
        var ocid = String(data.client_id || '');
        if (!ocid) throw E('INVALID', 'client_id required');
        var oex = db.field_orders.find(function (o) { return o.client_id === ocid; });
        if (oex) return { order: clone(oex), duplicate: true };
        var oshop = db.shops.find(function (s) { return s.shop_id === data.shop_id; });
        if (!oshop) throw E('NOT_FOUND', 'shop');
        if (!Array.isArray(data.items) || !data.items.length) throw E('INVALID', 'items required');
        if (data.delivery_date && !isYmd(data.delivery_date)) throw E('INVALID', 'delivery_date');
        var lines = data.items.map(function (it) { return priceLine(db, oshop, it); }); // client prices are ignored
        var order = {
          order_id: 'FO-' + pad(nextId(db, 'field_order'), 4), client_id: ocid, user: user.name, order_date: today, order_time: h.jktISO(), shop_id: oshop.shop_id, shop_name: oshop.name,
          visit_id: data.visit_id || '', items: JSON.stringify(lines), total: lines.reduce(function (a, l) { return a + l.line_total; }, 0), notes: String(data.notes || ''),
          delivery_date: data.delivery_date || '', status: 'baru', invoice_no: '', updated_by: '', status_note: ''
        };
        db.field_orders.push(order);
        if (oshop.status !== 'pelanggan') oshop.status = 'pelanggan';
        return { order: clone(order), duplicate: false };
      }
      case 'list_field': {
        needRole(user, ['owner', 'manager']);
        if (!isYmd(data.from) || !isYmd(data.to) || data.to < data.from) throw E('INVALID', 'from/to');
        // inclusive number of days in the range
        var span = Math.round((Date.parse(data.to + 'T00:00:00Z') - Date.parse(data.from + 'T00:00:00Z')) / 86400000) + 1;
        if (span > 366) throw E('INVALID', 'Range too long (max 1 year)');
        var withTracks = data.include_tracks !== false && span <= 7;   // tracks only for ranges ≤ 7 days
        var withPhotos = span <= 31;                                    // photo_thumb only for ranges ≤ 31 days
        var inR = function (d) { return d >= data.from && d <= data.to; };
        var who = function (u) { return !data.user || sameUser(u, data.user); };
        return {
          tracks: withTracks ? db.tracks.filter(function (x) { return inR(x.track_date) && who(x.user); }) : [],
          visits: db.visits.filter(function (x) { return inR(x.visit_date) && who(x.user); }).map(function (v) { return withPhotos ? v : Object.assign({}, v, { photo_thumb: '' }); }),
          shops: db.shops,
          orders: db.field_orders.filter(function (x) { return inR(x.order_date) && who(x.user); }),
          days: db.field_days.filter(function (x) { return inR(x.day_date) && who(x.user); }).map(function (x) { if (x.ended_at) return x; var o = dayOut(db, x.user, x.day_date); return Object.assign({}, x, { km: o.km_today, visits: o.visits_today, orders: o.orders_today }); }),
          include_tracks: withTracks, include_photos: withPhotos
        };
      }
      case 'link_shop': {
        needRole(user, ['owner', 'manager']);
        var ls = db.shops.find(function (x) { return x.shop_id === data.shop_id; });
        if (!ls) throw E('NOT_FOUND', 'shop');
        var lc = (db.customers || []).find(function (c) { return c.id === Number(data.customer_id); });
        if (!lc) throw E('NOT_FOUND', 'customer');
        ls.customer_id = lc.id; ls.status = 'pelanggan';
        return { shop: clone(ls) };
      }
      case 'update_order': {
        needRole(user, ['owner', 'manager']);
        var ord = db.field_orders.find(function (o) { return o.order_id === data.order_id; });
        if (!ord) throw E('NOT_FOUND', 'order');
        if (['diproses', 'dikirim', 'batal'].indexOf(data.status) < 0) throw E('INVALID', 'status');
        ord.status = data.status; ord.status_note = String(data.note || ''); ord.updated_by = user.name; ord.updated_at = h.jktISO();
        if (data.invoice_no) ord.invoice_no = String(data.invoice_no);
        return { order: clone(ord) };
      }
      case 'set_product_image': {
        needRole(user, ['owner', 'manager']);
        var prod = db.products.find(function (p) { return p.id === Number(data.product_id); });
        if (!prod) throw E('NOT_FOUND', 'product');
        var img = String(data.image_base64 || '').replace(/^data:[^,]*,/, '');
        if (!img) throw E('INVALID', 'image_base64 required');
        if (img.length > MAX_IMAGE_B64) throw E('INVALID', 'image too large (max 60 KB base64)');
        var at = h.jktISO();
        var row = db.product_images.find(function (x) { return x.product_id === prod.id; });
        if (row) { row.image_base64 = img; row.image_updated = at; } else db.product_images.push({ product_id: prod.id, image_base64: img, image_updated: at });
        prod.image_updated = at;
        return { product_id: prod.id, image_updated: at };
      }
      case 'product_images': {
        var ids = Array.isArray(data.ids) ? data.ids.map(Number) : null;
        return { images: db.product_images.filter(function (x) { return !ids || ids.indexOf(Number(x.product_id)) >= 0; }).map(function (x) { return { product_id: x.product_id, image_base64: x.image_base64, image_updated: x.image_updated }; }) };
      }
      default: throw E('INVALID', 'Unknown action ' + action);
    }
  }

  /* ---------- synchronous SHA-256 (to hash the demo PIN like the main mock does) ---------- */
  function sha256(str) {
    var bytes = new TextEncoder().encode(str);
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var Hh = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length, total = ((len + 9 + 63) >> 6) << 6;
    var m = new Uint8Array(total); m.set(bytes); m[len] = 0x80;
    var bits = len * 8; for (var i = 0; i < 4; i++) m[total - 1 - i] = (bits >>> (8 * i)) & 255;
    m[total - 5] = Math.floor(bits / 4294967296) & 255;
    var W = new Uint32Array(64), r = function (x, n) { return (x >>> n) | (x << (32 - n)); };
    for (var o = 0; o < total; o += 64) {
      for (i = 0; i < 16; i++) W[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3];
      for (i = 16; i < 64; i++) { var s0 = r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
      var a = Hh[0], b = Hh[1], c = Hh[2], d = Hh[3], e = Hh[4], f = Hh[5], g = Hh[6], hh = Hh[7];
      for (i = 0; i < 64; i++) {
        var t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      Hh[0] = (Hh[0] + a) | 0; Hh[1] = (Hh[1] + b) | 0; Hh[2] = (Hh[2] + c) | 0; Hh[3] = (Hh[3] + d) | 0; Hh[4] = (Hh[4] + e) | 0; Hh[5] = (Hh[5] + f) | 0; Hh[6] = (Hh[6] + g) | 0; Hh[7] = (Hh[7] + hh) | 0;
    }
    return Hh.map(function (x) { return pad((x >>> 0).toString(16), 8); }).join('');
  }

  /* ---------- seed ---------- */
  function rng(seedN) { var a = seedN >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function b64(s) { try { return btoa(unescape(encodeURIComponent(s))); } catch (e) { return ''; } }
  /** Small generated product picture (SVG, base64 without the data: prefix; starts with "PHN2Zy"). */
  function productSvg(p, hue) {
    var words = String(p.name).split(' ');
    var l1 = words.slice(0, 2).join(' '), l2 = words.slice(2, 4).join(' ');
    var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    return b64('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + hue + ',62%,46%)"/><stop offset="1" stop-color="hsl(' + ((hue + 35) % 360) + ',58%,30%)"/></linearGradient></defs>' +
      '<rect width="400" height="300" fill="url(#g)"/><circle cx="320" cy="70" r="90" fill="#fff" opacity=".12"/><circle cx="60" cy="260" r="70" fill="#fff" opacity=".08"/>' +
      '<rect x="140" y="58" width="120" height="132" rx="22" fill="#fff" opacity=".92"/><rect x="160" y="80" width="80" height="14" rx="7" fill="hsl(' + hue + ',60%,40%)"/>' +
      '<rect x="160" y="104" width="56" height="10" rx="5" fill="hsl(' + hue + ',40%,70%)"/><circle cx="200" cy="150" r="22" fill="hsl(' + hue + ',60%,45%)"/>' +
      '<text x="200" y="236" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">' + esc(l1) + '</text>' +
      '<text x="200" y="268" font-family="Arial,sans-serif" font-size="20" fill="#fff" opacity=".9" text-anchor="middle">' + esc(l2) + '</text></svg>');
  }
  var SHOP_SEED = [
    ['Warung Bu Siti Condet', 'Bu Siti', 'warung', 'Condet'], ['Toko Sembako Barokah', 'Pak Rahmat', 'toko', 'Condet'], ['Minimarket Berkah Jaya', 'Pak Hendra', 'minimarket', 'Balekambang'],
    ['Roti Ummi Bakery', 'Bu Ummi', 'bakery', 'Batu Ampar'], ['Katering Al-Ikhlas', 'Bu Nur', 'katering', 'Kramat Jati'], ['Rumah Makan Padang Sederhana', 'Uda Rizal', 'restoran', 'Cililitan'],
    ['Masjid Al-Hidayah', 'Ust. Hasan', 'masjid', 'Condet'], ['Warung Kopi Bang Jali', 'Bang Jali', 'warung', 'Kramat Jati'], ['Toko Kurma Al-Madinah', 'Pak Salim', 'toko', 'Condet'],
    ['Warung Mpok Ipah', 'Mpok Ipah', 'warung', 'Batu Ampar'], ['Toko Oleh-oleh Haji Nur', 'H. Nur', 'toko', 'Cililitan'], ['Minimarket Sinar Pagi', 'Bu Lina', 'minimarket', 'Kramat Jati'],
    ['Bakery Kue Arab Yaman', 'Pak Ahmad Baraqbah', 'bakery', 'Condet'], ['Katering Barokah Aqiqah', 'Bu Fauziah', 'katering', 'Balekambang'], ['Resto Kebab Turki', 'Mas Deni', 'restoran', 'Cililitan'],
    ['Warung Sembako Pak Udin', 'Pak Udin', 'warung', 'Dukuh'], ['Toko Rempah Hadramaut', 'Pak Alwi', 'toko', 'Condet'], ['Warung Nasi Uduk Bu Yati', 'Bu Yati', 'warung', 'Kramat Jati'],
    ['Toko Busana Muslim Az-Zahra', 'Bu Zahra', 'toko', 'Cililitan'], ['Kantin Pesantren Darul Quran', 'Ust. Farid', 'lainnya', 'Batu Ampar'], ['Minimarket Amanah', 'Pak Joko', 'minimarket', 'Balekambang'],
    ['Warung Bu Halimah 2', 'Bu Halimah', 'warung', 'Batu Ampar'], ['Toko Madu & Herbal Syifa', 'Pak Arif', 'toko', 'Kramat Jati'], ['Restoran Nasi Kebuli Abah', 'Abah Umar', 'restoran', 'Condet'],
    ['Warung Jajanan Ceu Popon', 'Ceu Popon', 'warung', 'Dukuh']
  ];
  function seed(db) {
    if (!db || typeof db !== 'object') return false;
    var changed = false;
    db.users = db.users || [];
    if (!db.users.some(function (u) { return sameUser(u.name, 'Ahmad'); })) {
      db.users.push({ name: 'Ahmad', role: 'sales', pin_hash: sha256('demo:ahmad:4444'), active: true });
      changed = true;
    }
    if (Array.isArray(db.shops)) { ensureTables(db); return changed; }
    ensureTables(db);
    db.products = db.products || []; db.customers = db.customers || []; db.seq = db.seq || {};
    var R = rng(20261008), ri = function (a, b) { return a + Math.floor(R() * (b - a + 1)); }, pick = function (a) { return a[Math.floor(R() * a.length)]; };
    var h = H(), todayStr = h.jktDate();
    var addDays = function (ymd, n) { var d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    var iso = function (ymd, minutes) { return ymd + 'T' + pad(Math.floor(minutes / 60), 2) + ':' + pad(minutes % 60, 2) + ':' + pad(ri(0, 59), 2) + '+07:00'; };
    // shops
    var grosirCust = db.customers.filter(function (c) { return c.type === 'grosir'; });
    var created0 = addDays(todayStr, -60);
    SHOP_SEED.forEach(function (s, i) {
      var lat = -6.27 + R() * 0.02, lng = 106.85 + R() * 0.02;
      var cust = i < grosirCust.length ? grosirCust[i] : null; // the first shops are the store's existing grosir customers
      db.shops.push({
        shop_id: 'TK-' + pad(i + 1, 4), name: cust ? cust.name : s[0], owner_name: s[1], phone: '08' + ri(11, 59) + '-' + ri(1000, 9999) + '-' + ri(1000, 9999),
        address: 'Jl. ' + pick(['Raya Condet', 'Batu Ampar', 'Dewi Sartika', 'Kampung Tengah', 'Balekambang', 'Haji Jian', 'Mesjid']) + ' No. ' + ri(1, 120), area: s[3], type: s[2],
        lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, created_by: 'Ahmad', created_at: iso(addDays(created0, i), 9 * 60), last_visit_at: '', visits: 0,
        status: cust || i % 3 === 0 ? 'pelanggan' : 'prospek', customer_id: cust ? cust.id : null, next_visit: ''
      });
    });
    db.seq.shop = db.shops.length;
    var active = db.products.filter(function (p) { return p.active !== false; });
    // days, tracks, visits, orders
    var visitN = 0, orderN = 0;
    for (var d = 14; d >= 1; d--) {
      var date = addDays(todayStr, -d);
      var dow = new Date(date + 'T00:00:00Z').getUTCDay();
      if (dow === 0) continue; // Sunday off
      var start = 8 * 60 + ri(0, 25), minute = start;
      var pos = { lat: STORE.lat + (R() - 0.5) * 0.001, lng: STORE.lng + (R() - 0.5) * 0.001 };
      var dayTracks = [];
      var pushPt = function (p, m, spd) { dayTracks.push({ user: 'Ahmad', track_date: date, t: iso(date, Math.min(m, 23 * 60 + 59)), lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6, acc: ri(5, 35), speed: spd, battery: Math.max(15, 95 - Math.round((m - start) / 6)) }); };
      pushPt(pos, minute, 0);
      var order = db.shops.slice().sort(function () { return R() - 0.5; }).slice(0, ri(4, 8));
      // visit nearest-next to make a plausible route
      var route = [], left = order.slice(), cur = pos;
      while (left.length) { left.sort(function (a, b) { return haversine(cur, a) - haversine(cur, b); }); cur = left.shift(); route.push(cur); }
      var dayVisits = 0, dayOrders = 0;
      route.concat([{ lat: STORE.lat, lng: STORE.lng, home: true }]).forEach(function (target) {
        var dist = haversine(pos, target), mins = Math.max(3, Math.round(dist / 250)); // ~15 km/h on a motorbike
        var steps = Math.max(1, Math.round(mins / 3));
        for (var k = 1; k <= steps; k++) {
          minute += 3;
          var f = k / steps;
          pushPt({ lat: pos.lat + (target.lat - pos.lat) * f + (R() - 0.5) * 0.0002, lng: pos.lng + (target.lng - pos.lng) * f + (R() - 0.5) * 0.0002 }, minute, Math.round(dist / steps / 180 * 10) / 10);
        }
        pos = { lat: target.lat, lng: target.lng };
        if (target.home) return;
        var stay = ri(25, 55); // talk, present the catalog, take the order
        for (var s2 = 3; s2 < stay; s2 += 3) pushPt({ lat: pos.lat + (R() - 0.5) * 0.00008, lng: pos.lng + (R() - 0.5) * 0.00008 }, minute + s2, 0);
        var vt = iso(date, minute + 2);
        var oc = target.status === 'pelanggan' ? pick(['order', 'order', 'order', 'sudah_pelanggan', 'tutup']) : pick(['tertarik', 'tertarik', 'tidak', 'order', 'tutup']);
        var nv = oc === 'tidak' ? '' : addDays(date, pick([3, 5, 7, 7, 10, 14]));
        visitN++;
        var visit = { visit_id: 'KV-' + pad(visitN, 5), client_id: 'seed-v-' + visitN, user: 'Ahmad', visit_date: date, visit_time: vt, shop_id: target.shop_id, shop_name: target.name,
          lat: Math.round((target.lat + (R() - 0.5) * 0.0003) * 1e6) / 1e6, lng: Math.round((target.lng + (R() - 0.5) * 0.0003) * 1e6) / 1e6, acc: ri(6, 40), distance_m: 0, outcome: oc,
          notes: pick(['', 'Minta katalog kurma', 'Pemilik sedang keluar', 'Tertarik kurma Sukkari untuk Ramadan', 'Stok masih ada, kembali minggu depan', 'Minta harga grosir', '']), next_visit: nv, photo_thumb: '', photo_consent: false, drive_url: '' };
        visit.distance_m = Math.round(haversine(visit, target));
        db.visits.push(visit); dayVisits++;
        target.last_visit_at = vt; target.visits = int(target.visits) + 1; if (nv) target.next_visit = nv;
        if (oc === 'order') { target.status = 'pelanggan'; }
        if (oc === 'order' && active.length) {
          var n = ri(1, 4), used = {}, items = [];
          for (var q = 0; q < n; q++) { var p = pick(active); if (used[p.id]) continue; used[p.id] = 1; items.push({ product_id: p.id, qty: pick([2, 5, 6, 10, 12, 20]) }); }
          var lines = items.map(function (it) { return priceLine(db, target, it); });
          orderN++;
          var age = d;
          var status = age > 7 ? pick(['dikirim', 'dikirim', 'dikirim', 'batal']) : age > 3 ? pick(['dikirim', 'diproses', 'diproses']) : pick(['baru', 'baru', 'diproses']);
          db.field_orders.push({ order_id: 'FO-' + pad(orderN, 4), client_id: 'seed-o-' + orderN, user: 'Ahmad', order_date: date, order_time: vt, shop_id: target.shop_id, shop_name: target.name, visit_id: visit.visit_id,
            items: JSON.stringify(lines), total: lines.reduce(function (a, l) { return a + l.line_total; }, 0), notes: pick(['', 'Antar sore', 'Bayar tempo 7 hari', '']), delivery_date: addDays(date, ri(1, 3)),
            status: status, invoice_no: status === 'dikirim' ? 'KM' + date.slice(2).replace(/-/g, '') + '-0' + ri(100, 199) : '', updated_by: status === 'baru' ? '' : 'Pemilik', status_note: '' });
          if (status !== 'batal') dayOrders++;
        }
        minute += stay;
      });
      db.tracks.push.apply(db.tracks, dayTracks);
      db.field_days.push({ user: 'Ahmad', day_date: date, started_at: dayTracks[0].t, ended_at: dayTracks[dayTracks.length - 1].t, start_lat: dayTracks[0].lat, start_lng: dayTracks[0].lng,
        end_lat: dayTracks[dayTracks.length - 1].lat, end_lng: dayTracks[dayTracks.length - 1].lng, km: trackKm(dayTracks), visits: dayVisits, orders: dayOrders, note: '' });
    }
    db.seq.visit = visitN; db.seq.field_order = orderN;
    // a few product images
    var withImg = active.slice(0, 20);
    withImg.forEach(function (p, i) {
      var at = iso(addDays(todayStr, -20 + i), 10 * 60);
      db.product_images.push({ product_id: p.id, image_base64: productSvg(p, (i * 37 + 200) % 360), image_updated: at });
      p.image_updated = at;
    });
    return true;
  }

  window.KhairFieldMock = { actions: ACTIONS.slice(), handle: handle, seed: seed, _util: { haversine: haversine, trackKm: trackKm, sha256: sha256 } };
})();
