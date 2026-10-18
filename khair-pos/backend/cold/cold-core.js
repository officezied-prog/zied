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
     open → sent (to the warehouse) → approved | rejected → ready → dispatch (owner/manager approve sending) → driver → [arrived] → picked (stock out) → delivered.
     v59: arrived (order_arrived: the car entered and registered, door, overtime) and trip_cancel (driver → dispatch, book another car).
     rejected → open (edit and send again). cancel: any step before picked. Statuses in HOLD keep their cartons reserved. */
  var HOLD = ['open', 'sent', 'approved', 'ready', 'dispatch', 'driver', 'arrived']; // v59: arrived = the car is in (order_arrived)
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

  /* ---------- the cooler's hours (v59) ----------
     Owner 2026-10-18: «البراد يعمل من الساعة 9 الصبح الى الساعة 17 … الوقت الإضافة بعد الساعة 17 ب300 الف روبية لكل ساعة … راحة من الساعة 12
     الى 13 … اذا لم تدخل السيارة و تسجل قبل الساعة 17 ينطلق احتساب وقت إضافي … اخر طلبية في الوقت العادي الساعة 16»; a started hour counts in
     full; Sunday only by arrangement, at a cost agreed each time; closed on public holidays; Lalamove's time + 15–20 %.
     Each cooler may keep its own `hours` (JSON); these are the owner's defaults, field by field. */
  var HOURS = { open: '09:00', close: '17:00', brk: '12:00-13:00', last: '16:00', days: [1, 2, 3, 4, 5, 6], arrange: [0], ot: 300000 };
  var ETA_MARGIN = 20; // % added to the minutes Lalamove shows
  var OT_CAUSES = ['order_late', 'store_late', 'car_late', 'car_cancel', 'other'];
  function hmOk(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(str(s)); }
  function hm(s) { var p = str(s).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
  function rpS(n) { return 'Rp ' + String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function hmStr(m) { m = Math.max(0, Math.round(m)); return ('0' + Math.floor(m / 60) % 24).slice(-2) + ':' + ('0' + m % 60).slice(-2); }
  function dayList(v, d) {
    if (!Array.isArray(v)) return d.slice();
    return v.map(Number).filter(function (n, i, a) { return n >= 0 && n <= 6 && Math.floor(n) === n && a.indexOf(n) === i; }).sort();
  }
  function hoursOf(w) {
    var x = json(w && w.hours, {}) || {}, o = {};
    ['open', 'close', 'last'].forEach(function (k) { o[k] = hmOk(x[k]) ? x[k] : HOURS[k]; });
    var b = str(x.brk).split('-');
    o.brk = x.brk === '' ? '' : b.length === 2 && hmOk(b[0]) && hmOk(b[1]) && hm(b[0]) < hm(b[1]) ? str(x.brk) : HOURS.brk;
    o.days = dayList(x.days, HOURS.days);
    o.arrange = dayList(x.arrange, HOURS.arrange).filter(function (d) { return o.days.indexOf(d) < 0; });
    o.ot = x.ot !== undefined && x.ot !== null && x.ot !== '' && isFinite(Number(x.ot)) && Number(x.ot) >= 0 ? Math.round(Number(x.ot)) : HOURS.ot;
    return o;
  }
  /** WIB date, minutes since midnight and weekday (0 = Sunday) of an ISO time. */
  function wibAt(iso) { var s = wib(iso); return { date: s.slice(0, 10), min: Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)), dow: new Date(s.slice(0, 10) + 'T00:00:00Z').getUTCDay() }; }
  function holidayName(date, holidays) { var x = (holidays || []).find(function (h) { return h && h.date === date; }); return x ? str(x.name) || 'Libur' : ''; }
  /** 'work' | 'arrange' (open only by arrangement, at a cost) | 'holiday' | 'closed'. */
  function dayKind(date, H, holidays) {
    if (holidayName(date, holidays)) return 'holiday';
    var d = new Date(date + 'T00:00:00Z').getUTCDay();
    return H.days.indexOf(d) >= 0 ? 'work' : H.arrange.indexOf(d) >= 0 ? 'arrange' : 'closed';
  }
  function nextWorkDay(date, H, holidays) { for (var i = 1; i <= 31; i++) { var d = addDays(date, i); if (dayKind(d, H, holidays) === 'work') return d; } return addDays(date, 1); }
  /** A car that enters at `iso`: every started hour after closing is a full hour of overtime. */
  function overtimeAt(iso, H) { var late = wibAt(iso).min - hm(H.close), hrs = late > 0 ? Math.ceil(late / 60) : 0; return { minutes: Math.max(0, late), hours: hrs, cost: hrs * H.ot }; }
  function inBreak(min, H) { if (!H.brk) return false; var b = H.brk.split('-'); return min >= hm(b[0]) && min < hm(b[1]); }
  /** When the car will really be there: Lalamove's minutes plus the margin. */
  function etaOf(nowIso, etaMin, margin) { return new Date(Date.parse(nowIso) + Math.round(num(etaMin) * (1 + num(margin) / 100)) * 60000).toISOString(); }
  /** Today's pickups at risk of overtime: no car yet from 30 min before the last order time, a car not in from 30 min before closing
      (or past its expected time), still not in after closing. */
  function timeAlerts(orders, warehouses, nowIso, holidays) {
    var n = wibAt(nowIso), out = [];
    (orders || []).forEach(function (o) {
      if (!str(o.order_date) || str(o.order_date) > n.date || ['sent', 'approved', 'ready', 'dispatch', 'driver'].indexOf(o.status) < 0) return;
      var H = hoursOf((warehouses || []).find(function (w) { return w.code === o.warehouse; }) || {}), k = dayKind(n.date, H, holidays), kind = '';
      if (k === 'holiday' || k === 'closed') return;
      if (n.min >= hm(H.close)) kind = 'overtime';
      else if (o.status === 'driver') { if (n.min >= hm(H.close) - 30 || (str(o.eta_at) && Date.parse(o.eta_at) < Date.parse(nowIso))) kind = 'car_late'; }
      else if (n.min >= hm(H.last) - 30) kind = 'no_car';
      if (kind) out.push({ order_no: o.order_no, warehouse: o.warehouse, status: o.status, kind: kind });
    });
    return out;
  }
  /** Overtime and agreed extra costs of a month (pickup month), by cause. */
  function otSummary(orders, month) {
    var s = { month: month, count: 0, hours: 0, cost: 0, n_extra: 0, extra: 0, by_cause: {} };
    (orders || []).forEach(function (o) {
      if (str(o.order_date).slice(0, 7) !== month || o.status === 'cancelled') return;
      if (num(o.ot_cost) > 0) { var c = str(o.ot_cause) || 'other'; s.count++; s.hours += num(o.ot_hours); s.cost += num(o.ot_cost); s.by_cause[c] = (s.by_cause[c] || 0) + num(o.ot_cost); }
      if (num(o.extra_cost) > 0) { s.n_extra++; s.extra += num(o.extra_cost); }
    });
    return s;
  }

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

  /* ---------- v60: an order read from a photo of the written sheet or from a customer's message (stage 1b) ----------
     Owner 2026-10-17: the order is a sheet with the quantity, the product, the pallet number and the product code, sent by
     WhatsApp. The AI (or, without an AI key, the rules below) only READS it; these fixed rules turn what was read into a
     draft order — the pallet as written, else FEFO — which the manager checks and saves like any other order. Nothing is
     saved here, and a line that cannot be matched is listed, never dropped. */
  var READ_MAX = 60;
  function productKeys(st) {
    var keys = [];
    st.products.filter(active).forEach(function (p) {
      [p.code, p.name].concat(str(p.aliases).split(',')).forEach(function (a) { var k = norm(a); if (k.length >= 3) keys.push({ k: k, code: p.code }); });
    });
    st.pallets.forEach(function (p) { if (p.ext_item) keys.push({ k: norm(p.ext_item), code: p.product }); });
    return keys.sort(function (a, b) { return b.k.length - a.k.length; });
  }
  function productIn(keys, codeText, text) {
    var c = norm(codeText); if (c) { var e = keys.find(function (x) { return x.k === c; }); if (e) return e.code; }
    var t = norm(text); if (!t) return '';
    var hit = keys.find(function (x) { return t.indexOf(x.k) >= 0; }) || (t.length >= 4 ? keys.find(function (x) { return x.k.indexOf(t) >= 0; }) : null);
    return hit ? hit.code : '';
  }
  /** What the AI reads the order against: the coolers, the products and the pallets in stock (it copies their codes). */
  function readPrompt(st, today) {
    var R = reserved(st, ''), rows = stockRows(st, '', '').filter(function (r) { return r.cartons > 0; }).slice(0, 400);
    var system = [
      'You read pickup orders for the cold-storage goods of Khair Mart (Jakarta). The input is a photo of a written order sheet or a customer\'s WhatsApp message, in Indonesian, Arabic or English. A line usually has a quantity, the product, a pallet number and a product code.',
      'Answer with ONE JSON object and nothing else:',
      '{"warehouse":"","customer":{"name":"","phone":"","address":""},"date":"","note":"","items":[{"pallet":"","code":"","product":"","qty":0,"unit":"ctn","unclear":false,"line":""}]}',
      '- items: one per order line, in the order written; never add a line that is not written; skip greetings and signatures.',
      '- pallet: the pallet number as written. When it is close to a pallet in the list (a digit hard to read), give the listed one and set unclear to true.',
      '- code: the product code from the list when you can tell which product it is, else empty. product: the product as written.',
      '- qty and unit: "ctn" for cartons (dus, karton, box, MC, cs), "pallet" for whole pallets, "kg" for kilograms. A pallet line with no quantity: qty 0 (the whole pallet).',
      '- unclear: true when you are not sure of the pallet, the product or the quantity of that line.',
      '- warehouse: the cooler code from the list when the order names the cooler, else empty.',
      '- customer: who receives the goods (not the cold store, not Khair Mart itself); the phone as written.',
      '- date: the pickup day as YYYY-MM-DD when written ("besok" = tomorrow; today is ' + today + ' in Jakarta), else empty.',
      '- note: anything else the cold store must know, short.'
    ].join('\n');
    var catalog = ['Coolers (code | name):'].concat(st.warehouses.filter(active).map(function (w) { return w.code + ' | ' + str(w.name); }),
      ['', 'Products (code | name | other names | kg per carton):'], st.products.filter(active).map(function (p) { return [p.code, str(p.name), str(p.aliases), num(p.kg_per_ctn) || ''].join(' | '); }),
      ['', 'Pallets in stock (pallet | product code | cooler | free cartons):'], rows.map(function (r) { return [r.pallet_code, r.product, r.warehouse, r.cartons - (R[r.pallet_code + '|' + r.warehouse] || 0)].join(' | '); })).join('\n');
    return { system: system, catalog: catalog };
  }
  /** The model's answer → { warehouse, customer, date, note, items } (the JSON object in it), or null. */
  function readJson(text) {
    var s = str(text), a = s.indexOf('{'), b = s.lastIndexOf('}'), o = null;
    if (a < 0 || b <= a) return null;
    try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
    return o && typeof o === 'object' && Array.isArray(o.items) ? o : null;
  }
  /** No AI: a typed / pasted message read by fixed rules ("Sukari 50 ctn", "2 palet Ajwa", "PID 2274537 120 dus"). */
  var RE_RQTY = /(\d[\d.,]*)\s*(ctn|ctns|carton|cartons|karton|krt|dus|box|bx|mc|cs|palet|pallet|pallets|plt)\b/i;
  var RE_RPAL = /\b(?:pid|plt|pallet|palet)\s*(?:no\.?|nomor|#|:)?\s*-?\s*([A-Z]*-?\d[A-Z0-9\-]*)/i;
  function readRules(st, text, today) {
    var toI = P ? P.toInt : function (v) { return Math.round(Number(String(v).replace(/[.,]/g, ''))); };
    var pals = st.pallets.map(function (p) { return p.pallet_code; }).filter(function (c) { return norm(c).length >= 4; }).sort(function (a, b) { return b.length - a.length; });
    var keys = productKeys(st), out = { items: [], unread: [], customer: {}, date: '' }, all = String(text || '').replace(/\r/g, '');
    var ph = all.match(/(?:\+62|\b62|\b0)8[\d\s.\-]{7,14}\d/); if (ph) out.customer.phone = ph[0];
    var na = norm(all), cm = st.customers.filter(function (c) { return norm(c.name).length >= 4 && na.indexOf(norm(c.name)) >= 0; }).sort(function (a, b) { return str(b.name).length - str(a.name).length; })[0];
    if (cm) out.customer.name = str(cm.name);
    if (/\bbesok\b|\btomorrow\b|غدا|غداً/i.test(all)) out.date = addDays(today, 1);
    var dm = all.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b/); if (dm && P && P.toDate(dm[0])) out.date = P.toDate(dm[0]);
    all.split('\n').forEach(function (l) {
      var s = clean(l, 200).replace(/^\s*(?:[-•*·]|\d{1,2}[.)])\s+/, ''); if (!s) return;
      var am = s.match(/^(?:alamat|address|العنوان)\s*[:=]?\s*(.+)$/i); if (am) { out.customer.address = clean(am[1], 200); return; }
      var nm = s.match(/^(?:nama|name|kepada|untuk|pelanggan|customer|الزبون|الاسم)\s*[:=]\s*(.+)$/i); if (nm) { if (!out.customer.name) out.customer.name = clean(nm[1], 60); return; }
      if (ph && s.indexOf(ph[0]) >= 0 && !/[a-z]{3}/i.test(s.replace(ph[0], '').replace(/\b(hp|wa|telp|tel|no)\b/ig, ''))) return; // a phone-only line
      var it = { line: s, unit: 'ctn', qty: 0 }, rest = s, ns = norm(s);
      var pk = pals.find(function (c) { return ns.indexOf(norm(c)) >= 0; });
      if (pk) { it.pallet = pk; rest = rest.replace(new RegExp(pk.replace(/[-]/g, '[-\\s]?'), 'i'), ' '); }
      else { var pm = rest.match(RE_RPAL); if (pm && norm(pm[1]).length >= 3 && !RE_RQTY.test(pm[0] + ' x')) { it.pallet = pm[1].toUpperCase(); rest = rest.replace(pm[0], ' '); } }
      rest = rest.replace(/\b(?:pid|plt)\b\s*[:#.]?/ig, ' ');
      var q = rest.match(RE_RQTY);
      if (q) { it.qty = toI(q[1]); it.unit = /^(palet|pallet|pallets|plt)$/i.test(q[2]) ? 'pallet' : 'ctn'; rest = rest.replace(q[0], ' '); }
      else {
        var tq = rest.match(/(?:^|\s|[=:x×])(\d[\d.,]*)\s*$/), lq = rest.match(/^\s*(\d[\d.,]*)\s*(?:x|×)?\s+(?=\S)/i);
        if (tq && /[a-z]/i.test(rest.slice(0, rest.length - tq[0].length))) { it.qty = toI(tq[1]); rest = rest.slice(0, rest.length - tq[0].length); }
        else if (lq) { it.qty = toI(lq[1]); rest = rest.slice(lq[0].length); }
      }
      it.product = clean(rest.replace(/[:=|,;]+/g, ' '), 80);
      if (!(it.qty > 0) && !it.pallet) { if (/\d/.test(s) || productIn(keys, '', s)) out.unread.push(s); return; }
      out.items.push(it);
    });
    out.items = out.items.slice(0, READ_MAX);
    return out;
  }
  /** What was read → a draft order. Pallet lines take that pallet (its free cartons, the whole of it when no quantity is
      written); product lines take FEFO in the cooler; "N palet" = the N oldest pallets whole. */
  function draftOf(st, read, hint, today) {
    read = read && typeof read === 'object' ? read : {};
    var items = (Array.isArray(read.items) ? read.items : []).slice(0, READ_MAX), keys = productKeys(st), R = reserved(st, '');
    var rows = stockRows(st, '', ''), whs = st.warehouses.filter(active), byPal = {}, prodOf = {};
    st.pallets.forEach(function (p) { byPal[norm(p.pallet_code)] = p; });
    st.products.forEach(function (p) { prodOf[p.code] = p; });
    var got = items.map(function (it) {
      it = it && typeof it === 'object' ? it : {};
      var line = clean(it.line, 120) || clean([it.qty, it.unit, it.product || it.code, it.pallet].filter(function (x) { return str(x); }).join(' '), 120);
      var u = str(it.unit).toLowerCase(), p = str(it.pallet) ? byPal[norm(it.pallet)] || null : null;
      return { line: line, qty: num(it.qty), unit: /^(pallet|pallets|palet|plt)$/.test(u) ? 'pallet' : u === 'kg' ? 'kg' : 'ctn', pallet: p, pallet_raw: clean(it.pallet, 30),
        product: p ? str(p.product) : productIn(keys, it.code, str(it.product) || line), unclear: bool(it.unclear) };
    });
    // the cooler: as written, else where the written pallets are, else where the products can be taken (the form's cooler wins a tie)
    var W = null, wr = norm(read.warehouse), h0 = code(hint);
    if (wr) W = whs.find(function (w) { return norm(w.code) === wr || norm(w.name) === wr; }) || whs.find(function (w) { return norm(w.name).indexOf(wr) >= 0 || wr.indexOf(norm(w.code)) >= 0; }) || null;
    function bestOf(m) { var k = Object.keys(m).filter(function (x) { return m[x] > 0; }).sort(function (a, b) { return m[b] - m[a] || (b === h0) - (a === h0); })[0]; return k ? whs.find(function (w) { return w.code === k; }) || null : null; }
    if (!W) { var pw = {}; got.forEach(function (g) { if (g.pallet) rows.forEach(function (r) { if (r.pallet_code === g.pallet.pallet_code && r.cartons > 0) pw[r.warehouse] = (pw[r.warehouse] || 0) + 1; }); }); W = bestOf(pw); }
    if (!W) { var fw = {}; got.forEach(function (g) { if (!g.pallet && g.product) rows.forEach(function (r) { if (r.product === g.product) fw[r.warehouse] = (fw[r.warehouse] || 0) + Math.max(0, r.cartons - (R[r.pallet_code + '|' + r.warehouse] || 0)); }); }); W = bestOf(fw); }
    if (!W) W = whs.find(function (w) { return w.code === h0; }) || whs[0] || null;
    var wc = W ? W.code : '', take = {}, lines = [], unmatched = [], warn = [], unclear = 0;
    function free(pc) { var r = rows.find(function (x) { return x.pallet_code === pc && x.warehouse === wc; }); return r ? r.cartons - (R[pc + '|' + wc] || 0) : 0; }
    function left(pc) { return free(pc) - (take[pc] || 0); }
    function add(pc, n, g, src) {
      take[pc] = (take[pc] || 0) + n;
      var x = lines.find(function (l) { return l.pallet_code === pc; }); if (x) { x.cartons += n; return; }
      var pp = byPal[norm(pc)] || {}, pr = prodOf[pp.product] || {};
      lines.push({ pallet_code: pc, cartons: n, product: str(pp.product), product_name: str(pr.name) || str(pp.product), exp_date: str(pp.exp_date), src: src, line: g.line });
    }
    got.forEach(function (g) {
      if (g.unclear) unclear++;
      var pr = prodOf[g.product] || null, kpc = pr ? num(pr.kg_per_ctn) : 0;
      if (g.pallet) {
        var pc = g.pallet.pallet_code, f = left(pc);
        if (f <= 0) { // booked by another order (or an earlier line), in another cooler, or empty
          var inW = rows.some(function (r) { return r.pallet_code === pc && r.warehouse === wc && r.cartons > 0; });
          unmatched.push({ line: g.line, pallet: pc, reason: inW ? 'taken' : rows.some(function (r) { return r.pallet_code === pc && r.cartons > 0; }) ? 'elsewhere' : 'empty' }); unclear++; return;
        }
        var want = g.unit === 'pallet' || !(g.qty > 0) ? f : g.unit === 'kg' ? (kpc > 0 ? Math.ceil(g.qty / kpc) : 0) : Math.round(g.qty);
        if (!(want > 0)) { unmatched.push({ line: g.line, pallet: pc, reason: 'qty' }); unclear++; return; }
        if (want > f) { warn.push({ line: g.line, kind: 'short', pallet: pc, n: want - f }); want = f; }
        add(pc, want, g, 'pallet'); return;
      }
      if (!pr) { unmatched.push(g.pallet_raw ? { line: g.line, pallet: g.pallet_raw, reason: 'no_pallet' } : { line: g.line, reason: 'unknown' }); unclear++; return; }
      if (g.pallet_raw) { warn.push({ line: g.line, kind: 'no_pallet', pallet: g.pallet_raw }); unclear++; } // the written pallet is not ours: FEFO instead, said
      var avail = rows.filter(function (r) { return r.warehouse === wc && r.product === pr.code && left(r.pallet_code) > 0; }); // FEFO order (stockRows)
      if (g.unit === 'pallet') {
        var np = Math.max(1, Math.round(g.qty) || 1), whole = avail.slice(0, np);
        whole.forEach(function (r) { add(r.pallet_code, left(r.pallet_code), g, 'fefo'); });
        if (whole.length < np) warn.push({ line: g.line, kind: 'short_pallets', product: pr.code, n: np - whole.length });
        return;
      }
      var need = g.unit === 'kg' ? (kpc > 0 ? Math.ceil(g.qty / kpc) : 0) : Math.round(g.qty);
      if (!(need > 0)) { unmatched.push({ line: g.line, product: pr.code, reason: 'qty' }); unclear++; return; }
      avail.forEach(function (r) { if (need <= 0) return; var tk = Math.min(need, left(r.pallet_code)); if (tk > 0) { add(r.pallet_code, tk, g, 'fefo'); need -= tk; } });
      if (need > 0) warn.push({ line: g.line, kind: 'short', product: pr.code, n: need });
    });
    // who receives it: the registry customer (same phone, else same name), a new customer, or the shop itself
    var cu = read.customer && typeof read.customer === 'object' ? read.customer : {}, cn = clean(cu.name, 60), cph = str(cu.phone) ? normPhone(cu.phone) : '', ca = clean(cu.address, 200);
    var shop = norm(st.settings.store_name || 'Khair Mart'), isShop = !!cn && (norm(cn) === shop || norm(cn).indexOf('khairmart') >= 0);
    var cm = isShop ? null : (cph && st.customers.find(function (c) { return normPhone(c.phone) === cph; })) || (cn && st.customers.find(function (c) { return norm(c.name) === norm(cn); })) || null;
    var pel = !isShop && !!(cm || cn);
    return { warehouse: wc, order_date: isDate(str(read.date)) && read.date >= today ? read.date : today,
      dest_type: pel ? 'pelanggan' : 'toko', dest_name: pel ? (cm ? str(cm.name) : cn) : '', dest_phone: pel ? (cph || (cm ? str(cm.phone) : '')) : '',
      dest_address: pel ? (ca || (cm ? str(cm.address) : '')) : '', customer_id: pel && cm ? cm.id : 0, note: clean(read.note, 200),
      lines: lines, unmatched: unmatched, warn: warn, unclear: unclear + (items.length ? 0 : 1), n_items: items.length };
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
    var holidays = json(st.settings.cold_holidays, []) || [], ms = st.settings.cold_eta_margin;
    var margin = ms !== undefined && ms !== null && ms !== '' && isFinite(Number(ms)) ? Number(ms) : ETA_MARGIN; // v59

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
    function whOut(w) { var o = { id: w.id, code: w.code, name: w.name, mode: str(w.mode), hours: hoursOf(w), hours_set: !!str(w.hours), address: str(w.address), pic_name: str(w.pic_name), pic_wa: str(w.pic_wa), customer_id: str(w.customer_id), parser: str(w.parser) || 'generic', active: active(w) }; if (seesCost) { o.rate = num(w.rate); o.rate_frozen = rateOf(w, 'FROZEN'); o.rate_chiller = rateOf(w, 'CHILLER'); o.rate_dry = rateOf(w, 'DRY'); o.rate_unit = w.rate_unit || 'month'; } return o; }
    /** Containers with what came in, what is left and the day the last carton went out (finished). */
    function contOut(c) {
      var pals = st.pallets.filter(function (p) { return p.container_no === c.container_no; }).map(function (p) { return p.pallet_code; });
      var mv = st.movements.filter(function (m) { return pals.indexOf(m.pallet_code) >= 0; }).sort(function (a, b) { return str(a.move_date).localeCompare(str(b.move_date)) || a.seq - b.seq; });
      var bal = 0, received = 0, fin = '';
      mv.forEach(function (m) { if (m.type === 'IN') received += m.cartons; bal += m.cartons; fin = bal <= 0 && received > 0 ? str(m.move_date) : ''; });
      return Object.assign({}, c, { kind: str(c.kind) || 'container', status: str(c.status) || (pals.length ? 'stored' : 'planned'), log: json(c.log, []), cartons: num(c.cartons), pallets: pals.length, received: received, now: bal, finished_date: fin, origin: str(c.origin), product: str(c.product) });
    }
    // v36 (owner 2026-10-11: "رقم الحاوية … رقم السيارة … بلات كامل او عدد من الكراتين"): every order line carries the
    // pallet's CONTAINER number and whether the whole pallet is taken (full) or only some cartons of it. A running order
    // reads it live from the stock (another order may have taken part of the pallet since); a picked one keeps what was true
    // at the pick. Older orders get the container from the pallet register.
    var BAL = null, BALN = -1;
    function bal(pc, w) { if (!BAL || BALN !== st.movements.length) { BAL = ledger(st.movements, '', ''); BALN = st.movements.length; } return BAL[pc + '|' + w] || 0; }
    function lineOut(l, o, live) {
      var x = Object.assign({}, l), p = pallet(l.pallet_code) || {};
      if (!str(x.container_no)) x.container_no = str(p.container_no);
      if (live) { var b = bal(x.pallet_code, o.warehouse); x.pallet_ctn = b; x.full = b > 0 && num(x.cartons) >= b; }
      else { x.full = x.full === undefined || x.full === null || x.full === '' ? null : bool(x.full); x.pallet_ctn = num(x.pallet_ctn); } // null: an order picked before v36 (not known)
      return x;
    }
    function orderOut(o) { var x = Object.assign({}, o), live = HOLD.indexOf(o.status) >= 0; x.lines = json(o.lines, []).map(function (l) { return lineOut(l, o, live); }); x.trip = json(o.trip, null); x.log = json(o.log, []); x.plate = str(o.plate); x.dest_phone = str(o.dest_phone); return x; }
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
        var whole = balanceOf(st, pc, w.code); // v36: container number + full pallet or some cartons
        seen[pc] = true; out.push({ pallet_code: pc, cartons: c, product: p.product, exp_date: str(p.exp_date), lot: str(p.lot), container_no: str(p.container_no), full: c >= whole, pallet_ctn: whole });
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
      a.overtime = otSummary(st.orders, today.slice(0, 7)); // v59: overtime + agreed extra costs this month (every role: it is avoidable)
      return a;
    }

    switch (action) {
      case 'login':
        return done({ me: { name: by, role: role, via_master: viaMaster && me.pin_hash !== ph }, today: today });
      case 'bootstrap': {
        var s = st.settings;
        return done({
          me: { name: by, role: role }, today: today, sees_cost: seesCost, holidays: holidays, eta_margin: margin, ot_causes: OT_CAUSES,
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
        // v59: the cooler's hours (open, close, break, last order, working days, days by arrangement, overtime per hour)
        var hrs = ex ? str(ex.hours) : '';
        if (data.hours !== undefined) {
          var hx = data.hours && typeof data.hours === 'object' ? data.hours : null;
          if (!hx) hrs = '';
          else {
            var hb = str(hx.brk), hbp = hb.split('-');
            if (!hmOk(hx.open) || !hmOk(hx.close) || !hmOk(hx.last) || !(hm(hx.open) < hm(hx.last) && hm(hx.last) <= hm(hx.close))) return fail('INVALID', 'Jam kerja: buka < order terakhir ≤ tutup (JJ:MM)');
            if (hb && !(hbp.length === 2 && hmOk(hbp[0]) && hmOk(hbp[1]) && hm(hx.open) <= hm(hbp[0]) && hm(hbp[0]) < hm(hbp[1]) && hm(hbp[1]) <= hm(hx.close))) return fail('INVALID', 'Jam istirahat tidak valid (contoh 12:00-13:00)');
            var hdays = dayList(hx.days, []), harr = dayList(hx.arrange, []).filter(function (d) { return hdays.indexOf(d) < 0; }), hot = num(hx.ot);
            if (!hdays.length) return fail('INVALID', 'Pilih minimal satu hari kerja');
            if (hot < 0 || hot > 100000000) return fail('INVALID', 'Tarif lembur tidak valid');
            hrs = JSON.stringify({ open: hx.open, close: hx.close, brk: hb, last: hx.last, days: hdays, arrange: harr, ot: Math.round(hot) });
          }
        }
        var row = Object.assign({}, ex || { created_at: now, created_by: by }, { code: c, name: name, mode: mode, address: clean(data.address, 200), pic_name: clean(data.pic_name, 40), pic_wa: wa,
          customer_id: clean(data.customer_id, 20), rate: rate, rate_frozen: rz.rate_frozen, rate_chiller: rz.rate_chiller, rate_dry: rz.rate_dry, rate_unit: unit, parser: parser, active: data.active === undefined ? true : bool(data.active), hours: hrs });
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
        if (data.holidays !== undefined) { // v59: public holidays (the coolers are closed)
          if (!Array.isArray(data.holidays) || data.holidays.length > 60) return fail('INVALID', 'Maksimal 60 hari libur');
          var hl = [];
          for (var hi = 0; hi < data.holidays.length; hi++) {
            var hd = data.holidays[hi] || {};
            if (!isDate(hd.date)) return fail('INVALID', 'Tanggal libur tidak valid: ' + str(hd.date));
            if (!hl.some(function (x) { return x.date === hd.date; })) hl.push({ date: hd.date, name: clean(hd.name, 40) });
          }
          hl.sort(function (a, b) { return a.date.localeCompare(b.date); });
          put('settings', { skey: 'cold_holidays', svalue: JSON.stringify(hl) });
        }
        if (data.eta_margin !== undefined) { var em = num(data.eta_margin); if (!(em >= 0 && em <= 100)) return fail('INVALID', 'Tambahan waktu 0–100 %'); put('settings', { skey: 'cold_eta_margin', svalue: JSON.stringify(Math.round(em)) }); }
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
        // v59: the pickup day must be a day the cooler opens (a day by arrangement is settled when the order is sent)
        var oH = hoursOf(ow), oK = od >= today ? dayKind(od, oH, holidays) : 'work';
        if (oK === 'holiday' || oK === 'closed') return fail('CLOSED', 'Gudang ' + ow.name + ' tutup tanggal ' + od + (oK === 'holiday' ? ' (' + holidayName(od, holidays) + ')' : '') + '. Hari kerja berikutnya: ' + nextWorkDay(od, oH, holidays), { next: nextWorkDay(od, oH, holidays), kind: oK });
        var ocid = int(data.customer_id), ocust = ocid ? cust(ocid) : null; // Batch C: link to the customer registry
        var dt = data.dest_type === 'pelanggan' ? 'pelanggan' : 'toko', dn2 = clean(data.dest_name, 60) || (ocust ? clean(ocust.name, 60) : '');
        if (dt === 'pelanggan' && !dn2) return fail('INVALID', 'Nama pelanggan wajib');
        // v36 (owner 2026-10-11: «في أمر جديد يُسجَّل الزبون دائمًا مع العنوان والهاتف وتخرج قائمة بالزبائن»): a customer
        // order always lands in the customer list — the picked one (or the one with the same name) gets the typed phone /
        // address, a new name becomes a new customer. Only name/phone/address are written: never POS-only columns (debt…).
        var oph = str(data.dest_phone) ? normPhone(data.dest_phone) : '';
        if (dt === 'pelanggan' && str(data.dest_phone) && !oph) return fail('INVALID', 'Nomor telepon tidak valid');
        var oaddr = clean(data.dest_address, 200);
        if (dt === 'pelanggan') {
          if (ocust && norm(ocust.name) !== norm(dn2)) ocust = null; // the name was changed after picking: another customer
          if (!ocust) ocust = st.customers.find(function (c) { return str(c.name) && norm(c.name) === norm(dn2); }) || null;
        } else ocust = null;
        var ll = lineList(data.lines, ow, oe ? oe.order_no : '');
        if (ll.err) return fail(ll.code || 'INVALID', ll.err);
        if (dt === 'pelanggan') {
          if (!ocust) put('customers', { name: dn2, phone: oph, address: oaddr, type: 'grosir', debt_balance: 0, source: 'gudang' });
          else if ((oph && oph !== str(ocust.phone)) || (oaddr && oaddr !== str(ocust.address)))
            put('customers', { id: ocust.id, name: str(ocust.name), phone: oph || str(ocust.phone), address: oaddr || str(ocust.address) });
        }
        var nth2 = st.orders.filter(function (o) { return str(o.order_no).indexOf('SPB-' + yymmdd) === 0; }).length + 1;
        var orow = Object.assign({}, oe || { order_no: 'SPB-' + yymmdd + '-' + pad3(nth2), status: 'open', created_at: now, created_by: by, trip: '' }, {
          order_date: od, warehouse: ow.code, dest_type: dt, dest_name: dt === 'toko' ? (dn2 || 'Khair Mart') : dn2, dest_address: oaddr || (ocust ? clean(ocust.address, 200) : ''),
          dest_phone: dt === 'pelanggan' ? (oph || (ocust ? str(ocust.phone) : '')) : '',
          customer_id: dt === 'pelanggan' && ocust ? ocust.id : 0,
          pickup_person: clean(data.pickup_person, 40), vehicle: clean(data.vehicle, 40), plate: clean(data.plate, 12).toUpperCase(), note: clean(data.note, 200), lines: JSON.stringify(ll.lines) });
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
        if (to === 'sent') {
          // v59: a pickup today after the last order time costs overtime (when = 'overtime' accepts it, 'later' moves the pickup to the
          // next working day); a day by arrangement needs the extra cost agreed with the cooler; a closed day / holiday only 'later'.
          var sw = wh(os.warehouse) || {}, sH = hoursOf(sw), sn = wibAt(now), pd0 = str(os.order_date) || sn.date, when = str(data.when);
          var pk = pd0 >= sn.date ? dayKind(pd0, sH, holidays) : 'work', late = pd0 <= sn.date && sn.min > hm(sH.last);
          var nextD = nextWorkDay(pd0 > sn.date ? pd0 : sn.date, sH, holidays);
          if (when === 'later' && (pk !== 'work' || late)) {
            os = Object.assign({}, os, { order_date: nextD });
            onote = (onote ? onote + ' · ' : '') + 'Diambil ' + nextD + ' (tanpa lembur)';
          } else {
            if (pk === 'holiday' || pk === 'closed') return fail('CLOSED', 'Gudang ' + str(sw.name || os.warehouse) + ' tutup tanggal ' + pd0 + (pk === 'holiday' ? ' (' + holidayName(pd0, holidays) + ')' : ''), { next: nextD, kind: pk });
            if (pk === 'arrange') {
              if (data.extra_cost === undefined || data.extra_cost === null || data.extra_cost === '') return fail('ARRANGE', 'Tanggal ' + pd0 + ' gudang buka hanya dengan perjanjian dan biaya tambahan. Isi biaya yang disepakati.', { next: nextD });
              var xc = num(data.extra_cost); if (!(xc >= 0 && xc <= 100000000)) return fail('INVALID', 'Biaya tambahan tidak valid');
              os = Object.assign({}, os, { extra_cost: Math.round(xc), extra_note: clean(data.extra_note, 120) || 'Buka di luar hari kerja (perjanjian)' });
              onote = (onote ? onote + ' · ' : '') + 'Biaya tambahan ' + rpS(xc);
            }
            if (late) {
              if (when !== 'overtime') return fail('AFTER_HOURS', 'Lewat jam order terakhir (' + sH.last + '). Diambil hari ini bisa kena lembur ' + rpS(sH.ot) + ' per jam setelah ' + sH.close + '.', { next: nextD, last: sH.last, close: sH.close, ot: sH.ot });
              onote = (onote ? onote + ' · ' : '') + 'Lewat ' + sH.last + ': risiko lembur disetujui';
            }
          }
        }
        return done({ order: orderOut(put('orders', step(os, to, onote))) });
      }
      case 'order_pick': {
        var op = order(data.order_no); if (!op) return fail('NOT_FOUND', 'Order tidak ada');
        if (HOLD.indexOf(op.status) < 0) return fail('INVALID', 'Order sudah ' + op.status);
        var pd = data.pick_date || today; if (!isDate(pd) || pd > today) return fail('INVALID', 'Tanggal ambil tidak valid');
        var lines = json(op.lines, []), short = lines.filter(function (l) { return balanceOf(st, l.pallet_code, op.warehouse) < num(l.cartons); });
        if (short.length) return fail('NOT_ENOUGH', 'Stok tidak cukup: ' + short.map(function (l) { return l.pallet_code + ' (ada ' + balanceOf(st, l.pallet_code, op.warehouse) + ', perlu ' + l.cartons + ')'; }).join(', '));
        var og = nextSeq();
        lines = lines.map(function (l) { var b = balanceOf(st, l.pallet_code, op.warehouse), p = pallet(l.pallet_code) || {}; // v36: what was true at the pick
          return Object.assign({}, l, { container_no: str(l.container_no) || str(p.container_no), full: num(l.cartons) >= b, pallet_ctn: b }); });
        lines.forEach(function (l) { move({ type: 'OUT', pallet_code: l.pallet_code, warehouse: op.warehouse, cartons: -num(l.cartons), move_date: pd, grp: og, order_no: op.order_no, reason: 'Ambil ke ' + str(op.dest_name) }); });
        var picked = put('orders', step(Object.assign({}, op, { picked_at: now, picked_by: by, pick_date: pd, lines: JSON.stringify(lines) }), 'picked'));
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
        // v59: the minutes Lalamove shows + the margin = when the car is really there; a pickup today that would enter after closing
        // is overtime (accept_ot: true accepts it); arriving in the break only warns (the car waits)
        var etaRaw = data.eta_min, eta = etaRaw === undefined || etaRaw === null || etaRaw === '' ? null : int(etaRaw), etaAt = str(ot.eta_at), warn = '', tnote = '';
        if (eta !== null) {
          if (!(eta >= 0 && eta <= 600)) return fail('INVALID', 'Waktu tiba 0–600 menit');
          etaAt = etaOf(now, eta, margin); trip.eta_min = eta;
          if (str(ot.order_date) <= today) {
            var tH = hoursOf(wh(ot.warehouse) || {}), ea = wibAt(etaAt), eo = overtimeAt(etaAt, tH);
            if (eo.hours > 0 && data.accept_ot !== true) return fail('LATE_CAR', 'Mobil diperkirakan tiba ' + hmStr(ea.min) + ', lewat ' + tH.close + ': lembur ' + eo.hours + ' jam (' + rpS(eo.cost) + ')', { eta_at: etaAt, ot_hours: eo.hours, ot_cost: eo.cost });
            if (eo.hours > 0) tnote = 'Tiba ±' + hmStr(ea.min) + ': lembur ' + eo.hours + ' jam diterima';
            else if (inBreak(ea.min, tH)) warn = 'BREAK';
          }
        }
        var trow = Object.assign({}, ot, { trip: JSON.stringify(trip), eta_at: etaAt });
        if (ot.status === 'dispatch' && trip.driver) trow = step(trow, 'driver', [trip.driver, trip.plate, tnote].filter(Boolean).join(' · '));
        var tr = put('orders', trow);
        return done({ order: orderOut(tr), warn: warn });
      }
      case 'trip_cancel': {
        // v59: the car was cancelled (driver / Lalamove): back to "book a car", the cancellation stays in the history
        var tc = order(data.order_no); if (!tc) return fail('NOT_FOUND', 'Order tidak ada');
        if (tc.status !== 'driver') return fail('INVALID', 'Belum ada mobil untuk order ini');
        var tcr = clean(data.reason, 120); if (tcr.length < 3) return fail('INVALID', 'Alasan wajib');
        var old = json(tc.trip, {}) || {}, tcn = wibAt(now), tcH = hoursOf(wh(tc.warehouse) || {});
        var tcrow = step(Object.assign({}, tc, { trip: '', eta_at: '', trip_cancels: num(tc.trip_cancels) + 1 }), 'dispatch', 'Mobil batal: ' + [old.driver, old.plate].filter(Boolean).join(' · ') + ' — ' + tcr);
        return done({ order: orderOut(put('orders', tcrow)), risk: str(tc.order_date) <= today && tcn.min >= hm(tcH.last) - 30 });
      }
      case 'order_arrived': {
        // v59: the car entered and registered at the cooler (the time, the door); after closing every started hour is overtime, with its cause
        var oa = order(data.order_no); if (!oa) return fail('NOT_FOUND', 'Order tidak ada');
        var door = clean(data.door, 10).toUpperCase();
        if (oa.status === 'arrived') { // only the door can still change
          if (!door) return fail('INVALID', 'Isi nomor pintu');
          return done({ order: orderOut(put('orders', Object.assign({}, oa, { door: door }))) });
        }
        if (oa.status !== 'driver') return fail('INVALID', oa.status === 'dispatch' ? 'Isi data mobil dulu (Pesan truk)' : 'Order sudah ' + oa.status);
        var an = wibAt(now), aAt = now;
        if (str(data.time)) {
          if (!hmOk(data.time)) return fail('INVALID', 'Jam tidak valid (JJ:MM)');
          if (hm(data.time) > an.min) return fail('INVALID', 'Jam masuk belum terjadi');
          aAt = new Date(Date.parse(an.date + 'T' + data.time + ':00+07:00')).toISOString();
        }
        var aH = hoursOf(wh(oa.warehouse) || {}), ov = overtimeAt(aAt, aH), cause = str(data.cause);
        if (ov.hours > 0 && OT_CAUSES.indexOf(cause) < 0) return fail('CAUSE', 'Mobil masuk lewat ' + aH.close + ': lembur ' + ov.hours + ' jam (' + rpS(ov.cost) + '). Pilih sebabnya.', { ot_hours: ov.hours, ot_cost: ov.cost });
        var arow = Object.assign({}, oa, { arrived_at: aAt, door: door, ot_hours: ov.hours, ot_cost: ov.cost, ot_cause: ov.hours ? cause : '', ot_note: ov.hours ? clean(data.note, 120) : '' });
        return done({ order: orderOut(put('orders', step(arow, 'arrived', ['Masuk ' + hmStr(wibAt(aAt).min), door ? 'Pintu ' + door : '', ov.hours ? 'Lembur ' + ov.hours + ' jam (' + rpS(ov.cost) + ')' : ''].filter(Boolean).join(' · ')))) });
      }
      case 'order_read': { // v60 stage 1b: a draft order from a photo / a message — read only, nothing is saved
        // The Worker passes has_image / ai_on and, after its AI call, _ai = { text, model } or { error }; it never forwards a
        // client's own _ai. First call with the AI on → { need_ai, prompt } (never sent to the app: the Worker reads it).
        var rtxt = String(data.text === undefined || data.text === null ? '' : data.text).slice(0, 4000).trim(), rimg = bool(data.has_image), rh = str(data.warehouse);
        var rai = data._ai && typeof data._ai === 'object' ? data._ai : null;
        if (!rtxt && !rimg) return fail('INVALID', 'Kirim foto pesanan atau tempel pesannya');
        if (rai && str(rai.text)) {
          var rj = readJson(rai.text);
          if (rj) return done({ draft: draftOf(st, rj, rh, today), read_by: clean(rai.model, 40) || 'ai' });
          if (rimg) return fail('AI_UNREAD', 'Foto tidak terbaca. Ambil foto lebih dekat dan terang, atau ketik pesannya.');
        } else if (rai) {
          if (rimg) return fail('AI_ERROR', 'Pembaca foto (AI) gagal: ' + clean(rai.error, 60) + '. Coba lagi, atau ketik pesannya.');
        } else if (bool(data.ai_on)) return done({ need_ai: true, prompt: readPrompt(st, today) });
        else if (rimg) return fail('AI_OFF', 'Pembaca foto (AI) belum aktif: pemilik perlu memasang kunci AI. Untuk sekarang tempel atau ketik pesannya.');
        var rr = readRules(st, rtxt, today), rd = draftOf(st, rr, rh, today); // no AI (or it failed on a text): the fixed rules
        rd.unmatched = rd.unmatched.concat(rr.unread.map(function (l) { return { line: l, reason: 'unread' }; }));
        return done({ draft: rd, read_by: 'rules', ai: rai ? 'error' : 'off' });
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
  return { core: core, stockRows: stockRows, fefo: fefo, storage: storage, compare: compare, FLOW: FLOW, CFLOW: CFLOW, HOLD: HOLD, vehicleFor: vehicleFor, zoneOf: zoneOf, ZONES: ZONES, MODES: MODES, VEHICLES: VEHICLES, EXPIRY_DAYS: EXPIRY_DAYS,
    HOURS: HOURS, ETA_MARGIN: ETA_MARGIN, OT_CAUSES: OT_CAUSES, hoursOf: hoursOf, hm: hm, hmStr: hmStr, wibAt: wibAt, dayKind: dayKind, nextWorkDay: nextWorkDay, holidayName: holidayName,
    overtimeAt: overtimeAt, inBreak: inBreak, etaOf: etaOf, timeAlerts: timeAlerts, otSummary: otSummary,
    readPrompt: readPrompt, readJson: readJson, readRules: readRules, draftOf: draftOf };
})();
if (typeof window !== 'undefined') window.KCold = KCold;
