/* Khair Mart — the sizes written in product names (v72, owner 2026-10-22: «هناك خطاء في العملية الحسابية»). A pack's content is
   kept in its BULK product's unit (repack_qty): "Garam Himalaya 1 kg" from "Garam Himalaya 25 Kg" counted in karung is 0.04 karung
   a pack. It had been set up as 1 (the kilogram typed where a karung was asked), so 2 karung gave "2 packs" instead of 50. Now the
   apps and the server read the sizes the two names already say (kg, g, gr, gram, ons, L, ml …; "10 x 500 g" = 5 kg), propose the
   content from them, accept it typed as "1 kg" / "500 g", and refuse a content that does not match the names (3 % tolerance).
   One file for three places: the owner app, the cashier app (window.KMeasure) and the Worker's POS process (concatenated by
   worker/build.js before backend/process.js). Pure: no network, no storage, no clock.
     KMeasure.of(name, unit)       → { d: 'w' (grams) | 'v' (millilitres), q } of ONE unit, or null when nothing (or two different
                                     sizes) is written. A weight / volume unit ("kg", "liter") wins over the name.
     KMeasure.size(bulk, pack)     → the pack's content in the bulk's unit from the two names (e.g. 0.04), or 0
     KMeasure.fits(size, want)     → size within 3 % of want
     KMeasure.input(text, bulk)    → { size, typed } from "0,04" or "1 kg" / "500 gr" (converted with the bulk's size), or
                                     { error: 'bulk' (the bulk's size is unknown) | 'dim' (kg against litres) | 'num' }
     KMeasure.text(m)              → "1 kg", "500 g", "1,5 L", "250 ml"
     KMeasure.packs(fromQty, size) → whole packs from that much bulk (what the server plans, the screens show)
     KMeasure.round(size)          → the size as it is stored (12 decimals: 1/18 must not become 0.056 — 17 packs instead of 18)
     KMeasure.label(bulk, pack, s) → "0,04 karung (1 kg)": a content as the screens show it
     KMeasure.inputText(b, p, s)   → what a content box shows: "1 kg" when that is exactly what the names give (saved exact again)
     KMeasure.amountText(b, qty)   → "50 kg" for 2 karung of 25 kg; '' when unknown or the bulk is counted in kg / L itself */
