/* Khair Order Brad — the cold-store order process as its own app (v60). Owner 2026-10-18: «انطلق بالمرحلة الاولى و الاحسن في
   تطبيق اخر الان منفصل حتى نتأكد منه قبل دمجه مع القديم»: stage 1 of worker/docs/phase2-plan.md, in a separate app until it is
   proven, then merged into the gudang app. No outside account is needed:
   - the order read from a photo of the written sheet or a customer's message (the AI only reads; fixed rules match the
     pallets as written, else FEFO) — a draft the manager checks;
   - the owner's 9 steps (2026-10-17): written → sent to the cold store → it agrees → ready → car booked → car in → door →
     loading → left, each with its one-tap WhatsApp message (the cold store works only by WhatsApp) and its time;
   - the cooler's hours: last order 16:00, overtime Rp 300.000 per started hour when the car is not in by 17:00, break
     12:00–13:00, Sunday only by arrangement at an agreed cost, public holidays closed; Lalamove's minutes + 20 %; loading
     ≈ 30 minutes a pallet (owner: 25–35).
   Its orders live in their own table (brad_orders). It READS the gudang data (coolers, products, pallets, stock, the gudang
   app's open orders, the customer list) and writes to it one thing only: when the car leaves, the goods go out of the
   stock (OUT movements in the same append-only ledger, order number BRD-…), so nobody types them twice.
   Pure functions: one source for the Worker (process-brad.js) and the page's demo. Loaded after cold-parsers.js and
   cold-core.js (it uses KCold.stockRows / KCold.HOLD and KColdParsers). */
