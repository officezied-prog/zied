/* Khair Gudang Dingin — demo backend (?mock=1). Runs the same core as the server (backend/cold/cold-core.js, loaded first)
   on tables kept in localStorage ('kcold.mock.db'). Store key "demo"; users as in the POS demo:
   Pemilik / 1234 (owner), Jihan / 2222 (manager), Akuntan / 3333 (akuntan), Siti / 1111 (kasir → refused).
   Seed: DPP, Bosko and Kawanishi, one container, 15 date pallets (some near expiry), 10 days of movements, one open pick order,
   one daily check with a difference. KColdMock.reset() starts again. */
(function (root) {
  var DBKEY = 'kcold.mock.db', TABLES = ['warehouses', 'products', 'containers', 'pallets', 'movements', 'checks', 'orders'];
  function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function sha(s) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(hex); }
  function load() { try { return JSON.parse(localStorage.getItem(DBKEY) || 'null'); } catch (e) { return null; } }
  function save(db) { try { localStorage.setItem(DBKEY, JSON.stringify(db)); } catch (e) { } }
  function apply(db, writes) {
    writes.forEach(function (w) {
      if (w.table === 'settings') { db.settings[w.row.skey] = JSON.parse(w.row.svalue); return; }
      var row = JSON.parse(JSON.stringify(w.row)), list = db[w.table];
      if (row.id === undefined) { row.id = db.nid++; list.push(row); } else { var i = list.findIndex(function (x) { return x.id === row.id; }); if (i >= 0) list[i] = row; }
    });
  }
  function run(db, req, nowIso) {
    var state = JSON.parse(JSON.stringify(db)), res = root.KCold.core(state, req, nowIso || new Date().toISOString());
    if (res.response.ok) { apply(db, res.writes); save(db); }
    return res.response;
  }
  function day(n) { var d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
  function at(n, hm) { return new Date(day(n) + 'T' + (hm || '09:00') + ':00+07:00').toISOString(); }
  function seed() {
    var people = [['Pemilik', 'owner', '1234'], ['Jihan', 'manager', '2222'], ['Akuntan', 'akuntan', '3333'], ['Siti', 'kasir', '1111']];
    return Promise.all(people.map(function (p) { return sha('demo:' + p[0].toLowerCase() + ':' + p[2]); })).then(function (hs) {
      var db = { nid: 1, settings: { store_name: 'Khair Mart', address: 'Jl. Raya Condet No.4, Jakarta Timur', phone: '0812-8000-2700' } };
      TABLES.forEach(function (t) { db[t] = []; });
      db.users = people.map(function (p, i) { return { id: 900 + i, name: p[0], role: p[1], pin_hash: hs[i], active: true }; });
      var O = function (action, data, n, hm) { var r = run(db, { action: action, user: 'Pemilik', pin_hash: hs[0], data: data }, at(n, hm)); if (!r.ok) throw new Error(action + ': ' + r.message); return r; };
      var M = function (action, data, n, hm) { var r = run(db, { action: action, user: 'Jihan', pin_hash: hs[1], data: data }, at(n, hm)); if (!r.ok) throw new Error(action + ': ' + r.message); return r; };
      O('warehouse_save', { code: 'DPP', name: 'DPP Cold Storage', address: 'Jl. Contoh Pergudangan No. 1, Jakarta Utara', pic_name: 'Admin DPP', pic_wa: '081200000001', customer_id: '0157', rate_frozen: 600000, rate_chiller: 450000, rate_dry: 300000, rate_unit: 'month', parser: 'dpp' }, 12);
      O('warehouse_save', { code: 'BOSKO', name: 'Bosko', address: 'Jl. Contoh Industri No. 2, Bekasi', pic_name: 'Admin Bosko', pic_wa: '081200000002', rate_frozen: 20000, rate_chiller: 16000, rate_dry: 10000, rate_unit: 'day', parser: 'bosko' }, 12);
      O('warehouse_save', { code: 'KAWANISHI', name: 'Kawanishi', address: 'Jl. Contoh Logistik No. 3, Cikarang', pic_name: 'Admin Kawanishi', pic_wa: '081200000003', rate_frozen: 550000, rate_chiller: 400000, rate_dry: 250000, rate_unit: 'month', parser: 'kawanishi' }, 12);
      [['SUKARI-3', 'Kurma Sukari 3kg', 3, 'sukari, sukkari', 286], ['AJWA-5', 'Kurma Ajwa Jumbo 5kg', 5, 'ajwa', 121], ['MEDJOOL-5', 'Kurma Medjool 5kg', 5, 'medjool, majhool', 120],
        ['KHALAS-10', 'Kurma Khalas 10kg', 10, 'khalas, khalash', 100], ['RUTHAB-2', 'Ruthab Dates 2kg', 2, 'ruthab, 157-007', 286]].forEach(function (p) { O('product_save', { code: p[0], name: p[1], kg_per_ctn: p[2], aliases: p[3], ctn_per_pallet: p[4] }, 12); });
      O('settings_save', { drivers: [{ name: 'Pak Udin', wa: '081300000010', vehicle: 'Engkel (CDE)', plate: 'B 9123 KXT' }, { name: 'Pak Rahmat', wa: '081300000011', vehicle: 'Pickup (bak)', plate: 'B 9456 PQR' }] }, 12);
      M('container_save', { container_no: 'CGMU5288973', size: '40', warehouse: 'DPP', arrival_date: day(10), supplier: 'Al Qassim Dates', origin: 'Saudi Arabia', product: 'SUKARI-3', cartons: 1820 }, 10, '08:00');
      var P = function (code, product, cartons, expDays, lot, zone) { var d = new Date(day(-expDays) + 'T00:00:00Z'); return { pallet_code: code, product: product, cartons: cartons, exp_date: d.toISOString().slice(0, 10), lot: lot, zone: zone }; };
      M('pallet_in', { warehouse: 'DPP', container_no: 'CGMU5288973', date: day(10), pallets: [
        P('2274537', 'SUKARI-3', 286, 300, '260925/A', 'FROZEN'), P('2274538', 'SUKARI-3', 286, 40, '260925/A', 'FROZEN'), P('2274553', 'RUTHAB-2', 282, 25, '260925/B', 'FROZEN'),
        P('2274561', 'RUTHAB-2', 286, 210, '260925/B', 'FROZEN'), P('3619208', 'AJWA-5', 121, 180, '260925/C', 'CHILLER'), P('3619209', 'AJWA-5', 121, 180, '260925/C', 'CHILLER'),
        P('3619210', 'MEDJOOL-5', 120, 150, '260925/D', 'CHILLER'), P('3619211', 'MEDJOOL-5', 118, 55, '260925/D', 'CHILLER')] }, 10, '10:00');
      M('pallet_in', { warehouse: 'BOSKO', date: day(9), pallets: [P('B-0101', 'KHALAS-10', 100, 240, 'KH-01', 'DRY'), P('B-0102', 'KHALAS-10', 100, 240, 'KH-01', 'DRY'), P('B-0103', 'SUKARI-3', 300, 120, 'SK-07', 'CHILLER'), P('B-0104', 'AJWA-5', 90, 20, 'AJ-02', 'CHILLER')] }, 9);
      M('pallet_in', { warehouse: 'KAWANISHI', date: day(8), pallets: [P('K-77001', 'MEDJOOL-5', 110, 270, 'MJ-11'), P('K-77002', 'KHALAS-10', 80, 330, 'KH-02'), P('K-77003', 'RUTHAB-2', 250, 90, 'RT-03')] }, 8);
      var o1 = M('order_save', { warehouse: 'DPP', order_date: day(7), dest_type: 'toko', dest_address: 'Jl. Raya Condet No.4, Jakarta Timur', pickup_person: 'Wahyu', vehicle: 'Pickup (bak)', lines: [{ pallet_code: '2274553', cartons: 40 }] }, 7, '08:30').order;
      M('trip_save', { order_no: o1.order_no, vehicle: 'Pickup (bak)', driver: 'Pak Rahmat', plate: 'B 9456 PQR', cost: 180000, via: 'sopir' }, 7, '08:40');
      M('order_pick', { order_no: o1.order_no, pick_date: day(7) }, 7, '11:00'); M('order_status', { order_no: o1.order_no, to: 'delivered' }, 7, '17:00');
      var o2 = M('order_save', { warehouse: 'BOSKO', order_date: day(5), dest_type: 'pelanggan', dest_name: 'Toko Barokah', dest_address: 'Jl. Dewi Sartika 5, Jakarta Timur', pickup_person: 'Sopir pelanggan', lines: [{ pallet_code: 'B-0103', cartons: 60 }, { pallet_code: 'B-0104', cartons: 30 }] }, 5).order;
      M('order_pick', { order_no: o2.order_no, pick_date: day(5) }, 5, '13:00'); M('order_status', { order_no: o2.order_no, to: 'delivered' }, 5, '17:00');
      M('movement_add', { type: 'TRANSFER', pallet_code: '3619209', warehouse: 'DPP', to_warehouse: 'KAWANISHI', move_date: day(4) }, 4);
      M('movement_add', { type: 'ADJUST', pallet_code: 'B-0101', warehouse: 'BOSKO', cartons: -2, reason: 'Karton rusak (basah), dibuang', move_date: day(3) }, 3);
      var o3 = M('order_save', { warehouse: 'DPP', order_date: day(2), dest_type: 'toko', dest_address: 'Jl. Raya Condet No.4, Jakarta Timur', pickup_person: 'Wahyu', lines: [{ pallet_code: '2274538', cartons: 50 }, { pallet_code: '3619211', cartons: 20 }] }, 2).order;
      M('order_pick', { order_no: o3.order_no, pick_date: day(2) }, 2, '15:00'); M('order_status', { order_no: o3.order_no, to: 'delivered' }, 2, '17:00');
      var o4 = M('order_save', { warehouse: 'DPP', order_date: day(-1), dest_type: 'toko', dest_address: 'Jl. Raya Condet No.4, Jakarta Timur', pickup_person: 'Wahyu', vehicle: 'Engkel (CDE)', note: 'Untuk stok Maulid', lines: [{ pallet_code: '2274538', cartons: 100 }, { pallet_code: '3619208', cartons: 21 }] }, 1, '16:00').order;
      M('order_status', { order_no: o4.order_no, to: 'sent' }, 1, '16:05');
      // a customer order at Kawanishi: the warehouse said yes and the goods are ready — waiting for the owner's approval to send
      var o5 = M('order_save', { warehouse: 'KAWANISHI', order_date: day(0), dest_type: 'pelanggan', dest_name: 'Toko Al Amin', dest_address: 'Jl. Kalimalang 12, Bekasi', pickup_person: 'Sopir Lalamove', lines: [{ pallet_code: 'K-77001', cartons: 30 }] }, 1, '17:00').order;
      M('order_status', { order_no: o5.order_no, to: 'sent' }, 1, '17:02'); M('order_status', { order_no: o5.order_no, to: 'approved' }, 1, '18:10'); M('order_status', { order_no: o5.order_no, to: 'ready' }, 0, '07:30');
      // a container on its way: entry request sent, waiting for the warehouse
      M('container_save', { kind: 'container', container_no: 'FBIU5049090', size: '40', warehouse: 'BOSKO', arrival_date: day(-5), supplier: 'Tunis Dates Co', origin: 'Tunisia', product: 'KHALAS-10', cartons: 1600 }, 1, '10:00');
      M('container_status', { container_no: 'FBIU5049090', to: 'requested' }, 1, '10:05');
      // yesterday's WhatsApp check from Bosko: they count 2 cartons fewer of Sukari
      M('check_save', { warehouse: 'BOSKO', check_date: day(1), text: 'Selamat pagi pak, stok PT Saida di Bosko:\nKhalas 10kg = 198 ctn\nSukari 3kg = 238 ctn\nAjwa 5kg = 60 ctn\nTerima kasih' }, 1, '09:15');
      save(db);
      return db;
    });
  }
  var ready = null;
  function db() { if (!ready) { var d = load(); ready = d && d.users ? Promise.resolve(d) : seed(); } return ready; }
  /** Same envelope as the server; the key must be "demo". */
  function api(body) {
    return db().then(function (d) {
      if (body.key !== 'demo') return { ok: false, error: 'BAD_KEY', message: 'Kunci toko salah (demo: "demo")' };
      return run(d, body);
    });
  }
  function reset() { try { localStorage.removeItem(DBKEY); } catch (e) { } ready = null; return db(); }
  root.KColdMock = { api: api, reset: reset, db: db };
})(window);
