/* Khair Gudang Dingin — documents (v1). Pure builders that return HTML strings (every value goes through esc()):
     order(o, ctx)   Surat Pengambilan Barang (SPB) A4: header, number, table, signature boxes Dibuat / Gudang / Sopir / Penerima
     check(c, ctx)   Laporan cek stok harian (result of one daily check)
     stock(rep, ctx) Laporan stok gudang (balances on a date, per warehouse / product, expiries)
     waOrder(o, ctx) the pick order as WhatsApp text for the warehouse
   plus file helpers without libraries: toDoc(html, filename) → .doc (HTML with the Word MIME type),
   toXls(rows, filename) → .xls (SpreadsheetML 2003), rows = [[cell, ...], ...] (first row = header).
   ctx = { company: {name, store, address, phone}, wh: {code: warehouse}, pr: {code: product}, now: Date } */
(function (root) {
  var CSS = '<style>@page{size:A4;margin:12mm}.kdoc{font:12px/1.45 Arial,Helvetica,sans-serif;color:#000;background:#fff;max-width:186mm;margin:0 auto}' +
    '.kdoc h1{font-size:18px;margin:0 0 2px}.kdoc .hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:10px}' +
    '.kdoc .meta{text-align:right}.kdoc .box{border:1px solid #000;padding:6px 8px;margin-bottom:10px}.kdoc .two{display:flex;gap:10px}.kdoc .two .box{flex:1}' +
    '.kdoc table{width:100%;border-collapse:collapse;margin-bottom:8px}.kdoc th,.kdoc td{border:1px solid #000;padding:4px 6px;vertical-align:top;text-align:left}' +
    '.kdoc th{background:#eee}.kdoc .n{text-align:right;white-space:nowrap}.kdoc .bad{font-weight:bold}.kdoc .sig{display:flex;gap:12px;margin-top:24px}' +
    '.kdoc .sig div{flex:1;text-align:center}.kdoc .sig .line{margin-top:56px;border-top:1px solid #000;padding-top:2px}.kdoc .ft{margin-top:14px;font-size:10px;color:#333}' +
    '.kdoc h2{font-size:14px;margin:12px 0 4px}.kdoc .stamp{border:3px solid #000;display:inline-block;padding:2px 10px;font-weight:bold;font-size:16px}</style>';
  var MON = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n0(v) { var n = Math.round(Number(v) || 0); return (n < 0 ? '-' : '') + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function kg(v) { var n = Math.round((Number(v) || 0) * 10) / 10; return n0(Math.trunc(n)) + (n % 1 ? ',' + Math.abs(Math.round(n * 10) % 10) : ''); }
  function rp(v) { return 'Rp ' + n0(v); }
  function date(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[3] + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1] : ''; }
  function wib(iso) { if (!iso) return ''; var d = new Date(Date.parse(iso) + 7 * 3600000).toISOString(); return date(d) + ' ' + d.slice(11, 16) + ' WIB'; }
  function head(title, no, ctx, extra) {
    var c = ctx.company || {};
    return CSS + '<div class="kdoc"><div class="hd"><div><b style="font-size:16px">' + esc(c.name || 'Khair Mart') + '</b><div>' + esc(c.store || '') + '</div><div>' + esc(c.address || '') + '</div>' +
      (c.phone ? '<div>' + esc(c.phone) + '</div>' : '') + '</div><div class="meta"><h1>' + esc(title) + '</h1>' + (no ? '<div><b>' + esc(no) + '</b></div>' : '') + (extra || '') + '</div></div>';
  }
  function foot(ctx) { return '<div class="ft">Dicetak ' + esc(wib((ctx.now || new Date()).toISOString())) + ' · Khair Gudang Dingin</div></div>'; }
  function whName(ctx, code) { var w = (ctx.wh || {})[code]; return w ? w.name : code; }
  function prName(ctx, code) { var p = (ctx.pr || {})[code]; return p ? p.name : code; }
  function orderTotals(o, ctx) {
    var c = 0, k = 0;
    (o.lines || []).forEach(function (l) { var p = (ctx.pr || {})[l.product] || {}, pal = (ctx.pal || {})[l.pallet_code] || {}; c += Number(l.cartons) || 0; k += (Number(l.cartons) || 0) * (Number(pal.kg_per_ctn) || Number(p.kg_per_ctn) || 0); });
    return { cartons: c, kg: Math.round(k * 10) / 10 };
  }

  function order(o, ctx) {
    var w = (ctx.wh || {})[o.warehouse] || {}, t = orderTotals(o, ctx);
    var st = o.status === 'cancelled' ? '<div class="stamp">DIBATALKAN</div>' : o.status === 'picked' ? '<div class="stamp">SUDAH DIAMBIL</div>' : '';
    var h = head('SURAT PENGAMBILAN BARANG', o.order_no, ctx, '<div>Tanggal ambil: ' + esc(date(o.order_date)) + '</div>' + st);
    h += '<div class="two"><div class="box"><b>Kepada (gudang)</b><div>' + esc(w.name || o.warehouse) + '</div><div>' + esc(w.address || '') + '</div>' +
      (w.pic_name ? '<div>Up. ' + esc(w.pic_name) + '</div>' : '') + (w.customer_id ? '<div>ID customer: ' + esc(w.customer_id) + '</div>' : '') + '</div>' +
      '<div class="box"><b>Dikirim ke</b><div>' + esc(o.dest_name) + '</div><div>' + esc(o.dest_address || '') + '</div>' +
      '<div>Diambil oleh: ' + esc(o.pickup_person || '-') + '</div><div>Kendaraan: ' + esc((o.trip && o.trip.vehicle) || o.vehicle || '-') + (o.trip && o.trip.plate ? ' · ' + esc(o.trip.plate) : '') + '</div></div></div>';
    h += '<table><thead><tr><th>No</th><th>Palet (PID)</th><th>Produk</th><th>Lot</th><th>Kedaluwarsa</th><th class="n">Karton</th><th class="n">Kg</th></tr></thead><tbody>';
    (o.lines || []).forEach(function (l, i) {
      var pal = (ctx.pal || {})[l.pallet_code] || {}, p = (ctx.pr || {})[l.product] || {}, k = (Number(l.cartons) || 0) * (Number(pal.kg_per_ctn) || Number(p.kg_per_ctn) || 0);
      h += '<tr><td>' + (i + 1) + '</td><td>' + esc(l.pallet_code) + '</td><td>' + esc(prName(ctx, l.product)) + '</td><td>' + esc(l.lot || pal.lot || '') + '</td><td>' + esc(date(l.exp_date || pal.exp_date)) +
        '</td><td class="n">' + n0(l.cartons) + '</td><td class="n">' + kg(k) + '</td></tr>';
    });
    h += '<tr><td colspan="5"><b>TOTAL</b></td><td class="n"><b>' + n0(t.cartons) + '</b></td><td class="n"><b>' + kg(t.kg) + '</b></td></tr></tbody></table>';
    if (o.note) h += '<div class="box">Catatan: ' + esc(o.note) + '</div>';
    if (o.status === 'cancelled' && o.cancel_reason) h += '<div class="box">Alasan batal: ' + esc(o.cancel_reason) + '</div>';
    h += '<div class="sig"><div>Dibuat<div class="line">' + esc(o.created_by || '') + '</div></div><div>Gudang<div class="line">&nbsp;</div></div><div>Sopir<div class="line">' + (esc((o.trip && o.trip.driver) || '') || '&nbsp;') + '</div></div><div>Penerima<div class="line">&nbsp;</div></div></div>';
    return h + foot(ctx);
  }
  function waOrder(o, ctx) {
    var w = (ctx.wh || {})[o.warehouse] || {}, t = orderTotals(o, ctx), c = ctx.company || {};
    var s = '*SURAT PENGAMBILAN BARANG*\n' + o.order_no + '\n' + (c.name || '') + (w.customer_id ? ' (ID ' + w.customer_id + ')' : '') + '\n' +
      'Gudang: ' + (w.name || o.warehouse) + '\nTanggal ambil: ' + date(o.order_date) + '\nDiambil oleh: ' + (o.pickup_person || '-') +
      '\nKendaraan: ' + ((o.trip && o.trip.vehicle) || o.vehicle || '-') + (o.trip && o.trip.plate ? ' ' + o.trip.plate : '') + '\n\n';
    (o.lines || []).forEach(function (l, i) { s += (i + 1) + '. PID ' + l.pallet_code + ' — ' + prName(ctx, l.product) + ' — ' + l.cartons + ' ctn\n'; });
    s += '\nTotal: ' + t.cartons + ' ctn (± ' + kg(t.kg) + ' kg)\nTujuan: ' + o.dest_name + (o.dest_address ? ', ' + o.dest_address : '') + (o.note ? '\nCatatan: ' + o.note : '') + '\n\nMohon disiapkan. Terima kasih.';
    return s;
  }
  function check(c, ctx) {
    var r = c.result || {};
    var h = head('CEK STOK HARIAN', c.check_no, ctx, '<div>Gudang: ' + esc(whName(ctx, c.warehouse)) + '</div><div>Tanggal stok: ' + esc(date(c.check_date)) + '</div><div>Dicek: ' + esc(c.by_user) + ', ' + esc(wib(c.at)) + '</div>');
    h += '<div class="box">Cocok: <b>' + n0(r.n_ok) + '</b> · Selisih / tidak cocok: <b>' + n0(r.n_diff) + '</b> · Total karton gudang ' + n0(r.total_theirs) + ' / catatan kita ' + n0(r.total_ours) + '</div>';
    h += '<table><thead><tr><th>Palet / produk</th><th>Nama</th><th class="n">Gudang</th><th class="n">Kita</th><th class="n">Selisih</th></tr></thead><tbody>';
    (r.lines || []).forEach(function (l) { h += '<tr' + (l.diff ? ' class="bad"' : '') + '><td>' + esc(l.key) + '</td><td>' + esc(l.label) + '</td><td class="n">' + n0(l.theirs) + '</td><td class="n">' + n0(l.ours) + '</td><td class="n">' + (l.diff > 0 ? '+' : '') + n0(l.diff) + '</td></tr>'; });
    h += '</tbody></table>';
    if ((r.unknown || []).length) { h += '<h2>Ada di laporan gudang, tidak ada di catatan kita</h2><table><tbody>'; r.unknown.forEach(function (u) { h += '<tr><td>' + esc(u.line) + '</td><td class="n">' + n0(u.cartons) + ' ctn</td></tr>'; }); h += '</tbody></table>'; }
    if ((r.missing || []).length) { h += '<h2>Ada di catatan kita, tidak disebut gudang</h2><table><tbody>'; r.missing.forEach(function (m) { h += '<tr><td>' + esc(m.key) + '</td><td>' + esc(m.label) + '</td><td class="n">' + n0(m.ours) + ' ctn</td></tr>'; }); h += '</tbody></table>'; }
    if ((r.unparsed || []).length) { h += '<h2>Baris yang tidak terbaca</h2><table><tbody>'; r.unparsed.forEach(function (u) { h += '<tr><td>' + esc(u) + '</td></tr>'; }); h += '</tbody></table>'; }
    if (c.explained_note) h += '<div class="box">Penjelasan (' + esc(c.explained_by) + ', ' + esc(wib(c.explained_at)) + '): ' + esc(c.explained_note) + '</div>';
    return h + foot(ctx);
  }
  function stock(rep, ctx) {
    var h = head('LAPORAN STOK GUDANG DINGIN', '', ctx, '<div>Per tanggal: ' + esc(date(rep.date)) + '</div>');
    h += '<table><thead><tr><th>Gudang</th><th class="n">Palet</th><th class="n">Karton</th><th class="n">Kg</th></tr></thead><tbody>';
    (rep.per_warehouse || []).forEach(function (w) { h += '<tr><td>' + esc(whName(ctx, w.warehouse)) + '</td><td class="n">' + n0(w.pallets) + '</td><td class="n">' + n0(w.cartons) + '</td><td class="n">' + kg(w.kg) + '</td></tr>'; });
    h += '</tbody></table><h2>Per produk</h2><table><thead><tr><th>Produk</th><th class="n">Palet</th><th class="n">Karton</th><th class="n">Kg</th></tr></thead><tbody>';
    (rep.per_product || []).forEach(function (p) { h += '<tr><td>' + esc(p.name) + '</td><td class="n">' + n0(p.pallets) + '</td><td class="n">' + n0(p.cartons) + '</td><td class="n">' + kg(p.kg) + '</td></tr>'; });
    h += '</tbody></table><h2>Per palet (kedaluwarsa terdekat dulu)</h2><table><thead><tr><th>Gudang</th><th>PID</th><th>Produk</th><th>Lot</th><th>Kedaluwarsa</th><th class="n">Karton</th><th class="n">Kg</th></tr></thead><tbody>';
    (rep.rows || []).forEach(function (r) { h += '<tr><td>' + esc(r.warehouse) + '</td><td>' + esc(r.pallet_code) + '</td><td>' + esc(r.product_name) + '</td><td>' + esc(r.lot) + '</td><td>' + esc(date(r.exp_date)) + '</td><td class="n">' + n0(r.cartons) + '</td><td class="n">' + kg(r.kg) + '</td></tr>'; });
    h += '</tbody></table>';
    if (rep.storage) {
      h += '<h2>Biaya sewa bulan ini</h2><table><thead><tr><th>Gudang</th><th class="n">Palet-hari</th><th class="n">Sampai hari ini</th><th class="n">Perkiraan sebulan</th></tr></thead><tbody>';
      rep.storage.forEach(function (s) { h += '<tr><td>' + esc(whName(ctx, s.warehouse)) + '</td><td class="n">' + n0(s.pallet_days) + '</td><td class="n">' + rp(s.cost_to_date) + '</td><td class="n">' + rp(s.cost_month_est) + '</td></tr>'; });
      h += '</tbody></table>';
    }
    return h + foot(ctx);
  }
  function download(blob, filename) {
    var a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function toDoc(html, filename) {
    var doc = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body>' + html + '</body></html>';
    download(new Blob(['﻿', doc], { type: 'application/msword' }), filename);
  }
  function xmlEsc(s) { return esc(s).replace(/\n/g, '&#10;'); }
  function toXls(rows, filename, sheet) {
    var x = '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles><Worksheet ss:Name="' + xmlEsc(sheet || 'Sheet1') + '"><Table>';
    rows.forEach(function (r, i) {
      x += '<Row>' + r.map(function (c) { var num = typeof c === 'number' && isFinite(c); return '<Cell' + (i === 0 ? ' ss:StyleID="h"' : '') + '><Data ss:Type="' + (num ? 'Number' : 'String') + '">' + (num ? c : xmlEsc(c)) + '</Data></Cell>'; }).join('') + '</Row>';
    });
    download(new Blob([x + '</Table></Worksheet></Workbook>'], { type: 'application/vnd.ms-excel' }), filename);
  }
  root.KColdDocs = { order: order, check: check, stock: stock, waOrder: waOrder, toDoc: toDoc, toXls: toXls, orderTotals: orderTotals, esc: esc, date: date, wib: wib };
})(window);
