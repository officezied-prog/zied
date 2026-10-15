/* Khair Mart — one sale paid by several methods (v51, owner 2026-10-15: «إمكانية البيع كل فاتورة مثلا نصف نقدا والنصف الآخر عن طريق
   الجوال أو التحويل أو أي شيء فإمكانية تجزئة الدفع حسب عدة أنواع طرق للدفع»). The same rules as the server (backend/process.js
   payPartsIn / saleParts), used by the apps' screens and their demo backends:
     KPay.partsIn([{method, amount}], total) → { parts: [{m, a}], paid, method } | { error }
       two or more methods → method 'campur' with its parts; one method → that method, no parts; nothing paid → 'hutang'.
     KPay.of(sale) → { tunai, transfer, qris }: what the sale brought in by method (never more than its total; a hutang down
       payment is cash).
     KPay.lines(sale) → [{ m, a }]: the paid parts to show on a receipt / list (a single method → one line). */
(function () {
  'use strict';
  if (window.KPay) return;
  var M = ['tunai', 'transfer', 'qris'];
  function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function partsOfSale(s) {
    if (!s || String(s.payment_method) !== 'campur') return null;
    var p = s.pay_parts;
    if (typeof p === 'string') { try { p = JSON.parse(p || '[]'); } catch (e) { p = null; } }
    return Array.isArray(p) && p.length ? p.filter(function (x) { return x && M.indexOf(x.m) >= 0 && n(x.a) > 0; }) : null;
  }
  window.KPay = {
    METHODS: M,
    partsIn: function (list, total) {
      if (!Array.isArray(list) || !list.length) return { error: 'Tidak ada pembayaran' };
      var acc = { tunai: 0, transfer: 0, qris: 0 };
      for (var i = 0; i < list.length; i++) {
        var x = list[i] || {}, m = String(x.method || ''), a = Number(x.amount);
        if (M.indexOf(m) < 0) return { error: 'Cara bayar tidak valid: ' + m.slice(0, 20) };
        if (!isFinite(a) || a < 0 || a > 1e12) return { error: 'Jumlah ' + m + ' tidak valid' };
        acc[m] += Math.round(a);
      }
      var parts = M.filter(function (m) { return acc[m] > 0; }).map(function (m) { return { m: m, a: acc[m] }; });
      var paid = parts.reduce(function (t, p) { return t + p.a; }, 0);
      if (total !== undefined && paid > n(total)) return { error: 'Jumlah pembayaran lebih dari total' };
      return { parts: parts.length > 1 ? parts : [], paid: paid, method: parts.length > 1 ? 'campur' : parts.length ? parts[0].m : 'hutang' };
    },
    of: function (s) {
      var o = { tunai: 0, transfer: 0, qris: 0 }, p = partsOfSale(s);
      if (p) { p.forEach(function (x) { o[x.m] += n(x.a); }); return o; }
      var m = s && o[s.payment_method] !== undefined ? s.payment_method : 'tunai';
      o[m] += Math.min(n(s && s.paid_amount), n(s && s.total));
      return o;
    },
    lines: function (s) {
      var p = partsOfSale(s);
      if (p) return p.map(function (x) { return { m: x.m, a: n(x.a) }; });
      return [{ m: s ? s.payment_method : 'tunai', a: Math.min(n(s && s.paid_amount), n(s && s.total)) }];
    }
  };
})();
