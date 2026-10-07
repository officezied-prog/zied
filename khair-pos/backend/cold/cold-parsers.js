/* Khair Gudang Dingin — readers for the warehouses' daily stock reports (pure functions, no I/O).
   One source for the n8n workflow (Code node "Process Cold" = cold-parsers.js + cold-core.js + process-cold.js)
   and the page's demo mode.

   Input is always text: a WhatsApp message, cells copied from Excel (tab separated), or an .xlsx file that the page
   turned into tab-separated text (one block per sheet). Output: { format, report_date, items, ignored, unparsed }
     items    = [{ pallet?, item?, product?, lot?, cartons, kg?, date_in?, exp_date?, zone?, container_no?, line }]
     ignored  = titles, headers, sub totals (recognised, not stock)
     unparsed = lines we could not read — always shown to the user, never dropped.

   TUNING: each warehouse has a parser code (Pengaturan → Gudang → Format laporan). Today 'dpp', 'bosko' and 'kawanishi'
   all use `generic`, which already reads the DPP "LAPORAN STOCK PER-PID" Excel (PID | Item # | Lot.No | Spec Product |
   Tanggal Masuk | Expire Date | ... | Stock Akhir MC | Kg). When a real Bosko / Kawanishi message arrives, write
   `bosko(text)` here (start from `generic`) and add a sample to test-cold.js. */
