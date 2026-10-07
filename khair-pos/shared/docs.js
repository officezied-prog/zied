/* Khair Mart — A4 business documents shared by the owner app and Khair Kasir (v17).
   Pure builders: each takes plain data and returns HTML for the app's print area (window.print → printer or "Save as PDF").
   Documents are in Indonesian (customers and suppliers read them):
     invoice       Faktur penjualan (grosir / eceran), on request for any sale; debt → due date + bank accounts
     deliveryNote  Surat jalan for goods leaving with a sale: quantities only, no prices, three signatures
     quotation     Penawaran harga from the current cart; nothing is saved or reserved
     goodsIn       Tanda terima barang masuk for a supplier delivery (prices only when the caller allows)
     statement     Rekap tagihan: a customer's open invoices
   ctx (every builder): { store: settings, customer?: {name, phone, address}, by: user name, now: Date } */
(function (root) {
  var PAGE = 'size:A4;margin:12mm';
  var CSS = '<style>.kdoc{font:12px/1.45 Arial,Helvetica,sans-serif;color:#000;background:#fff;max-width:186mm;margin:0 auto}' +
    '.kdoc h1{font-size:18px;margin:0 0 2px;letter-spacing:.5px}.kdoc .hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:10px}' +
    '.kdoc .st b{font-size:16px}.kdoc .meta{text-align:right}.kdoc .meta div{white-space:nowrap}.kdoc .to{border:1px solid #000;padding:6px 8px;margin-bottom:10px;min-height:44px}' +
    '.kdoc table{width:100%;border-collapse:collapse;margin-bottom:8px}.kdoc th,.kdoc td{border:1px solid #000;padding:4px 6px;vertical-align:top}.kdoc th{background:#eee;text-align:left}' +
    '.kdoc td.n,.kdoc th.n{text-align:right;white-space:nowrap}.kdoc .tot{width:60%;margin-left:auto}.kdoc .tot td{border:none;padding:2px 6px}.kdoc .tot tr.b td{font-weight:bold;border-top:1px solid #000}' +
    '.kdoc .words{font-style:italic;margin:4px 0 10px}.kdoc .note{margin:6px 0;font-size:11px}.kdoc .sig{display:flex;gap:12px;margin-top:22px}' +
    '.kdoc .sig div{flex:1;text-align:center}.kdoc .sig .line{margin-top:52px;border-top:1px solid #000;padding-top:2px}.kdoc .fill{display:inline-block;min-width:150px;border-bottom:1px dotted #000}' +
    '.kdoc .stamp{border:3px solid #000;display:inline-block;padding:2px 10px;font-weight:bold;font-size:18px;transform:rotate(-6deg);margin:4px 0}.kdoc .ft{margin-top:14px;font-size:10px;color:#333;border-top:1px solid #999;padding-top:4px}</style>';

  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function int(v) { var n = Math.round(Number(v)); return isFinite(n) ? n : 0; }
  function rp(v) { var n = int(v); return (n < 0 ? '-' : '') + 'Rp ' + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function qty(v) { var n = Number(v) || 0; return (Math.round(n * 1000) / 1000).toString().replace('.', ','); }
  var MON = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  function date(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    return m ? Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1] : '';
  }
  function addDays(d, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    if (!m) return '';
    var x = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
    return x.toISOString().slice(0, 10);
  }
  /** HH:MM in Jakarta time from an ISO timestamp (sale_time) or an 'HH:MM[:SS]' string. */
  function hhmm(t) {
    t = String(t || '');
    if (t.indexOf('T') > 0) { var d = new Date(t); return isNaN(d) ? '' : new Date(d.getTime() + 7 * 3600000).toISOString().slice(11, 16); }
    var m = /^(\d{2}:\d{2})/.exec(t); return m ? m[1] : '';
  }
  function jkt(now) { return new Date((now || new Date()).getTime() + 7 * 3600000).toISOString(); }
  /** Rupiah in Indonesian words ("terbilang"), as written on Indonesian invoices. */
  function words(n) {
    n = Math.abs(int(n));
    var S = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
    function w(x) {
      if (x < 12) return S[x];
      if (x < 20) return w(x - 10) + ' belas';
      if (x < 100) return w(Math.floor(x / 10)) + ' puluh' + (x % 10 ? ' ' + w(x % 10) : '');
      if (x < 200) return 'seratus' + (x - 100 ? ' ' + w(x - 100) : '');
      if (x < 1000) return w(Math.floor(x / 100)) + ' ratus' + (x % 100 ? ' ' + w(x % 100) : '');
      if (x < 2000) return 'seribu' + (x - 1000 ? ' ' + w(x - 1000) : '');
      if (x < 1e6) return w(Math.floor(x / 1000)) + ' ribu' + (x % 1000 ? ' ' + w(x % 1000) : '');
      if (x < 1e9) return w(Math.floor(x / 1e6)) + ' juta' + (x % 1e6 ? ' ' + w(x % 1e6) : '');
      if (x < 1e12) return w(Math.floor(x / 1e9)) + ' miliar' + (x % 1e9 ? ' ' + w(x % 1e9) : '');
      return w(Math.floor(x / 1e12)) + ' triliun' + (x % 1e12 ? ' ' + w(x % 1e12) : '');
    }
    var s = n === 0 ? 'nol' : w(n);
    return s.charAt(0).toUpperCase() + s.slice(1) + ' rupiah';
  }
  function phoneLocal(p) { p = String(p || ''); return /^62\d/.test(p) ? '0' + p.slice(2) : p; }

  function header(ctx, title, metaRows) {
    var st = ctx.store || {};
    var contact = [st.phone ? 'Telp ' + st.phone : '', st.wa_shop_number ? 'WA ' + phoneLocal(st.wa_shop_number) : ''].filter(Boolean).join(' · ');
    return '<div class="hd"><div class="st"><b>' + esc(st.store_name || 'Khair Mart') + '</b>' +
      (st.address ? '<div>' + esc(st.address) + '</div>' : '') + (contact ? '<div>' + esc(contact) + '</div>' : '') + '</div>' +
      '<div class="meta"><h1>' + esc(title) + '</h1>' + metaRows.filter(function (r) { return r && r[1]; }).map(function (r) { return '<div>' + esc(r[0]) + ': <b>' + esc(r[1]) + '</b></div>'; }).join('') + '</div></div>';
  }
  function toBox(label, c) {
    c = c || {};
    return '<div class="to"><div>' + esc(label) + ':</div><b>' + esc(c.name || '-') + '</b>' +
      (c.address ? '<div>' + esc(c.address) + '</div>' : '') + (c.phone ? '<div>Telp/WA ' + esc(phoneLocal(c.phone)) + '</div>' : '') + '</div>';
  }
  function sigs(names) { return '<div class="sig">' + names.map(function (n) { return '<div>' + esc(n) + '<div class="line">(&nbsp;' + '&nbsp;'.repeat(30) + ')</div></div>'; }).join('') + '</div>'; }
  function footer(ctx, extra) {
    return '<div class="ft">' + esc((extra ? extra + ' · ' : '') + 'Dicetak ' + jkt(ctx.now).slice(0, 16).replace('T', ' ') + ' WIB' + (ctx.by ? ' oleh ' + ctx.by : '')) + '</div>';
  }
  function wrap(html) { return CSS + '<div class="kdoc">' + html + '</div>'; }
  function priceRows(lines) {
    return lines.map(function (l, i) {
      return '<tr><td class="n">' + (i + 1) + '</td><td>' + esc(l.name) + (l.price_type === 'grosir' ? ' <i>(grosir)</i>' : '') + '</td><td class="n">' + esc(qty(l.qty)) + '</td><td>' + esc(l.unit || '') +
        '</td><td class="n">' + esc(rp(l.unit_price)) + '</td><td class="n">' + esc(rp(l.line_total)) + '</td></tr>';
    }).join('');
  }
  var PRICE_HEAD = '<tr><th class="n">No</th><th>Nama barang</th><th class="n">Qty</th><th>Satuan</th><th class="n">Harga</th><th class="n">Jumlah</th></tr>';
  var METHOD = { tunai: 'Tunai', transfer: 'Transfer bank', qris: 'QRIS', hutang: 'Tempo (hutang)', campur: 'Campuran' };
  function banksHTML(st) {
    var b = (Array.isArray(st.bank_accounts) ? st.bank_accounts : []).filter(function (x) { return x && x.active !== false && x.account_no; });
    return b.length ? '<div class="note">Pembayaran transfer ke: ' + b.map(function (x) { return esc(x.bank + ' ' + x.account_no + ' a.n. ' + x.holder); }).join('; ') + '</div>' : '';
  }
  /** Retail or wholesale: a grosir customer, or every line at the wholesale price. */
  function saleKind(rc, c) {
    if (c && c.type === 'grosir') return 'GROSIR';
    return rc.lines.length && rc.lines.every(function (l) { return l.price_type === 'grosir'; }) ? 'GROSIR' : 'ECERAN';
  }

  function invoice(rc, ctx) {
    var st = ctx.store || {}, c = ctx.customer || { name: rc.customer_name, phone: rc.customer_phone };
    var dueDays = int(st.invoice_due_days) > 0 ? int(st.invoice_due_days) : 14;
    var due = int(rc.debt) > 0 ? addDays(rc.sale_date, dueDays) : '';
    var h = header(ctx, 'FAKTUR PENJUALAN', [['No. faktur', rc.invoice_no], ['Tanggal', (date(rc.sale_date) + ' ' + hhmm(rc.sale_time)).trim()],
      ['Jenis', saleKind(rc, ctx.customer)], ['Kasir', rc.cashier], ['Jatuh tempo', due ? date(due) : '']]);
    if (rc.status === 'void') h += '<div class="stamp">BATAL</div>';
    h += toBox('Kepada', c);
    h += '<table>' + PRICE_HEAD + priceRows(rc.lines) + '</table>';
    var t = [['Subtotal', rp(rc.subtotal)]];
    if (int(rc.discount)) t.push(['Diskon', '-' + rp(rc.discount)]);
    if (int(rc.send_fee)) t.push(['Biaya kirim struk', rp(rc.send_fee)]);
    h += '<table class="tot">' + t.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td class="n">' + esc(r[1]) + '</td></tr>'; }).join('') +
      '<tr class="b"><td>TOTAL</td><td class="n">' + esc(rp(rc.total)) + '</td></tr>' +
      '<tr><td>Dibayar (' + esc(METHOD[rc.method] || rc.method || '-') + ')</td><td class="n">' + esc(rp(int(rc.total) - int(rc.debt))) + '</td></tr>' +
      (int(rc.debt) ? '<tr class="b"><td>Sisa tagihan</td><td class="n">' + esc(rp(rc.debt)) + '</td></tr>' : '') + '</table>';
    h += '<div class="words">Terbilang: ' + esc(words(rc.total)) + '</div>';
    if (int(rc.debt)) h += '<div class="note">Sisa tagihan ' + esc(rp(rc.debt)) + ' dibayar paling lambat ' + esc(date(due)) + '.</div>' + banksHTML(st);
    h += sigs(['Penerima', 'Hormat kami']);
    return wrap(h + footer(ctx, st.receipt_footer ? String(st.receipt_footer).split('\n')[0] : ''));
  }

  function deliveryNote(rc, ctx) {
    var c = ctx.customer || { name: rc.customer_name, phone: rc.customer_phone };
    var h = header(ctx, 'SURAT JALAN', [['No. surat jalan', 'SJ-' + rc.invoice_no], ['Tanggal', date(ctx.date || jkt(ctx.now).slice(0, 10))], ['No. faktur', rc.invoice_no]]);
    if (rc.status === 'void') h += '<div class="stamp">BATAL</div>';
    h += toBox('Dikirim kepada', c);
    h += '<table><tr><th class="n">No</th><th>Nama barang</th><th class="n">Qty</th><th>Satuan</th><th>Keterangan</th></tr>' +
      rc.lines.map(function (l, i) { return '<tr><td class="n">' + (i + 1) + '</td><td>' + esc(l.name) + '</td><td class="n">' + esc(qty(l.qty)) + '</td><td>' + esc(l.unit || '') + '</td><td></td></tr>'; }).join('') + '</table>';
    var total = rc.lines.reduce(function (s, l) { return s + (Number(l.qty) || 0); }, 0);
    h += '<div class="note">Jumlah barang: <b>' + esc(qty(total)) + '</b> (' + rc.lines.length + ' jenis)</div>';
    h += '<div class="note">Sopir / pembawa: <span class="fill"></span> &nbsp; No. kendaraan: <span class="fill"></span></div>';
    h += '<div class="note">Barang sudah diterima dalam keadaan baik dan jumlah sesuai.</div>';
    h += sigs(['Bagian gudang', 'Sopir / pembawa', 'Penerima']);
    return wrap(h + footer(ctx));
  }

  function quotation(q, ctx) {
    var st = ctx.store || {};
    var valid = int(q.valid_days) > 0 ? int(q.valid_days) : 7;
    var h = header(ctx, 'PENAWARAN HARGA', [['No.', q.no], ['Tanggal', date(q.date)], ['Berlaku s.d.', date(addDays(q.date, valid))]]);
    h += toBox('Kepada', ctx.customer || { name: q.customer_name });
    h += '<table>' + PRICE_HEAD + priceRows(q.lines) + '</table>';
    h += '<table class="tot">' + (int(q.discount) ? '<tr><td>Subtotal</td><td class="n">' + esc(rp(q.subtotal)) + '</td></tr><tr><td>Diskon</td><td class="n">-' + esc(rp(q.discount)) + '</td></tr>' : '') +
      '<tr class="b"><td>TOTAL</td><td class="n">' + esc(rp(q.total)) + '</td></tr></table>';
    h += '<div class="words">Terbilang: ' + esc(words(q.total)) + '</div>';
    h += '<div class="note">Harga berlaku sampai ' + esc(date(addDays(q.date, valid))) + '. Penawaran ini bukan faktur dan belum memesan stok; ketersediaan dipastikan saat pemesanan.</div>' + banksHTML(st);
    h += sigs(['Hormat kami']);
    return wrap(h + footer(ctx));
  }
  /** Same quotation as WhatsApp text. */
  function quotationText(q, ctx) {
    var st = ctx.store || {}, valid = int(q.valid_days) > 0 ? int(q.valid_days) : 7, L = '--------------------------------';
    var out = ['*' + (st.store_name || 'Khair Mart') + '*', '*PENAWARAN HARGA* ' + q.no, 'Tanggal: ' + date(q.date) + ' · berlaku s.d. ' + date(addDays(q.date, valid))];
    if (q.customer_name) out.push('Kepada: ' + q.customer_name);
    out.push(L);
    q.lines.forEach(function (l) { out.push(l.name + (l.price_type === 'grosir' ? ' (grosir)' : ''), '  ' + qty(l.qty) + ' ' + (l.unit || '') + ' x ' + rp(l.unit_price) + ' = ' + rp(l.line_total)); });
    out.push(L);
    if (int(q.discount)) out.push('Diskon: -' + rp(q.discount));
    out.push('*TOTAL: ' + rp(q.total) + '*', 'Penawaran ini belum memesan stok.');
    return out.join('\n');
  }

  /** g = {no, date, supplier, lines: [{name, qty, unit, cost_price, total}], carrier_text, note_status, user}; ctx.showPrices for the owner. */
  function goodsIn(g, ctx) {
    var prices = !!ctx.showPrices;
    var h = header(ctx, 'TANDA TERIMA BARANG', [['No. barang masuk', g.no], ['Tanggal', date(g.date)], ['Diterima oleh', g.user]]);
    h += toBox('Dari pemasok', { name: g.supplier || '-' });
    h += '<table><tr><th class="n">No</th><th>Nama barang</th><th class="n">Qty</th><th>Satuan</th>' + (prices ? '<th class="n">Harga beli</th><th class="n">Jumlah</th>' : '<th>Keterangan</th>') + '</tr>' +
      g.lines.map(function (l, i) {
        return '<tr><td class="n">' + (i + 1) + '</td><td>' + esc(l.name) + '</td><td class="n">' + esc(qty(l.qty)) + '</td><td>' + esc(l.unit || '') + '</td>' +
          (prices ? '<td class="n">' + esc(rp(l.cost_price)) + '</td><td class="n">' + esc(rp(l.total)) + '</td>' : '<td></td>') + '</tr>';
      }).join('') + '</table>';
    if (prices) h += '<table class="tot"><tr class="b"><td>TOTAL</td><td class="n">' + esc(rp(g.lines.reduce(function (s, l) { return s + int(l.total); }, 0))) + '</td></tr></table>';
    if (g.carrier_text) h += '<div class="note">Dibawa oleh: ' + esc(g.carrier_text) + '</div>';
    if (g.note_status) h += '<div class="note">Cek nota pemasok (foto): ' + esc(g.note_status) + '</div>';
    h += '<div class="note">Barang di atas sudah diterima dan dihitung. Barang rusak / kurang dicatat di kolom keterangan.</div>';
    h += sigs(['Diserahkan (pemasok / sopir)', 'Diterima (gudang)']);
    return wrap(h + footer(ctx));
  }

  /** s = {customer: {name, phone, address}, date, rows: [{ref, date, debt, paid, remaining}], total} */
  function statement(s, ctx) {
    var st = ctx.store || {};
    var h = header(ctx, 'REKAP TAGIHAN', [['Per tanggal', date(s.date)]]);
    h += toBox('Kepada', s.customer);
    h += '<table><tr><th class="n">No</th><th>No. faktur</th><th>Tanggal</th><th class="n">Tagihan</th><th class="n">Sudah dibayar</th><th class="n">Sisa</th></tr>' +
      s.rows.map(function (r, i) { return '<tr><td class="n">' + (i + 1) + '</td><td>' + esc(r.ref) + '</td><td>' + esc(date(r.date)) + '</td><td class="n">' + esc(rp(r.debt)) + '</td><td class="n">' + esc(rp(r.paid)) + '</td><td class="n">' + esc(rp(r.remaining)) + '</td></tr>'; }).join('') +
      (s.rows.length ? '' : '<tr><td colspan="6">Tidak ada tagihan terbuka.</td></tr>') + '</table>';
    h += '<table class="tot"><tr class="b"><td>TOTAL SISA TAGIHAN</td><td class="n">' + esc(rp(s.total)) + '</td></tr></table>';
    h += '<div class="words">Terbilang: ' + esc(words(s.total)) + '</div>' + banksHTML(st);
    h += sigs(['Hormat kami']);
    return wrap(h + footer(ctx));
  }

  /** Monthly attendance (v17). rep = att_report response; ctx.showWages for the owner's copy (wage due = days present × daily wage). */
  function attendance(rep, ctx) {
    var wages = !!ctx.showWages, days = [];
    for (var d = rep.from; d <= rep.to && days.length < 62; d = addDays(d, 1)) days.push(d);
    var cell = { hadir: '✓', terlambat: 'T', tidak_hadir: 'A', libur: 'L', belum: '·' };
    var hm = function (m) { m = int(m); return Math.floor(m / 60) + 'j ' + ('0' + (m % 60)).slice(-2) + 'm'; };
    var h = header(ctx, 'LAPORAN ABSENSI', [['Periode', date(rep.from) + ' – ' + date(rep.to)], ['Catatan', String(rep.verify ? rep.verify.count : '')]]);
    h += '<table><tr><th>Nama</th><th>Jabatan</th><th class="n">Hadir</th><th class="n">Terlambat</th><th class="n">Tidak hadir</th><th class="n">Jam kerja</th><th class="n">Gagal wajah</th>' +
      (wages ? '<th class="n">Upah / hari</th><th class="n">Upah dibayar</th>' : '') + '</tr>' +
      rep.totals.map(function (t) {
        return '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.job) + '</td><td class="n">' + t.present + '</td><td class="n">' + t.late_days + (t.late_min ? ' (' + t.late_min + ' mnt)' : '') + '</td><td class="n">' + t.absent +
          '</td><td class="n">' + hm(t.minutes) + '</td><td class="n">' + t.fails + '</td>' + (wages ? '<td class="n">' + esc(rp(t.daily_wage)) + '</td><td class="n"><b>' + esc(rp(t.wage_due)) + '</b></td>' : '') + '</tr>';
      }).join('') + '</table>';
    if (wages) h += '<table class="tot"><tr class="b"><td>TOTAL UPAH</td><td class="n">' + esc(rp(rep.totals.reduce(function (a, t) { return a + int(t.wage_due); }, 0))) + '</td></tr></table>';
    h += '<div class="note">Per hari: ✓ hadir · T terlambat · A tidak hadir · L libur</div><table style="font-size:10px"><tr><th>Nama</th>' +
      days.map(function (d) { return '<th class="n">' + Number(d.slice(8, 10)) + '</th>'; }).join('') + '</tr>' +
      rep.totals.map(function (t) {
        return '<tr><td>' + esc(t.name) + '</td>' + days.map(function (d) {
          var r = rep.rows.find(function (x) { return x.worker_id === t.worker_id && x.date === d; });
          return '<td class="n">' + (r ? cell[r.status] || '' : '') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</table>';
    var v = rep.verify || {};
    h += '<div class="note"><b>' + (v.ok ? 'Data utuh' : 'PERINGATAN: data berubah') + '</b> — ' + esc(v.ok ? 'semua ' + v.count + ' catatan dan ' + rep.sealed_days + ' segel harian cocok dengan rantai kode (tidak ada yang diubah atau dihapus).' :
      (v.issues || []).map(function (i) { return i.text; }).join('; ')) + '</div>';
    h += sigs(['Dibuat oleh', 'Diperiksa']);
    return wrap(h + footer(ctx));
  }

  root.KDocs = { PAGE: PAGE, invoice: invoice, deliveryNote: deliveryNote, quotation: quotation, quotationText: quotationText, goodsIn: goodsIn, statement: statement, attendance: attendance, words: words, addDays: addDays };
})(typeof window !== 'undefined' ? window : this);
