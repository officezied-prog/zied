/* Khair Order Brad — demo backend (?mock=1). Runs the same core as the server (backend/brad/brad-core.js) on the gudang demo
   data (shared/cold-mock.js, localStorage 'kcold.mock.db': coolers, products, pallets, stock, customers, users) plus this
   app's own orders and settings ('kbrad.mock.db'). Like the server, the only gudang data it writes is the goods out of the
   stock when a car leaves. Store key "demo"; Pemilik / 1234, Jihan / 2222, Akuntan / 3333.
   Seed (relative to today): one order with its car on the way, one sent to the cold store, one that left yesterday after
   17:00 (overtime). The demo has no AI: a stand-in answers for a photo the way the AI would for a sample sheet
   (window.KBradMockAI can replace it — a function giving that answer — or be false = AI off); a typed message is read by the
   server's fixed rules. KBradMock.reset() starts again (the gudang demo too).
   v61 (stage 2): window.KBradMockWA = true plays automatic WhatsApp as if it were set up (every message "sent", logged);
   KBradMock.waIn({ from, type, payload | text, ctx_order_no }) plays a message from WhatsApp (the cold store's button or reply)
   through the server's own rules (KBrad.waEvent). Off (default) = not set up: the app sends by hand, as in stage 1.
   v61.1: the page's demo switch (home card, or ?wa=1 / ?wa=0; remembered as 'kbrad.mock.wa') sets KBradMockWA; each order then
   shows the phone that got its step's message (the cold store / the driver / the customer), the cold store's buttons going
   through waIn — the whole process can be tried without WhatsApp.
   v63 (stage 3): a simulated Lalamove (on by default; window.KBradMockLala = false plays "not set up": the app keeps its manual
   ways). The same core rules as the Worker (lala_plan → a price → lala_booked / lala_cancelled); the price is a fixed demo formula
   by distance, a booking gives a fake order (DEMO-…), and KBradMock.lalaStep(order_no, 'driver' | 'picked' | 'done' | 'cancel')
   moves it the way Lalamove would — read back through the server's own lala_sync. The coolers', the shop's places and the city's
   vehicles are seeded so it works at once. */