var KBrad = (function () {
  'use strict';
  var K = typeof KCold !== 'undefined' ? KCold : (typeof window !== 'undefined' ? window.KCold : null);
  var P = typeof KColdParsers !== 'undefined' ? KColdParsers : (typeof window !== 'undefined' ? window.KColdParsers : null);
  var ROLES = ['owner', 'manager', 'akuntan'], READ = { login: 1, bootstrap: 1 }, OWNER_ONLY = { cooler_save: 1, settings_save: 1 };
  var STEPS = ['new', 'sent', 'approved', 'ready', 'car', 'arrived', 'door', 'loading', 'departed'];
  var LIVE = STEPS.slice(0, 8); // these hold their pallets; at 'departed' the goods leave the stock
  var NEXT = { new: ['sent'], sent: ['approved', 'rejected'], approved: ['ready'], departed: ['delivered'] };

  function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clean(v, max) { return str(v).replace(/[\u0000-\u001f\u007f<>‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80); }
  function code(v) { var s = str(v).toUpperCase().replace(/\s+/g, '-'); return /^[A-Z0-9][A-Z0-9._\-]{0,29}$/.test(s) ? s : ''; }
  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function wib(iso) { return new Date(Date.parse(iso) + 7 * 3600000).toISOString(); }
  function addDays(d, n) { var x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function int(v) { var n = Number(v); return isFinite(n) && Math.floor(n) === n ? n : NaN; }
  function bool(v) { return v === true || v === 'true' || v === 1; }
  function json(v, d) { if (v && typeof v === 'object') return v; try { var x = JSON.parse(v); return x === null || x === undefined ? d : x; } catch (e) { return d; } }
  function norm(s) { return str(s).toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ''); }
  function normPhone(v) { var d = str(v).replace(/\D/g, ''); if (d.indexOf('0') === 0) d = '62' + d.slice(1); else if (d.indexOf('8') === 0) d = '62' + d; return d.length >= 9 && d.length <= 15 ? d : ''; }
  function pad3(n) { return ('00' + n).slice(-3); }
  function active(r) { return r.active !== false && r.active !== 'false'; }
  function stockRows(st, asOf, wh) { return K.stockRows(st, asOf, wh); }

  /* ---------- the cooler's hours ----------
     Owner 2026-10-18: «البراد يعمل من الساعة 9 الصبح الى الساعة 17 … الوقت الإضافة بعد الساعة 17 ب300 الف روبية لكل ساعة … راحة من الساعة 12
     الى 13 … اذا لم تدخل السيارة و تسجل قبل الساعة 17 ينطلق احتساب وقت إضافي … اخر طلبية في الوقت العادي الساعة 16»; a started hour counts in
     full; Sunday only by arrangement, at a cost agreed each time; closed on public holidays; Lalamove's time + 15–20 %. Each cooler may
     keep its own hours (Pengaturan); these are the owner's defaults, field by field. */
  var HOURS = { open: '09:00', close: '17:00', brk: '12:00-13:00', last: '16:00', days: [1, 2, 3, 4, 5, 6], arrange: [0], ot: 300000 };
  var ETA_MARGIN = 20; // % added to the minutes Lalamove shows
  var LOAD_MIN = 30; // minutes to load one pallet (owner 2026-10-18: 25–35)
  var OT_CAUSES = ['order_late', 'store_late', 'car_late', 'car_cancel', 'other'];
  function hmOk(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(str(s)); }
  function hm(s) { var p = str(s).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
  function rpS(n) { return 'Rp ' + String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function hmStr(m) { m = Math.max(0, Math.round(m)); return ('0' + Math.floor(m / 60) % 24).slice(-2) + ':' + ('0' + m % 60).slice(-2); }
  function dayList(v, d) {
    if (!Array.isArray(v)) return d.slice();
    return v.map(Number).filter(function (n, i, a) { return n >= 0 && n <= 6 && Math.floor(n) === n && a.indexOf(n) === i; }).sort();
  }
  /** A cooler's hours from its settings ({ hours: {…} }), the owner's defaults for what is not set. */
  function hoursOf(cfg) {
    var x = json(cfg && cfg.hours, {}) || {}, o = {};
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
  /** The ISO time of a WIB date + "HH:MM". */
  function atWib(date, hhmm) { return new Date(Date.parse(date + 'T' + hhmm + ':00+07:00')).toISOString(); }
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
  /** The settings this app keeps (pos_settings, keys brad_*): per cooler { wa, hours }, holidays, ETA margin, minutes a pallet. */
  function settingsOf(s) {
    s = s || {};
    var c = json(s.brad_coolers, {}), h = json(s.brad_holidays, []), m = s.brad_eta_margin, l = s.brad_load_min;
    return { coolers: c && typeof c === 'object' && !Array.isArray(c) ? c : {}, holidays: Array.isArray(h) ? h : [],
      margin: m !== undefined && m !== null && m !== '' && isFinite(Number(m)) ? Number(m) : ETA_MARGIN,
      load_min: l !== undefined && l !== null && l !== '' && Number(l) > 0 ? Number(l) : LOAD_MIN };
  }
  /** Today's pickups at risk of overtime (computed on the device too): no car yet from 30 min before the last order time,
      a car not in from 30 min before closing (or past its expected time), still not in after closing. */
  function timeAlerts(orders, coolers, nowIso, holidays) {
    var n = wibAt(nowIso), out = [];
    (orders || []).forEach(function (o) {
      if (!str(o.order_date) || str(o.order_date) > n.date || ['new', 'sent', 'approved', 'ready', 'car'].indexOf(o.status) < 0) return;
      var H = hoursOf((coolers || {})[o.warehouse]), k = dayKind(n.date, H, holidays), kind = '';
      if (k === 'holiday' || k === 'closed') return;
      if (n.min >= hm(H.close)) kind = 'overtime';
      else if (o.status === 'car') { if (n.min >= hm(H.close) - 30 || (str(o.eta_at) && Date.parse(o.eta_at) < Date.parse(nowIso))) kind = 'car_late'; }
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
  /** Pallets held by running orders: the gudang app's (its HOLD states) and this app's (LIVE) — except one order. */
  function reserved(st, exceptNo) {
    var m = {}, add = function (o) { json(o.lines, []).forEach(function (l) { var k = l.pallet_code + '|' + o.warehouse; m[k] = (m[k] || 0) + num(l.cartons); }); };
    (st.cold_orders || []).forEach(function (o) { if (K.HOLD.indexOf(o.status) >= 0) add(o); });
    (st.orders || []).forEach(function (o) { if (LIVE.indexOf(o.status) >= 0 && o.order_no !== exceptNo) add(o); });
    return m;
  }
  function balanceOf(st, pc, wh) { return st.movements.reduce(function (s, x) { return x.pallet_code === pc && x.warehouse === wh ? s + num(x.cartons) : s; }, 0); }

  /* ---------- the order read from a photo of the written sheet or a customer's message ----------
     Owner 2026-10-17: the order is a sheet with the quantity, the product, the pallet number and the product code, sent by
     WhatsApp. The AI (or, without an AI key, the rules below) only READS it; these fixed rules turn what was read into a
     draft — the pallet as written, else FEFO — which the manager checks and saves. A line that cannot be matched is listed,
     never dropped. */
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

  /* ---------- the WhatsApp texts (Indonesian: the cold stores, the drivers and the customers are in Jakarta) ---------- */
  var ID_DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  var ID_MON = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  function dLong(d) { if (!isDate(d)) return str(d); var x = new Date(d + 'T00:00:00Z'); return ID_DAY[x.getUTCDay()] + ', ' + x.getUTCDate() + ' ' + ID_MON[x.getUTCMonth()] + ' ' + x.getUTCFullYear(); }
  function n0(v) { return String(Math.round(num(v))).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function phoneLocal(p) { p = str(p); return p.indexOf('62') === 0 ? '0' + p.slice(2) : p; }
  function totals(o) { var L = json(o.lines, []); return { pallets: L.length, cartons: L.reduce(function (s, l) { return s + num(l.cartons); }, 0) }; }
  function car(o) { return json(o.car, null) || {}; }
  /** C = { cooler: { name, address }, products: { code: { name } }, company: { name, store } } */
  function msgOrder(o, C) {
    C = C || {};
    var L = json(o.lines, []), T = totals(o), pr = C.products || {}, w = C.cooler || {}, co = C.company || {};
    var out = ['*ORDER AMBIL — ' + (str(co.store) || 'Khair Mart') + '*', 'No: ' + o.order_no, 'Tanggal ambil: ' + dLong(o.order_date),
      'Gudang: ' + (str(w.name) || o.warehouse), 'Tujuan: ' + str(o.dest_name) + (o.dest_type === 'pelanggan' ? ' (pelanggan)' : ''), ''];
    L.forEach(function (l, i) {
      var p = pr[l.product] || {};
      out.push((i + 1) + '. ' + n0(l.cartons) + ' ctn · ' + (str(p.name) || str(l.product_name) || str(l.product)) + ' · Palet ' + l.pallet_code + (l.full ? ' (utuh)' : '') + ' · Kode ' + str(l.product));
    });
    out.push('Total: ' + n0(T.cartons) + ' ctn · ' + T.pallets + ' palet');
    if (num(o.extra_cost) > 0) out.push('Hari perjanjian: biaya tambahan ' + rpS(o.extra_cost) + (str(o.extra_note) ? ' (' + str(o.extra_note) + ')' : ''));
    if (str(o.note)) out.push('Catatan: ' + str(o.note));
    out.push('', 'Mohon dicek dan dikonfirmasi. Terima kasih.');
    if (str(co.name)) out.push(str(co.name));
    return out.join('\n');
  }
  /** To the cold store: the car that will take the goods (so they are handed to that exact car). */
  function msgCar(o, C) {
    var c = car(o), w = (C && C.cooler) || {};
    return ['Order ' + o.order_no + ' — mobil untuk ambil di ' + (str(w.name) || o.warehouse) + ':', 'Kendaraan: ' + (str(c.vehicle) || '-'), 'No. polisi: ' + str(c.plate),
      'Sopir: ' + str(c.driver) + (str(c.driver_wa) ? ' (' + phoneLocal(c.driver_wa) + ')' : ''), str(o.eta_at) ? 'Perkiraan tiba: ' + hmStr(wibAt(o.eta_at).min) : '', 'Terima kasih.']
      .filter(Boolean).join('\n');
  }
  /** To the driver: the door to drive to. */
  function msgDoor(o, C) {
    var c = car(o), w = (C && C.cooler) || {}, T = totals(o);
    return ['Halo ' + (str(c.driver) || 'Pak/Bu sopir') + ', order ' + o.order_no + ':', 'silakan masuk ke ' + (str(w.name) || o.warehouse) + (str(w.address) ? ' (' + str(w.address) + ')' : '') + ' — *PINTU ' + str(o.door) + '*.',
      'Muat ' + T.pallets + ' palet · ' + n0(T.cartons) + ' ctn untuk ' + str(o.dest_name) + '.', 'Terima kasih.'].join('\n');
  }
  /** To the customer (or the shop): the car has left. */
  function msgDepart(o, C) {
    var c = car(o), w = (C && C.cooler) || {}, co = (C && C.company) || {}, T = totals(o);
    return ['Halo ' + str(o.dest_name) + ', pesanan ' + o.order_no + ' (' + n0(T.cartons) + ' ctn) sudah berangkat dari ' + (str(w.name) || o.warehouse) + (str(o.departed_at) ? ' jam ' + hmStr(wibAt(o.departed_at).min) : '') + '.',
      'Mobil: ' + str(c.plate) + ' · Sopir ' + str(c.driver) + (str(c.driver_wa) ? ' (' + phoneLocal(c.driver_wa) + ')' : ''), 'Terima kasih — ' + (str(co.store) || 'Khair Mart')].join('\n');
  }
  /** The cold store's WhatsApp reply, pasted: what it says, by fixed rules → { kind: 'door' | 'reject' | 'ready' | 'approve' | '', door }.
      "siap" alone is "OK" in Indonesian; "sudah siap" / "siap diambil" is "ready". "Terima kasih" is not an approval. */
  function readReply(text) {
    var s = ' ' + str(text).toLowerCase().replace(/terima\s*kasih|makasih|thanks?|thx/g, ' ') + ' ';
    var dm = s.match(/(?:pintu|pnt|door|dock|gate|loket)\s*(?:no\.?|nomor|nmr|#|:)?\s*([a-z]?\d{1,3}[a-z]?)\b/i);
    if (dm) return { kind: 'door', door: dm[1].toUpperCase() };
    if (/\b(tolak|ditolak|tidak bisa|tdk bisa|gak bisa|ga bisa|gk bisa|nggak bisa|belum bisa|penuh|habis|kosong|cancel|batal|reject)\b/.test(s)) return { kind: 'reject', door: '' };
    if (/\b(sudah siap|udah siap|sdh siap|siap diambil|siap ambil|sudah disiapkan|barang siap|ready)\b/.test(s)) return { kind: 'ready', door: '' };
    if (/\b(ok|oke|okay|okey|siap|setuju|acc|approved?|bisa|noted|baik|diterima|confirm|konfirm)\b/.test(s)) return { kind: 'approve', door: '' };
    return { kind: '', door: '' };
  }

  /* ---------- the request ---------- */
  function core(state, req, nowIso) {
    var st = {};
    ['warehouses', 'products', 'pallets', 'movements', 'cold_orders', 'customers', 'orders', 'users'].forEach(function (k) { st[k] = (state[k] || []).slice(); });
    st.settings = state.settings || {};
    st.movements = st.movements.map(function (m) { return Object.assign({}, m, { seq: num(m.seq), cartons: num(m.cartons) }); }).sort(function (a, b) { return a.seq - b.seq; });
    var writes = [], now = str(nowIso), today = wib(now).slice(0, 10), yymmdd = today.slice(2).replace(/-/g, '');
    var action = str(req && req.action), data = (req && req.data && typeof req.data === 'object') ? req.data : {};
    function fail(c, msg, extra) { var r = { ok: false, error: c, message: msg || c }; Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; }); return { response: r, writes: [] }; }
    function done(resp) { resp.ok = true; return { response: resp, writes: writes }; }
    function put(table, row) { writes.push({ table: table, row: row }); var list = st[table]; if (!Array.isArray(list)) return row; if (row.id !== undefined) { var i = list.findIndex(function (x) { return x.id === row.id; }); if (i >= 0) list[i] = row; } else list.push(row); return row; }

    /* who is asking (same rules as the POS and the gudang app) */
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
    var S = settingsOf(st.settings);

    function wh(c) { return st.warehouses.find(function (w) { return w.code === code(c) && active(w); }); }
    function H(c) { return hoursOf(S.coolers[c]); }
    function order(no) { return st.orders.find(function (o) { return o.order_no === str(no).toUpperCase(); }); }
    function nextSeq() { return st.movements.reduce(function (m, x) { return Math.max(m, x.seq); }, 0) + 1; }
    function move(o) {
      var row = { seq: nextSeq(), move_date: o.move_date || today, at: now, type: o.type, pallet_code: o.pallet_code, warehouse: o.warehouse, cartons: o.cartons,
        ref_seq: 0, grp: o.grp || 0, order_no: o.order_no || '', reason: o.reason || '', by_user: by };
      if (!row.grp) row.grp = row.seq;
      put('movements', row); return row;
    }
    function coolerOut(w) {
      var cfg = S.coolers[w.code] || {};
      return { code: w.code, name: str(w.name), address: str(w.address), pic_name: str(w.pic_name), wa: normPhone(cfg.wa) || str(w.pic_wa), wa_own: !!normPhone(cfg.wa),
        hours: hoursOf(cfg), hours_set: !!(cfg.hours && typeof cfg.hours === 'object') };
    }
    var BAL = null;
    function bal(pc, w) { if (!BAL) { BAL = {}; st.movements.forEach(function (x) { var k = x.pallet_code + '|' + x.warehouse; BAL[k] = (BAL[k] || 0) + x.cartons; }); } return BAL[pc + '|' + w] || 0; }
    function orderOut(o) {
      var x = Object.assign({}, o), live = LIVE.indexOf(o.status) >= 0;
      x.lines = json(o.lines, []).map(function (l) { var y = Object.assign({}, l); if (live) { var b = bal(l.pallet_code, o.warehouse); y.pallet_ctn = b; y.full = b > 0 && num(l.cartons) >= b; } return y; });
      x.car = json(o.car, null); x.log = json(o.log, []); x.step = STEPS.indexOf(o.status) + 1;
      var T = totals(o); x.pallets = T.pallets; x.cartons = T.cartons;
      ['extra_cost', 'ot_hours', 'ot_cost', 'car_cancels', 'customer_id'].forEach(function (k) { x[k] = num(o[k]); });
      return x;
    }
    /** The row with a new status and one more log line {at, by, from, to, note}. */
    function step(row, to, note) { var l = json(row.log, []); l.push({ at: now, by: by, from: str(row.status), to: to, note: note || '' }); return Object.assign({}, row, { status: to, log: JSON.stringify(l.slice(-60)) }); }
    function lineList(raw, w, exceptNo) {
      if (!Array.isArray(raw) || !raw.length || raw.length > 60) return { err: 'Isi 1–60 baris palet' };
      var R = reserved(st, exceptNo), seen = {}, out = [];
      for (var i = 0; i < raw.length; i++) {
        var pc = code(raw[i] && raw[i].pallet_code), c = int(raw[i] && raw[i].cartons);
        if (!pc || seen[pc]) return { err: 'Palet tidak valid atau dobel: ' + str(raw[i] && raw[i].pallet_code) };
        if (!(c > 0)) return { err: 'Jumlah karton harus angka bulat > 0 (' + pc + ')' };
        var p = st.pallets.find(function (x) { return x.pallet_code === pc; }); if (!p) return { err: 'Palet tidak ada: ' + pc, code: 'NOT_FOUND' };
        var free = bal(pc, w) - (R[pc + '|' + w] || 0);
        if (c > free) return { err: 'Stok palet ' + pc + ' tidak cukup: tersedia ' + Math.max(0, free) + ' ctn', code: 'NOT_ENOUGH' };
        var pr = st.products.find(function (x) { return x.code === p.product; }) || {};
        seen[pc] = true; out.push({ pallet_code: pc, cartons: c, product: str(p.product), product_name: str(pr.name), exp_date: str(p.exp_date), lot: str(p.lot), container_no: str(p.container_no) });
      }
      return { lines: out };
    }
    function closedMsg(w, d, k, Hx) { return 'Gudang ' + w.name + ' tutup tanggal ' + d + (k === 'holiday' ? ' (' + holidayName(d, S.holidays) + ')' : '') + '. Hari kerja berikutnya: ' + nextWorkDay(d, Hx, S.holidays); }

    switch (action) {
      case 'login':
        return done({ me: { name: by, role: role, via_master: viaMaster && me.pin_hash !== ph }, today: today });
      case 'bootstrap': {
        var s = st.settings, R0 = reserved(st, ''), names = {};
        var custs = st.customers.filter(function (c) { return str(c.name); }).map(function (c) { names[norm(c.name)] = 1; return { id: c.id, name: str(c.name), phone: str(c.phone), address: str(c.address) }; });
        st.orders.slice().reverse().forEach(function (o) { // customers typed on this app's orders (the shared list is not written while on trial)
          if (o.dest_type !== 'pelanggan' || !str(o.dest_name) || names[norm(o.dest_name)]) return;
          names[norm(o.dest_name)] = 1; custs.push({ id: 0, name: str(o.dest_name), phone: str(o.dest_phone), address: str(o.dest_address) });
        });
        return done({
          me: { name: by, role: role }, today: today, holidays: S.holidays, eta_margin: S.margin, load_min: S.load_min, ot_causes: OT_CAUSES,
          company: { name: str(s.cold_company) || 'PT. SAIDA REZEKI ABADI', store: str(s.store_name) || 'Khair Mart', address: str(s.address), phone: str(s.phone) },
          coolers: st.warehouses.filter(active).map(coolerOut),
          products: st.products.filter(active).map(function (p) { return { code: p.code, name: str(p.name), kg_per_ctn: num(p.kg_per_ctn), ctn_per_pallet: num(p.ctn_per_pallet), aliases: str(p.aliases) }; }),
          stock: stockRows(st, '', '').filter(function (r) { return r.cartons > 0; }).map(function (r) { return Object.assign({}, r, { free: r.cartons - (R0[r.pallet_code + '|' + r.warehouse] || 0) }); }),
          customers: custs, drivers: json(s.cold_drivers, []),
          orders: st.orders.slice(-300).reverse().map(orderOut), overtime: otSummary(st.orders, today.slice(0, 7))
        });
      }
      case 'order_read': { // a draft from a photo / a message — read only, nothing is saved
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
      case 'order_save': {
        var ow = wh(data.warehouse); if (!ow) return fail('NOT_FOUND', 'Gudang tidak ada');
        var oe = data.order_no ? order(data.order_no) : null;
        if (data.order_no && !oe) return fail('NOT_FOUND', 'Order tidak ada');
        if (oe && oe.status !== 'new' && oe.status !== 'rejected') return fail('INVALID', 'Order sudah dikirim ke gudang: tidak bisa diubah');
        if (oe && oe.warehouse !== ow.code) return fail('INVALID', 'Gudang order tidak bisa diganti; batalkan dan buat baru');
        var od = data.order_date || today; if (!isDate(od) || od < today) return fail('INVALID', 'Tanggal ambil tidak valid');
        var oH = H(ow.code), oK = dayKind(od, oH, S.holidays);
        if (oK === 'holiday' || oK === 'closed') return fail('CLOSED', closedMsg(ow, od, oK, oH), { next: nextWorkDay(od, oH, S.holidays), kind: oK });
        var dt = data.dest_type === 'pelanggan' ? 'pelanggan' : 'toko', dn = clean(data.dest_name, 60);
        if (dt === 'pelanggan' && !dn) return fail('INVALID', 'Nama pelanggan wajib');
        var dph = str(data.dest_phone) ? normPhone(data.dest_phone) : '';
        if (str(data.dest_phone) && !dph) return fail('INVALID', 'Nomor telepon tidak valid');
        var cid = int(data.customer_id), oc = dt === 'pelanggan' && cid > 0 ? st.customers.find(function (c) { return c.id === cid && norm(c.name) === norm(dn); }) : null;
        var ll = lineList(data.lines, ow.code, oe ? oe.order_no : '');
        if (ll.err) return fail(ll.code || 'INVALID', ll.err);
        var src = ['photo', 'message', 'manual'].indexOf(str(data.source)) >= 0 ? str(data.source) : 'manual';
        var nth = st.orders.filter(function (o) { return str(o.order_no).indexOf('BRD-' + yymmdd) === 0; }).length + 1;
        var orow = Object.assign({}, oe || { order_no: 'BRD-' + yymmdd + '-' + pad3(nth), status: 'new', created_at: now, created_by: by, source: src, read_by: clean(data.read_by, 40) }, {
          order_date: od, warehouse: ow.code, dest_type: dt, dest_name: dt === 'toko' ? (dn || str(st.settings.store_name) || 'Khair Mart') : dn, dest_phone: dph,
          dest_address: clean(data.dest_address, 200), customer_id: oc ? oc.id : 0, note: clean(data.note, 200), lines: JSON.stringify(ll.lines) });
        if (!oe) orow = step(orow, 'new', src === 'manual' ? '' : 'Dibaca dari ' + (src === 'photo' ? 'foto' : 'pesan') + (str(orow.read_by) ? ' (' + orow.read_by + ')' : ''));
        else if (oe.status === 'rejected') orow = step(orow, 'new', 'Diubah setelah ditolak');
        put('orders', orow);
        return done({ order: orderOut(orow) });
      }
      case 'order_status': {
        var o = order(data.order_no); if (!o) return fail('NOT_FOUND', 'Order tidak ada');
        var to = str(data.to), note = clean(data.note, 120), row = Object.assign({}, o);
        if (to === 'cancelled') {
          if (LIVE.indexOf(o.status) < 0 && o.status !== 'rejected') return fail('INVALID', 'Order sudah ' + o.status);
          if (note.length < 3) return fail('INVALID', 'Alasan wajib');
          return done({ order: orderOut(put('orders', step(Object.assign(row, { cancelled_at: now, cancel_reason: note }), 'cancelled', note))) });
        }
        if ((NEXT[o.status] || []).indexOf(to) < 0) return fail('INVALID', 'Langkah tidak valid: ' + o.status + ' → ' + to);
        if (to === 'sent') {
          var sw = wh(o.warehouse) || { name: o.warehouse, code: o.warehouse }, sH = H(o.warehouse), sd = str(o.order_date) < today ? today : str(o.order_date), sk = dayKind(sd, sH, S.holidays);
          if (sk === 'holiday' || sk === 'closed') return fail('CLOSED', closedMsg(sw, sd, sk, sH), { next: nextWorkDay(sd, sH, S.holidays), kind: sk });
          if (sd === today && wibAt(now).min >= hm(sH.last)) { // after the last order time: tomorrow, or today with the overtime risk accepted
            var nx = nextWorkDay(today, sH, S.holidays);
            if (data.when === 'later') { sd = nx; sk = 'work'; note = 'Lewat ' + sH.last + ': diambil ' + sd; }
            else if (data.when === 'overtime') note = 'Hari ini, risiko lembur disetujui';
            else return fail('AFTER_HOURS', 'Lewat jam order terakhir (' + sH.last + '). Diambil hari ini: mobil harus masuk sebelum ' + sH.close + ', setelah itu lembur ' + rpS(sH.ot) + ' per jam.', { last: sH.last, close: sH.close, ot: sH.ot, next: nx });
          }
          if (sk === 'arrange') { // a day the cooler opens only by arrangement: the agreed extra cost goes with the order
            var ec = num(data.extra_cost);
            if (!(ec > 0)) return fail('ARRANGE', 'Tanggal ' + sd + ' gudang ' + sw.name + ' buka hanya dengan perjanjian: isi biaya tambahan yang disepakati.', { date: sd, next: nextWorkDay(sd, sH, S.holidays) });
            row.extra_cost = Math.round(ec); row.extra_note = clean(data.extra_note, 120); note = (note ? note + ' · ' : '') + 'Biaya perjanjian ' + rpS(ec);
          }
          row.order_date = sd; row.sent_at = now;
        }
        if (to === 'approved') row.approved_at = now;
        if (to === 'rejected') { if (note.length < 3) return fail('INVALID', 'Alasan penolakan wajib'); row.rejected_reason = note; }
        if (to === 'ready') row.ready_at = now;
        if (to === 'delivered') row.delivered_at = now;
        return done({ order: orderOut(put('orders', step(row, to, note))) });
      }
      case 'car_save': { // step 5: the car booked (Lalamove or own driver) — its plate and driver go to the cold store
        var co = order(data.order_no); if (!co) return fail('NOT_FOUND', 'Order tidak ada');
        if (co.status !== 'ready' && co.status !== 'car') return fail('INVALID', 'Pesan mobil setelah barang siap');
        var drv = clean(data.driver, 40), plate = clean(data.plate, 12).toUpperCase(), dwa = str(data.driver_wa) ? normPhone(data.driver_wa) : '';
        if (!drv || !plate) return fail('INVALID', 'Nama sopir dan nomor polisi wajib');
        if (str(data.driver_wa) && !dwa) return fail('INVALID', 'Nomor WhatsApp sopir tidak valid');
        var em = data.eta_min === undefined || data.eta_min === null || data.eta_min === '' ? null : int(data.eta_min);
        if (em !== null && !(em >= 0 && em <= 600)) return fail('INVALID', 'Menit Lalamove 0–600');
        var cH = H(co.warehouse), eta = em !== null && str(co.order_date) <= today ? etaOf(now, em, S.margin) : '', warn = '';
        if (eta) {
          var cov = overtimeAt(eta, cH);
          if (cov.hours > 0 && !bool(data.accept_ot)) return fail('LATE_CAR', 'Mobil diperkirakan tiba ' + hmStr(wibAt(eta).min) + ', lewat ' + cH.close + ': lembur ' + cov.hours + ' jam (' + rpS(cov.cost) + ').', { eta_at: eta, ot_hours: cov.hours, ot_cost: cov.cost });
          if (inBreak(wibAt(eta).min, cH)) warn = 'BREAK';
        }
        var trip = { via: data.via === 'sopir' ? 'sopir' : 'lalamove', vehicle: clean(data.vehicle, 40), driver: drv, driver_wa: dwa, plate: plate, cost: Math.max(0, Math.round(num(data.cost))), eta_min: em, booked_at: now };
        var crow = Object.assign({}, co, { car: JSON.stringify(trip), eta_at: eta });
        crow = step(crow, 'car', (co.status === 'car' ? 'Mobil diubah: ' : '') + plate + ' · ' + drv + (eta ? ' · tiba ± ' + hmStr(wibAt(eta).min) : '') + (bool(data.accept_ot) && eta && overtimeAt(eta, cH).hours ? ' · risiko lembur disetujui' : ''));
        return done({ order: orderOut(put('orders', crow)), warn: warn });
      }
      case 'car_cancel': { // the car was cancelled: back to "book a car", counted; after the last order time that risks overtime
        var xo = order(data.order_no); if (!xo) return fail('NOT_FOUND', 'Order tidak ada');
        if (xo.status !== 'car') return fail('INVALID', 'Belum ada mobil');
        var xr = clean(data.reason, 120); if (xr.length < 3) return fail('INVALID', 'Alasan wajib');
        var xc = car(xo), xrow = Object.assign({}, xo, { car: '', eta_at: '', car_cancels: num(xo.car_cancels) + 1 });
        var risk = str(xo.order_date) <= today && wibAt(now).min >= hm(H(xo.warehouse).last);
        return done({ order: orderOut(put('orders', step(xrow, 'ready', 'Mobil batal: ' + str(xc.driver) + ' · ' + str(xc.plate) + ' — ' + xr))), risk: risk });
      }
      case 'order_arrived': { // step 6: the car is in (registered) — after closing every started hour is overtime, with its cause
        var ao = order(data.order_no); if (!ao) return fail('NOT_FOUND', 'Order tidak ada');
        if (ao.status !== 'car' && ao.status !== 'arrived') return fail('INVALID', 'Belum ada mobil');
        var tm = str(data.time) || hmStr(wibAt(now).min); if (!hmOk(tm)) return fail('INVALID', 'Jam masuk tidak valid (JJ:MM)');
        var aAt = atWib(today, tm); if (Date.parse(aAt) > nowMs + 60000) return fail('INVALID', 'Jam masuk belum lewat');
        var aH = H(ao.warehouse), ov = overtimeAt(aAt, aH), cause = str(data.cause), door = clean(data.door, 6).toUpperCase();
        if (ov.hours > 0 && OT_CAUSES.indexOf(cause) < 0) return fail('CAUSE', 'Mobil masuk lewat ' + aH.close + ': lembur ' + ov.hours + ' jam (' + rpS(ov.cost) + '). Pilih sebabnya.', { ot_hours: ov.hours, ot_cost: ov.cost });
        var arow = Object.assign({}, ao, { arrived_at: aAt, ot_hours: ov.hours, ot_cost: ov.cost, ot_cause: ov.hours ? cause : '', ot_note: ov.hours ? clean(data.note, 120) : '' });
        if (door) arow.door = door;
        var anote = ['Masuk ' + tm, door ? 'Pintu ' + door : '', ov.hours ? 'Lembur ' + ov.hours + ' jam (' + rpS(ov.cost) + ')' : ''].filter(Boolean).join(' · ');
        return done({ order: orderOut(put('orders', step(arow, door ? 'door' : 'arrived', anote))) });
      }
      case 'door_save': { // step 7: the door the car drives to (the cold store says it; the driver gets it by WhatsApp)
        var dor = order(data.order_no); if (!dor) return fail('NOT_FOUND', 'Order tidak ada');
        if (['arrived', 'door', 'loading'].indexOf(dor.status) < 0) return fail('INVALID', 'Mobil belum masuk');
        var dno = clean(data.door, 6).toUpperCase(); if (!/^[A-Z0-9-]{1,6}$/.test(dno)) return fail('INVALID', 'Nomor pintu tidak valid');
        var drow = Object.assign({}, dor, { door: dno });
        return done({ order: orderOut(put('orders', dor.status === 'arrived' ? step(drow, 'door', 'Pintu ' + dno) : step(drow, dor.status, 'Pintu diubah: ' + dno))) });
      }
      case 'load_start': { // step 8: loading — about LOAD_MIN minutes a pallet
        var lo = order(data.order_no); if (!lo) return fail('NOT_FOUND', 'Order tidak ada');
        if (lo.status !== 'door' && lo.status !== 'arrived') return fail('INVALID', 'Isi nomor pintu dulu');
        var lend = new Date(nowMs + totals(lo).pallets * S.load_min * 60000).toISOString();
        return done({ order: orderOut(put('orders', step(Object.assign({}, lo, { load_at: now, load_end_est: lend }), 'loading', 'Selesai ± ' + hmStr(wibAt(lend).min)))) });
      }
      case 'depart': { // step 9: the car has left — the goods go out of the stock (the gudang ledger), the customer is told
        var dp = order(data.order_no); if (!dp) return fail('NOT_FOUND', 'Order tidak ada');
        if (['arrived', 'door', 'loading'].indexOf(dp.status) < 0) return fail('INVALID', 'Mobil belum masuk');
        var og = nextSeq(), short = [];
        var dl = json(dp.lines, []).map(function (l) {
          var b = bal(l.pallet_code, dp.warehouse), take = Math.max(0, Math.min(b, num(l.cartons)));
          if (take < num(l.cartons)) short.push(l.pallet_code + ' (stok ' + b + ', order ' + num(l.cartons) + ')');
          if (take > 0) move({ type: 'OUT', pallet_code: l.pallet_code, warehouse: dp.warehouse, cartons: -take, grp: og, order_no: dp.order_no, reason: 'Ambil ke ' + str(dp.dest_name) + ' (Order Brad)' });
          return Object.assign({}, l, { out: take, pallet_ctn: b, full: b > 0 && take >= b });
        });
        var prow = Object.assign({}, dp, { departed_at: now, lines: JSON.stringify(dl), stock_note: short.join(', ') });
        return done({ order: orderOut(put('orders', step(prow, 'departed', short.length ? 'Stok kurang: ' + short.join(', ') : ''))), short: short });
      }
      case 'cooler_save': { // owner: a cooler's WhatsApp for orders and its hours (empty hours = the owner's defaults)
        var cw = wh(data.code); if (!cw) return fail('NOT_FOUND', 'Gudang tidak ada');
        var waRaw = str(data.wa), wa = waRaw ? normPhone(waRaw) : '';
        if (waRaw && !wa) return fail('INVALID', 'Nomor WhatsApp tidak valid');
        var cfg = { wa: wa }, hx = data.hours && typeof data.hours === 'object' ? data.hours : null;
        if (hx) {
          var hb = str(hx.brk), hbp = hb.split('-');
          if (!hmOk(hx.open) || !hmOk(hx.close) || !hmOk(hx.last) || !(hm(hx.open) < hm(hx.last) && hm(hx.last) <= hm(hx.close))) return fail('INVALID', 'Jam kerja: buka < order terakhir ≤ tutup (JJ:MM)');
          if (hb && !(hbp.length === 2 && hmOk(hbp[0]) && hmOk(hbp[1]) && hm(hx.open) <= hm(hbp[0]) && hm(hbp[0]) < hm(hbp[1]) && hm(hbp[1]) <= hm(hx.close))) return fail('INVALID', 'Jam istirahat tidak valid (contoh 12:00-13:00)');
          var hdays = dayList(hx.days, []), harr = dayList(hx.arrange, []).filter(function (d) { return hdays.indexOf(d) < 0; }), hot = num(hx.ot);
          if (!hdays.length) return fail('INVALID', 'Pilih minimal satu hari kerja');
          if (hot < 0 || hot > 100000000) return fail('INVALID', 'Tarif lembur tidak valid');
          cfg.hours = { open: hx.open, close: hx.close, brk: hb, last: hx.last, days: hdays, arrange: harr, ot: Math.round(hot) };
        }
        var all = Object.assign({}, S.coolers); all[cw.code] = cfg;
        put('settings', { skey: 'brad_coolers', svalue: JSON.stringify(all) });
        S.coolers = all;
        return done({ cooler: coolerOut(cw) });
      }
      case 'settings_save': {
        if (data.holidays !== undefined) { // public holidays (the coolers are closed)
          if (!Array.isArray(data.holidays) || data.holidays.length > 60) return fail('INVALID', 'Maksimal 60 hari libur');
          var hl = [];
          for (var hi = 0; hi < data.holidays.length; hi++) {
            var hd = data.holidays[hi] || {};
            if (!isDate(hd.date)) return fail('INVALID', 'Tanggal libur tidak valid: ' + str(hd.date));
            if (!hl.some(function (x) { return x.date === hd.date; })) hl.push({ date: hd.date, name: clean(hd.name, 40) });
          }
          hl.sort(function (a, b) { return a.date.localeCompare(b.date); });
          put('settings', { skey: 'brad_holidays', svalue: JSON.stringify(hl) });
        }
        if (data.eta_margin !== undefined) { var mg = num(data.eta_margin); if (!(mg >= 0 && mg <= 100)) return fail('INVALID', 'Tambahan waktu 0–100 %'); put('settings', { skey: 'brad_eta_margin', svalue: JSON.stringify(Math.round(mg)) }); }
        if (data.load_min !== undefined) { var lm = num(data.load_min); if (!(lm >= 5 && lm <= 120)) return fail('INVALID', 'Menit muat per palet 5–120'); put('settings', { skey: 'brad_load_min', svalue: JSON.stringify(Math.round(lm)) }); }
        return done({});
      }
      default:
        return fail('INVALID', 'Aksi tidak dikenal: ' + action);
    }
  }
  return { core: core, STEPS: STEPS, LIVE: LIVE, HOURS: HOURS, ETA_MARGIN: ETA_MARGIN, LOAD_MIN: LOAD_MIN, OT_CAUSES: OT_CAUSES,
    hoursOf: hoursOf, hm: hm, hmStr: hmStr, rpS: rpS, wibAt: wibAt, atWib: atWib, dayKind: dayKind, nextWorkDay: nextWorkDay, holidayName: holidayName,
    overtimeAt: overtimeAt, inBreak: inBreak, etaOf: etaOf, timeAlerts: timeAlerts, otSummary: otSummary, readReply: readReply, readJson: readJson,
    readRules: readRules, draftOf: draftOf, readPrompt: readPrompt, msgOrder: msgOrder, msgCar: msgCar, msgDoor: msgDoor, msgDepart: msgDepart, dLong: dLong };
})();
if (typeof window !== 'undefined') window.KBrad = KBrad;
