/* Khair Gudang Dingin — core (v1). One source for two places:
   - the n8n workflow "Khair Gudang Dingin" (Code node "Process Cold" = cold-parsers.js + this file + process-cold.js), and
   - the page's demo mode (gudang/index.html?mock=1, shared/cold-mock.js).
   Pure: no network, no storage, no clock. KCold.core(state, req, nowIso) → { response, writes: [{ table, row }] }.
   A row with an id updates that row; without an id it is inserted (the caller gives the id). Nothing is ever deleted.

   Stock is never stored: the balance of a pallet in a warehouse is the sum of its movements (cartons, signed).
   Movements are append-only. A mistake is fixed with movement_reverse, which writes REVERSE rows that point (ref_seq)
   to the original. Roles: owner = everything; manager = everything except settings and storage costs; akuntan = read-only.
   Users are the POS users (pos_users): same name, PIN, master code, lock and "must change PIN" rules as the POS. */
var KCold = (function () {
  'use strict';
  var P = typeof KColdParsers !== 'undefined' ? KColdParsers : (typeof window !== 'undefined' ? window.KColdParsers : null);
  var ROLES = ['owner', 'manager', 'akuntan'];
  var OWNER_ONLY = { warehouse_save: 1, product_save: 1, settings_save: 1 };
  var READ = { login: 1, bootstrap: 1, report: 1, fefo: 1, check_preview: 1 };
  var EXPIRY_DAYS = 60;
  /* Order flow (every step is logged with who and when; status is never written outside these tables):
     open → sent (to the warehouse) → approved | rejected → ready → dispatch (owner/manager approve sending) → driver → picked (stock out) → delivered.
     rejected → open (edit and send again). cancel: any step before picked. Statuses in HOLD keep their cartons reserved. */
  var HOLD = ['open', 'sent', 'approved', 'ready', 'dispatch', 'driver'];
  var FLOW = { open: ['sent'], sent: ['approved', 'rejected'], approved: ['ready'], ready: ['dispatch'], dispatch: ['driver'], picked: ['delivered'], rejected: ['open'] };
  /* Inbound (containers and in-place purchases): planned → requested (entry request sent) → approved | rejected → stored (pallets entered). */
  var CFLOW = { planned: ['requested', 'stored'], requested: ['approved', 'rejected'], rejected: ['requested'], approved: ['stored'] };
  /** Vehicle by weight (kg, gross ≈ net × 1.1). Edit here if the owner uses other sizes. */
  var VEHICLES = [[700, 'Pickup (bak)'], [1000, 'Van / blind van'], [2500, 'Engkel (CDE)'], [5000, 'CDD'], [Infinity, 'Fuso / 2 truk']];

  function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clean(v, max) { return str(v).replace(/[\u0000-\u001f\u007f<>‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80); }
  function code(v) { var s = str(v).toUpperCase().replace(/\s+/g, '-'); return /^[A-Z0-9][A-Z0-9._\-]{0,29}$/.test(s) ? s : ''; }
  /** A code from the name when none (or an Arabic one) is typed: "Kurma Sukari 3kg" → SUKARI-3KG style, else P1, P2… */
  function autoCode(name, taken, prefix) {
    var base = str(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
    if (!base) { var n = taken.length + 1; while (taken.indexOf(prefix + n) >= 0) n++; return prefix + n; }
    var c = base, k = 2; while (taken.indexOf(c) >= 0) c = base + '-' + k++;
    return c;
  }
  var ZONES = ['FROZEN', 'CHILLER', 'DRY'];
  // Batch C (owner): a cooler's operating MODE, shown on the home page per named cooler (Bosco/DP/BP).
  // tabrid=تبريد (chilling), takhzin=تخزين (storage), tajmid=تجميد (freezing), biasa=براد عادي (normal).
  var MODES = ['tabrid', 'takhzin', 'tajmid', 'biasa'];
  /** FROZEN (beku / تجميد), CHILLER (dingin / تبريد), DRY (kering, biasa / عادي); empty → CHILLER. */
  function zoneOf(v) {
    var z = str(v).toUpperCase();
    if (/FROZ|BEKU|FREEZ|تجميد|مجمد/.test(z)) return 'FROZEN';
    if (/DRY|KERING|AMBIENT|NORMAL|BIASA|عادي|جاف/.test(z)) return 'DRY';
    return 'CHILLER';
  }
  function rateOf(w, zone) { var r = num(w['rate_' + zone.toLowerCase()]); return r > 0 ? r : num(w.rate); }
  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function wib(iso) { return new Date(Date.parse(iso) + 7 * 3600000).toISOString(); }
  function addDays(d, n) { var x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function daysIn(ym) { var a = ym.split('-').map(Number); return new Date(Date.UTC(a[0], a[1], 0)).getUTCDate(); }
  function int(v) { var n = Number(v); return isFinite(n) && Math.floor(n) === n ? n : NaN; }
  function bool(v) { return v === true || v === 'true' || v === 1; }
  function json(v, d) { if (v && typeof v === 'object') return v; try { var x = JSON.parse(v); return x === null || x === undefined ? d : x; } catch (e) { return d; } }
  function norm(s) { return str(s).toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ''); }
  function normPhone(v) { var d = str(v).replace(/\D/g, ''); if (d.indexOf('0') === 0) d = '62' + d.slice(1); else if (d.indexOf('8') === 0) d = '62' + d; return d.length >= 9 && d.length <= 15 ? d : ''; }
  function pad3(n) { return ('00' + n).slice(-3); }
  function vehicleFor(kg) { var g = num(kg) * 1.1; for (var i = 0; i < VEHICLES.length; i++) if (g <= VEHICLES[i][0]) return VEHICLES[i][1]; return VEHICLES[VEHICLES.length - 1][1]; }
  function active(r) { return r.active !== false && r.active !== 'false'; }

  /* ---------- stock from movements ---------- */
  function ledger(moves, asOf, wh) {
    var m = {};
    moves.forEach(function (x) {
      if (asOf && str(x.move_date) > asOf) return;
      if (wh && x.warehouse !== wh) return;
      var k = x.pallet_code + '|' + x.warehouse; m[k] = (m[k] || 0) + num(x.cartons);
    });
    return m;
  }
  function stockRows(st, asOf, wh) {
    var L = ledger(st.movements, asOf, wh), PI = {}, PR = {};
    st.pallets.forEach(function (p) { PI[p.pallet_code] = p; });
    st.products.forEach(function (p) { PR[p.code] = p; });
    return Object.keys(L).filter(function (k) { return L[k] !== 0; }).map(function (k) {
      var i = k.indexOf('|'), pc = k.slice(0, i), p = PI[pc] || {}, pr = PR[p.product] || {};
      var kpc = num(p.kg_per_ctn) || num(pr.kg_per_ctn);
      return { pallet_code: pc, warehouse: k.slice(i + 1), cartons: L[k], kg: Math.round(L[k] * kpc * 10) / 10, product: str(p.product), product_name: str(pr.name) || str(p.product),
        lot: str(p.lot), prod_date: str(p.prod_date), exp_date: str(p.exp_date), kg_per_ctn: kpc, position: str(p.position), zone: str(p.zone),
        container_no: str(p.container_no), date_in: str(p.date_in), ext_item: str(p.ext_item) };
    }).sort(function (a, b) { return (a.exp_date || '9999').localeCompare(b.exp_date || '9999') || a.date_in.localeCompare(b.date_in) || a.pallet_code.localeCompare(b.pallet_code); });
  }
  function balanceOf(st, pc, wh) { return st.movements.reduce(function (s, x) { return x.pallet_code === pc && x.warehouse === wh ? s + num(x.cartons) : s; }, 0); }
  function reserved(st, exceptNo) {
    var m = {};
    st.orders.forEach(function (o) {
      if (HOLD.indexOf(o.status) < 0 || o.order_no === exceptNo) return;
      json(o.lines, []).forEach(function (l) { var k = l.pallet_code + '|' + o.warehouse; m[k] = (m[k] || 0) + num(l.cartons); });
    });
    return m;
  }
  /** FEFO: oldest expiry first, then oldest date in. */
  function fefo(st, wh, product, cartons, exceptNo) {
    var R = reserved(st, exceptNo), need = cartons, lines = [];
    stockRows(st, '', wh).forEach(function (r) {
      if (need <= 0 || r.product !== product) return;
      var free = r.cartons - (R[r.pallet_code + '|' + r.warehouse] || 0);
      if (free <= 0) return;
      var take = Math.min(free, need); need -= take;
      lines.push({ pallet_code: r.pallet_code, cartons: take, exp_date: r.exp_date, lot: r.lot });
    });
    return { lines: lines, short: need };
  }
  /** Pallet-days and storage cost of one warehouse in a month (up to `upTo`), pro rata per day. */
  function storage(st, w, ym, upTo) {
    // each pallet pays the rate of its zone (frozen / chiller / dry), per day; a monthly rate counts as rate / 30 per day
    var perDay = {}, first = ym + '-01', last = ym + '-' + daysIn(ym), end = upTo < last ? upTo : last, zoneOfP = {};
    ZONES.forEach(function (z) { var r = rateOf(w, z); perDay[z] = w.rate_unit === 'day' ? r : r / 30; });
    st.pallets.forEach(function (p) { zoneOfP[p.pallet_code] = zoneOf(p.zone); });
    var moves = st.movements.filter(function (x) { return x.warehouse === w.code; }).sort(function (a, b) { return str(a.move_date).localeCompare(str(b.move_date)); });
    var bal = {}, i = 0, days = { FROZEN: 0, CHILLER: 0, DRY: 0 }, nowZ = { FROZEN: 0, CHILLER: 0, DRY: 0 };
    for (var d = first; d <= end; d = addDays(d, 1)) {
      while (i < moves.length && str(moves[i].move_date) <= d) { bal[moves[i].pallet_code] = (bal[moves[i].pallet_code] || 0) + num(moves[i].cartons); i++; }
      nowZ = { FROZEN: 0, CHILLER: 0, DRY: 0 };
      Object.keys(bal).forEach(function (k) { if (bal[k] > 0) nowZ[zoneOfP[k] || 'CHILLER']++; });
      ZONES.forEach(function (z) { days[z] += nowZ[z]; });
    }
    var left = end < last ? (Date.parse(last) - Date.parse(end)) / 86400000 : 0, cost = 0, est = 0, pd = 0, now = 0;
    ZONES.forEach(function (z) { cost += days[z] * perDay[z]; est += (days[z] + nowZ[z] * left) * perDay[z]; pd += days[z]; now += nowZ[z]; });
    return { warehouse: w.code, month: ym, rate: rateOf(w, 'CHILLER'), rates: { FROZEN: rateOf(w, 'FROZEN'), CHILLER: rateOf(w, 'CHILLER'), DRY: rateOf(w, 'DRY') }, rate_unit: w.rate_unit || 'month',
      pallet_days: pd, pallet_days_zone: days, pallets_now: now, pallets_now_zone: nowZ, cost_to_date: Math.round(cost), cost_month_est: Math.round(est) };
  }

  /* ---------- daily check: their lines vs our balance ---------- */
  function compare(st, wh, parsed, asOf) {
    var ours = stockRows(st, asOf, wh), byPallet = {}, used = {}, keys = [];
    ours.forEach(function (r) { byPallet[norm(r.pallet_code)] = r; });
    st.products.forEach(function (p) {
      [p.code, p.name].concat(str(p.aliases).split(',')).forEach(function (a) { var k = norm(a); if (k.length >= 3) keys.push({ k: k, code: p.code }); });
    });
    st.pallets.forEach(function (p) { if (p.ext_item) keys.push({ k: norm(p.ext_item), code: p.product }); });
    keys.sort(function (a, b) { return b.k.length - a.k.length; });
    function productOf(it) {
      var exact = it.item ? norm(it.item) : '';
      if (exact) { var e = keys.find(function (x) { return x.k === exact; }); if (e) return e.code; }
      var t = norm(it.product) || norm(it.line), hit = keys.find(function (x) { return t.indexOf(x.k) >= 0; });
      return hit ? hit.code : '';
    }
    var lines = [], unknown = [], theirs = {}, src = {};
    parsed.items.forEach(function (it) {
      var c = num(it.cartons), r = null;
      if (it.pallet) r = byPallet[norm(it.pallet)];
      if (!r && !it.pallet) { var nl = norm(it.line); r = ours.find(function (o) { return norm(o.pallet_code).length >= 4 && nl.indexOf(norm(o.pallet_code)) >= 0; }) || null; }
      if (r && !used[r.pallet_code]) {
        used[r.pallet_code] = true;
        lines.push({ kind: 'pallet', key: r.pallet_code, label: r.product_name, theirs: c, ours: r.cartons, diff: c - r.cartons, line: it.line });
        return;
      }
      var pc = productOf(it);
      if (it.pallet && !r) { unknown.push({ line: it.line, pallet: it.pallet, product: pc, cartons: c, item: it }); return; }
      if (!pc) { unknown.push({ line: it.line, cartons: c, item: it }); return; }
      theirs[pc] = (theirs[pc] || 0) + c; (src[pc] = src[pc] || []).push(it.line);
    });
    var oursProd = {};
    ours.forEach(function (r) { if (!used[r.pallet_code]) oursProd[r.product] = (oursProd[r.product] || 0) + r.cartons; });
    var name = {}; st.products.forEach(function (p) { name[p.code] = p.name; });
    Object.keys(theirs).forEach(function (pc) { var o = oursProd[pc] || 0; lines.push({ kind: 'product', key: pc, label: name[pc] || pc, theirs: theirs[pc], ours: o, diff: theirs[pc] - o, line: src[pc].join(' / ') }); });
    var missing = [];
    ours.forEach(function (r) { if (!used[r.pallet_code] && theirs[r.product] === undefined && parsed.items.some(function (i) { return i.pallet; })) missing.push({ kind: 'pallet', key: r.pallet_code, label: r.product_name, ours: r.cartons }); });
    Object.keys(oursProd).forEach(function (pc) {
      if (theirs[pc] !== undefined || oursProd[pc] === 0) return;
      if (missing.some(function (m) { return m.kind === 'pallet' && ours.some(function (r) { return r.pallet_code === m.key && r.product === pc; }); })) return;
      missing.push({ kind: 'product', key: pc, label: name[pc] || pc, ours: oursProd[pc] });
    });
    var diffs = lines.filter(function (l) { return l.diff !== 0; }).length;
    return { lines: lines, unknown: unknown, missing: missing, unparsed: parsed.unparsed, ignored: (parsed.ignored || []).length, report_date: parsed.report_date || '',
      parser: parsed.parser || 'generic', n_ok: lines.length - diffs, n_diff: diffs + unknown.length + missing.length,
      total_theirs: parsed.items.reduce(function (s, i) { return s + num(i.cartons); }, 0), total_ours: ours.reduce(function (s, r) { return s + r.cartons; }, 0) };
  }

  /* ---------- the request ---------- */
  function core(state, req, nowIso) {
    var st = {};
    ['warehouses', 'products', 'containers', 'pallets', 'movements', 'checks', 'orders', 'users', 'customers'].forEach(function (k) { st[k] = (state[k] || []).slice(); });
    st.settings = state.settings || {};
    st.movements.forEach(function (m) { m.seq = num(m.seq); m.cartons = num(m.cartons); });
    st.movements.sort(function (a, b) { return a.seq - b.seq; });
    var writes = [], now = str(nowIso), today = wib(now).slice(0, 10), yymmdd = today.slice(2).replace(/-/g, '');
    var action = str(req && req.action), data = (req && req.data && typeof req.data === 'object') ? req.data : {};
    function fail(code, msg, extra) { var r = { ok: false, error: code, message: msg || code }; Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; }); return { response: r, writes: [] }; }
    function done(resp) { resp.ok = true; return { response: resp, writes: writes }; }
    function put(table, row) { writes.push({ table: table, row: row }); var list = st[table]; if (!Array.isArray(list)) return row; if (row.id !== undefined) { var i = list.findIndex(function (x) { return x.id === row.id; }); if (i >= 0) list[i] = row; } else list.push(row); return row; }

    /* who is asking (same rules as the POS) */
    var users = st.users.filter(active), ph = str(req && req.pin_hash), nowMs = Date.parse(now);
    var me = users.find(function (u) { return str(u.name).toLowerCase() === str(req && req.user).toLowerCase(); });
    if (!me || !/^[a-f0-9]{64}$/.test(ph)) return fail('BAD_PIN', 'Nama atau PIN salah');
    if (Date.parse(me.locked_until) > nowMs) return fail('LOCKED', 'Akun dikunci sementara karena PIN salah berkali-kali');
    var viaMaster = users.some(function (u) { return u.role === 'owner' && u.master_hash && u.master_hash === ph; });
    if (me.pin_hash !== ph && !viaMaster) return fail('BAD_PIN', 'Nama atau PIN salah');
    if (bool(me.must_change) && !viaMaster) return fail('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu di aplikasi Khair Mart');
    var role = str(me.role), by = str(me.name);
    if (ROLES.indexOf(role) < 0) return fail('FORBIDDEN', 'Hanya pemilik, manajer dan akuntan');
    if (!READ[action] && role === 'akuntan') return fail('FORBIDDEN', 'Akuntan hanya bisa melihat');
    if (OWNER_ONLY[action] && role !== 'owner') return fail('FORBIDDEN', 'Hanya pemilik');
    var seesCost = role === 'owner' || role === 'akuntan';

    function wh(c) { return st.warehouses.find(function (w) { return w.code === code(c); }); }
    function product(c) { return st.products.find(function (p) { return p.code === code(c); }); }
    function pallet(c) { var k = code(c); return st.pallets.find(function (p) { return p.pallet_code === k; }); }
    function order(no) { return st.orders.find(function (o) { return o.order_no === str(no).toUpperCase(); }); }
    function cust(id) { return st.customers.find(function (c) { return c.id === int(id); }); } // Batch C: customer registry (pos_customers)
    function nextSeq() { return st.movements.reduce(function (m, x) { return Math.max(m, x.seq); }, 0) + 1; }
    function move(o) {
      var row = { seq: nextSeq(), move_date: o.move_date || today, at: now, type: o.type, pallet_code: o.pallet_code, warehouse: o.warehouse, cartons: o.cartons,
        ref_seq: o.ref_seq || 0, grp: o.grp || 0, order_no: o.order_no || '', reason: o.reason || '', by_user: by };
      if (!row.grp) row.grp = row.seq;
      put('movements', row); return row;
    }
    function whOut(w) { var o = { id: w.id, code: w.code, name: w.name, mode: str(w.mode), address: str(w.address), pic_name: str(w.pic_name), pic_wa: str(w.pic_wa), customer_id: str(w.customer_id), parser: str(w.parser) || 'generic', active: active(w) }; if (seesCost) { o.rate = num(w.rate); o.rate_frozen = rateOf(w, 'FROZEN'); o.rate_chiller = rateOf(w, 'CHILLER'); o.rate_dry = rateOf(w, 'DRY'); o.rate_unit = w.rate_unit || 'month'; } return o; }
    /** Containers with what came in, what is left and the day the last carton went out (finished). */
    function contOut(c) {
      var pals = st.pallets.filter(function (p) { return p.container_no === c.container_no; }).map(function (p) { return p.pallet_code; });
      var mv = st.movements.filter(function (m) { return pals.indexOf(m.pallet_code) >= 0; }).sort(function (a, b) { return str(a.move_date).localeCompare(str(b.move_date)) || a.seq - b.seq; });
      var bal = 0, received = 0, fin = '';
      mv.forEach(function (m) { if (m.type === 'IN') received += m.cartons; bal += m.cartons; fin = bal <= 0 && received > 0 ? str(m.move_date) : ''; });
      return Object.assign({}, c, { kind: str(c.kind) || 'container', status: str(c.status) || (pals.length ? 'stored' : 'planned'), log: json(c.log, []), cartons: num(c.cartons), pallets: pals.length, received: received, now: bal, finished_date: fin, origin: str(c.origin), product: str(c.product) });
    }
    function orderOut(o) { var x = Object.assign({}, o); x.lines = json(o.lines, []); x.trip = json(o.trip, null); x.log = json(o.log, []); return x; }
    /** The row with a new status and one more log line {at, by, from, to, note}. */
    function step(row, to, note) { var l = json(row.log, []); l.push({ at: now, by: by, from: str(row.status), to: to, note: note || '' }); return Object.assign({}, row, { status: to, log: JSON.stringify(l.slice(-60)) }); }
    function checkOut(c, full) { var x = { id: c.id, check_no: c.check_no, check_date: c.check_date, warehouse: c.warehouse, at: c.at, by_user: c.by_user, n_diff: num(c.n_diff),
      explained_note: str(c.explained_note), explained_by: str(c.explained_by), explained_at: str(c.explained_at) }; if (full) { x.result = json(c.result, {}); x.raw_text = str(c.raw_text); } return x; }
    function lineList(raw, w, exceptNo) {
      if (!Array.isArray(raw) || !raw.length || raw.length > 60) return { err: 'Isi 1–60 baris palet' };
      var R = reserved(st, exceptNo), seen = {}, out = [];
      for (var i = 0; i < raw.length; i++) {
        var pc = code(raw[i] && raw[i].pallet_code), c = int(raw[i] && raw[i].cartons);
        if (!pc || seen[pc]) return { err: 'Palet tidak valid atau dobel: ' + str(raw[i] && raw[i].pallet_code) };
        if (!(c > 0)) return { err: 'Jumlah karton harus angka bulat > 0 (' + pc + ')' };
        var p = pallet(pc); if (!p) return { err: 'Palet tidak ada: ' + pc, code: 'NOT_FOUND' };
        var free = balanceOf(st, pc, w.code) - (R[pc + '|' + w.code] || 0);
        if (c > free) return { err: 'Stok palet ' + pc + ' tidak cukup: tersedia ' + free + ' ctn', code: 'NOT_ENOUGH' };
        seen[pc] = true; out.push({ pallet_code: pc, cartons: c, product: p.product, exp_date: str(p.exp_date), lot: str(p.lot) });
      }
      return { lines: out };
    }
    function alerts() {
      var rows = stockRows(st, ''), lim = addDays(today, EXPIRY_DAYS);
      var exp = rows.filter(function (r) { return r.cartons > 0 && r.exp_date && r.exp_date <= lim; });
      var checked = {}; st.checks.forEach(function (c) { if (c.check_date === today || wib(str(c.at) || now).slice(0, 10) === today) checked[c.warehouse] = true; });
      var withStock = {}; rows.forEach(function (r) { if (r.cartons > 0) withStock[r.warehouse] = true; });
      var a = { expiring: exp, no_check_today: st.warehouses.filter(function (w) { return active(w) && withStock[w.code] && !checked[w.code]; }).map(function (w) { return w.code; }),
        unexplained: st.checks.filter(function (c) { return num(c.n_diff) > 0 && !str(c.explained_note); }).map(function (c) { return checkOut(c); }).slice(-20) };
      if (seesCost) a.storage = st.warehouses.filter(active).map(function (w) { return storage(st, w, today.slice(0, 7), today); });
      return a;
    }

    switch (action) {
      case 'login':
        return done({ me: { name: by, role: role, via_master: viaMaster && me.pin_hash !== ph }, today: today });
      case 'bootstrap': {
        var s = st.settings;
        return done({
          me: { name: by, role: role }, today: today, sees_cost: seesCost,
          company: { name: str(s.cold_company) || 'PT. SAIDA REZEKI ABADI', store: str(s.store_name) || 'Khair Mart', address: str(s.address), phone: str(s.phone) },
          drivers: json(s.cold_drivers, []), wa: { owner: str(s.wa_owner_number), manager: str(s.wa_manager_number) },
          customers: st.customers.filter(function (c) { return str(c.name); }).map(function (c) { return { id: c.id, name: str(c.name), phone: str(c.phone), address: str(c.address), type: str(c.type) }; }),
          warehouses: st.warehouses.map(whOut), products: st.products.map(function (p) { return { id: p.id, code: p.code, name: p.name, kg_per_ctn: num(p.kg_per_ctn), ctn_per_pallet: num(p.ctn_per_pallet), aliases: str(p.aliases), active: active(p) }; }),
          containers: st.containers.map(contOut), pallets: st.pallets, stock: stockRows(st, ''),
          movements: st.movements.slice(-500).reverse(), checks: st.checks.slice(-60).reverse().map(function (c) { return checkOut(c, true); }),
          orders: st.orders.slice(-100).reverse().map(orderOut), alerts: alerts(), vehicles: VEHICLES.map(function (v) { return { max_kg: v[0] === Infinity ? null : v[0], name: v[1] }; })
        });
      }
      case 'warehouse_save': {
        var name = clean(data.name, 60);
        if (!name) return fail('INVALID', 'Nama gudang wajib');
        var c = code(data.code) || autoCode(name, st.warehouses.map(function (x) { return x.code; }), 'GD');
        var ex = wh(c), rate = num(data.rate), rz = {};
        ZONES.forEach(function (z) { rz['rate_' + z.toLowerCase()] = num(data['rate_' + z.toLowerCase()]); });
        if ([rate, rz.rate_frozen, rz.rate_chiller, rz.rate_dry].some(function (r) { return r < 0 || r > 100000000; })) return fail('INVALID', 'Tarif tidak valid');
        var unit = data.rate_unit === 'day' ? 'day' : 'month', parser = P && P.parsers[str(data.parser)] ? str(data.parser) : 'generic';
        var waRaw = str(data.pic_wa), wa = waRaw ? normPhone(waRaw) : '';
        if (waRaw && !wa) return fail('INVALID', 'Nomor WhatsApp tidak valid');
        var mode = MODES.indexOf(str(data.mode)) >= 0 ? str(data.mode) : (ex ? str(ex.mode) : ''); // Batch C: cooler operating mode
        var row = Object.assign({}, ex || { created_at: now, created_by: by }, { code: c, name: name, mode: mode, address: clean(data.address, 200), pic_name: clean(data.pic_name, 40), pic_wa: wa,
          customer_id: clean(data.customer_id, 20), rate: rate, rate_frozen: rz.rate_frozen, rate_chiller: rz.rate_chiller, rate_dry: rz.rate_dry, rate_unit: unit, parser: parser, active: data.active === undefined ? true : bool(data.active) });
        put('warehouses', row);
        return done({ warehouse: whOut(row) });
      }
      case 'product_save': {
        var pn = clean(data.name, 60), kpc = num(data.kg_per_ctn), cpp = data.ctn_per_pallet === undefined || data.ctn_per_pallet === '' ? 0 : int(data.ctn_per_pallet);
        if (!pn) return fail('INVALID', 'Nama produk wajib');
        var pc = code(data.code) || autoCode(pn, st.products.map(function (x) { return x.code; }), 'P');
        if (kpc < 0 || kpc > 100) return fail('INVALID', 'Kg per karton 0–100');
        if (!(cpp >= 0 && cpp <= 5000)) return fail('INVALID', 'Karton per palet 0–5000');
        var pe = product(pc);
        var prow = Object.assign({}, pe || { created_at: now, created_by: by }, { code: pc, name: pn, kg_per_ctn: kpc, ctn_per_pallet: cpp,
          aliases: str(data.aliases).split(',').map(function (a) { return clean(a, 40); }).filter(Boolean).slice(0, 12).join(', '), active: data.active === undefined ? true : bool(data.active) });
        put('products', prow);
        return done({ product: prow });
      }
      case 'settings_save': {
        if (data.drivers !== undefined) {
          if (!Array.isArray(data.drivers) || data.drivers.length > 20) return fail('INVALID', 'Maksimal 20 sopir');
          var drv = [];
          for (var di = 0; di < data.drivers.length; di++) {
            var d = data.drivers[di] || {}, dn = clean(d.name, 40), dw = normPhone(d.wa);
            if (!dn || !dw) return fail('INVALID', 'Nama dan WhatsApp sopir wajib');
            drv.push({ name: dn, wa: dw, vehicle: clean(d.vehicle, 30), plate: clean(d.plate, 12).toUpperCase() });
          }
          put('settings', { skey: 'cold_drivers', svalue: JSON.stringify(drv) });
        }
        if (data.company !== undefined) { var cn = clean(data.company, 60); if (!cn) return fail('INVALID', 'Nama perusahaan wajib'); put('settings', { skey: 'cold_company', svalue: JSON.stringify(cn) }); }
        return done({});
      }
      case 'customer_save': {
        // Batch C: the reusable customer registry (shared pos_customers). Owner + manager (akuntan is read-only).
        // A new record only sets the fields the cold app owns; an edit touches name/phone/address — never POS-only
        // columns (debt, member, …), so the writer leaves those intact.
        var cnm = clean(data.name, 80);
        if (!cnm) return fail('INVALID', 'Nama pelanggan wajib');
        var cwa = str(data.phone) ? normPhone(data.phone) : '';
        if (str(data.phone) && !cwa) return fail('INVALID', 'Nomor telepon tidak valid');
        var ccid = int(data.id), cex2 = ccid ? cust(ccid) : null;
        if (ccid && !cex2) return fail('NOT_FOUND', 'Pelanggan tidak ada');
        var crow = cex2
          ? { id: cex2.id, name: cnm, phone: cwa, address: clean(data.address, 200) }
          : { name: cnm, phone: cwa, address: clean(data.address, 200), type: clean(data.type, 20) || 'grosir', debt_balance: 0, source: 'gudang' };
        put('customers', crow);
        return done({ customer: Object.assign({ id: cex2 ? cex2.id : 0 }, crow) });
      }
      case 'container_save': {
        var kind = data.kind === 'in_place' ? 'in_place' : 'container', no = str(data.container_no).toUpperCase().replace(/[\s-]/g, ''), cw = wh(data.warehouse);
        if (kind === 'in_place' && !no) { var ym = today.slice(2, 4) + today.slice(5, 7), nIn = st.containers.filter(function (x) { return str(x.container_no).indexOf('IN' + ym) === 0; }).length + 1; no = 'IN' + ym + ('000' + nIn).slice(-4); }
        if (kind === 'container' ? !/^[A-Z]{4}\d{7}$/.test(no) : !/^[A-Z0-9]{3,20}$/.test(no)) return fail('INVALID', 'Nomor kontainer: 4 huruf + 7 angka (contoh CGMU5288973)');
        if (!cw) return fail('NOT_FOUND', 'Gudang tidak ada');
        if (!isDate(data.arrival_date)) return fail('INVALID', 'Tanggal tiba wajib');
        var ce = st.containers.find(function (x) { return x.container_no === no; });
        var cp = str(data.product) ? product(data.product) : null, cc = data.cartons === undefined || data.cartons === '' ? 0 : int(data.cartons);
        if (str(data.product) && !cp) return fail('NOT_FOUND', 'Produk tidak ada');
        if (!(cc >= 0 && cc <= 100000)) return fail('INVALID', 'Jumlah karton tidak valid');
        var crow = Object.assign({}, ce || { created_at: now, created_by: by }, { container_no: no, size: ['20', '40', '40HC'].indexOf(str(data.size)) >= 0 ? str(data.size) : '40',
          arrival_date: data.arrival_date, supplier: clean(data.supplier, 60), warehouse: cw.code, note: clean(data.note, 200),
          origin: clean(data.origin, 40), product: cp ? cp.code : '', cartons: cc, kind: kind });
        if (!ce) crow = step(crow, 'planned', kind === 'in_place' ? 'Beli di gudang' : '');
        put('containers', crow);
        return done({ container: contOut(crow) });
      }
      case 'container_status': {
        var cs = st.containers.find(function (x) { return x.container_no === str(data.container_no).toUpperCase(); }); if (!cs) return fail('NOT_FOUND', 'Kontainer tidak ada');
        var cfrom = str(cs.status) || 'planned', cto = str(data.to), cnote = clean(data.note, 160);
        if ((CFLOW[cfrom] || []).indexOf(cto) < 0) return fail('INVALID', 'Status ' + cfrom + ' → ' + cto + ' tidak boleh');
        if (cto === 'rejected' && cnote.length < 3) return fail('INVALID', 'Alasan wajib');
        var cr2 = put('containers', step(cs, cto, cnote));
        return done({ container: contOut(cr2) });
      }
      case 'pallet_in':
      case 'import_report': {
        var w = wh(data.warehouse); if (!w) return fail('NOT_FOUND', 'Gudang tidak ada');
        var date = data.date || today; if (!isDate(date) || date > today) return fail('INVALID', 'Tanggal masuk tidak valid');
        var list = data.pallets; if (!Array.isArray(list) || !list.length || list.length > 200) return fail('INVALID', 'Isi 1–200 palet');
        var cno = str(data.container_no).toUpperCase().replace(/[\s-]/g, '');
        if (cno && !st.containers.some(function (x) { return x.container_no === cno; })) return fail('NOT_FOUND', 'Kontainer belum dicatat: ' + cno);
        var seenP = {}, made = [], newProducts = [];
        for (var i = 0; i < list.length; i++) {
          var x = list[i] || {}, pcode = code(x.pallet_code), cart = int(x.cartons);
          if (!pcode || seenP[pcode] || pallet(pcode)) return fail('INVALID', 'Kode palet kosong, dobel atau sudah ada: ' + str(x.pallet_code));
          if (!(cart > 0 && cart <= 10000)) return fail('INVALID', 'Karton 1–10000 (' + pcode + ')');
          var pr = product(x.product);
          if (!pr && action === 'import_report' && role === 'owner' && code(x.product) && clean(x.product_name, 60)) {
            pr = put('products', { code: code(x.product), name: clean(x.product_name, 60), kg_per_ctn: num(x.kg_per_ctn), aliases: clean(x.ext_item, 40), active: true, created_at: now, created_by: by });
            newProducts.push(pr.code);
          }
          if (!pr) return fail('NOT_FOUND', 'Produk tidak ada: ' + str(x.product) + (action === 'import_report' && role !== 'owner' ? ' (produk baru hanya oleh pemilik)' : ''));
          var exp = str(x.exp_date); if (!isDate(exp)) return fail('INVALID', 'Tanggal kedaluwarsa wajib (' + pcode + ')');
          var pcn = str(x.container_no).toUpperCase().replace(/[\s-]/g, '') || cno;
          if (pcn && !/^[A-Z]{4}\d{7}$/.test(pcn)) pcn = '';
          if (pcn && !st.containers.some(function (k) { return k.container_no === pcn; })) {
            if (action !== 'import_report') return fail('NOT_FOUND', 'Kontainer belum dicatat: ' + pcn);
            put('containers', { container_no: pcn, size: '40', arrival_date: isDate(x.date_in) ? x.date_in : date, supplier: '', warehouse: w.code, note: 'dari laporan gudang', created_at: now, created_by: by });
          }
          seenP[pcode] = true;
          made.push(put('pallets', { pallet_code: pcode, product: pr.code, lot: clean(x.lot, 60), prod_date: isDate(x.prod_date) ? x.prod_date : '', exp_date: exp,
            kg_per_ctn: num(x.kg_per_ctn) || num(pr.kg_per_ctn), position: clean(x.position, 20), zone: zoneOf(x.zone), container_no: pcn,
            date_in: isDate(x.date_in) ? x.date_in : date, ext_item: clean(x.ext_item, 20), warehouse: w.code, created_at: now, created_by: by }));
        }
        var grp = nextSeq();
        made.map(function (p) { return p.container_no; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).forEach(function (c) {
          var row = st.containers.find(function (x) { return x.container_no === c; });
          if (row && str(row.status) !== 'stored') put('containers', step(row, 'stored', made.filter(function (p) { return p.container_no === c; }).length + ' palet'));
        });
        made.forEach(function (p, k) { move({ type: 'IN', pallet_code: p.pallet_code, warehouse: w.code, cartons: int(list[k].cartons), move_date: date, grp: grp, reason: action === 'import_report' ? 'Stok awal dari laporan gudang' : clean(data.note, 120) }); });
        return done({ pallets: made.length, new_products: newProducts });
      }
      case 'movement_add': {
        var p = pallet(data.pallet_code); if (!p) return fail('NOT_FOUND', 'Palet tidak ada');
        var from = wh(data.warehouse); if (!from) return fail('NOT_FOUND', 'Gudang tidak ada');
        var bal = balanceOf(st, p.pallet_code, from.code), md = data.move_date || today;
        if (!isDate(md) || md > today) return fail('INVALID', 'Tanggal tidak valid');
        var reason = clean(data.reason, 120);
        if (data.type === 'TRANSFER') {
          var to = wh(data.to_warehouse); if (!to || to.code === from.code) return fail('INVALID', 'Gudang tujuan tidak valid');
          var n = data.cartons === undefined || data.cartons === '' ? bal : int(data.cartons);
          if (!(n > 0)) return fail('INVALID', 'Jumlah karton tidak valid');
          if (n > bal) return fail('NOT_ENOUGH', 'Stok palet hanya ' + bal + ' ctn');
          var g = nextSeq();
          move({ type: 'TRANSFER', pallet_code: p.pallet_code, warehouse: from.code, cartons: -n, move_date: md, grp: g, reason: reason || ('ke ' + to.code) });
          move({ type: 'TRANSFER', pallet_code: p.pallet_code, warehouse: to.code, cartons: n, move_date: md, grp: g, reason: reason || ('dari ' + from.code) });
          return done({ grp: g });
        }
        if (data.type === 'ADJUST') {
          var dlt = int(data.cartons);
          if (!dlt) return fail('INVALID', 'Selisih karton harus angka bulat, bukan 0');
          if (reason.length < 3) return fail('INVALID', 'Alasan koreksi wajib');
          if (bal + dlt < 0) return fail('NOT_ENOUGH', 'Stok palet hanya ' + bal + ' ctn');
          return done({ movement: move({ type: 'ADJUST', pallet_code: p.pallet_code, warehouse: from.code, cartons: dlt, move_date: md, reason: reason }) });
        }
        return fail('INVALID', 'Jenis mutasi: TRANSFER atau ADJUST');
      }
      case 'movement_reverse': {
        var m = st.movements.find(function (x) { return x.seq === int(data.seq); });
        if (!m) return fail('NOT_FOUND', 'Mutasi tidak ada');
        if (m.type === 'REVERSE') return fail('INVALID', 'Pembatalan tidak bisa dibatalkan lagi; buat koreksi');
        var why = clean(data.reason, 120); if (why.length < 3) return fail('INVALID', 'Alasan wajib');
        var group = st.movements.filter(function (x) { return x.seq === m.seq || (m.type === 'TRANSFER' && x.type === 'TRANSFER' && x.grp === m.grp); }); // a transfer is undone as a pair
        if (group.some(function (x) { return st.movements.some(function (y) { return y.type === 'REVERSE' && y.ref_seq === x.seq; }); })) return fail('INVALID', 'Mutasi ini sudah dibatalkan');
        var after = {};
        group.forEach(function (x) { var k = x.pallet_code + '|' + x.warehouse; after[k] = (after[k] === undefined ? balanceOf(st, x.pallet_code, x.warehouse) : after[k]) - x.cartons; });
        var neg = Object.keys(after).find(function (k) { return after[k] < 0; });
        if (neg) return fail('NOT_ENOUGH', 'Tidak bisa: stok ' + neg.split('|')[0] + ' akan minus');
        var rg = nextSeq();
        group.forEach(function (x) { move({ type: 'REVERSE', pallet_code: x.pallet_code, warehouse: x.warehouse, cartons: -x.cartons, ref_seq: x.seq, grp: rg, order_no: x.order_no, reason: why }); });
        return done({ reversed: group.map(function (x) { return x.seq; }) });
      }
      case 'check_preview':
      case 'check_save': {
        var cw2 = wh(data.warehouse); if (!cw2) return fail('NOT_FOUND', 'Gudang tidak ada');
        var text = String(data.text || ''); if (!text.trim()) return fail('INVALID', 'Tempel pesan atau pilih file laporan');
        if (text.length > 60000) return fail('INVALID', 'Teks terlalu panjang (maks 60.000 huruf)');
        if (!P) return fail('SERVER', 'Parser tidak dimuat');
        var parsed = P.parse(cw2.parser || 'generic', text);
        var cdate = isDate(data.check_date) ? data.check_date : (isDate(parsed.report_date) ? parsed.report_date : today);
        if (cdate > today) return fail('INVALID', 'Tanggal cek di masa depan');
        var result = compare(st, cw2.code, parsed, cdate);
        if (action === 'check_preview') return done({ check_date: cdate, result: result });
        var nth = st.checks.filter(function (c) { return str(c.check_no).indexOf('CEK-' + yymmdd) === 0; }).length + 1;
        var crow2 = put('checks', { check_no: 'CEK-' + yymmdd + '-' + pad3(nth), check_date: cdate, warehouse: cw2.code, at: now, by_user: by, raw_text: text, result: JSON.stringify(result), n_diff: result.n_diff,
          explained_note: '', explained_by: '', explained_at: '' });
        return done({ check: checkOut(crow2, true) });
      }
      case 'check_note': {
        var ck = st.checks.find(function (c) { return c.check_no === str(data.check_no).toUpperCase(); });
        if (!ck) return fail('NOT_FOUND', 'Cek tidak ada');
        if (str(ck.explained_note)) return fail('INVALID', 'Penjelasan sudah ada dan tidak bisa diubah');
        var note = clean(data.note, 300); if (note.length < 3) return fail('INVALID', 'Penjelasan wajib');
        put('checks', Object.assign({}, ck, { explained_note: note, explained_by: by, explained_at: now }));
        return done({});
      }
      case 'order_save': {
        var ow = wh(data.warehouse); if (!ow) return fail('NOT_FOUND', 'Gudang tidak ada');
        var oe = data.order_no ? order(data.order_no) : null;
        if (data.order_no && !oe) return fail('NOT_FOUND', 'Order tidak ada');
        if (oe && oe.status !== 'open' && oe.status !== 'rejected') return fail('INVALID', 'Order sudah ' + oe.status);
        if (oe && oe.warehouse !== ow.code) return fail('INVALID', 'Gudang order tidak bisa diganti; batalkan dan buat baru');
        var od = data.order_date || today; if (!isDate(od) || od < addDays(today, -7)) return fail('INVALID', 'Tanggal ambil tidak valid');
        var ocid = int(data.customer_id), ocust = ocid ? cust(ocid) : null; // Batch C: link to the customer registry
        var dt = data.dest_type === 'pelanggan' ? 'pelanggan' : 'toko', dn2 = clean(data.dest_name, 60) || (ocust ? clean(ocust.name, 60) : '');
        if (dt === 'pelanggan' && !dn2) return fail('INVALID', 'Nama pelanggan wajib');
        var ll = lineList(data.lines, ow, oe ? oe.order_no : '');
        if (ll.err) return fail(ll.code || 'INVALID', ll.err);
        var nth2 = st.orders.filter(function (o) { return str(o.order_no).indexOf('SPB-' + yymmdd) === 0; }).length + 1;
        var orow = Object.assign({}, oe || { order_no: 'SPB-' + yymmdd + '-' + pad3(nth2), status: 'open', created_at: now, created_by: by, trip: '' }, {
          order_date: od, warehouse: ow.code, dest_type: dt, dest_name: dt === 'toko' ? (dn2 || 'Khair Mart') : dn2, dest_address: clean(data.dest_address, 200) || (ocust ? clean(ocust.address, 200) : ''),
          customer_id: dt === 'pelanggan' ? (ocid || 0) : 0,
          pickup_person: clean(data.pickup_person, 40), vehicle: clean(data.vehicle, 40), note: clean(data.note, 200), lines: JSON.stringify(ll.lines) });
        if (!oe) orow = step(orow, 'open'); else if (oe.status === 'rejected') orow = step(orow, 'open', 'Diubah');
        put('orders', orow);
        return done({ order: orderOut(orow) });
      }
      case 'order_status': {
        var os = order(data.order_no); if (!os) return fail('NOT_FOUND', 'Order tidak ada');
        var to = str(data.to), onote = clean(data.note, 160);
        if ((FLOW[os.status] || []).indexOf(to) < 0) return fail('INVALID', 'Status ' + os.status + ' → ' + to + ' tidak boleh');
        if (to === 'rejected' && onote.length < 3) return fail('INVALID', 'Alasan penolakan wajib');
        if (to === 'driver' && !(json(os.trip, {}) || {}).driver) return fail('INVALID', 'Isi data sopir dulu (Pesan truk)');
        return done({ order: orderOut(put('orders', step(os, to, onote))) });
      }
      case 'order_pick': {
        var op = order(data.order_no); if (!op) return fail('NOT_FOUND', 'Order tidak ada');
        if (HOLD.indexOf(op.status) < 0) return fail('INVALID', 'Order sudah ' + op.status);
        var pd = data.pick_date || today; if (!isDate(pd) || pd > today) return fail('INVALID', 'Tanggal ambil tidak valid');
        var lines = json(op.lines, []), short = lines.filter(function (l) { return balanceOf(st, l.pallet_code, op.warehouse) < num(l.cartons); });
        if (short.length) return fail('NOT_ENOUGH', 'Stok tidak cukup: ' + short.map(function (l) { return l.pallet_code + ' (ada ' + balanceOf(st, l.pallet_code, op.warehouse) + ', perlu ' + l.cartons + ')'; }).join(', '));
        var og = nextSeq();
        lines.forEach(function (l) { move({ type: 'OUT', pallet_code: l.pallet_code, warehouse: op.warehouse, cartons: -num(l.cartons), move_date: pd, grp: og, order_no: op.order_no, reason: 'Ambil ke ' + str(op.dest_name) }); });
        var picked = put('orders', step(Object.assign({}, op, { picked_at: now, picked_by: by, pick_date: pd }), 'picked'));
        return done({ order: orderOut(picked) });
      }
      case 'order_cancel': {
        var oc = order(data.order_no); if (!oc) return fail('NOT_FOUND', 'Order tidak ada');
        if (HOLD.indexOf(oc.status) < 0 && oc.status !== 'rejected') return fail('INVALID', oc.status === 'cancelled' ? 'Order sudah dibatalkan' : 'Sudah diambil: batalkan mutasinya di Mutasi');
        var cr = clean(data.reason, 120); if (cr.length < 3) return fail('INVALID', 'Alasan wajib');
        var cancelled = put('orders', step(Object.assign({}, oc, { cancel_reason: cr, cancelled_at: now, cancelled_by: by }), 'cancelled', cr));
        return done({ order: orderOut(cancelled) });
      }
      case 'trip_save': {
        var ot = order(data.order_no); if (!ot) return fail('NOT_FOUND', 'Order tidak ada');
        if (ot.status === 'cancelled' || ot.status === 'rejected') return fail('INVALID', 'Order ' + ot.status);
        var cost = num(data.cost); if (cost < 0 || cost > 100000000) return fail('INVALID', 'Ongkos tidak valid');
        var trip = { vehicle: clean(data.vehicle, 40), driver: clean(data.driver, 40), driver_wa: data.driver_wa ? normPhone(data.driver_wa) : '', plate: clean(data.plate, 12).toUpperCase(),
          cost: Math.round(cost), via: data.via === 'lalamove' ? 'lalamove' : 'sopir', saved_by: by, saved_at: now };
        if (!trip.vehicle && !trip.driver && !trip.plate) return fail('INVALID', 'Isi kendaraan, sopir atau plat');
        var trow = Object.assign({}, ot, { trip: JSON.stringify(trip) });
        if (ot.status === 'dispatch' && trip.driver) trow = step(trow, 'driver', [trip.driver, trip.plate].filter(Boolean).join(' · '));
        var tr = put('orders', trow);
        return done({ order: orderOut(tr) });
      }
      case 'fefo': {
        var fw = wh(data.warehouse), fp = product(data.product), fc = int(data.cartons);
        if (!fw || !fp) return fail('NOT_FOUND', 'Gudang atau produk tidak ada');
        if (!(fc > 0)) return fail('INVALID', 'Jumlah karton tidak valid');
        return done(fefo(st, fw.code, fp.code, fc, str(data.order_no).toUpperCase()));
      }
      case 'report': {
        var rd = data.date || today; if (!isDate(rd) || rd > today) return fail('INVALID', 'Tanggal tidak valid');
        var rows = stockRows(st, rd).filter(function (r) { return r.cartons !== 0; }), perW = {}, perP = {};
        rows.forEach(function (r) {
          var a = perW[r.warehouse] = perW[r.warehouse] || { warehouse: r.warehouse, pallets: 0, cartons: 0, kg: 0 }; a.pallets++; a.cartons += r.cartons; a.kg += r.kg;
          var b = perP[r.product] = perP[r.product] || { product: r.product, name: r.product_name, pallets: 0, cartons: 0, kg: 0 }; b.pallets++; b.cartons += r.cartons; b.kg += r.kg;
        });
        var rep = { date: rd, rows: rows, per_warehouse: Object.keys(perW).map(function (k) { return perW[k]; }), per_product: Object.keys(perP).map(function (k) { return perP[k]; }),
          expiring: rows.filter(function (r) { return r.cartons > 0 && r.exp_date && r.exp_date <= addDays(rd, EXPIRY_DAYS); }) };
        if (seesCost) rep.storage = st.warehouses.filter(active).map(function (w) { return storage(st, w, rd.slice(0, 7), rd); });
        return done(rep);
      }
      default:
        return fail('INVALID', 'Aksi tidak dikenal: ' + action);
    }
  }
  return { core: core, stockRows: stockRows, fefo: fefo, storage: storage, compare: compare, FLOW: FLOW, CFLOW: CFLOW, HOLD: HOLD, vehicleFor: vehicleFor, zoneOf: zoneOf, ZONES: ZONES, MODES: MODES, VEHICLES: VEHICLES, EXPIRY_DAYS: EXPIRY_DAYS };
})();
if (typeof window !== 'undefined') window.KCold = KCold;
