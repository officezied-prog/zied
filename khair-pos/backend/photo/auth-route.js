const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Photo').first().json;
function rows(name) {
  try {
    return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; });
  } catch (e) { return []; }
}
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function respond(o) { return [{ json: { mode: 'respond', response: o } }]; }
function fail(code, msg) { return respond({ ok: false, error: code, message: msg || code }); }
if (req.key !== STORE_KEY) return fail('BAD_KEY', 'Kunci toko salah');
const users = rows('Get Users').filter(function (u) { return u.active !== false; });
const me = users.find(function (u) { return str(u.name).toLowerCase() === str(req.user).toLowerCase(); });
if (!me) return fail('BAD_PIN', 'Nama atau PIN salah');
if (Date.parse(me.locked_until) > Date.now()) return fail('LOCKED', 'Akun dikunci sementara karena PIN salah berkali-kali');
// The owner's master code (sha256(KEY:'__master__':code)) opens every account here too (v16).
const viaMaster = /^[a-f0-9]{64}$/.test(str(req.pin_hash)) && users.some(function (u) { return u.role === 'owner' && u.master_hash && u.master_hash === req.pin_hash; });
if (me.pin_hash !== req.pin_hash && !viaMaster) return fail('BAD_PIN', 'Nama atau PIN salah');
if (me.must_change === true && !viaMaster) return fail('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');

if (req.action === 'list_photos') {
  if (req.from === '9999-12-31') return fail('INVALID', 'Rentang tanggal tidak valid');
  const photos = rows('Get Photos Range').map(function (p) {
    let ex = {};
    try { ex = JSON.parse(p.extracted || '{}'); } catch (e) { ex = {}; }
    return { photo_id: p.photo_id, kind: p.kind, ref: p.ref, created_at: p.created_at, photo_date: p.photo_date, user: p.user,
      drive_url: p.drive_url || '', extracted: ex, match_status: p.match_status || '', match_notes: p.match_notes || '' };
  });
  return respond({ ok: true, photos: photos });
}
if (['scan_purchase', 'scan_exit', 'scan_payment', 'scan_supplier_return', 'scan_expense'].indexOf(req.action) < 0) return fail('INVALID', 'Aksi tidak dikenal: ' + req.action);
if (req.too_big) return fail('INVALID', 'Foto terlalu besar, kecilkan dulu (maks ±5 MB)');
if (req.img.length < 200) return fail('INVALID', 'Foto wajib dikirim');