(function (root) {
  var KEY = 'kbrad.mock.db', COLD_KEY = 'kcold.mock.db';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(b) { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch (e) { } }
  function saveCold(c) { try { localStorage.setItem(COLD_KEY, JSON.stringify(c)); } catch (e) { } }
  function state(c, b) {
    return { users: c.users, settings: Object.assign({}, c.settings, b.settings), warehouses: c.warehouses, products: c.products, pallets: c.pallets,
      movements: c.movements, cold_orders: c.orders, customers: c.customers, orders: b.orders, wa_log: b.wa_log || [] };
  }
  function run(c, b, req, nowIso) {
    var res = root.KBrad.core(JSON.parse(JSON.stringify(state(c, b))), req, nowIso || new Date().toISOString());
    if (!res.response.ok) return res.response;
    var coldChanged = false;
    res.writes.forEach(function (w) {
      var row = JSON.parse(JSON.stringify(w.row));
      if (w.table === 'settings') { b.settings[row.skey] = JSON.parse(row.svalue); return; }
      if (w.table === 'log') { row.id = b.nid++; (b.wa_log = b.wa_log || []).push(row); return; }
      if (w.table === 'movements') { row.id = c.nid++; c.movements.push(row); coldChanged = true; return; } // the goods out, at departure
      if (row.id === undefined) { row.id = b.nid++; b.orders.push(row); } else { var i = b.orders.findIndex(function (x) { return x.id === row.id; }); if (i >= 0) b.orders[i] = row; }
    });
    save(b); if (coldChanged) saveCold(c);
    var resp = res.response;
    if (Array.isArray(resp.wa)) { resp.wa_sent = mockSend(b, resp.wa); delete resp.wa; save(b); } // like the Worker: the messages never reach the app
    return resp;
  }
  // automatic WhatsApp, played: "sent" when on (logged as the Worker logs it), else "not set up" → the app sends by hand
  function mockSend(b, msgs) {
    var on = root.KBradMockWA === true, now = new Date().toISOString();
    return msgs.map(function (m) {
      if (!on) return { kind: m.kind, ok: false, error: 'WA_OFF' };
      (b.wa_log = b.wa_log || []).push({ id: b.nid++, wamid: 'wamid.demo' + b.nid, dir: 'out', peer: m.to, order_no: m.order_no, kind: m.kind, template: m.template,
        text: m.params.join(' · '), status: 'sent', error: '', applied: '', at: now, updated_at: now });
      return { kind: m.kind, ok: true, error: '' };
    });
  }
  function sentThisMonth(b) { var mo = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7); return (b.wa_log || []).filter(function (x) { return x.dir === 'out' && x.status !== 'not_sent' && String(x.at).slice(0, 7) === mo; }).length; }
  function wibDay(n) { var d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
  function at(n, hm) { return new Date(wibDay(n) + 'T' + hm + ':00+07:00').toISOString(); }
  // v63: the demo places (near the real areas) and the demo vehicles (Lalamove's list for Jakarta is read by "Tes koneksi")
  var LALA_DEMO = [{ key: 'MOTORCYCLE', description: 'Motor', load: { value: 20, unit: 'kg' }, base: 10000, km: 2500 },
    { key: 'MPV', description: 'Mobil (MPV)', load: { value: 300, unit: 'kg' }, base: 40000, km: 4500 }, { key: 'VAN', description: 'Van / blind van', load: { value: 600, unit: 'kg' }, base: 65000, km: 5500 },
    { key: 'TRUCK175', description: 'Pickup (bak)', load: { value: 1000, unit: 'kg' }, base: 90000, km: 6500 }, { key: 'TRUCK330', description: 'Engkel box', load: { value: 2500, unit: 'kg' }, base: 180000, km: 9500 }];
  function lalaSeed() {
    return { brad_coolers: { DPP: { lat: -6.1214, lng: 106.9021 }, BOSKO: { lat: -6.2383, lng: 106.9756 }, KAWANISHI: { lat: -6.3080, lng: 107.1520 } },
      brad_store_geo: { lat: -6.2788, lng: 106.8631, address: 'Jl. Raya Condet No.4, Jakarta Timur' },
      brad_lala_services: { at: new Date().toISOString(), city: { locode: 'ID_JKT', name: 'Jakarta (demo)' }, services: LALA_DEMO.map(function (x) { return { key: x.key, description: x.description, load: x.load }; }) } };
  }
  function seed(c) {
    var b = { nid: 1, orders: [], settings: lalaSeed(), wa_log: [], lala: { n: 0, orders: {} } }, hs = c.users.find(function (u) { return u.name === 'Jihan'; }).pin_hash;
    var M = function (action, data, n, hm) { var r = run(c, b, { action: action, user: 'Jihan', pin_hash: hs, data: data }, at(n, hm)); if (!r.ok) throw new Error(action + ': ' + r.message); return r; };
    // a day the coolers open only by arrangement (Sunday) goes with the agreed extra cost
    var X = function (n) { var K = root.KBrad; return K.dayKind(wibDay(n), K.hoursOf({}), []) === 'arrange' ? { extra_cost: 350000, extra_note: 'Buka Minggu (perjanjian)' } : {}; };
    // yesterday: Khalas from Bosko, the car came at 17:20 → 1 hour overtime (the car was late)
    var y = M('order_save', { warehouse: 'BOSKO', order_date: wibDay(1), dest_type: 'pelanggan', dest_name: 'Toko Al Amin', dest_phone: '081300000021', dest_address: 'Jl. Kalimalang 12, Bekasi', lines: [{ pallet_code: 'B-0101', cartons: 20 }] }, 1, '15:40').order.order_no;
    M('order_status', Object.assign({ order_no: y, to: 'sent' }, X(1)), 1, '15:45'); M('order_status', { order_no: y, to: 'approved' }, 1, '15:55'); M('order_status', { order_no: y, to: 'ready' }, 1, '16:05');
    M('car_save', { order_no: y, via: 'lalamove', vehicle: 'Pickup (bak)', driver: 'Pak Rahmat', driver_wa: '081300000011', plate: 'B 9456 PQR', eta_min: 50, accept_ot: true }, 1, '16:10');
    M('order_arrived', { order_no: y, time: '17:20', door: '7', cause: 'car_late', note: 'Macet di tol' }, 1, '17:22');
    M('load_start', { order_no: y }, 1, '17:25'); M('depart', { order_no: y }, 1, '17:55'); M('order_status', { order_no: y, to: 'delivered' }, 1, '19:10');
    // today: Sukari for Toko Barokah — the car is on its way
    var a = M('order_save', { warehouse: 'DPP', order_date: wibDay(0), dest_type: 'pelanggan', dest_name: 'Toko Barokah', dest_phone: '081300000020', dest_address: 'Jl. Dewi Sartika 5, Jakarta Timur', lines: [{ pallet_code: '2274537', cartons: 40 }] }, 0, '08:30').order.order_no;
    M('order_status', Object.assign({ order_no: a, to: 'sent' }, X(0)), 0, '08:35'); M('order_status', { order_no: a, to: 'approved' }, 0, '09:10'); M('order_status', { order_no: a, to: 'ready' }, 0, '09:40');
    M('car_save', { order_no: a, via: 'lalamove', vehicle: 'Engkel (CDE)', driver: 'Pak Udin', driver_wa: '081300000010', plate: 'B 9123 KXT', eta_min: 40 }, 0, '09:45');
    // today: Ruthab for the shop from Kawanishi — sent, waiting for the cold store's answer
    var k = M('order_save', { warehouse: 'KAWANISHI', order_date: wibDay(0), dest_type: 'toko', lines: [{ pallet_code: 'K-77003', cartons: 30 }] }, 0, '08:40').order.order_no;
    M('order_status', Object.assign({ order_no: k, to: 'sent' }, X(0)), 0, '08:45');
    save(b); saveCold(c);
    return b;
  }
  function demoAI() {
    if (typeof root.KBradMockAI === 'function') return root.KBradMockAI();
    return JSON.stringify({ customer: { name: 'Toko Barokah', phone: '081300000020' }, note: '', items: [
      { pallet: '2274561', product: 'Ruthab 2kg', qty: 40, unit: 'ctn', line: 'Ruthab 2kg · PLT 2274561 · 40 ctn' },
      { code: 'AJWA-5', product: 'Ajwa 5kg', qty: 1, unit: 'pallet', line: 'Ajwa 5kg · 1 palet' },
      { product: 'Zahidi', qty: 10, unit: 'ctn', unclear: true, line: 'Zahidi · 10 ctn' }] });
  }
  /* ---------- v63: the simulated Lalamove ---------- */
  function lalaOn() { return root.KBradMockLala !== false; }
  function sysRun(d, action, data) { return run(d.c, d.b, { __sys: 'lalamove', action: action, data: data }); }
  function km(a, b) { // straight line × 1.3 for the roads
    var R = 6371, r = Math.PI / 180, la1 = Number(a.lat) * r, la2 = Number(b.lat) * r, dl = (Number(b.lng) - Number(a.lng)) * r;
    var x = Math.sin((la2 - la1) / 2), y = Math.sin(dl / 2), q = x * x + Math.cos(la1) * Math.cos(la2) * y * y;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(q))) * 1.3;
  }
  function fakeQuote(d, qb) {
    var sv = LALA_DEMO.find(function (x) { return x.key === qb.serviceType; }) || LALA_DEMO[2], k = km(qb.stops[0].coordinates, qb.stops[1].coordinates), L = d.b.lala = d.b.lala || { n: 0, orders: {} };
    L.n++;
    return { quotationId: 'DQ' + L.n, price: Math.ceil((sv.base + sv.km * k) / 1000) * 1000, currency: 'IDR', expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), distance_m: Math.round(k * 1000),
      stops: qb.stops.map(function (s, i) { return { stopId: 'DS' + L.n + '-' + i, address: s.address }; }) };
  }
  function quoteOut(plan, q) {
    return { price: q.price, currency: q.currency, expires_at: q.expiresAt, distance_m: q.distance_m, service: plan.service, service_name: plan.service_name, schedule_at: plan.schedule_at,
      eta_at: plan.eta_at, warn: plan.warn, kg: plan.kg, spent: plan.spent, cap: plan.cap, from: plan.quote.stops[0].address, to: plan.dest.address };
  }
  var LALA_OFF = { ok: false, error: 'LALA_OFF', message: 'Lalamove otomatis belum aktif: pesan mobil dengan cara manual (pemilik: Pengaturan → Lalamove otomatis)' };
  function lalaState() { var on = lalaOn(); return { on: on, env: 'demo', market: 'ID', city: '', set: { key: on, secret: on } }; }
  /** The Worker's lala_quote / lala_book / lala_cancel / lala_admin, played (worker/src/brad.js lalaStaff) against the fake Lalamove. */
  function lalaApi(d, body) {
    var data = Object.assign({}, body.data || {}), A = body.action;
    Object.keys(data).forEach(function (k) { if (k.charAt(0) === '_') delete data[k]; });
    var req = function (action, dt) { return Object.assign({}, body, { action: action, data: dt }); };
    if (A === 'lala_admin') {
      var a = run(d.c, d.b, req(A, data)); if (!a.ok) return a;
      if (a.lala_admin === 'status') return Object.assign(a, lalaState());
      if (!lalaOn()) return Object.assign({}, LALA_OFF, lalaState());
      var sv = sysRun(d, 'lala_services', { city: { locode: 'ID_JKT', name: 'Jakarta (demo)' }, services: LALA_DEMO.map(function (x) { return { key: x.key, description: x.description, load: x.load }; }) });
      return Object.assign(a, lalaState(), { lala: sv.lala, cities: [{ locode: 'ID_JKT', name: 'Jakarta (demo)', n: LALA_DEMO.length }], picked: 'ID_JKT' });
    }
    if (A === 'lala_cancel') {
      var c1 = run(d.c, d.b, req(A, data)); if (!c1.ok) return c1;
      if (!lalaOn()) return Object.assign({}, LALA_OFF, { manual: true });
      var fo = ((d.b.lala || {}).orders || {})[c1.cancel.lala_order_id]; if (fo) fo.status = 'CANCELED';
      return sysRun(d, 'lala_cancelled', c1.cancel);
    }
    var p1 = run(d.c, d.b, req('lala_plan', data)); if (!p1.ok) return p1;
    if (!lalaOn()) return LALA_OFF;
    if (A === 'lala_book' && !(Number(data.seen_price) > 0)) return { ok: false, error: 'INVALID', message: 'Cek harga dulu' };
    var q = fakeQuote(d, p1.plan.quote), p2 = run(d.c, d.b, req('lala_plan', Object.assign({}, data, { _price: q.price })));
    if (!p2.ok) return Object.assign(p2, { price: q.price });
    var plan = p2.plan;
    if (A === 'lala_quote') { save(d.b); return { ok: true, quote: quoteOut(plan, q) }; }
    var id = 'DEMO-' + (1000 + d.b.lala.n), share = 'https://share.lalamove.com/?ID=' + id + '&lang=id_ID';
    d.b.lala.orders[id] = { status: 'ASSIGNING_DRIVER', driverId: '', price: q.price, shareLink: share };
    var bk = sysRun(d, 'lala_booked', { order_no: plan.order_no, by: plan.by, service: plan.service, service_name: plan.service_name, schedule_at: plan.schedule_at, eta_at: plan.eta_at,
      eta_min: plan.eta_min, accept_ot: plan.accept_ot, dest: plan.dest, quote: { id: q.quotationId, price: q.price, currency: 'IDR', distance_m: q.distance_m },
      placed: { order_id: id, share_link: share, status: 'ASSIGNING_DRIVER', price: q.price } });
    if (!bk.ok) delete d.b.lala.orders[id];
    save(d.b);
    return bk.ok ? Object.assign(bk, { quote: quoteOut(plan, q) }) : bk;
  }
  /** Lalamove moves the demo trip (as its app would): a driver found, the goods picked up, done, or cancelled — then the server's
      own lala_sync reads it, as the Worker does every 2 minutes (and on Lalamove's webhook). */
  function lalaStep(no, kind) {
    return dbs().then(function (d) {
      var o = d.b.orders.find(function (x) { return x.order_no === no; }), c = o ? root.KBrad.lalaTrip(o) : null;
      if (!c) return { ok: false, error: 'NOT_FOUND', message: 'Tidak ada Lalamove otomatis di order ini' };
      var L = d.b.lala = d.b.lala || { n: 0, orders: {} }, f = L.orders[c.lala_order_id] = L.orders[c.lala_order_id] || { status: c.lala_status, driverId: '', price: c.price, shareLink: c.share_link };
      if (kind === 'driver') { f.status = 'ON_GOING'; f.driverId = 'DRV' + (L.n + 7); f.driver = { name: 'Pak Slamet', phone: '+6281300000077', plate: 'B 9876 TKL' }; }
      else if (kind === 'picked') f.status = 'PICKED_UP';
      else if (kind === 'done') f.status = 'COMPLETED';
      else if (kind === 'cancel') f.status = 'CANCELED';
      var r = sysRun(d, 'lala_sync', { items: [{ order_no: no, lala_order_id: c.lala_order_id, ok: true, status: f.status, driver_id: f.driverId || '',
        driver: f.driverId && f.driverId !== c.lala_driver_id ? f.driver : null, share_link: f.shareLink, price: f.price }] });
      save(d.b);
      return Object.assign({ status: f.status }, r);
    });
  }
  var ready = null;
  function dbs() {
    if (!ready) ready = root.KColdMock.db().then(function (c) {
      var b = load();
      if (b && b.orders) { // a demo from before v63: its places and vehicles added (what was set stays)
        var ls = lalaSeed(); b.settings = b.settings || {}; b.lala = b.lala || { n: 0, orders: {} };
        Object.keys(ls).forEach(function (k) { if (b.settings[k] === undefined) b.settings[k] = ls[k]; });
      }
      return { c: c, b: b && b.orders ? b : seed(c) };
    });
    return ready;
  }
  function api(body) {
    return dbs().then(function (d) {
      if (body.key !== 'demo') return { ok: false, error: 'BAD_KEY', message: 'Kunci toko salah (demo: "demo")' };
      if (body.action === 'order_read') {
        var x = body.data || {}, img = typeof x.image_base64 === 'string' && x.image_base64.length > 0;
        var base = { text: typeof x.text === 'string' ? x.text.slice(0, 4000) : '', warehouse: String(x.warehouse || ''), has_image: img, ai_on: img && root.KBradMockAI !== false };
        var first = run(d.c, d.b, Object.assign({}, body, { data: base }));
        if (!first.ok || !first.need_ai) return first;
        return run(d.c, d.b, Object.assign({}, body, { data: Object.assign({}, base, { _ai: { text: demoAI(), model: 'demo' } }) }));
      }
      if (/^lala_(quote|book|cancel|admin)$/.test(body.action)) return lalaApi(d, body); // v63, as the Worker does around the core
      var r = run(d.c, d.b, body);
      if (r && r.ok) delete r.lala_due; // (the Worker reads those trips; here lalaStep plays Lalamove)
      if (body.action === 'bootstrap' && r.ok) { r.ai_reader = root.KBradMockAI !== false; r.wa = { on: root.KBradMockWA === true, count: sentThisMonth(d.b), cap: r.wa_cap }; r.lala = Object.assign({}, r.lala, lalaState()); }
      if (body.action === 'wa_admin' && r.ok) {
        var on = root.KBradMockWA === true;
        if (r.wa_admin === 'status') Object.assign(r, { on: on, set: { token: on, phone: on, waba: on, secret: on, verify: on }, count: sentThisMonth(d.b), cap: r.wa_cap || 3000,
          templates: on ? r.names.map(function (n) { return { name: n, status: 'APPROVED', language: 'id', category: 'UTILITY' }; }) : [], templates_error: on ? '' : 'WA_OFF' });
        if (r.wa_admin === 'templates') { if (!on) return { ok: false, error: 'WA_OFF', message: 'WhatsApp belum disiapkan: isi WA_TOKEN dan WA_WABA_ID di Cloudflare dulu' }; r.templates = r.defs.map(function (x) { return { name: x.name, status: 'PENDING' }; }); delete r.defs; }
      }
      return r;
    });
  }
  /** A message from WhatsApp, played through the server's rules (as the Worker's webhook does after Meta's signature check). */
  function waIn(ev) {
    return dbs().then(function (d) {
      var e = Object.assign({ id: 'wamid.in' + Date.now() + Math.random().toString(36).slice(2, 6), type: ev && ev.payload ? 'button' : 'text' }, ev || {});
      var res = root.KBrad.waEvent(JSON.parse(JSON.stringify(state(d.c, d.b))), e, new Date().toISOString());
      res.writes.forEach(function (w) {
        var row = JSON.parse(JSON.stringify(w.row));
        if (w.table === 'log') { row.id = d.b.nid++; (d.b.wa_log = d.b.wa_log || []).push(row); return; }
        var i = d.b.orders.findIndex(function (x) { return x.id === row.id; }); if (i >= 0) d.b.orders[i] = row;
      });
      if (Array.isArray(res.response.wa)) mockSend(d.b, res.response.wa);
      save(d.b);
      return res.response;
    });
  }
  function reset() { try { localStorage.removeItem(KEY); } catch (e) { } ready = null; return root.KColdMock.reset().then(function () { return dbs(); }); }
  root.KBradMock = { api: api, reset: reset, waIn: waIn, lalaStep: lalaStep };
})(window);