var KMeasure = (function () {
  'use strict';
  // unit word → [dimension, amount in grams / millilitres]
  var U = {
    kg: ['w', 1000], kgs: ['w', 1000], kilo: ['w', 1000], kilogram: ['w', 1000], kilogramm: ['w', 1000],
    g: ['w', 1], gr: ['w', 1], grm: ['w', 1], gram: ['w', 1], gm: ['w', 1], ons: ['w', 100], ton: ['w', 1000000],
    l: ['v', 1000], lt: ['v', 1000], ltr: ['v', 1000], liter: ['v', 1000], litre: ['v', 1000], ml: ['v', 1], cc: ['v', 1]
  };
  var WORDS = 'kilogramm|kilogram|kilo|kgs|kg|gram|grm|gr|gm|g|ons|ton|liter|litre|ltr|lt|ml|cc|l';
  var RE = new RegExp('(\\d+(?:[.,]\\d+)?(?:\\s*\\/\\s*\\d+)?)\\s*(' + WORDS + ')(?![a-z])', 'g');
  function numOf(s, base) {
    s = String(s).replace(/\s+/g, '');
    if (s.indexOf('/') > 0) { var f = s.split('/'), a = Number(f[0].replace(',', '.')), b = Number(f[1]); return b > 0 ? a / b : NaN; }
    // Indonesian thousands: "1.000 gr" = 1000 g (only for grams / millilitres: "1.250 kg" stays 1.25 kg)
    if (base === 1 && /^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
    return Number(s.replace(',', '.'));
  }
  function parse(text) {
    var s = String(text || '').toLowerCase().replace(/(\d)\s*½/g, '$1.5').replace(/½/g, '0.5').replace(/¼/g, '0.25').replace(/¾/g, '0.75');
    var found = [], m;
    RE.lastIndex = 0;
    while ((m = RE.exec(s))) {
      var u = U[m[2]], q = numOf(m[1], u[1]);
      if (m.index > 0 && /[a-z]/.test(s.charAt(m.index - 1))) continue; // "A4", "B12": not a size
      if (!(q > 0)) continue;
      var before = s.slice(0, m.index), after = s.slice(m.index + m[0].length);
      var mb = /(\d+)\s*[x×*]\s*$/.exec(before), ma = /^\s*[x×*]\s*(\d+)(?!\s*[.,]?\d*\s*(?:kilogramm|kilogram|kilo|kgs|kg|gram|grm|gr|gm|g|ons|ton|liter|litre|ltr|lt|ml|cc|l)(?![a-z]))/.exec(after);
      var times = (mb ? Number(mb[1]) : 1) * (ma ? Number(ma[1]) : 1);
      found.push({ d: u[0], q: q * u[1] * (times > 0 ? times : 1), x: times > 1 });
    }
    if (!found.length) return null;
    // "1 kg (isi 10)", "500 g 12 pcs", "@5": a count beside the size — how much one unit holds is unclear, so nothing is checked
    if (!found.some(function (f) { return f.x; }) && /(^|[^a-z])isi\s*\d|@\s*\d|\d+\s*(pcs|pc|bks|bungkus|btl|botol|sachet|saset|pak|pack|toples|box|dus|ctn|bal|lusin|biji|buah|rtg|renteng)(?![a-z])/.test(s)) return null;
    for (var i = 1; i < found.length; i++) if (found[i].d !== found[0].d || Math.abs(found[i].q - found[0].q) > found[0].q * 0.001) return null; // two different sizes: unclear
    return { d: found[0].d, q: found[0].q };
  }
  function of(name, unit) {
    var u = String(unit || '').toLowerCase().trim();
    if (U[u]) return { d: U[u][0], q: U[u][1] };
    if (/\d/.test(u)) { var pu = parse(u); if (pu) return pu; }
    return parse(name);
  }
  function size(bulk, pack) {
    if (!bulk || !pack) return 0;
    var a = of(bulk.name, bulk.unit), b = of(pack.name, pack.unit);
    if (!a || !b || a.d !== b.d || !(a.q > 0)) return 0;
    return round(b.q / a.q);
  }
  function fits(sz, want) { sz = Number(sz); want = Number(want); return want > 0 && sz > 0 && Math.abs(sz - want) <= want * 0.03; }
  function round(sz) { return Math.round(Number(sz) * 1e12) / 1e12; }
  function fmt(x) { var r = Math.round(x * 1000) / 1000; return String(r).replace('.', ','); }
  function text(m) {
    if (!m || !(m.q > 0)) return '';
    if (m.d === 'w') return m.q >= 1000 ? fmt(m.q / 1000) + ' kg' : fmt(m.q) + ' g';
    return m.q >= 1000 ? fmt(m.q / 1000) + ' L' : fmt(m.q) + ' ml';
  }
  function input(txt, bulk) {
    var s = String(txt == null ? '' : txt).trim();
    if (!s) return { error: 'num' };
    if (/^\d+(?:[.,]\d+)?$/.test(s)) { var n = Number(s.replace(',', '.')); return n > 0 ? { size: round(n), typed: '' } : { error: 'num' }; }
    var m = parse(s);
    if (!m) return { error: 'num' };
    var a = bulk ? of(bulk.name, bulk.unit) : null;
    if (!a) return { error: 'bulk' };
    if (a.d !== m.d) return { error: 'dim' };
    return { size: round(m.q / a.q), typed: text(m) };
  }
  function num4(x) { return String(Math.round(Number(x) * 10000) / 10000).replace('.', ','); }
  function measureUnit(bulk) { return !!U[String((bulk && bulk.unit) || '').toLowerCase().trim()]; }
  function label(bulk, pack, sz) {
    var bu = String((bulk && bulk.unit) || ''), s = num4(sz) + (bu ? ' ' + bu : ''), want = size(bulk, pack);
    return want && fits(sz, want) && !measureUnit(bulk) ? s + ' (' + text(of(pack.name, pack.unit)) + ')' : s;
  }
  function inputText(bulk, pack, sz) {
    var want = size(bulk, pack);
    if (want && Math.abs(Number(sz) - want) <= want * 1e-6) return text(of(pack.name, pack.unit));
    return Number(sz) > 0 ? String(round(sz)).replace('.', ',') : '';
  }
  function amountText(bulk, qty) { var a = bulk ? of(bulk.name, bulk.unit) : null; return a && !measureUnit(bulk) && Number(qty) > 0 ? text({ d: a.d, q: a.q * Number(qty) }) : ''; }
  function packs(fromQty, sz) { fromQty = Number(fromQty); sz = Number(sz); return sz > 0 && fromQty > 0 ? Math.floor(fromQty / sz * (1 + 1e-7) + 1e-9) : 0; }
  return { of: of, size: size, fits: fits, input: input, text: text, packs: packs, round: round, parse: parse, label: label, inputText: inputText, amountText: amountText };
})();
if (typeof window !== 'undefined') window.KMeasure = KMeasure;