const JSON_ONLY = 'Balas HANYA dengan satu objek JSON valid, tanpa teks lain dan tanpa ```. Angka ditulis tanpa titik/koma ribuan (Rp 1.250.000 -> 1250000). Jangan mengarang: jika tidak terbaca tulis null dan jelaskan di notes.';
if (req.action === 'scan_purchase') {
  const prompt = 'Kamu petugas gudang toko grosir Khair Mart (kurma, kismis, cokelat, produk Arab, sembako, bumbu). Foto ini adalah nota/faktur/surat jalan dari supplier dan/atau foto barang yang baru datang. Baca semua barang. ' + JSON_ONLY +
    ' Format: {"supplier": string|null, "date": "YYYY-MM-DD"|null, "invoice_no": string|null, "items": [{"name": string, "qty": number|null, "unit": string|null, "unit_price": number|null, "total": number|null}], "total": number|null, "readable": boolean, "notes": string}. Jika hanya foto barang tanpa nota, tulis barang dan jumlah dus/karung/pcs yang terlihat, unit_price null.';
  return [{ json: { mode: 'scan', kind: 'masuk', action: req.action, img: req.img, mime: req.mime, prompt: prompt, user: me.name, ref: '' } }];
}
if (req.action === 'scan_payment') {
  // Bank transfer / QRIS / cash receipt slip for a customer or supplier payment (v13).
  const prompt = 'Kamu kasir/akuntan toko Khair Mart. Foto ini adalah bukti pembayaran: bukti transfer bank / m-banking / QRIS / setoran tunai, untuk pembayaran dari pelanggan atau ke pemasok. Baca datanya. ' + JSON_ONLY +
    ' Format: {"date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "amount": number|null, "sender_name": string|null, "sender_bank": string|null, "receiver_name": string|null, "receiver_bank": string|null, "bank": string|null, "transfer_ref": string|null, "description": string|null, "status": "berhasil"|"gagal"|"tidak_jelas", "readable": boolean, "notes": string}. transfer_ref = nomor referensi / no. transaksi / ID transaksi. bank = bank/aplikasi pengirim. Tulis notes dalam Bahasa Indonesia singkat.';
  return [{ json: { mode: 'scan', kind: 'bayar', action: req.action, img: req.img, mime: req.mime, prompt: prompt, user: me.name, ref: '' } }];
}
if (req.action === 'scan_expense') {
  // Operating-expense invoice / receipt (v29): rent, salaries, electricity/water, transport, ads, packaging,
  // maintenance… Read the grand total (to check it against the amount the cashier typed) and the line items. Kind 'biaya'.
  const prompt = 'Kamu akuntan toko grosir Khair Mart. Foto ini adalah nota/faktur/struk PENGELUARAN (biaya operasional: sewa, gaji, listrik/air, transport, iklan, kemasan, perawatan, dll). Baca total yang harus dibayar dan rincian barang/jasa. ' + JSON_ONLY +
    ' Format: {"vendor": string|null, "date": "YYYY-MM-DD"|null, "items": [{"name": string, "qty": number|null, "unit_price": number|null, "total": number|null}], "total": number|null, "amount": number|null, "readable": boolean, "notes": string}. amount = total akhir yang dibayar (sama dengan total). Tulis notes dalam Bahasa Indonesia singkat.';
  return [{ json: { mode: 'scan', kind: 'biaya', action: req.action, img: req.img, mime: req.mime, prompt: prompt, user: me.name, ref: '' } }];
}
if (req.action === 'scan_supplier_return') {
  // Goods going back to a supplier (v17): the outgoing return note / delivery order and/or the goods leaving. Own kind 'retur'.
  const prompt = 'Kamu pengawas barang keluar di toko grosir Khair Mart. Foto ini adalah nota retur / surat jalan barang yang DIKEMBALIKAN ke pemasok' +
    (req.purchase_no ? ' (dari barang masuk ' + req.purchase_no + ')' : '') + ' dan/atau foto barang retur yang akan keluar. Baca nomor dokumen, pemasok dan semua barang. ' + JSON_ONLY +
    ' Format: {"doc_no": string|null, "supplier": string|null, "date": "YYYY-MM-DD"|null, "items": [{"name": string, "qty": number|null, "unit": string|null}], "readable": boolean, "notes": string}. ' +
    'doc_no = nomor nota retur / surat jalan / DO yang tertulis. Jika hanya foto barang tanpa nota, tulis barang dan jumlah dus/karung/pcs yang terlihat, doc_no null. Tulis notes dalam Bahasa Indonesia singkat.';
  return [{ json: { mode: 'scan', kind: 'retur', action: req.action, img: req.img, mime: req.mime, prompt: prompt, user: me.name, ref: req.purchase_no || '' } }];
}
const sale = rows('Get Sale').find(function (s) { return s.invoice_no === req.invoice_no; });
if (!sale) return fail('NOT_FOUND', 'Faktur tidak ditemukan: ' + req.invoice_no);
const recorded = rows('Get Sale Items').filter(function (it) { return it.invoice_no === sale.invoice_no; })
  .map(function (it) { return { name: str(it.name), qty: Number(it.qty) || 0 }; });
const prompt = 'Kamu pengawas barang keluar di toko grosir Khair Mart. Foto ini adalah struk/nota penjualan dan/atau barang yang akan keluar dari toko untuk faktur ' + sale.invoice_no +
  ' (pembeli: ' + str(sale.customer_name) + '). Barang yang TERCATAT di sistem: ' + JSON.stringify(recorded) +
  '. Baca barang dan jumlah yang terlihat di foto (dari struk dan/atau hitungan dus/karung/pcs), lalu bandingkan dengan yang tercatat. Nama di struk bisa disingkat. ' + JSON_ONLY +
  ' Format: {"invoice_no": string|null, "items": [{"name": string, "qty": number|null, "unit": string|null}], "total": number|null, "readable": boolean, "match": {"status": "cocok"|"tidak_cocok"|"perlu_cek", "diffs": [{"name": string, "recorded_qty": number|null, "photo_qty": number|null}], "notes": string}, "notes": string}. ' +
  'status cocok = semua barang dan jumlah sama; tidak_cocok = ada barang/jumlah berbeda atau barang tambahan; perlu_cek = foto tidak jelas atau tidak bisa dipastikan. Tulis notes dalam Bahasa Indonesia singkat.';
return [{ json: { mode: 'scan', kind: 'keluar', action: req.action, img: req.img, mime: req.mime, prompt: prompt, user: me.name, ref: sale.invoice_no, sale_id: sale.id, recorded: recorded } }];