var KColdParsers = (function () {
  'use strict';
  var UNIT = '(?:ctn|ctns|carton|cartons|karton|krt|dus|box|bx|mc|cs)';
  var RE_UNIT = new RegExp('(\\d[\\d.,]*)\\s*' + UNIT + '\\b', 'i');
  var RE_IGNORE = /^(sub\s*total|total|grand|jumlah|laporan|report|customer|id customer|item\s*#|no\b|pid\b|stock|stok awal|informasi|spec|date|time|tanggal|mc\b|kg|kgs|pallet\b|\(bulan\)|waktu|selamat|assalam|terima kasih|thanks|berikut|=+|-+$)/i;

  function cell(v) { return v === undefined || v === null ? '' : String(v).replace(/ /g, ' ').trim(); }
  function rowsOf(text) {
    return String(text || '').replace(/\r/g, '').split('\n').map(function (l) {
      var r = l.indexOf('\t') >= 0 ? l.split('\t').map(cell) : [cell(l)];
      while (r.length && r[r.length - 1] === '') r.pop();
      return r;
    });
  }
  function lineOf(r) { return r.filter(function (c) { return c !== ''; }).join(' | '); }
  /** Whole cartons: "1.200" / "1,200" = 1200 (Indonesian thousands), "120" = 120. */
  function toInt(v) {
    var s = cell(v).replace(/\s/g, '');
    if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
    var n = Number(s.replace(',', '.'));
    return s !== '' && isFinite(n) ? Math.round(n) : NaN;
  }
  function toNum(v) { var s = cell(v).replace(/\s/g, ''); if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, ''); var n = Number(s.replace(',', '.')); return s !== '' && isFinite(n) ? n : NaN; }
  /** "2025-04-26 00:00:00", "26/04/2025", "26-04-2025" or an Excel day number (45773) → "2025-04-26"; else ''. */
  function toDate(v) {
    var s = cell(v), m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    if (/^\d{5}(\.\d+)?$/.test(s)) { var n = Number(s); if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10); }
    return '';
  }
  function containerOf(s) { var m = String(s || '').toUpperCase().match(/\b([A-Z]{4})\s?-?(\d{7})\b/); return m ? m[1] + m[2] : ''; }
  function isNumCell(c) { return c !== '' && !isNaN(toNum(c)); }
  function isItemCode(c) { return /^\d{2,5}-\d{2,5}$/.test(c); }

  /** Reads tables (DPP per-pallet and per-item sheets, or any copy with the same shape) and free WhatsApp lines. */
  function generic(text) {
    var out = { format: 'generic', report_date: '', items: [], ignored: [], unparsed: [] }, perItem = [], zone = '';
    rowsOf(text).forEach(function (r) {
      var L = lineOf(r);
      if (!L || /^[=\-_*~. ]+$/.test(L)) return;
      var cells = r.filter(function (c) { return c !== ''; });
      // a zone heading: "FROZEN" / "CHILLER" (maybe with totals after it)
      var z = cells.find(function (c) { return /^(frozen|chiller|dry|ambient)$/i.test(c); }), zt = L.match(/\((frozen|chiller|dry|ambient)\)/i);
      if (zt) zone = zt[1].toUpperCase();
      if (z && !cells.some(isItemCode)) { zone = z.toUpperCase(); out.ignored.push(L); return; }
      // the report date: a row that is only a date
      if (cells.length <= 2 && toDate(cells[0]) && cells.slice(1).every(function (c) { return /^wib$/i.test(c); })) { if (!out.report_date) out.report_date = toDate(cells[0]); out.ignored.push(L); return; }
      // per-pallet row: ... PID | Item # | Lot | Product | Tanggal Masuk | Expire | ... | MC akhir | Kg akhir
      var p = r.findIndex(function (c, i) { return /^\d{5,10}$/.test(c) && isItemCode(r[i + 1] || ''); });
      if (p >= 0) {
        var nums = r.slice(p + 4).filter(isNumCell);
        var dIn = toDate(r[p + 4]), dExp = toDate(r[p + 5]);
        var tail = r.slice(p + 6).filter(isNumCell);
        if (tail.length >= 2) {
          var mc = toInt(tail[tail.length - 2]), kg = toNum(tail[tail.length - 1]);
          out.items.push({ pallet: r[p], item: r[p + 1], lot: r[p + 2] || '', product: r[p + 3] || '', cartons: mc, kg: kg, date_in: dIn, exp_date: dExp,
            zone: zone, container_no: containerOf(r[p + 2]), line: L });
          return;
        }
        if (nums.length) { out.unparsed.push(L); return; }
      }
      // per-item row: Item # | Description | Net | ... | MC akhir | KGS akhir | Pallet akhir
      if (isItemCode(r[0] || '') && /[a-z]/i.test(r[1] || '')) {
        var n = r.slice(2).filter(isNumCell);
        if (n.length >= 4) { perItem.push({ item: r[0], product: r[1], kg_per_ctn: toNum(r[2]), cartons: toInt(n[n.length - 3]), kg: toNum(n[n.length - 2]), pallets: toInt(n[n.length - 1]), zone: zone, line: L }); return; }
      }
      if (RE_IGNORE.test(cells[0]) || RE_IGNORE.test(L) || cells.every(function (c) { return isNumCell(c) || /^(wib|:)$/i.test(c); })) { out.ignored.push(L); return; }
      // free text (WhatsApp): "Sukari 3kg PLT-07 lot 2408 ... 120 ctn"
      if (cells.length === 1) {
        var s = cells[0].replace(/^\s*(?:[-•*·]|\d{1,3}[.)])\s+/, ''), item = { line: L, zone: zone };
        var u = s.match(RE_UNIT), tailNum = s.match(/(?:^|\s|[=:])(\d[\d.,]*)\s*$/);
        if (u) { item.cartons = toInt(u[1]); s = s.replace(u[0], ' '); }
        else if (tailNum && /[a-z]/i.test(s)) { item.cartons = toInt(tailNum[1]); s = s.slice(0, s.length - tailNum[0].length); }
        if (item.cartons !== undefined && !isNaN(item.cartons)) {
          var pm = s.match(/\b(pid|plt|pallet|palet)(\s*[:#.]?\s*|-)([A-Z0-9][A-Z0-9\-]*)/i); // "PID 2274537", "PLT-07"
          if (pm) { item.pallet = (pm[2] === '-' ? pm[1] + '-' + pm[3] : pm[3]).toUpperCase(); s = s.replace(pm[0], ' '); }
          var lm = s.match(/\b(?:lot|batch)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\/\-]*)/i);
          if (lm) { item.lot = lm[1]; s = s.replace(lm[0], ' '); }
          var km = s.match(/(\d[\d.,]*)\s*kg\b/i);
          if (km) item.kg = toNum(km[1]);
          item.product = s.replace(/[:=|]+/g, ' ').replace(/\s+/g, ' ').trim();
          item.container_no = containerOf(s);
          if (item.product || item.pallet) { out.items.push(item); return; }
        }
      }
      out.unparsed.push(L);
    });
    // the per-item sheet repeats the per-pallet sheets: use it only when there are no pallet rows
    if (!out.items.some(function (x) { return x.pallet && x.item; })) out.items = out.items.concat(perItem);
    else perItem.forEach(function (x) { out.ignored.push(x.line); });
    if (out.items.some(function (x) { return x.item; })) out.format = 'table';
    return out;
  }

  var parsers = { generic: generic, dpp: generic, bosko: generic, kawanishi: generic };
  function parse(code, text) { var f = parsers[String(code || '').toLowerCase()] || generic; var r = f(text); r.parser = parsers[code] ? code : 'generic'; return r; }
  return { parse: parse, parsers: parsers, toDate: toDate, toInt: toInt, toNum: toNum, containerOf: containerOf, rowsOf: rowsOf };
})();
if (typeof window !== 'undefined') window.KColdParsers = KColdParsers;
