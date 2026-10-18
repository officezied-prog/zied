/* Khair Order Brad — demo backend (?mock=1). Runs the same core as the server (backend/brad/brad-core.js) on the gudang demo
   data (shared/cold-mock.js, localStorage 'kcold.mock.db': coolers, products, pallets, stock, customers, users) plus this
   app's own orders and settings ('kbrad.mock.db'). Like the server, the only gudang data it writes is the goods out of the
   stock when a car leaves. Store key "demo"; Pemilik / 1234, Jihan / 2222, Akuntan / 3333.
   Seed (relative to today): one order with its car on the way, one sent to the cold store, one that left yesterday after
   17:00 (overtime). The demo has no AI: a stand-in answers for a photo the way the AI would for a sample sheet
   (window.KBradMockAI can replace it — a function giving that answer — or be false = AI off); a typed message is read by the
   server's fixed rules. KBradMock.reset() starts again (the gudang demo too). */
(function (root) {
  var KEY = 'kbrad.mock.db', COLD_KEY = 'kcold.mock.db';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(b) { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch (e) { } }
  function saveCold(c) { try { localStorage.setItem(COLD_KEY, JSON.stringify(c)); } catch (e) { } }
  function state(c, b) {
    return { users: c.users, settings: Object.assign({}, c.settings, b.settings), warehouses: c.warehouses, products: c.products, pallets: c.pallets,
      movements: c.movements, cold_orders: c.orders, customers: c.customers, orders: b.orders };
  }
  function run(c, b, req, nowIso) {
    var res = root.KBrad.core(JSON.parse(JSON.stringify(state(c, b))), req, nowIso || new Date().toISOString());
    if (!res.response.ok) return res.response;
    var coldChanged = false;
    res.writes.forEach(function (w) {
      var row = JSON.parse(JSON.stringify(w.row));
      if (w.table === 'settings') { b.settings[row.skey] = JSON.parse(row.svalue); return; }
      if (w.table === 'movements') { row.id = c.nid++; c.movements.push(row); coldChanged = true; return; } // the goods out, at departure
      if (row.id === undefined) { row.id = b.nid++; b.orders.push(row); } else { var i = b.orders.findIndex(function (x) { return x.id === row.id; }); if (i >= 0) b.orders[i] = row; }
    });
    save(b); if (coldChanged) saveCold(c);
    return res.response;
  }
  function wibDay(n) { var d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
  function at(n, hm) { return new Date(wibDay(n) + 'T' + hm + ':00+07:00').toISOString(); }
  function seed(c) {
    var b = { nid: 1, orders: [], settings: {} }, hs = c.users.find(function (u) { return u.name === 'Jihan'; }).pin_hash;
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
  var ready = null;
  function dbs() {
    if (!ready) ready = root.KColdMock.db().then(function (c) { var b = load(); return { c: c, b: b && b.orders ? b : seed(c) }; });
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
      var r = run(d.c, d.b, body);
      if (body.action === 'bootstrap' && r.ok) r.ai_reader = root.KBradMockAI !== false;
      return r;
    });
  }
  function reset() { try { localStorage.removeItem(KEY); } catch (e) { } ready = null; return root.KColdMock.reset().then(function () { return dbs(); }); }
  root.KBradMock = { api: api, reset: reset };
})(window);
