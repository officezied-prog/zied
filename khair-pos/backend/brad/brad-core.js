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
  var ROLES = ['owner', 'manager', 'akuntan'], READ = { login: 1, bootstrap: 1, poll: 1 }, OWNER_ONLY = { cooler_save: 1, settings_save: 1 };
  // v63: what the Worker itself tells the core after talking to Lalamove (req.__sys === 'lalamove', never from a client)
  var SYS_ONLY = { lala_booked: 1, lala_sync: 1, lala_cancelled: 1, lala_due: 1, lala_services: 1 };
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
  /** The settings this app keeps (pos_settings, keys brad_*): per cooler { wa, hours, lat, lng }, holidays, ETA margin, minutes a
      pallet; v63: the shop's location, the month's Lalamove cap (Rp) and the vehicles Lalamove offers in the city (cached). */
  function settingsOf(s) {
    s = s || {};
    var c = json(s.brad_coolers, {}), h = json(s.brad_holidays, []), m = s.brad_eta_margin, l = s.brad_load_min, wc = s.brad_wa_cap, lc = s.brad_lala_cap;
    var sg = json(s.brad_store_geo, null), sv = json(s.brad_lala_services, null), g = geoNum(sg);
    return { coolers: c && typeof c === 'object' && !Array.isArray(c) ? c : {}, holidays: Array.isArray(h) ? h : [],
      margin: m !== undefined && m !== null && m !== '' && isFinite(Number(m)) ? Number(m) : ETA_MARGIN,
      load_min: l !== undefined && l !== null && l !== '' && Number(l) > 0 ? Number(l) : LOAD_MIN,
      wa_cap: wc !== undefined && wc !== null && wc !== '' && isFinite(Number(wc)) && Number(wc) >= 0 ? Math.round(Number(wc)) : 3000,
      lala_cap: lc !== undefined && lc !== null && lc !== '' && isFinite(Number(lc)) && Number(lc) >= 0 ? Math.round(Number(lc)) : LALA_CAP,
      store_geo: g ? { lat: g.lat, lng: g.lng, address: str(sg.address) } : null,
      lala_services: sv && typeof sv === 'object' && Array.isArray(sv.services) ? sv : null };
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

  /* ---------- v62: the car the customer booked himself ----------
     Owner 2026-10-20: «كثير من الأحيان يقوم الزبون هو باختيار السيارة للموف لإرسال البضاعة من المخزن التبريد مباشرة، فيجب أن تكون هناك مكان
     لكتابة رسائل الزبون»: the customer books the Lalamove car and sends its details by WhatsApp — in his own words or as Lalamove's
     share text. His message is kept with the trip; these fixed rules only PROPOSE the driver, the plate, the driver's WhatsApp,
     the vehicle, the minutes and the tracking link, which staff check in the form (nothing is saved from here). */
  var PLATE_AREAS = ('A B D E F G H K L M N P R S T W Z AA AB AD AE AG BA BB BD BE BG BH BK BL BM BN BP ' +
    'DA DB DC DD DE DG DH DK DL DM DN DR DS DT DW EA EB ED KB KH KT KU PA PB').split(' '); // the region codes of Indonesian plates
  var PLATE_NOT_END = ['YA', 'YG', 'OK', 'DAN', 'DGN', 'PAK', 'BU', 'JAM', 'MIN', 'MNT', 'KG', 'CTN', 'DUS', 'HP', 'WA', 'NO', 'KE', 'DI', 'SDH', 'OTW', 'LG', 'AJA']; // words, not plate letters
  var RE_PLATE = /\b([A-Z]{1,2})[ \t.\-]{0,2}(\d{1,4})(?:[ \t.\-]{0,2}([A-Z]{1,3}))?\b(?![ \t.\-]*\d)/gi; // B 1234 XYZ · D 5678 AB · AB 12 C
  var RE_PLATE_LBL = /(?:\bplate?(?:\s*(?:nomor|no\.?|number))?|\bnopol|\bno\.?\s*pol(?:isi)?|\bnomor\s*polisi|\b(?:no\.?|nomor)\s*kendaraan|\blicen[cs]e(?:\s*plate)?|\btnkb)\s*[:=#.\-]?\s*/gi;
  var RE_CPHONE = /(?:\(?\+62\)?|\b62|\b0)[ .\-]?8\d(?:[ .\-]?\d){6,11}/g; // 08…, +62…, 62…
  var RE_LINK = /https?:\/\/[^\s<>"'`]+/gi;
  var RE_DRV = /(?:\byour\s+driver|\b(?:nama\s+)?(?:pengemudi|driver|sopir|supir|kurir)(?:nya)?(?:\s+(?:anda|kamu|name))?)\s*(?:[:=\-–]|\badalah\b|\bbernama\b|\bnamanya\b|\bis\b)?\s*/gi;
  var MINS = '(?:menit|mnt|mins?|minutes?)';
  var RE_ETA = [new RegExp('\\b(\\d{1,3})\\s*(?:-|–|s\\.?\\/?d\\.?|sampai|hingga|to)\\s*(\\d{1,3})\\s*' + MINS + '\\b', 'i'), // a range: its upper end
    new RegExp('\\b(\\d{1,2}(?:[.,]5)?)\\s*jam\\b(?:\\s*(?:dan\\s*)?(\\d{1,2})\\s*' + MINS + '\\b)?', 'i'), new RegExp('\\b(\\d{1,3})\\s*' + MINS + '\\b', 'i')];
  var VEHICLE_WORDS = [[/\bgr[ae]nd?\s*max\b/i, 'Grand Max'], [/\bl\s*-?\s*300\b/i, 'L300'], [/\bblind\s*van\b/i, 'Blind van'], [/\bcdd\b/i, 'CDD'], [/\b(?:engkel|cde)\b/i, 'Engkel (CDE)'],
    [/\bpick\s*-?\s*up\b/i, 'Pickup'], [/\bvan\b/i, 'Van'], [/\b(?:truck|truk|fuso)\b/i, 'Truk'], [/\bmotor\b/i, 'Motor'],
    [/\b(?:kendaraan|jenis|layanan|armada|vehicle|tipe|type)\s*[:=]?\s*mobil\b/i, 'Mobil']]; // "mobil" alone is any car ("mobil sudah dipesan"): only when named as the vehicle
  var NAME_STOP = ('sudah udah sdh telah akan sedang lagi lg otw menuju meluncur dalam dlm tiba sampai smp datang jalan on the is ke di dari dr mau baru nanti belum blm ' +
    'ya yg yang dengan dgn pakai pake naik plat plate nopol no nomor nmr hp wa whatsapp telp telepon tlp kontak phone mobil mobilnya motor kendaraan van blind pickup pick ' +
    'engkel cdd cde truk truck fuso grand gran granmax l300 segera menit min mnt eta jam sekitar kira kurang lebih sekarang skrg tolong mohon harap bisa ok oke siap dan ' +
    'atau untuk utk buat pesanan order lalamove anda kamu').split(' ');
  var TITLES = ['pak', 'bpk', 'bapak', 'bu', 'ibu', 'mas', 'mbak', 'bang', 'kak'];
  /** A tracking link as kept: http(s) only, one piece, at most 300 characters — else ''. */
  function urlOf(v) { var s = str(v); return s.length <= 300 && /^https?:\/\/[^\s<>"'`\u0000-\u001f\u007f]+$/i.test(s) ? s : ''; }
  /** A pasted message kept as written: its line breaks, no other control characters (nor < > or bidi overrides), at most `max`. */
  function textOf(v, max) {
    return str(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>‪-‮⁦-⁩]/g, ' ').replace(/[  ]+/g, ' ')
      .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max).trim();
  }
  /** The customer's message about the car → { driver, plate, phone, link, vehicle, eta_min } ('' / null when not in it). What was
      read leaves the working text, so a plate's digits are never taken for minutes nor its letters for the driver's name. */
  function parseCarMsg(text) {
    var s = String(text === undefined || text === null ? '' : text).slice(0, 4000).replace(/\r\n?/g, '\n'), w, m, re;
    var out = { driver: '', plate: '', phone: '', link: '', vehicle: '', eta_min: null };
    function cut(a, b) { w = w.slice(0, a) + ' , ' + w.slice(b); }
    function plateOf(a, n, z) { z = str(z).toUpperCase(); if (PLATE_NOT_END.indexOf(z) >= 0) z = ''; return { v: [a.toUpperCase(), n, z].filter(Boolean).join(' '), end: !!z }; }
    // the tracking link: Lalamove's own first, else the first http(s) link
    var links = (s.match(RE_LINK) || []).map(function (u) { return u.replace(/[.,;:!?)\]}»”’]+$/, ''); }).filter(urlOf);
    out.link = links.filter(function (u) { return /lalamove/i.test(u); })[0] || links[0] || '';
    w = s.replace(RE_LINK, ' , ');
    // the plate: after its label ("Plat:", "Nopol", "No. kendaraan", "No. polisi"), else the first one that looks like a plate
    // (a region code, the digits, the letters after them — "L300" is a car, "RT 05", "no 12 ya", "Blok B 12 A" are not plates)
    var pl = null;
    re = new RegExp(RE_PLATE_LBL.source, 'gi');
    while (!pl && (m = re.exec(w))) {
      var e = m.index + m[0].length, x = w.slice(e).match(new RegExp('^' + RE_PLATE.source, 'i'));
      if (x) pl = { at: m.index, end: e + x[0].length, v: plateOf(x[1], x[2], x[3]).v };
    }
    re = new RegExp(RE_PLATE.source, 'gi');
    while (!pl && (m = re.exec(w))) {
      var p = plateOf(m[1], m[2], m[3]);
      if (PLATE_AREAS.indexOf(m[1].toUpperCase()) < 0 || !p.end || /\b(?:blok|blk|no|nomor|kav|unit|lantai|lt|gedung|pintu|gate|door|rt|rw)\.?\s*$/i.test(w.slice(Math.max(0, m.index - 12), m.index))) continue;
      pl = { at: m.index, end: m.index + m[0].length, v: p.v };
    }
    if (pl) { out.plate = pl.v; cut(pl.at, pl.end); }
    // the driver's phone: the first mobile number; a group too many (more than 13 digits, or "… 25 menit" right after) is not his
    m = new RegExp(RE_CPHONE.source, 'g').exec(w);
    if (m) {
      var raw = m[0], rest = w.slice(m.index + raw.length);
      var drop = function () { var k = raw.search(/[ .\-]\d+$/); if (k > 0) raw = raw.slice(0, k); return k > 0; };
      while (raw.replace(/\D/g, '').replace(/^62/, '0').length > 13 && drop()) { /* next group */ }
      if (/^\s*(?:menit|mnt|mins?|minutes?|jam)\b/i.test(rest) && /\s\d+$/.test(raw)) drop();
      var pn = normPhone(raw);
      if (pn) { out.phone = pn; cut(m.index, m.index + raw.length); }
    }
    // the minutes until the car is there: the first of "25 menit", "± 30 mnt", "15-20 mins" (the upper end), "1 jam 10 menit"
    var etas = RE_ETA.map(function (r, i) {
      var y = w.match(r); if (!y) return null;
      var v = i === 0 ? Math.max(Number(y[1]), Number(y[2])) : i === 1 ? Math.round(Number(y[1].replace(',', '.')) * 60) + (y[2] ? Number(y[2]) : 0) : Number(y[1]);
      return v >= 0 && v <= 600 ? { at: y.index, i: i, v: v } : null;
    }).filter(Boolean).sort(function (a, b) { return a.at - b.at || a.i - b.i; });
    if (etas.length) out.eta_min = etas[0].v;
    // the vehicle: the model with its body when both are named ("Grand Max blind van", "L300 pickup")
    var hits = VEHICLE_WORDS.filter(function (v) { return v[0].test(w); }).map(function (v) { return v[1]; });
    if (hits.length) {
      var body = hits.filter(function (v) { return v === 'Blind van' || v === 'Pickup'; })[0];
      out.vehicle = (hits[0] === 'Grand Max' || hits[0] === 'L300') && body ? hits[0] + ' ' + body.toLowerCase() : hits[0];
    }
    // the driver's name: the words after "Driver:", "Pengemudi Anda:", "Sopirnya", … up to a comma, a number or a word that is not a name
    re = new RegExp(RE_DRV.source, 'gi');
    while (!out.driver && (m = re.exec(w))) {
      var seg = w.slice(m.index + m[0].length).split(/[,;:|·•\n()[\]\/+0-9]| - /)[0], words = [];
      seg.trim().split(/\s+/).some(function (x) {
        var k = x.toLowerCase().replace(/[.'’]+$/, '');
        if (!/^[a-zÀ-ɏ][a-zÀ-ɏ.'’]*$/i.test(x) || NAME_STOP.indexOf(k) >= 0 || words.length >= 5) return true;
        words.push(x); return false;
      });
      var nm = words.join(' ').replace(/\.+$/, '');
      if (nm.replace(/[^a-zÀ-ɏ]/gi, '').length >= 2 && !words.every(function (x) { return TITLES.indexOf(x.toLowerCase().replace(/\.$/, '')) >= 0; })) out.driver = clean(nm, 40);
    }
    return out;
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
  /** To the cold store: the car that will take the goods (so they are handed to that exact car) — v62: with the Lalamove
      tracking link when the customer sent one (the car template's six values stay as Meta approved them: the link is here only). */
  function msgCar(o, C) {
    var c = car(o), w = (C && C.cooler) || {}, tu = urlOf(c.track_url);
    return ['Order ' + o.order_no + ' — mobil untuk ambil di ' + (str(w.name) || o.warehouse) + ':', 'Kendaraan: ' + (str(c.vehicle) || '-'), 'No. polisi: ' + str(c.plate),
      'Sopir: ' + str(c.driver) + (str(c.driver_wa) ? ' (' + phoneLocal(c.driver_wa) + ')' : ''), str(o.eta_at) ? 'Perkiraan tiba: ' + hmStr(wibAt(o.eta_at).min) : '',
      tu ? 'Lacak mobil: ' + tu : '', 'Terima kasih.']
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

  /* ---------- stage 2: automatic WhatsApp (the official WhatsApp Cloud API, sent by the Worker) ----------
     Owner 2026-10-18: «ابدأ المرحلة الثانية: إرسال الواتساب تلقائيًا». The cold stores accept only WhatsApp, so the four messages
     of the flow go out by themselves as Meta-approved templates (utility, Indonesian): the order to the cold store with buttons
     Setuju / Tolak / Barang siap, the car to the cold store with a button "Mobil sudah masuk", the door to the driver, the
     departure to the customer. A button tapped — or a reply such as "pintu 12" — from THE COLD STORE'S OWN NUMBER moves the
     order by the same fixed rules as the buttons in the app (no AI deciding); anything else is only shown. Not configured,
     over the monthly cap, or refused by WhatsApp → the app falls back to the one-tap wa.me message of stage 1: nothing stops.
     Template variables may not hold line breaks: every value is one line. */
  var WA_LANG = 'id';
  var WA_TEMPLATES = {
    order: { name: 'khair_order_brad', buttons: ['Setuju', 'Tolak', 'Barang siap'],
      body: 'Order ambil Khair Mart {{1}}\nTanggal ambil: {{2}}\nGudang: {{3}}\nTujuan: {{4}}\nBarang: {{5}}\nTotal: {{6}}\nMohon konfirmasi dengan tombol di bawah. Terima kasih.',
      example: ['BRD-261014-001', 'Rabu, 14 Oktober 2026', 'DPP Cold Storage', 'Toko Barokah (pelanggan)', '40 ctn Kurma Sukari 3kg, palet 2274537, kode SUKARI-3', '40 ctn, 1 palet'] },
    car: { name: 'khair_mobil_brad', buttons: ['Mobil sudah masuk'],
      body: 'Order {{1}}: mobil untuk ambil di {{2}}.\nKendaraan: {{3}}\nNo. polisi: {{4}}\nSopir: {{5}}\nPerkiraan tiba: {{6}}\nSaat mobil masuk, tekan tombol di bawah atau balas pesan ini dengan nomor pintu. Terima kasih.',
      example: ['BRD-261014-001', 'DPP Cold Storage', 'Engkel (CDE)', 'B 1234 XYZ', 'Pak Budi (081299990000)', '14:20'] },
    door: { name: 'khair_pintu_brad', buttons: [],
      body: 'Halo {{1}}, untuk order {{2}} silakan masuk ke {{3}} ({{4}}), PINTU {{5}}. Muat {{6}} untuk {{7}}. Terima kasih.',
      example: ['Pak Budi', 'BRD-261014-001', 'DPP Cold Storage', 'Jakarta Utara', '12', '1 palet, 40 ctn', 'Toko Barokah'] },
    depart: { name: 'khair_berangkat_brad', buttons: [],
      body: 'Halo {{1}}, pesanan {{2}} ({{3}}) sudah berangkat dari {{4}} jam {{5}}. Mobil {{6}}, sopir {{7}}. Terima kasih, {{8}}.',
      example: ['Toko Barokah', 'BRD-261014-001', '40 ctn', 'DPP Cold Storage', '15:10', 'B 1234 XYZ', 'Pak Budi (081299990000)', 'Khair Mart'] }
  };
  var WA_CAP = 3000; // messages a month (≈ Rp 1,1 juta); above it the app sends by hand (wa.me) — owner setting brad_wa_cap
  /** One template value: one line, no tabs, never empty (WhatsApp refuses an empty value). */
  function waVal(v, max) { var s = clean(v, max || 200); return s || '-'; }
  /** What goes to whom for a step: { kind, order_no, to, template, lang, params, payloads } — or null when nobody to send to. */
  function waOut(o, kind, C) {
    C = C || {};
    var w = C.cooler || {}, pr = C.products || {}, co = C.company || {}, c = car(o), T = totals(o), no = o.order_no, wname = str(w.name) || o.warehouse;
    var drv = str(c.driver) + (str(c.driver_wa) ? ' (' + phoneLocal(c.driver_wa) + ')' : ''), to = '', params = [], payloads = [];
    if (kind === 'order') {
      to = normPhone(w.wa);
      var L = json(o.lines, []), parts = [], used = 0;
      for (var i = 0; i < L.length; i++) { // the lines in one value; a very long order is cut (the full list stays in the app)
        var l = L[i], p = pr[l.product] || {}, s = n0(l.cartons) + ' ctn ' + (str(p.name) || str(l.product_name) || str(l.product)) + ', palet ' + l.pallet_code + (l.full ? ' (utuh)' : '') + ', kode ' + str(l.product);
        if (used + s.length > 560) { parts.push('+' + (L.length - i) + ' baris lagi (daftar lengkap menyusul)'); break; }
        parts.push(s); used += s.length + 3;
      }
      params = [no, dLong(o.order_date), wname, str(o.dest_name) + (o.dest_type === 'pelanggan' ? ' (pelanggan)' : ''), parts.join(' | '),
        n0(T.cartons) + ' ctn, ' + T.pallets + ' palet' + (num(o.extra_cost) > 0 ? ', biaya perjanjian ' + rpS(o.extra_cost) : '')];
      payloads = ['BRD|APPROVE|' + no, 'BRD|REJECT|' + no, 'BRD|READY|' + no];
    } else if (kind === 'car') {
      to = normPhone(w.wa);
      params = [no, wname, str(c.vehicle), str(c.plate), drv, str(o.eta_at) ? hmStr(wibAt(o.eta_at).min) : ''];
      payloads = ['BRD|IN|' + no];
    } else if (kind === 'door') {
      to = normPhone(c.driver_wa);
      params = [str(c.driver) || 'Pak/Bu sopir', no, wname, str(w.address), str(o.door), T.pallets + ' palet, ' + n0(T.cartons) + ' ctn', str(o.dest_name)];
    } else if (kind === 'depart') {
      to = o.dest_type === 'pelanggan' ? normPhone(o.dest_phone) : '';
      params = [str(o.dest_name), no, n0(T.cartons) + ' ctn', wname, str(o.departed_at) ? hmStr(wibAt(o.departed_at).min) : '', str(c.plate), drv, str(co.store) || 'Khair Mart'];
    } else return null;
    if (!to) return null;
    return { kind: kind, order_no: no, to: to, template: WA_TEMPLATES[kind].name, lang: WA_LANG, params: params.map(function (v) { return waVal(v, kind === 'order' ? 600 : 200); }), payloads: payloads };
  }
  /** The templates as Meta's message_templates API takes them (category UTILITY, Indonesian), with example values. */
  function waTemplateDefs() {
    return Object.keys(WA_TEMPLATES).map(function (k) {
      var t = WA_TEMPLATES[k], comps = [{ type: 'BODY', text: t.body, example: { body_text: [t.example] } }];
      if (t.buttons.length) comps.push({ type: 'BUTTONS', buttons: t.buttons.map(function (b) { return { type: 'QUICK_REPLY', text: b }; }) });
      return { name: t.name, language: WA_LANG, category: 'UTILITY', components: comps };
    });
  }

  /** An incoming WhatsApp message (the Worker has checked Meta's signature and resolved which order a reply refers to).
      ev = { id, from, type: 'button' | 'text' | 'interactive' | …, payload, text, ctx_order_no }.
      Only the order's cold store (its WhatsApp number) moves the order, by the same rules as the app's buttons; a car that comes
      in after closing is NOT entered (the overtime needs its cause, chosen in the app). Returns { response, writes }. */
  function waEvent(state, ev, nowIso) {
    var st = { warehouses: (state.warehouses || []).slice(), orders: (state.orders || []).slice(), settings: state.settings || {} };
    var S = settingsOf(st.settings), now = str(nowIso), today = wib(now).slice(0, 10), writes = [];
    ev = ev && typeof ev === 'object' ? ev : {};
    var from = normPhone(ev.from), text = clean(ev.text, 300), pm = str(ev.payload).match(/^BRD\|(APPROVE|REJECT|READY|IN)\|(BRD-[0-9-]{6,20})$/);
    function waOf(code) { var w = st.warehouses.find(function (x) { return x.code === code; }) || {}, cfg = S.coolers[code] || {}; return normPhone(cfg.wa) || normPhone(w.pic_wa); }
    function nameOf(code) { var w = st.warehouses.find(function (x) { return x.code === code; }); return w ? str(w.name) : code; }
    var no = pm ? pm[2] : str(ev.ctx_order_no), o = no ? st.orders.find(function (x) { return x.order_no === no; }) : null;
    if (!o && !pm && from) { // a reply that quotes nothing: the one order of that cold store now waiting for it, if there is exactly one
      var cand = st.orders.filter(function (x) { return ['sent', 'approved', 'car', 'arrived'].indexOf(x.status) >= 0 && waOf(x.warehouse) === from; }); // waiting for its answer
      if (cand.length === 1) o = cand[0];
    }
    var act = pm ? pm[1] : '', door = '';
    if (!act && text) { var r = readReply(text); act = { approve: 'APPROVE', reject: 'REJECT', ready: 'READY', door: 'DOOR' }[r.kind] || ''; door = r.door; }
    var applied = '', note = '';
    function step(row, to, nt) { var l = json(row.log, []); l.push({ at: now, by: 'WhatsApp ' + nameOf(row.warehouse), from: str(row.status), to: to, note: nt || '' }); return Object.assign({}, row, { status: to, log: JSON.stringify(l.slice(-60)) }); }
    function put(row) { writes.push({ table: 'orders', row: row }); return row; }
    if (o && act && from && waOf(o.warehouse) === from) {
      var st0 = o.status, H = hoursOf(S.coolers[o.warehouse]);
      if (act === 'APPROVE' && st0 === 'sent') { put(step(Object.assign({}, o, { approved_at: now }), 'approved', text)); applied = 'approved'; }
      else if (act === 'READY' && (st0 === 'sent' || st0 === 'approved')) { put(step(step(Object.assign({}, o, { approved_at: o.approved_at || now, ready_at: now }), 'approved', ''), 'ready', text)); applied = 'ready'; }
      else if (act === 'REJECT' && st0 === 'sent') { put(step(Object.assign({}, o, { rejected_reason: ('Lewat WhatsApp: ' + (text || 'Tolak')).slice(0, 120) }), 'rejected', text)); applied = 'rejected'; }
      else if ((act === 'IN' || (act === 'DOOR' && door)) && st0 === 'car') {
        var ov = overtimeAt(now, H);
        if (ov.hours > 0) note = 'after_close'; // the overtime's cause is chosen in the app
        else {
          var row = Object.assign({}, o, { arrived_at: now, ot_hours: 0, ot_cost: 0, ot_cause: '', ot_note: '' });
          if (door) row.door = door.slice(0, 6);
          put(step(row, door ? 'door' : 'arrived', ['Masuk ' + hmStr(wibAt(now).min), door ? 'Pintu ' + door : ''].filter(Boolean).join(' · ')));
          applied = door ? 'door' : 'arrived';
        }
      } else if (act === 'DOOR' && door && ['arrived', 'door', 'loading'].indexOf(st0) >= 0) {
        var drow = Object.assign({}, o, { door: door.slice(0, 6) });
        put(st0 === 'arrived' ? step(drow, 'door', 'Pintu ' + door) : step(drow, st0, 'Pintu diubah: ' + door)); applied = 'door';
      } else note = 'not_now';
    } else if (o && act && from) note = 'not_cooler';
    writes.push({ table: 'log', row: { wamid: str(ev.id).slice(0, 120), dir: 'in', peer: from, order_no: o ? o.order_no : '', kind: str(ev.type).slice(0, 20) || 'text',
      text: text || clean(ev.payload, 120), status: 'received', applied: applied || note, at: now, updated_at: now } });
    var resp = { ok: true, order_no: o ? o.order_no : '', applied: applied, note: note };
    if (applied === 'door') { // the door the cold store gave goes on to the driver by itself
      var nw = writes.filter(function (x) { return x.table === 'orders'; }).pop().row, w0 = st.warehouses.find(function (x) { return x.code === nw.warehouse; }) || {};
      var dm = waOut(nw, 'door', { cooler: { name: str(w0.name) || nw.warehouse, address: str(w0.address), wa: waOf(nw.warehouse) }, company: { store: str(st.settings.store_name) || 'Khair Mart' } });
      resp.wa = dm ? [dm] : [];
    }
    return { response: resp, writes: writes };
  }
  /* ---------- stage 3: the Lalamove car booked by the server (Lalamove's official Partner API v3, called by the Worker) ----------
     Owner 2026-10-20: «ابدأ المرحلة الثالثة: طلب سيارة لالاموف تلقائيًا». Staff choose the vehicle and the time; the server prices the trip
     (the cooler → where the goods go), books it, and follows it: the driver found → his name, plate and WhatsApp go to the cold
     store (the same car message as step 5); picked up while the car is at the door / loading → the departure (the goods out of the
     stock, the customer told); completed → delivered; cancelled / rejected / no driver → back to "book a car". These rules are
     here, with no network: the Worker reads Lalamove and tells the core what it said (req.__sys === 'lalamove', set by the Worker
     alone). Not set up, over the month's cap, refused or unreachable → the manual ways stay (Lalamove's app, our own driver, the
     customer's car): nothing stops. */
  var LALA_CAP = 10000000; // Rp a month of booked trips (owner setting brad_lala_cap; 0 = no automatic booking)
  var LALA_PICKUP_MIN = 40; // minutes until the car is at the cooler when nothing else is known (staff may type their own)
  var LALA_STATUSES = ['ASSIGNING_DRIVER', 'ON_GOING', 'PICKED_UP', 'COMPLETED', 'CANCELED', 'REJECTED', 'EXPIRED'];
  var LALA_FINAL = ['COMPLETED', 'CANCELED', 'REJECTED', 'EXPIRED'], LALA_GONE = ['CANCELED', 'REJECTED', 'EXPIRED'];
  var LALA_WORD = { CANCELED: 'dibatalkan', REJECTED: 'ditolak', EXPIRED: 'tidak dapat sopir' };
  var LALA_SYNC_STEPS = ['car', 'arrived', 'door', 'loading', 'departed']; // the trips worth reading again
  var GEO_HINT = 'tempel link Google Maps, lokasi WhatsApp, atau "lat,lng" (contoh -6.2088,106.8456)';
  function geoNum(o) {
    if (!o || typeof o !== 'object' || [o.lat, o.lng].some(function (v) { return v === null || v === undefined || v === ''; })) return null;
    var la = Number(o.lat), ln = Number(o.lng);
    return isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 && !(la === 0 && ln === 0) ? { lat: la, lng: ln } : null;
  }
  /** A place as pasted → { lat, lng } (6 decimals), else null: "lat,lng"; a Google Maps link — the pin (…!3dLAT!4dLNG), ?q= / ll= /
      query= / destination= / daddr=, the view (@lat,lng); a WhatsApp location (maps.google.com/?q=lat,lng); geo:lat,lng. A short
      link (maps.app.goo.gl/…) carries no position: the Worker follows it first (worker/src/gmaps.js). */
  function geoOf(text) {
    var s = str(text).slice(0, 2000), N = '(-?\\d{1,3}(?:\\.\\d+)?)', m;
    try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { /* keep it as typed */ }
    var pats = [/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/, new RegExp('[?&](?:q|ll|sll|query|destination|daddr|center)=(?:loc:)?\\s*' + N + '\\s*,\\s*' + N),
      /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, new RegExp('\\bgeo:' + N + ',' + N), /^\s*(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)\s*$/,
      /(?:^|[^\d.\-])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?![\d.])/];
    for (var i = 0; i < pats.length; i++) {
      m = s.match(pats[i]);
      var g = m ? geoNum({ lat: m[1], lng: m[2] }) : null;
      if (g) return { lat: Math.round(g.lat * 1e6) / 1e6, lng: Math.round(g.lng * 1e6) / 1e6 };
    }
    return null;
  }
  /** The trip booked through the API (its car JSON), or null. */
  function lalaTrip(o) { var c = car(o); return c.via === 'lalamove_api' && str(c.lala_order_id) ? c : null; }
  /** A Lalamove trip still running (not completed, cancelled, rejected or expired). */
  function lalaOpen(o) { var c = lalaTrip(o); return !!c && LALA_FINAL.indexOf(str(c.lala_status)) < 0; }
  /** What the month's trips cost (booked through the API that month, Jakarta time; a cancelled one costs nothing). */
  function lalaSpent(orders, month) {
    return (orders || []).reduce(function (s, o) {
      var c = lalaTrip(o);
      return c && wib(str(c.booked_at) || '1970-01-01T00:00:00Z').slice(0, 7) === month && LALA_GONE.indexOf(str(c.lala_status)) < 0 ? s + Math.round(num(c.price)) : s;
    }, 0);
  }
  /** The open trips to read again: not looked at for `ageSec`, the oldest look first, at most `max` (only `onlyId` when given).
      A pickup booked for more than 2 hours later is looked at every 30 minutes; a trip left open 3 days after its pickup is no
      longer read (staff close it by hand) — the reads stay few. */
  function lalaDue(orders, nowMs, ageSec, max, onlyId) {
    var at = function (o) { var t = Date.parse(lalaTrip(o).lala_synced_at); return isNaN(t) ? 0 : t; };
    return (orders || []).filter(function (o) {
      if (!lalaOpen(o) || LALA_SYNC_STEPS.indexOf(o.status) < 0) return false;
      var c = lalaTrip(o), pick = Math.max(Date.parse(c.booked_at) || 0, Date.parse(c.schedule_at) || 0);
      if ((onlyId && str(c.lala_order_id) !== onlyId) || pick < nowMs - 3 * 86400000) return false;
      return !(at(o) > nowMs - (ageSec >= 90 && pick > nowMs + 2 * 3600000 ? 1800 : ageSec) * 1000); // (Lalamove's webhook: at once)
    }).sort(function (a, b) { return at(a) - at(b); }).slice(0, max).map(function (o) {
      var c = lalaTrip(o); return { order_no: o.order_no, lala_order_id: str(c.lala_order_id), driver_id: str(c.lala_driver_id), synced_at: str(c.lala_synced_at) };
    });
  }
  /** The vehicle proposed for `kg` (+10 %, as KCold.vehicleFor): the smallest whose load (in kg) holds it, else the biggest. */
  function lalaServiceFor(services, kg) {
    var list = (services || []).map(function (s) { var l = s && s.load ? num(s.load.value) * (/^(lb|lbs)$/i.test(str(s.load.unit)) ? 0.4536 : 1) : 0; return { key: str(s && s.key), load: l }; })
      .filter(function (s) { return s.key; }), need = num(kg) * 1.1;
    if (!(need > 0)) return ''; // the weight unknown: staff choose
    var known = list.filter(function (s) { return s.load > 0; }).sort(function (a, b) { return a.load - b.load; });
    var fit = known.find(function (s) { return s.load >= need; });
    return fit ? fit.key : known.length ? known[known.length - 1].key : list.length ? list[0].key : '';
  }

  /** The newest change the app could not have seen yet (the light poll): the latest order log line or WhatsApp message, and how
      many there are — two changes in the same second still change it. */
  function stampOf(orders, log) {
    var m = '', n = 0;
    (orders || []).forEach(function (o) { var l = json(o.log, []), a = l.length ? str(l[l.length - 1].at) : ''; n += l.length; if (a > m) m = a; });
    (log || []).forEach(function (x) { var a = str(x.updated_at) || str(x.at); if (a > m) m = a; });
    return m + '#' + n + '.' + (log || []).length + '.' + (orders || []).length;
  }

  /* ---------- the request ---------- */
  function core(state, req, nowIso) {
    var st = {};
    ['warehouses', 'products', 'pallets', 'movements', 'cold_orders', 'customers', 'orders', 'users', 'wa_log'].forEach(function (k) { st[k] = (state[k] || []).slice(); });
    st.settings = state.settings || {};
    st.movements = st.movements.map(function (m) { return Object.assign({}, m, { seq: num(m.seq), cartons: num(m.cartons) }); }).sort(function (a, b) { return a.seq - b.seq; });
    var writes = [], now = str(nowIso), today = wib(now).slice(0, 10), yymmdd = today.slice(2).replace(/-/g, '');
    var action = str(req && req.action), data = (req && req.data && typeof req.data === 'object') ? req.data : {};
    function fail(c, msg, extra) { var r = { ok: false, error: c, message: msg || c }; Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; }); return { response: r, writes: [] }; }
    function done(resp) { resp.ok = true; return { response: resp, writes: writes }; }
    function put(table, row) { writes.push({ table: table, row: row }); var list = st[table]; if (!Array.isArray(list)) return row; if (row.id !== undefined) { var i = list.findIndex(function (x) { return x.id === row.id; }); if (i >= 0) list[i] = row; } else list.push(row); return row; }

    /* who is asking (same rules as the POS and the gudang app) — v63: or the Worker itself, right after it talked to Lalamove
       (req.__sys: a client's request can never carry it — parseBrad keeps only action / key / user / pin_hash / data) */
    var users = st.users.filter(active), ph = str(req && req.pin_hash), nowMs = Date.parse(now), sys = !!(req && req.__sys === 'lalamove');
    if (!!SYS_ONLY[action] !== sys) return fail('FORBIDDEN', 'Hanya server');
    var me = null, viaMaster = false, role = 'system', by = sys ? clean(data.by, 60) || 'Lalamove' : '';
    if (!sys) {
      me = users.find(function (u) { return str(u.name).toLowerCase() === str(req && req.user).toLowerCase(); });
      if (!me || !/^[a-f0-9]{64}$/.test(ph)) return fail('BAD_PIN', 'Nama atau PIN salah');
      if (Date.parse(me.locked_until) > nowMs) return fail('LOCKED', 'Akun dikunci sementara karena PIN salah berkali-kali');
      viaMaster = users.some(function (u) { return u.role === 'owner' && u.master_hash && u.master_hash === ph; });
      if (me.pin_hash !== ph && !viaMaster) return fail('BAD_PIN', 'Nama atau PIN salah');
      if (bool(me.must_change) && !viaMaster) return fail('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu di aplikasi Khair Mart');
      role = str(me.role); by = str(me.name);
      if (ROLES.indexOf(role) < 0) return fail('FORBIDDEN', 'Hanya pemilik, manajer dan akuntan');
      if (!READ[action] && role === 'akuntan') return fail('FORBIDDEN', 'Akuntan hanya bisa melihat');
      if (OWNER_ONLY[action] && role !== 'owner') return fail('FORBIDDEN', 'Hanya pemilik');
    }
    var S = settingsOf(st.settings);

    function wh(c) { return st.warehouses.find(function (w) { return w.code === code(c) && active(w); }); }
    function H(c) { return hoursOf(S.coolers[c]); }
    function order(no) { return st.orders.find(function (o) { return o.order_no === str(no).toUpperCase(); }); }
    function nextSeq() { return st.movements.reduce(function (m, x) { return Math.max(m, x.seq); }, 0) + 1; }
    function move(o) {
      var row = { seq: nextSeq(), move_date: o.move_date || today, at: now, type: o.type, pallet_code: o.pallet_code, warehouse: o.warehouse, cartons: o.cartons,
        ref_seq: 0, grp: o.grp || 0, order_no: o.order_no || '', reason: o.reason || '', by_user: by };
      if (!row.grp) row.grp = row.seq;
      if (BAL) { var bk = row.pallet_code + '|' + row.warehouse; BAL[bk] = (BAL[bk] || 0) + num(row.cartons); } // v63: two departures in one request
      put('movements', row); return row;
    }
    function coolerOut(w) {
      var cfg = S.coolers[w.code] || {}, g = geoNum(cfg);
      return { code: w.code, name: str(w.name), address: str(w.address), pic_name: str(w.pic_name), wa: normPhone(cfg.wa) || str(w.pic_wa), wa_own: !!normPhone(cfg.wa),
        hours: hoursOf(cfg), hours_set: !!(cfg.hours && typeof cfg.hours === 'object'), lat: g ? g.lat : null, lng: g ? g.lng : null };
    }
    var BAL = null;
    function bal(pc, w) { if (!BAL) { BAL = {}; st.movements.forEach(function (x) { var k = x.pallet_code + '|' + x.warehouse; BAL[k] = (BAL[k] || 0) + x.cartons; }); } return BAL[pc + '|' + w] || 0; }
    function orderOut(o) {
      var x = Object.assign({}, o), live = LIVE.indexOf(o.status) >= 0;
      x.lines = json(o.lines, []).map(function (l) { var y = Object.assign({}, l); if (live) { var b = bal(l.pallet_code, o.warehouse); y.pallet_ctn = b; y.full = b > 0 && num(l.cartons) >= b; } return y; });
      x.car = json(o.car, null); x.log = json(o.log, []); x.step = STEPS.indexOf(o.status) + 1;
      var T = totals(o); x.pallets = T.pallets; x.cartons = T.cartons;
      ['extra_cost', 'ot_hours', 'ot_cost', 'car_cancels', 'customer_id'].forEach(function (k) { x[k] = num(o[k]); });
      var dg = geoNum({ lat: o.dest_lat, lng: o.dest_lng }); x.dest_lat = dg ? dg.lat : null; x.dest_lng = dg ? dg.lng : null; // v63
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
    /** What the WhatsApp texts need about an order: its cooler, the product names, the company. */
    function ctxOf(o) {
      var w = st.warehouses.find(function (x) { return x.code === o.warehouse; }), pr = {};
      st.products.forEach(function (p) { pr[p.code] = { name: str(p.name) }; });
      return { cooler: w ? coolerOut(w) : { name: o.warehouse }, products: pr, company: { name: str(st.settings.cold_company), store: str(st.settings.store_name) || 'Khair Mart' } };
    }
    /** done() for a step whose message goes out by WhatsApp (sent by the Worker when it is set up; else the app sends it by hand). */
    function doneWa(resp, row, kind) { var m = waOut(row, kind, ctxOf(row)); resp.wa = m ? [m] : []; return done(resp); }
    function closedMsg(w, d, k, Hx) { return 'Gudang ' + w.name + ' tutup tanggal ' + d + (k === 'holiday' ? ' (' + holidayName(d, S.holidays) + ')' : '') + '. Hari kerja berikutnya: ' + nextWorkDay(d, Hx, S.holidays); }
    /** Step 9: what there is of each line goes out of the gudang ledger (a shortage is said, never blocks); the row has left. */
    function departRow(dp, note) {
      var og = nextSeq(), short = [];
      var dl = json(dp.lines, []).map(function (l) {
        var b = bal(l.pallet_code, dp.warehouse), take = Math.max(0, Math.min(b, num(l.cartons)));
        if (take < num(l.cartons)) short.push(l.pallet_code + ' (stok ' + b + ', order ' + num(l.cartons) + ')');
        if (take > 0) move({ type: 'OUT', pallet_code: l.pallet_code, warehouse: dp.warehouse, cartons: -take, grp: og, order_no: dp.order_no, reason: 'Ambil ke ' + str(dp.dest_name) + ' (Order Brad)' });
        return Object.assign({}, l, { out: take, pallet_ctn: b, full: b > 0 && take >= b });
      });
      var prow = Object.assign({}, dp, { departed_at: now, lines: JSON.stringify(dl), stock_note: short.join(', ') });
      return { row: put('orders', step(prow, 'departed', [note || '', short.length ? 'Stok kurang: ' + short.join(', ') : ''].filter(Boolean).join(' · '))), short: short };
    }
    /** The car is off: back to "book a car", counted; after the last order time that risks overtime. */
    function carCancelRow(xo, note) {
      var xrow = Object.assign({}, xo, { car: '', eta_at: '', car_cancels: num(xo.car_cancels) + 1 });
      return { row: put('orders', step(xrow, 'ready', note)), risk: str(xo.order_date) <= today && wibAt(now).min >= hm(H(xo.warehouse).last) };
    }
    /** v63: what the app shows about automatic Lalamove (the Worker adds whether its keys are set). */
    function lalaOut() {
      var sv = S.lala_services || {};
      return { cap: S.lala_cap, spent: lalaSpent(st.orders, today.slice(0, 7)), month: today.slice(0, 7), store_geo: S.store_geo, pickup_min: LALA_PICKUP_MIN,
        services: Array.isArray(sv.services) ? sv.services : [], services_city: sv.city || null, services_at: str(sv.at) };
    }
    /** v63: the Lalamove booking of an order — the quotation (the cooler → where the goods go) and the order's sender / recipient,
        after the same checks as a car typed by hand (the cooler's closing time: overtime asked first) and the month's cap. The
        Worker passes `_price` (its own fresh quote, never the client's) for the cap and, with the staff's `seen_price`, a price
        that rose more than 5 %. */
    function lalaPlan(o, d) {
      var w = st.warehouses.find(function (x) { return x.code === o.warehouse; }) || { code: o.warehouse, name: o.warehouse }, wn = str(w.name) || o.warehouse;
      var cfg = S.coolers[o.warehouse] || {}, cg = geoNum(cfg), oH = H(o.warehouse), toko = o.dest_type !== 'pelanggan';
      if (!cg) return { code: 'NO_GEO', err: 'Lokasi gudang ' + wn + ' belum diisi (Pengaturan → Lalamove otomatis)' };
      var cph = normPhone(cfg.wa) || normPhone(w.pic_wa);
      if (!cph) return { code: 'INVALID', err: 'Nomor WhatsApp gudang ' + wn + ' belum ada (untuk sopir Lalamove)' };
      var dg = null;
      if (str(d.dest_geo)) { dg = geoOf(d.dest_geo); if (!dg) return { code: 'INVALID', err: 'Lokasi tujuan tidak terbaca: ' + GEO_HINT }; }
      else dg = geoNum({ lat: o.dest_lat, lng: o.dest_lng }) || (toko ? S.store_geo : null);
      if (!dg) return { code: 'NO_GEO', err: toko ? 'Lokasi toko belum diisi (Pengaturan → Lalamove otomatis)' : 'Lokasi tujuan belum diisi: ' + GEO_HINT };
      var daddr = clean(d.dest_address, 200) || str(o.dest_address) || (toko && S.store_geo ? str(S.store_geo.address) : '') || (dg.lat + ',' + dg.lng);
      var rph = str(d.dest_phone) ? normPhone(d.dest_phone) : normPhone(toko ? st.settings.phone : o.dest_phone);
      if (!rph) return { code: 'INVALID', err: 'Nomor HP penerima wajib untuk Lalamove' };
      var svc = str(d.service).toUpperCase(), list = S.lala_services ? S.lala_services.services : [], sv = list.find(function (x) { return str(x.key) === svc; });
      if (!/^[A-Z0-9_]{2,40}$/.test(svc)) return { code: 'INVALID', err: 'Pilih jenis kendaraan Lalamove' };
      if (list.length && !sv) return { code: 'INVALID', err: 'Jenis kendaraan tidak ada di Lalamove kota ini: ' + svc };
      // when: now (Lalamove's minutes + the margin), or a later pickup time (Lalamove's scheduled order)
      var sch = '', eta = '', em = null;
      if (str(d.schedule_at)) {
        var sm = Date.parse(d.schedule_at);
        if (isNaN(sm) || sm < nowMs - 60000 || sm > nowMs + 30 * 86400000) return { code: 'INVALID', err: 'Jam jemput tidak valid (sekarang sampai 30 hari lagi)' };
        sch = new Date(Math.max(sm, nowMs)).toISOString(); eta = sch;
        var sk = dayKind(wibAt(sch).date, oH, S.holidays);
        if (sk === 'holiday' || sk === 'closed') return { code: 'CLOSED', err: closedMsg(w, wibAt(sch).date, sk, oH), extra: { next: nextWorkDay(wibAt(sch).date, oH, S.holidays), kind: sk } };
      } else {
        if (str(o.order_date) > today) return { code: 'INVALID', err: 'Order untuk tanggal ' + o.order_date + ': pilih jam jemput (dijadwalkan)' };
        em = d.eta_min === undefined || d.eta_min === null || d.eta_min === '' ? LALA_PICKUP_MIN : int(d.eta_min);
        if (!(em >= 0 && em <= 600)) return { code: 'INVALID', err: 'Menit Lalamove 0–600' };
        eta = etaOf(now, em, S.margin);
      }
      var ov = overtimeAt(eta, oH);
      if (ov.hours > 0 && !bool(d.accept_ot)) return { code: 'LATE_CAR', err: 'Mobil diperkirakan tiba ' + hmStr(wibAt(eta).min) + ', lewat ' + oH.close + ': lembur ' + ov.hours + ' jam (' + rpS(ov.cost) + ').', extra: { eta_at: eta, ot_hours: ov.hours, ot_cost: ov.cost } };
      // the month's trips against the owner's cap; a price that rose since staff saw it is asked again
      var spent = lalaSpent(st.orders, today.slice(0, 7)), price = Math.max(0, Math.round(num(d._price))), seen = Math.max(0, Math.round(num(d.seen_price)));
      if (spent >= S.lala_cap || (price > 0 && spent + price > S.lala_cap)) return { code: 'LALA_CAP', err: 'Batas biaya Lalamove bulan ini (' + rpS(S.lala_cap) + ') tercapai: sudah ' + rpS(spent) + (price ? ', mobil ini ' + rpS(price) : '') + '. Pesan mobil dengan cara manual.', extra: { spent: spent, cap: S.lala_cap, price: price } };
      if (price > 0 && seen > 0 && price > seen * 1.05) return { code: 'PRICE_CHANGED', err: 'Harga Lalamove naik: ' + rpS(price) + ' (tadi ' + rpS(seen) + '). Periksa, lalu pesan lagi.', extra: { price: price, seen_price: seen } };
      var T = totals(o), kg = json(o.lines, []).reduce(function (s, l) { var p = st.products.find(function (x) { return x.code === l.product; }); return s + num(l.cartons) * (p ? num(p.kg_per_ctn) : 0); }, 0);
      var remarks = clean('Order ' + o.order_no + ': ' + n0(T.cartons) + ' ctn, ' + T.pallets + ' palet' + (kg > 0 ? ', ± ' + n0(kg) + ' kg' : '') + ', ambil di ' + wn + (str(o.note) ? '. ' + str(o.note) : ''), 200);
      var quote = { serviceType: svc, language: 'id_ID', stops: [{ coordinates: { lat: String(cg.lat), lng: String(cg.lng) }, address: clean(str(w.address) || wn, 200) },
        { coordinates: { lat: String(dg.lat), lng: String(dg.lng) }, address: daddr }] };
      if (sch) quote.scheduleAt = sch;
      return { plan: { order_no: o.order_no, by: by, service: svc, service_name: sv ? clean(sv.description, 40) || svc : svc, schedule_at: sch, eta_at: eta, eta_min: em,
        accept_ot: bool(d.accept_ot), warn: inBreak(wibAt(eta).min, oH) ? 'BREAK' : '', kg: Math.round(kg), price: price, spent: spent, cap: S.lala_cap,
        dest: { lat: dg.lat, lng: dg.lng, address: daddr }, quote: quote,
        order: { sender: { name: clean(wn, 50), phone: '+' + cph }, recipients: [{ name: clean(toko ? str(st.settings.store_name) || 'Khair Mart' : o.dest_name, 50), phone: '+' + rph, remarks: remarks }],
          isPODEnabled: false, metadata: { order_no: o.order_no } } } };
    }
    /** v63: one trip as Lalamove reports it now ({ order_no, lala_order_id, ok, status, driver_id, driver: { name, phone, plate },
        share_link, price }) → the order follows by fixed rules. The same report twice changes nothing (only the time of the look). */
    function lalaSyncOne(it) {
      var o = order(it.order_no), c = o ? lalaTrip(o) : null;
      if (!c || str(c.lala_order_id) !== str(it.lala_order_id)) return { applied: 'not_trip', wa: [] };
      var trip = Object.assign({}, c, { lala_synced_at: now }), s = str(it.status).toUpperCase(), prev = str(c.lala_status), st0 = o.status;
      if (it.ok === false || LALA_STATUSES.indexOf(s) < 0) { // Lalamove did not answer: looked again later, nothing else changes
        trip.lala_error = clean(it.error || 'status ' + s, 120);
        put('orders', Object.assign({}, o, { car: JSON.stringify(trip) })); return { applied: 'error', wa: [] };
      }
      delete trip.lala_error;
      if (urlOf(it.share_link)) trip.share_link = urlOf(it.share_link);
      if (num(it.price) > 0) trip.price = trip.cost = Math.round(num(it.price));
      var dv = it.driver && typeof it.driver === 'object' ? it.driver : null, did = clean(it.driver_id, 40), dn = dv ? clean(dv.name, 40) : '', dpl = dv ? clean(dv.plate, 12).toUpperCase() : '';
      var newDrv = !!(dv && did && did !== str(c.lala_driver_id) && (dn || dpl)), changed = s !== prev, wa = [], applied = [], notes = [];
      if (newDrv) {
        Object.assign(trip, { driver: dn || 'Sopir Lalamove', plate: dpl, driver_wa: normPhone(dv.phone), lala_driver_id: did });
        notes.push((str(c.lala_driver_id) ? 'Sopir Lalamove diganti: ' : 'Sopir Lalamove: ') + trip.driver + (dpl ? ' · ' + dpl : '')); applied.push('driver');
      }
      trip.lala_status = s;
      var row = Object.assign({}, o, { car: JSON.stringify(trip) });
      // each move below changes the order's step, so the same report twice moves it once
      if (LALA_GONE.indexOf(s) >= 0 && st0 === 'car') { // no car after all: book again (counted, like a car cancelled by hand)
        carCancelRow(row, 'Lalamove ' + LALA_WORD[s] + ': ' + (str(c.driver) ? str(c.driver) + ' · ' + str(c.plate) : 'belum ada sopir') + ' — pesan mobil lagi');
        return { applied: 'cancelled', wa: [] };
      }
      if (changed && s === 'PICKED_UP' && st0 === 'car') notes.push('Lalamove: barang sudah diambil — catat mobil masuk lalu berangkat');
      if (changed && LALA_GONE.indexOf(s) >= 0) notes.push('Lalamove: ' + LALA_WORD[s]);
      if (notes.length) row = step(row, st0, notes.join(' · '));
      if ((s === 'PICKED_UP' || s === 'COMPLETED') && ['arrived', 'door', 'loading'].indexOf(st0) >= 0) { // the goods are on the car
        row = departRow(row, 'Lalamove: barang diambil').row; applied.push('departed');
        var dm = waOut(row, 'depart', ctxOf(row)); if (dm) wa.push(dm);
      } else put('orders', row);
      if (s === 'COMPLETED' && row.status === 'departed') { row = put('orders', step(Object.assign({}, row, { delivered_at: now }), 'delivered', 'Lalamove: selesai')); applied.push('delivered'); }
      if (newDrv && row.status === 'car') { var cm = waOut(row, 'car', ctxOf(row)); if (cm) wa.push(cm); } // the same car message as step 5
      return { applied: applied.join('+') || (changed ? 'status' : 'same'), wa: wa };
    }

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
          orders: st.orders.slice(-300).reverse().map(orderOut), overtime: otSummary(st.orders, today.slice(0, 7)),
          // stage 2: the WhatsApp messages of the last days (sent, delivered, read, failed; the cold store's replies), the monthly cap
          wa_log: st.wa_log.slice(-400).map(function (x) { return { at: str(x.at), dir: str(x.dir), kind: str(x.kind), order_no: str(x.order_no), peer: str(x.peer), text: str(x.text), status: str(x.status), error: str(x.error), applied: str(x.applied) }; }),
          wa_cap: S.wa_cap, stamp: stampOf(st.orders, st.wa_log),
          // stage 3: automatic Lalamove (the cap, this month's trips, the shop's place, the city's vehicles); lala_due = the open trips
          // the Worker reads again now (it removes the list before answering)
          lala: lalaOut(), lala_due: lalaDue(st.orders, nowMs, 90, 5, '')
        });
      }
      case 'poll': // the app's light check (every minute while it is on screen): has anything changed since its last look?
        return done({ stamp: stampOf(st.orders, st.wa_log), lala_due: lalaDue(st.orders, nowMs, 90, 5, '') });
      case 'wa_admin': { // automatic WhatsApp: status (owner, manager); register the templates / a test message (owner). The Worker does the calls.
        var wop = str(data.op);
        if (['status', 'templates', 'test'].indexOf(wop) < 0) return fail('INVALID', 'Aksi WhatsApp tidak dikenal');
        if (wop !== 'status' && role !== 'owner') return fail('FORBIDDEN', 'Hanya pemilik');
        if (wop === 'templates') return done({ wa_admin: wop, defs: waTemplateDefs() });
        if (wop === 'test') {
          var tto = normPhone(data.to); if (!tto) return fail('INVALID', 'Nomor WhatsApp tidak valid');
          var tp = WA_TEMPLATES.depart;
          return done({ wa_admin: wop, wa: [{ kind: 'test', order_no: '', to: tto, template: tp.name, lang: WA_LANG, params: tp.example.slice(), payloads: [] }] });
        }
        return done({ wa_admin: wop, names: Object.keys(WA_TEMPLATES).map(function (k) { return WA_TEMPLATES[k].name; }) });
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
        // v63: where the goods go, for Lalamove (a Maps link, a WhatsApp location or "lat,lng"; empty = none); not sent = kept
        var dgs = data.dest_geo !== undefined && data.dest_geo !== null, dgo = dgs && str(data.dest_geo) ? geoOf(data.dest_geo) : null;
        if (dgs && str(data.dest_geo) && !dgo) return fail('INVALID', 'Lokasi tujuan tidak terbaca: ' + GEO_HINT);
        var src = ['photo', 'message', 'manual'].indexOf(str(data.source)) >= 0 ? str(data.source) : 'manual';
        var nth = st.orders.filter(function (o) { return str(o.order_no).indexOf('BRD-' + yymmdd) === 0; }).length + 1;
        var orow = Object.assign({}, oe || { order_no: 'BRD-' + yymmdd + '-' + pad3(nth), status: 'new', created_at: now, created_by: by, source: src, read_by: clean(data.read_by, 40) }, {
          order_date: od, warehouse: ow.code, dest_type: dt, dest_name: dt === 'toko' ? (dn || str(st.settings.store_name) || 'Khair Mart') : dn, dest_phone: dph,
          dest_address: clean(data.dest_address, 200), customer_id: oc ? oc.id : 0, note: clean(data.note, 200), lines: JSON.stringify(ll.lines) });
        if (dgs) { orow.dest_lat = dgo ? dgo.lat : null; orow.dest_lng = dgo ? dgo.lng : null; }
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
          // v63: a Lalamove car still booked through the server is cancelled there first (else it comes, and is paid); when the
          // server cannot reach Lalamove, staff who cancelled it in Lalamove's own app say so (manual)
          if (lalaOpen(o) && !bool(data.manual)) return fail('LALA_ACTIVE', 'Mobil Lalamove otomatis masih dipesan: tekan "Batalkan Lalamove" dulu');
          if (lalaOpen(o)) note += ' (Lalamove dibatalkan sendiri di aplikasinya)';
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
        var srow = put('orders', step(row, to, note));
        return to === 'sent' ? doneWa({ order: orderOut(srow) }, srow, 'order') : done({ order: orderOut(srow) });
      }
      case 'car_save': { // step 5: the car booked (Lalamove, own driver, or — v62 — the customer's own) — its plate and driver go to the cold store
        var co = order(data.order_no); if (!co) return fail('NOT_FOUND', 'Order tidak ada');
        if (co.status !== 'ready' && co.status !== 'car') return fail('INVALID', 'Pesan mobil setelah barang siap');
        if (lalaOpen(co)) return fail('LALA_ACTIVE', 'Mobil Lalamove otomatis masih dipesan: tekan "Batalkan Lalamove" dulu'); // v63: never two cars
        var drv = clean(data.driver, 40), plate = clean(data.plate, 12).toUpperCase(), dwa = str(data.driver_wa) ? normPhone(data.driver_wa) : '';
        if (!drv || !plate) return fail('INVALID', 'Nama sopir dan nomor polisi wajib');
        if (str(data.driver_wa) && !dwa) return fail('INVALID', 'Nomor WhatsApp sopir tidak valid');
        // v62 (owner 2026-10-20: «كثير من الأحيان يقوم الزبون هو باختيار السيارة للموف … فيجب أن تكون هناك مكان لكتابة رسائل الزبون»): the customer
        // booked the car himself — his message is kept with the trip, with its tracking link (typed, else the one in the message);
        // the cost is his (0 unless typed); the driver and the plate are still required (staff type what the message lacks)
        var via = data.via === 'sopir' || data.via === 'pelanggan' ? data.via : 'lalamove', cmsg = '', turl = '';
        if (via === 'pelanggan') {
          cmsg = textOf(data.customer_msg, 1000);
          if (str(data.track_url) && !urlOf(data.track_url)) return fail('INVALID', 'Link lacak tidak valid (http/https, maks. 300 karakter)');
          turl = urlOf(data.track_url) || parseCarMsg(cmsg).link;
        }
        var em = data.eta_min === undefined || data.eta_min === null || data.eta_min === '' ? null : int(data.eta_min);
        if (em !== null && !(em >= 0 && em <= 600)) return fail('INVALID', 'Menit Lalamove 0–600');
        var cH = H(co.warehouse), eta = em !== null && str(co.order_date) <= today ? etaOf(now, em, S.margin) : '', warn = '';
        if (eta) {
          var cov = overtimeAt(eta, cH);
          if (cov.hours > 0 && !bool(data.accept_ot)) return fail('LATE_CAR', 'Mobil diperkirakan tiba ' + hmStr(wibAt(eta).min) + ', lewat ' + cH.close + ': lembur ' + cov.hours + ' jam (' + rpS(cov.cost) + ').', { eta_at: eta, ot_hours: cov.hours, ot_cost: cov.cost });
          if (inBreak(wibAt(eta).min, cH)) warn = 'BREAK';
        }
        var trip = { via: via, vehicle: clean(data.vehicle, 40), driver: drv, driver_wa: dwa, plate: plate, cost: Math.max(0, Math.round(num(data.cost))), eta_min: em, booked_at: now };
        if (via === 'pelanggan') { trip.customer_msg = cmsg; trip.track_url = turl; }
        var crow = Object.assign({}, co, { car: JSON.stringify(trip), eta_at: eta });
        crow = step(crow, 'car', (co.status === 'car' ? 'Mobil diubah: ' : '') + plate + ' · ' + drv + (via === 'pelanggan' ? ' · dipesan pelanggan' : '') + (eta ? ' · tiba ± ' + hmStr(wibAt(eta).min) : '') + (bool(data.accept_ot) && eta && overtimeAt(eta, cH).hours ? ' · risiko lembur disetujui' : ''));
        return doneWa({ order: orderOut(put('orders', crow)), warn: warn }, crow, 'car');
      }
      case 'car_cancel': { // the car was cancelled: back to "book a car", counted; after the last order time that risks overtime
        var xo = order(data.order_no); if (!xo) return fail('NOT_FOUND', 'Order tidak ada');
        if (xo.status !== 'car') return fail('INVALID', 'Belum ada mobil');
        var xr = clean(data.reason, 120); if (xr.length < 3) return fail('INVALID', 'Alasan wajib');
        // v63: a Lalamove car booked through the server is cancelled there ("Batalkan Lalamove"); by hand only when staff cancelled it
        // in Lalamove's own app themselves (the server could not reach Lalamove)
        if (lalaOpen(xo) && !bool(data.manual)) return fail('LALA_ACTIVE', 'Mobil dipesan lewat Lalamove otomatis: tekan "Batalkan Lalamove"');
        var xc = car(xo), xm = lalaOpen(xo) ? ' (dibatalkan sendiri di aplikasi Lalamove)' : '';
        var xx = carCancelRow(xo, 'Mobil batal: ' + str(xc.driver) + ' · ' + str(xc.plate) + ' — ' + xr + xm);
        return done({ order: orderOut(xx.row), risk: xx.risk });
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
        var arow2 = put('orders', step(arow, door ? 'door' : 'arrived', anote));
        return door ? doneWa({ order: orderOut(arow2) }, arow2, 'door') : done({ order: orderOut(arow2) });
      }
      case 'door_save': { // step 7: the door the car drives to (the cold store says it; the driver gets it by WhatsApp)
        var dor = order(data.order_no); if (!dor) return fail('NOT_FOUND', 'Order tidak ada');
        if (['arrived', 'door', 'loading'].indexOf(dor.status) < 0) return fail('INVALID', 'Mobil belum masuk');
        var dno = clean(data.door, 6).toUpperCase(); if (!/^[A-Z0-9-]{1,6}$/.test(dno)) return fail('INVALID', 'Nomor pintu tidak valid');
        var drow = Object.assign({}, dor, { door: dno });
        var drow2 = put('orders', dor.status === 'arrived' ? step(drow, 'door', 'Pintu ' + dno) : step(drow, dor.status, 'Pintu diubah: ' + dno));
        return dno !== str(dor.door) ? doneWa({ order: orderOut(drow2) }, drow2, 'door') : done({ order: orderOut(drow2) });
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
        var dpr = departRow(dp, '');
        return doneWa({ order: orderOut(dpr.row), short: dpr.short }, dpr.row, 'depart');
      }
      case 'cooler_save': { // owner: a cooler's WhatsApp for orders and its hours (empty hours = the owner's defaults)
        var cw = wh(data.code); if (!cw) return fail('NOT_FOUND', 'Gudang tidak ada');
        var waRaw = str(data.wa), wa = waRaw ? normPhone(waRaw) : '';
        if (waRaw && !wa) return fail('INVALID', 'Nomor WhatsApp tidak valid');
        var cfg = { wa: wa }, hx = data.hours && typeof data.hours === 'object' ? data.hours : null, cg0 = geoNum(S.coolers[cw.code]);
        if (cg0) { cfg.lat = cg0.lat; cfg.lng = cg0.lng; } // v63: its place (Pengaturan → Lalamove otomatis) stays
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
        if (data.wa_cap !== undefined) { var wcap = num(data.wa_cap); if (!(wcap >= 0 && wcap <= 100000) || Math.floor(wcap) !== wcap) return fail('INVALID', 'Batas WhatsApp per bulan 0–100.000'); put('settings', { skey: 'brad_wa_cap', svalue: JSON.stringify(wcap) }); }
        if (data.load_min !== undefined) { var lm = num(data.load_min); if (!(lm >= 5 && lm <= 120)) return fail('INVALID', 'Menit muat per palet 5–120'); put('settings', { skey: 'brad_load_min', svalue: JSON.stringify(Math.round(lm)) }); }
        // v63: automatic Lalamove — the month's cap (Rp; 0 = none booked by the server), the shop's place, each cooler's place
        if (data.lala_cap !== undefined) { var lcap = num(data.lala_cap); if (!(lcap >= 0 && lcap <= 1000000000) || Math.floor(lcap) !== lcap) return fail('INVALID', 'Batas biaya Lalamove per bulan Rp 0–1.000.000.000'); put('settings', { skey: 'brad_lala_cap', svalue: JSON.stringify(lcap) }); }
        if (data.store_geo !== undefined) {
          var sgt = str(data.store_geo), sgo = sgt ? geoOf(sgt) : null;
          if (sgt && !sgo) return fail('INVALID', 'Lokasi toko tidak terbaca: ' + GEO_HINT);
          put('settings', { skey: 'brad_store_geo', svalue: JSON.stringify(sgo ? { lat: sgo.lat, lng: sgo.lng, address: clean(data.store_address, 200) } : null) });
        }
        if (data.cooler_geo !== undefined) {
          var cgi = data.cooler_geo, cga = Object.assign({}, S.coolers);
          if (!cgi || typeof cgi !== 'object' || Array.isArray(cgi)) return fail('INVALID', 'Lokasi gudang tidak valid');
          var cgk = Object.keys(cgi).slice(0, 30);
          for (var gi = 0; gi < cgk.length; gi++) {
            var gw = wh(cgk[gi]); if (!gw) return fail('NOT_FOUND', 'Gudang tidak ada: ' + cgk[gi]);
            var gt = str(cgi[cgk[gi]]), gg = gt ? geoOf(gt) : null, gc = Object.assign({}, cga[gw.code] || {});
            if (gt && !gg) return fail('INVALID', 'Lokasi gudang ' + gw.name + ' tidak terbaca: ' + GEO_HINT);
            if (gg) { gc.lat = gg.lat; gc.lng = gg.lng; } else { delete gc.lat; delete gc.lng; }
            cga[gw.code] = gc;
          }
          put('settings', { skey: 'brad_coolers', svalue: JSON.stringify(cga) });
        }
        return done({});
      }
      /* ---------- v63 stage 3: automatic Lalamove (the Worker calls Lalamove around these; see worker/src/brad.js) ---------- */
      case 'lala_plan': { // staff: the booking to price (no network here) — from 'ready', or 'car' with a car typed by hand
        var lo2 = order(data.order_no); if (!lo2) return fail('NOT_FOUND', 'Order tidak ada');
        if (lo2.status !== 'ready' && lo2.status !== 'car') return fail('INVALID', 'Pesan mobil setelah barang siap');
        if (lalaOpen(lo2)) return fail('LALA_ACTIVE', 'Mobil Lalamove sudah dipesan: batalkan dulu untuk memesan lagi');
        var lp = lalaPlan(lo2, data);
        return lp.err ? fail(lp.code, lp.err, lp.extra) : done({ plan: lp.plan });
      }
      case 'lala_booked': { // system: Lalamove took the order — the trip is kept; the driver comes later (lala_sync)
        var bo = order(data.order_no); if (!bo) return fail('NOT_FOUND', 'Order tidak ada');
        if (bo.status !== 'ready' && bo.status !== 'car') return fail('INVALID', 'Order sudah ' + bo.status);
        if (lalaOpen(bo)) return fail('LALA_ACTIVE', 'Mobil Lalamove sudah dipesan untuk order ini');
        var pl = data.placed && typeof data.placed === 'object' ? data.placed : {}, qt = data.quote && typeof data.quote === 'object' ? data.quote : {};
        var lid = clean(pl.order_id, 64); if (!lid) return fail('INVALID', 'Order Lalamove tanpa nomor');
        var lpr = Math.round(num(pl.price) || num(qt.price)), beta = str(data.eta_at) && !isNaN(Date.parse(data.eta_at)) ? new Date(Date.parse(data.eta_at)).toISOString() : '';
        var bsch = str(data.schedule_at) && !isNaN(Date.parse(data.schedule_at)) ? new Date(Date.parse(data.schedule_at)).toISOString() : '';
        var bem = data.eta_min === undefined || data.eta_min === null || data.eta_min === '' ? null : int(data.eta_min);
        var trip0 = { via: 'lalamove_api', vehicle: clean(data.service_name, 40) || clean(data.service, 40), service: clean(data.service, 40), driver: '', driver_wa: '', plate: '',
          cost: lpr, price: lpr, currency: clean(qt.currency, 5) || 'IDR', eta_min: bem >= 0 ? bem : null, booked_at: now, schedule_at: bsch, lala_order_id: lid,
          lala_quote_id: clean(qt.id, 64), share_link: urlOf(pl.share_link), lala_status: LALA_STATUSES.indexOf(str(pl.status)) >= 0 ? str(pl.status) : 'ASSIGNING_DRIVER',
          lala_synced_at: now, distance_m: Math.max(0, Math.round(num(qt.distance_m))) };
        var brow = Object.assign({}, bo, { car: JSON.stringify(trip0), eta_at: beta }), bdg = geoNum(data.dest), bov = beta ? overtimeAt(beta, H(bo.warehouse)) : { hours: 0 };
        if (bdg) { brow.dest_lat = bdg.lat; brow.dest_lng = bdg.lng; if (clean(data.dest.address, 200)) brow.dest_address = clean(data.dest.address, 200); }
        brow = step(brow, 'car', (bo.status === 'car' ? 'Mobil diubah: ' : '') + 'Lalamove otomatis · ' + trip0.vehicle + ' · ' + rpS(lpr) + ' · mobil dipesan, mencari sopir' +
          (bsch ? ' · jemput ' + hmStr(wibAt(bsch).min) : beta ? ' · tiba ± ' + hmStr(wibAt(beta).min) : '') + (bool(data.accept_ot) && bov.hours ? ' · risiko lembur disetujui' : ''));
        return done({ order: orderOut(put('orders', brow)) });
      }
      case 'lala_sync': { // system: what Lalamove says now about each open trip (the Worker has just read it)
        var lsr = (Array.isArray(data.items) ? data.items.slice(0, 20) : []).map(function (it) { return lalaSyncOne(it && typeof it === 'object' ? it : {}); });
        var lsw = []; lsr.forEach(function (r) { r.wa.forEach(function (m) { lsw.push(m); }); });
        return done({ applied: lsr.map(function (r) { return r.applied; }), wa: lsw });
      }
      case 'lala_cancel': { // staff: may this Lalamove car be cancelled? (the Worker then cancels it at Lalamove → lala_cancelled)
        var co2 = order(data.order_no); if (!co2) return fail('NOT_FOUND', 'Order tidak ada');
        var ct = lalaTrip(co2); if (!ct || !lalaOpen(co2)) return fail('INVALID', 'Tidak ada mobil Lalamove otomatis yang berjalan');
        if (co2.status !== 'car' || ['PICKED_UP', 'COMPLETED'].indexOf(str(ct.lala_status)) >= 0) return fail('INVALID', 'Mobil sudah masuk / barang sudah diambil: tidak bisa dibatalkan');
        var cr = clean(data.reason, 120); if (cr.length < 3) return fail('INVALID', 'Alasan wajib');
        return done({ cancel: { order_no: co2.order_no, lala_order_id: str(ct.lala_order_id), reason: cr, by: by } });
      }
      case 'lala_cancelled': { // system: Lalamove has cancelled it — back to "book a car"
        var lc = order(data.order_no), lct = lc ? lalaTrip(lc) : null;
        if (!lct || str(lct.lala_order_id) !== str(data.lala_order_id)) return fail('NOT_FOUND', 'Mobil Lalamove tidak ada');
        if (lc.status !== 'car') return fail('INVALID', 'Mobil sudah masuk');
        var lcx = carCancelRow(lc, 'Lalamove dibatalkan: ' + (str(lct.driver) ? str(lct.driver) + ' · ' + str(lct.plate) : 'belum ada sopir') + ' — ' + clean(data.reason, 120));
        return done({ order: orderOut(lcx.row), risk: lcx.risk });
      }
      case 'lala_due': { // system: the open trips to read again (the cron every 2 minutes, Lalamove's webhook)
        var age = num(data.max_age) >= 10 ? num(data.max_age) : 90;
        return done({ due: lalaDue(st.orders, nowMs, age, Math.min(10, Math.max(1, int(data.max) || 5)), clean(data.lala_order_id, 64)) });
      }
      case 'lala_admin': { // owner / manager: is it set up (the Worker adds its keys) · "Tes koneksi" (the Worker reads the cities)
        var lop = str(data.op); if (['status', 'test'].indexOf(lop) < 0) return fail('INVALID', 'Aksi Lalamove tidak dikenal');
        return done({ lala_admin: lop, lala: lalaOut() });
      }
      case 'lala_services': { // system: the vehicles Lalamove offers in the city, kept for the car form
        var svl = (Array.isArray(data.services) ? data.services : []).slice(0, 30).map(function (x) {
          x = x && typeof x === 'object' ? x : {}; var k = str(x.key).toUpperCase(), ld = x.load && typeof x.load === 'object' ? x.load : null;
          return /^[A-Z0-9_]{2,40}$/.test(k) ? { key: k, description: clean(x.description, 60) || k, load: ld && num(ld.value) > 0 ? { value: num(ld.value), unit: clean(ld.unit, 6) || 'kg' } : null } : null;
        }).filter(Boolean), cty = data.city && typeof data.city === 'object' ? { locode: clean(data.city.locode, 20), name: clean(data.city.name, 60) } : null;
        put('settings', { skey: 'brad_lala_services', svalue: JSON.stringify({ at: now, city: cty, services: svl }) });
        S.lala_services = { at: now, city: cty, services: svl };
        return done({ lala: lalaOut() });
      }
      default:
        return fail('INVALID', 'Aksi tidak dikenal: ' + action);
    }
  }
  return { core: core, STEPS: STEPS, LIVE: LIVE, HOURS: HOURS, ETA_MARGIN: ETA_MARGIN, LOAD_MIN: LOAD_MIN, OT_CAUSES: OT_CAUSES,
    hoursOf: hoursOf, hm: hm, hmStr: hmStr, rpS: rpS, wibAt: wibAt, atWib: atWib, dayKind: dayKind, nextWorkDay: nextWorkDay, holidayName: holidayName,
    overtimeAt: overtimeAt, inBreak: inBreak, etaOf: etaOf, timeAlerts: timeAlerts, otSummary: otSummary, readReply: readReply, readJson: readJson,
    readRules: readRules, draftOf: draftOf, readPrompt: readPrompt, parseCarMsg: parseCarMsg, msgOrder: msgOrder, msgCar: msgCar, msgDoor: msgDoor, msgDepart: msgDepart, dLong: dLong,
    WA_TEMPLATES: WA_TEMPLATES, WA_LANG: WA_LANG, waOut: waOut, waEvent: waEvent, waTemplateDefs: waTemplateDefs, stampOf: stampOf,
    LALA_CAP: LALA_CAP, LALA_PICKUP_MIN: LALA_PICKUP_MIN, LALA_STATUSES: LALA_STATUSES, LALA_FINAL: LALA_FINAL, geoOf: geoOf, geoNum: geoNum,
    lalaTrip: lalaTrip, lalaOpen: lalaOpen, lalaSpent: lalaSpent, lalaDue: lalaDue, lalaServiceFor: lalaServiceFor };
})();
if (typeof window !== 'undefined') window.KBrad = KBrad;
