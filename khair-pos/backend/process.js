const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Request').first().json;
const data = req.data && typeof req.data === 'object' ? req.data : {};
// Everything the apps send is plain text, never code: control characters and < > are removed, keys that reach
// JavaScript internals (__proto__, constructor, prototype) are dropped and every string is cut at 4000 characters.
// Each action then checks its own fields (names, numbers, dates, phone, e-mail, document numbers).
(function cleanInput(o, depth) {
  if (!o || typeof o !== 'object' || depth > 6) return;
  Object.keys(o).forEach(function (k) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') { delete o[k]; return; }
    const v = o[k];
    if (typeof v === 'string') o[k] = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').slice(0, 4000);
    else if (v && typeof v === 'object') cleanInput(v, depth + 1);
  });
})(data, 0);
const ops = { sales: [], sale_items: [], payments: [], purchases: [], products: [], customers: [], users: [], settings: [], approvals: [], expenses: [], shifts: [], devices: [], repacks: [], activity: [], bank_lines: [], returns: [] };

function rows(name) {
  try {
    return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; });
  } catch (e) { return []; }
}
// Stock lives in two places: the warehouse (gudang) and the shop shelf (toko). stock = total, shop_stock = on the shelf,
// warehouse = stock - shop_stock. Goods-in, repacking, corrections and counts change the warehouse; only sales, voids and
// move_stock change the shelf. A product without shop_stock yet (before v16) counts all its stock as on the shelf.
var shopSet = {};
function shopOf(p) { return p.shop_stock === undefined || p.shop_stock === null || p.shop_stock === '' ? num(p.stock) : num(p.shop_stock); }
function normShop() {
  ops.products.forEach(function (r) {
    const orig = r._id !== -1 ? productById[String(r._id)] : null;
    const st = num(r.stock);
    let sh = shopSet[String(r._id)] !== undefined ? shopSet[String(r._id)] : (orig ? shopOf(orig) : st);
    if (sh > st) sh = st;
    if (sh < 0 && st >= 0) sh = 0;
    r.shop_stock = Math.round(sh * 1000) / 1000;
  });
}
function done(resp) { normShop(); return [{ json: { response: resp, ops: ops, action: req.action } }]; }
function fail(code, msg) { Object.keys(ops).forEach(function (k) { ops[k] = []; }); return done({ ok: false, error: code, message: msg || code }); }
function num(v) { const x = Number(v); return isFinite(x) ? x : 0; }
function money(v) { return Math.round(num(v)); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isHash(s) { return typeof s === 'string' && /^[a-f0-9]{64}$/.test(s); }
function clean(r) {
  const o = {};
  Object.keys(r).forEach(function (k) { if (k !== 'createdAt' && k !== 'updatedAt') o[k] = r[k]; });
  return o;
}
function forWrite(r, id) {
  const o = clean(r);
  delete o.id;
  o._id = id === undefined || id === null ? -1 : id;
  return o;
}
const COST_FIELDS = ['cost_price', 'total_cost', 'profit', 'line_profit'];
function strip(r, role) {
  const o = clean(r);
  if (role !== 'owner') COST_FIELDS.forEach(function (f) { delete o[f]; });
  return o;
}
function jkDate() { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
function rand(n) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

if (req.key !== STORE_KEY) return fail('BAD_KEY', 'Kunci toko salah');

const users = rows('Get Users');
const activeUsers = users.filter(function (u) { return u.active !== false; });

if (req.action === 'users') {
  return done({ ok: true, users: activeUsers.map(function (u) { return { name: u.name, role: u.role }; }) });
}
if (req.action === 'setup') {
  if (users.length > 0) return fail('FORBIDDEN', 'Pemilik sudah dibuat');
  const ownerName = str(data.owner_name);
  if (!ownerName || !isHash(data.pin_hash)) return fail('INVALID', 'Nama dan PIN wajib');
  ops.users.push({ _id: -1, name: ownerName, role: 'owner', pin_hash: data.pin_hash, active: true });
  return done({ ok: true, user: { name: ownerName, role: 'owner' } });
}
if (users.length === 0) return fail('NO_USERS', 'Belum ada pengguna');
const me = activeUsers.find(function (u) { return str(u.name).toLowerCase() === str(req.user).toLowerCase(); });
if (!me) return fail('BAD_PIN', 'Nama atau PIN salah');
// Wrong PIN 5 times in a row → that account is locked for 15 minutes.
function wibTime(iso) { return new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(11, 16) + ' WIB'; }
if (Date.parse(me.locked_until) > Date.now()) return done({ ok: false, error: 'LOCKED', locked_until: str(me.locked_until), message: 'Terlalu banyak PIN salah. Coba lagi jam ' + wibTime(me.locked_until) });
// Owner master code: sha256(KEY:'__master__':code) opens every account; every login with it is logged.
const masterOwner = isHash(req.pin_hash) && me.pin_hash !== req.pin_hash ? activeUsers.find(function (u) { return u.role === 'owner' && isHash(u.master_hash) && u.master_hash === req.pin_hash; }) || null : null;
const viaMaster = !!masterOwner;
if (me.pin_hash !== req.pin_hash && !viaMaster) {
  const fc = num(me.fail_count) + 1;
  const until = fc >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : '';
  ops.users.push(forWrite(Object.assign({}, me, { fail_count: until ? 0 : fc, locked_until: until }), me.id));
  return done(until ? { ok: false, error: 'LOCKED', locked_until: until, message: 'Terlalu banyak PIN salah. Coba lagi jam ' + wibTime(until) }
    : { ok: false, error: 'BAD_PIN', message: 'Nama atau PIN salah' + (fc >= 3 ? ' (' + (5 - fc) + ' kali lagi, lalu akun dikunci 15 menit)' : '') });
}
if ((num(me.fail_count) > 0 || str(me.locked_until)) && ['change_pin', 'set_master', 'save_user'].indexOf(req.action) < 0) {
  ops.users.push(forWrite(Object.assign({}, me, { fail_count: 0, locked_until: '' }), me.id));
}
if (me.must_change === true && !viaMaster && ['login', 'change_pin', 'users', 'device_ping'].indexOf(req.action) < 0) {
  return fail('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
}
const role = me.role === 'owner' ? 'owner' : (me.role === 'manager' ? 'manager' : (me.role === 'sales' ? 'sales' : 'kasir'));
if (role === 'sales' && ['login', 'bootstrap', 'device_ping', 'change_pin'].indexOf(req.action) < 0) return fail('FORBIDDEN', 'Akun sales memakai aplikasi Khair Sales');
const isApprover = role === 'owner' || role === 'manager';
function findApprover(name, hash) {
  const u = activeUsers.find(function (x) { return str(x.name).toLowerCase() === str(name).toLowerCase(); });
  if (!u || u.pin_hash !== hash || (u.role !== 'owner' && u.role !== 'manager')) return null;
  return u;
}
const openShifts = rows('Get Open Shifts').filter(function (x) { return x.status === 'open'; });
function shiftOf(name) { return openShifts.find(function (x) { return str(x.cashier).toLowerCase() === str(name).toLowerCase(); }) || null; }
const myShift = shiftOf(me.name);
function shiftOut(x) {
  if (!x) return null;
  const o = clean(x);
  if (role === 'kasir' && o.status === 'open') { ['cash_sales', 'cash_payments', 'sales_total', 'expected_cash'].forEach(function (f) { delete o[f]; }); }
  return o;
}
function addMove(x, type, amount, note) {
  let mv = [];
  try { mv = JSON.parse(x.moves || '[]'); } catch (e) { mv = []; }
  mv.push({ t: new Date().toISOString(), type: type, amount: amount, note: note, by: me.name });
  x.moves = JSON.stringify(mv.slice(-100));
}
const OWNER_ONLY = ['void_sale', 'save_product', 'import_products', 'stock_adjust', 'save_settings', 'save_user', 'list_devices', 'list_activity'];
if (OWNER_ONLY.indexOf(req.action) >= 0 && role !== 'owner') return fail('FORBIDDEN', 'Hanya pemilik');

const products = rows('Get Products');
const customers = rows('Get Customers');
const productById = {};
products.forEach(function (p) { productById[String(p.id)] = p; });
const customerById = {};
customers.forEach(function (c) { customerById[String(c.id)] = c; });

const DEFAULT_SETTINGS = {
  store_name: 'Khair Mart',
  address: 'Jl. Raya Condet No.4, Balekambang, Kramat Jati, Jakarta Timur',
  phone: '0811-9008-0090 / 0858-1045-4694',
  receipt_footer: 'Terima kasih 🙏 Produk halal & asli. Grosir & eceran.',
  paper: '58',
  survey_questions: [
    'Apakah ini pertama kali belanja di Khair Mart?',
    'Tahu Khair Mart dari mana?',
    'Apa yang paling Kakak suka di toko kami?',
    'Ada barang yang Kakak cari tapi tidak ada?',
    'Boleh kami kabari promo lewat WhatsApp?'
  ],
  exit_photo_min_total: 1000000,
  exit_photo_min_qty: 20,
  require_purchase_photo: true,
  require_shift: true,
  wa_shop_number: '',
  wa_manager_number: '',
  wa_owner_number: '',
  report_time: '21:00',
  max_discount_pct: 3,
  receipt_send_fee: 500,
  sell_from_shop_only: true,
  return_owner_min_value: 2000000,
  return_owner_min_qty: 0,
  return_fee_pct: 0,
  require_return_photo: true,
  require_carrier: true,
  limit_agreements: [],
  member_enabled: true,
  member_tiers: [{ from: 2, pct: 2 }, { from: 5, pct: 3 }, { from: 10, pct: 5 }],
  survey_voice: true,
  store_lat: 0,
  store_lng: 0,
  require_device_location: false,
  bank_accounts: []
};
const settingRows = rows('Get Settings');
const approvalRows = rows('Get Approvals');
function approvalById(id) { return approvalRows.find(function (a) { return a.request_id === id; }) || null; }
function canDecide(a) { return role === 'owner' || (role === 'manager' && a.approver_role !== 'owner'); }
function qtyOnly(c) { const x = Object.assign({}, c); ['cost_price', 'from_total', 'to_total', 'd_total'].forEach(function (f) { delete x[f]; }); return x; }
function approvalOut(a) {
  const o = clean(a);
  if (role !== 'owner' && o.payload) {
    try {
      const pl = JSON.parse(o.payload);
      if (pl.changes && pl.changes.cost_price) { pl.changes.cost_price = { from: null, to: null, hidden: true }; }
      o.payload = JSON.stringify(pl);
    } catch (e) { o.payload = ''; }
    o.summary = str(o.summary).replace(/cost_price -?\d+→-?\d+/g, 'cost_price (rahasia)');
  }
  if (role !== 'owner' && a.kind === 'purchase_fix') {
    // Goods-in corrections: quantities only for kasir / manager (purchase prices stay with the owner).
    try {
      const pl = JSON.parse(a.payload || '{}');
      if (Array.isArray(pl.changes)) pl.changes = pl.changes.map(qtyOnly);
      o.payload = JSON.stringify(pl);
    } catch (e) { o.payload = ''; }
    o.summary = str(o.summary).replace(/ \(Rp -?\d+→-?\d+\)/g, '');
    o.total = 0;
  }
  if (role !== 'owner' && a.kind === 'retur') {
    // Supplier returns are valued at purchase cost: only the owner sees the amounts.
    try {
      const pl = JSON.parse(a.payload || '{}');
      if (pl.kind === 'pemasok') {
        delete pl.value; delete pl.refund;
        (pl.lines || []).forEach(function (l) { delete l.unit_price; delete l.value; });
        o.payload = JSON.stringify(pl);
        o.total = 0;
        o.summary = str(o.summary).replace(/ \| nilai Rp -?\d+/g, '');
      }
    } catch (e) { o.payload = ''; }
  }
  if (!isApprover && a.kind === 'discount') {
    try {
      const pl = JSON.parse(a.payload || '{}');
      ['profit_before', 'profit_after', 'margin_before', 'margin_after', 'cost'].forEach(function (f) { delete pl[f]; });
      o.payload = JSON.stringify(pl);
    } catch (e) { o.payload = ''; }
    o.summary = str(o.summary).replace(/ \| laba[^|]*/g, '');
  }
  o.can_decide = canDecide(a);
  return o;
}
function newApproval(fields) {
  return Object.assign({
    request_id: 'AP' + rand(6), client_id: '', created_at: new Date().toISOString(), cashier: me.name,
    customer_id: 0, customer_name: '', customer_debt_before: 0, total: 0, debt_amount: 0, summary: '',
    status: 'pending', decided_by: '', decided_at: '', note: '', kind: 'credit', ref: '', payload: '', approver_role: 'manager'
  }, fields);
}
function doVoid(sale, reason, byName) {
  const items = rows('Get Items By Invoice').filter(function (it) { return it.invoice_no === sale.invoice_no; });
  const back = {};
  items.forEach(function (it) { back[String(it.product_id)] = (back[String(it.product_id)] || 0) + num(it.qty); });
  Object.keys(back).forEach(function (pid) {
    const p = productById[pid];
    if (p) {
      shopSet[String(p.id)] = Math.round((shopOf(p) + back[pid]) * 1000) / 1000;
      ops.products.push(forWrite(Object.assign({}, p, { stock: Math.round((num(p.stock) + back[pid]) * 1000) / 1000 }), p.id));
    }
  });
  const c = customerById[String(sale.customer_id)];
  if (c) {
    ops.customers.push(forWrite(Object.assign({}, c, {
      debt_balance: Math.max(0, money(c.debt_balance) - money(sale.debt_amount)), visits: Math.max(0, Math.round(num(c.visits)) - 1)
    }), c.id));
  }
  const voided = Object.assign({}, sale, { status: 'void', notes: (str(sale.notes) + ' [VOID oleh ' + byName + ': ' + str(reason) + ']').trim() });
  ops.sales.push(forWrite(voided, sale.id));
  return voided;
}
function applyPrices(p, changes) {
  const np = Object.assign({}, p);
  Object.keys(changes).forEach(function (f) { np[f] = changes[f].to; });
  ops.products.push(forWrite(np, p.id));
  return np;
}
const PRICE_FIELDS = ['retail_price', 'wholesale_price', 'cost_price'];
// Stock count (opname): each line's difference is counted against the stock at counting time, so sales made
// while the count waited for approval are not lost. Every change is logged as a 'STOK OPNAME' purchase row.
function applyCount(lines, note, byName) {
  const out = [];
  lines.forEach(function (l) {
    const p = productById[String(l.product_id)];
    const diff = Math.round(num(l.diff) * 1000) / 1000;
    if (!p || !diff) return;
    const newStock = Math.round((num(p.stock) + diff) * 1000) / 1000;
    ops.products.push(forWrite(Object.assign({}, p, { stock: newStock }), p.id));
    ops.purchases.push(forWrite({
      purchase_date: jkDate(), supplier: 'STOK OPNAME', product_id: p.id, name: str(p.name), qty: diff, cost_price: money(p.cost_price), total: 0,
      note: (str(note) + ' (dihitung ' + l.counted + ', sistem ' + l.system + ')').trim().slice(0, 500), user: byName, photo_id: '', exp_date: ''
    }, -1));
    const o = { product_id: p.id, stock: newStock };
    out.push(o);
  });
  return out;
}
function computeSale(invoice, quote) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return { error: fail('INVALID', 'Keranjang kosong') };
  if (!isDate(data.sale_date)) return { error: fail('INVALID', 'Tanggal tidak valid') };
  let customer = null;
  if (data.customer_id !== undefined && data.customer_id !== null && data.customer_id !== '' && Number(data.customer_id) !== 0) {
    customer = customerById[String(data.customer_id)] || null;
    if (!customer) return { error: fail('NOT_FOUND', 'Pelanggan tidak ditemukan') };
  }
  const lines = [];
  const qtyByProduct = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const p = productById[String(it.product_id)];
    if (!p) return { error: fail('NOT_FOUND', 'Produk tidak ditemukan: ' + it.product_id) };
    const qty = Math.round(num(it.qty) * 1000) / 1000;
    if (!(qty > 0)) return { error: fail('INVALID', 'Jumlah tidak valid: ' + p.name) };
    const unitPrice = money(it.unit_price);
    if (unitPrice < 0) return { error: fail('INVALID', 'Harga tidak valid: ' + p.name) };
    const cost = money(p.cost_price);
    const lineTotal = Math.round(qty * unitPrice);
    // List price (for the discount rule): wholesale when the customer is grosir or the line reaches the wholesale minimum, else retail.
    const grosirOk = money(p.wholesale_price) > 0 && ((customer && customer.type === 'grosir') || (num(p.wholesale_min_qty) > 0 && qty >= num(p.wholesale_min_qty)));
    const listPrice = grosirOk ? Math.min(money(p.wholesale_price), money(p.retail_price) || money(p.wholesale_price)) : money(p.retail_price);
    lines.push({
      invoice_no: invoice, sale_date: data.sale_date, product_id: p.id, sku: str(p.sku), name: str(p.name),
      qty: qty, unit_price: unitPrice, price_type: it.price_type === 'grosir' ? 'grosir' : 'eceran',
      cost_price: cost, line_total: lineTotal, line_profit: lineTotal - Math.round(qty * cost), list_total: Math.round(qty * listPrice),
      customer_name: customer ? str(customer.name) : str(data.customer_name || 'Umum')
    });
    qtyByProduct[String(p.id)] = (qtyByProduct[String(p.id)] || 0) + qty;
  }
  const subtotal = lines.reduce(function (a, l) { return a + l.line_total; }, 0);
  const discount = Math.min(Math.max(money(data.discount), 0), subtotal);
  // Receipt sent by WhatsApp / e-mail: the first one per customer is free (it is how we get the number), later ones
  // add receipt_send_fee (default Rp 500) to the bill. Sending needs a saved customer (phone / e-mail).
  if (data.send_receipt === true && !customer) return { error: fail('INVALID', 'Simpan nomor HP pelanggan dulu untuk kirim struk') };
  const sendFee = data.send_receipt === true ? receiptFee(customer) : 0;
  const total = subtotal - discount + sendFee;
  const totalCost = lines.reduce(function (a, l) { return a + Math.round(l.qty * l.cost_price); }, 0);
  const method = ['tunai', 'transfer', 'qris', 'hutang'].indexOf(data.payment_method) >= 0 ? data.payment_method : 'tunai';
  let paid = Math.max(money(data.paid_amount), 0);
  if (method === 'hutang' && data.paid_amount === undefined) paid = 0;
  const debt = Math.max(0, total - paid);
  if (debt > 0 && !customer && !quote) return { error: fail('INVALID', 'Hutang / bayar kurang wajib pilih pelanggan') };
  const listTotal = lines.reduce(function (a, l) { return a + l.list_total; }, 0);
  lines.forEach(function (l) { delete l.list_total; });
  return { lines: lines, qtyByProduct: qtyByProduct, customer: customer, subtotal: subtotal, discount: discount, total: total, totalCost: totalCost, method: method, paid: paid, debt: debt, listTotal: listTotal, sendFee: sendFee };
}
// Discount = list value − what the customer pays (a typed discount and lowered prices both count).
function discountOf(c) {
  const amount = Math.max(0, c.listTotal - (c.total - (c.sendFee || 0)));
  return { amount: amount, pct: c.listTotal > 0 ? Math.round(amount / c.listTotal * 1000) / 10 : 0 };
}
function receiptFee(cust) {
  const v = readSettings().receipt_send_fee;
  const fee = v === undefined || v === null || v === '' ? 500 : Math.max(0, money(v));
  return cust && num(cust.receipts_sent) >= 1 ? fee : 0;
}
function maxDiscountPct() { const v = num(readSettings().max_discount_pct); return v > 0 ? v : 3; }
// Member discount for repeat purchases: this sale is purchase number visits + 1; highest tier with from <= that number.
function memberInfo(cust) {
  const st = readSettings();
  if (!cust || cust.member !== true || st.member_enabled === false) return null;
  const n = Math.max(0, Math.round(num(cust.visits))) + 1;
  const tiers = Array.isArray(st.member_tiers) ? st.member_tiers : DEFAULT_SETTINGS.member_tiers;
  let pct = 0;
  tiers.forEach(function (t) { const f = num(t && t.from), p = num(t && t.pct); if (f >= 1 && f <= n && p > 0 && p <= 50 && p > pct) pct = p; });
  return { pct: pct, purchase_no: n, member_no: str(cust.member_no) };
}
// ---- Returns, carriers and strict text fields (v16) ----
// Limits the owner and the manager agree on together: changed only through propose_agreement, approved by the other one.
const AGREED_KEYS = ['return_owner_min_value', 'return_owner_min_qty'];
const RETURN_REASONS = ['tidak_sesuai', 'rusak', 'kadaluarsa', 'salah_kirim', 'kualitas_buruk', 'berubah_pikiran', 'lainnya'];
const RETURN_REASON_TEXT = { tidak_sesuai: 'Tidak sesuai spesifikasi', rusak: 'Rusak / cacat', kadaluarsa: 'Kedaluwarsa', salah_kirim: 'Salah kirim / salah barang', kualitas_buruk: 'Kualitas buruk', berubah_pikiran: 'Pelanggan berubah pikiran', lainnya: 'Lainnya' };
// A person's name: starts with a letter (any language), then letters, digits, spaces and . , ' - only, at most 60 characters.
function personName(v) { const x = str(v).replace(/\s+/g, ' '); return /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'-]{0,59}$/u.test(x) ? x : ''; }
// Document / vehicle numbers: letters, digits, space and / - . only.
// Names of products, shops, customers, suppliers: letters, digits, space and . , ' & ( ) / % + # - only.
function safeName(v, max) { const x = str(v).replace(/\s+/g, ' '); return x.length <= (max || 80) && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'&()\/%+#-]*$/u.test(x) ? x : ''; }
function docNo(v) { const x = str(v).toUpperCase().replace(/\s+/g, ' '); return /^[A-Z0-9][A-Z0-9 \/.-]{0,39}$/.test(x) ? x : ''; }
// Who brought (goods-in) or took (supplier return) the goods: public transport + its number, a friend's name,
// the supplier's driver, or one of our staff.
const CARRIER_TYPES = ['umum', 'teman', 'pemasok', 'karyawan'];
function readCarrier(c, required) {
  c = c && typeof c === 'object' ? c : {};
  const type = CARRIER_TYPES.indexOf(c.type) >= 0 ? c.type : '';
  if (!type) return required ? { error: 'Pilih siapa yang membawa barang (kendaraan umum / teman / sopir pemasok / karyawan)' } : { type: '', name: '', vehicle: '', phone: '' };
  const name = str(c.name) ? personName(c.name) : '';
  if (str(c.name) && !name) return { error: 'Nama pembawa barang hanya boleh huruf' };
  const vehicle = str(c.vehicle) ? docNo(c.vehicle) : '';
  if (str(c.vehicle) && !vehicle) return { error: 'Nomor kendaraan hanya boleh huruf dan angka' };
  const phone = str(c.phone) ? normPhone(c.phone) : '';
  if (str(c.phone) && !phone) return { error: 'Nomor HP pembawa tidak valid' };
  if (type === 'umum' && !vehicle) return { error: 'Kendaraan umum: tulis nomor kendaraannya (plat / nomor angkot)' };
  if ((type === 'teman' || type === 'karyawan') && !name) return { error: 'Tulis nama orang yang membawa barang' };
  const kindText = str(c.kind) ? str(c.kind).replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 30) : '';
  return { type: type, name: name || kindText, vehicle: vehicle, phone: phone };
}
// Quantities already returned (approved returns + pending requests) for one invoice / goods-in note.
function returnedBefore(ref) {
  const q = {};
  const add = function (lines) { (Array.isArray(lines) ? lines : []).forEach(function (l) { const k = String(l.product_id); q[k] = Math.round(((q[k] || 0) + num(l.qty)) * 1000) / 1000; }); };
  rows('Get Returns By Ref').filter(function (r) { return str(r.ref) === ref && r.status === 'approved'; }).forEach(function (r) { let l = []; try { l = JSON.parse(r.lines || '[]'); } catch (e) { l = []; } add(l); });
  approvalRows.filter(function (a) { return a.kind === 'retur' && a.status === 'pending'; }).forEach(function (a) { let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; } if (str(pl.ref) === ref) add(pl.lines); });
  return q;
}
function returnOut(r) {
  if (!r) return null;
  const o = clean(r);
  if (typeof o.lines === 'string') { try { o.lines = JSON.parse(o.lines); } catch (e) { o.lines = []; } }
  if (role === 'kasir' && o.kind === 'pemasok') return null;
  if (role !== 'owner' && o.kind === 'pemasok') { delete o.value; delete o.refund; (o.lines || []).forEach(function (l) { delete l.unit_price; delete l.value; }); }
  return o;
}
function isEmail(v) { return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(v) && v.length <= 120; }
function marginPct(total, cost) { return total > 0 ? Math.round((total - cost) / total * 1000) / 10 : 0; }
// Indonesian mobile number → 62…; '' when it does not look like a phone number
function normPhone(v) {
  let d = str(v).replace(/\D/g, '');
  if (d.indexOf('0') === 0) d = '62' + d.slice(1);
  else if (d.indexOf('8') === 0) d = '62' + d;
  return d.length >= 9 && d.length <= 15 ? d : '';
}
function readSettings() {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settingRows.forEach(function (r) {
    try { s[r.skey] = JSON.parse(r.svalue); } catch (e) { s[r.skey] = r.svalue; }
  });
  return s;
}
function productOut(p) { const sh = shopOf(p); return Object.assign(strip(p, role), { shop_stock: sh, gudang_stock: Math.round((num(p.stock) - sh) * 1000) / 1000 }); }

// ---- Activity log for the owner: every change, correction or decision, with date and time ----
function logAct(kind, summary, ref, amount, level) {
  ops.activity.push(forWrite({
    act_id: 'AC' + rand(8), at: new Date().toISOString(), act_date: jkDate(), user: me.name, role: role, kind: kind,
    summary: str(summary).slice(0, 1000), ref: str(ref).slice(0, 60), amount: money(amount), level: level || 'info'
  }, -1));
}
function fmtN(v) { return String(Math.round(num(v) * 1000) / 1000); }

// ---- Goods-in vs the photographed supplier note (extracted by the photo workflow) ----
function normName(x) {
  return str(x).toLowerCase().replace(/(\d+)[.,]?(\d*)\s*(kg|gr|gram|g|ml|ltr|l|pcs|pc)\b/g, '$1$2$3').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameTokens(x) { return normName(x).split(' ').filter(function (t) { return t.length > 1; }); }
function nearTok(a1, b1) {
  if (a1 === b1) return true;
  if (a1.length > 3 && b1.length > 3 && (a1.indexOf(b1) === 0 || b1.indexOf(a1) === 0)) return true;
  if (a1.length < 5 || b1.length < 5 || Math.abs(a1.length - b1.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a1.length && j < b1.length) {
    if (a1[i] === b1[j]) { i++; j++; continue; }
    edits++;
    if (edits > 1) return false;
    if (a1.length > b1.length) i++; else if (b1.length > a1.length) j++; else { i++; j++; }
  }
  return edits + (a1.length - i) + (b1.length - j) <= 1;
}
function nameScore(a1, b1) {
  const ta = nameTokens(a1), tb = nameTokens(b1);
  if (!ta.length || !tb.length) return 0;
  let hit = 0;
  ta.forEach(function (t) { if (tb.some(function (u) { return nearTok(t, u); })) hit++; });
  return Math.round(((hit / ta.length + hit / tb.length) / 2) * 100) / 100;
}
// lines: [{name, qty, photo_index?}] → {status: cocok | tidak_cocok | perlu_cek, diffs: [{name, recorded_qty, photo_qty}]}
function matchNote(lines, photoRow) {
  let ex = {};
  try { ex = JSON.parse(photoRow.extracted || '{}'); } catch (e) { ex = {}; }
  const pitems = Array.isArray(ex.items) ? ex.items : [];
  if (ex.readable === false || !pitems.length) return { status: 'perlu_cek', diffs: [], notes: 'Nota tidak terbaca' };
  const used = {};
  const diffs = [];
  let unsure = false;
  lines.forEach(function (l) {
    let idx = -1;
    const pi = Number(l.photo_index);
    if (l.photo_index !== undefined && l.photo_index !== null && l.photo_index !== '' && isFinite(pi) && pi >= 0 && pi < pitems.length && !used[pi]) idx = pi;
    if (idx < 0) {
      let best = -1, bs = 0;
      pitems.forEach(function (it, k) { if (used[k]) return; const sc = nameScore(it.name, l.name); if (sc > bs) { bs = sc; best = k; } });
      if (bs >= 0.5) idx = best;
    }
    if (idx < 0) { diffs.push({ name: l.name, recorded_qty: l.qty, photo_qty: null }); return; }
    used[idx] = true;
    const pq = pitems[idx].qty;
    if (pq === null || pq === undefined || !isFinite(Number(pq))) { unsure = true; return; }
    if (Math.abs(num(pq) - num(l.qty)) > 0.001) diffs.push({ name: l.name, recorded_qty: l.qty, photo_qty: num(pq) });
  });
  pitems.forEach(function (it, k) { if (!used[k] && str(it.name)) diffs.push({ name: str(it.name), recorded_qty: null, photo_qty: it.qty === null || it.qty === undefined ? null : num(it.qty) }); });
  return { status: diffs.length ? 'tidak_cocok' : (unsure ? 'perlu_cek' : 'cocok'), diffs: diffs.slice(0, 50), notes: '' };
}
function diffText(diffs) {
  return diffs.map(function (d) { return d.name + ': input ' + (d.recorded_qty === null ? '-' : fmtN(d.recorded_qty)) + ' / nota ' + (d.photo_qty === null ? '-' : fmtN(d.photo_qty)); }).join('; ');
}
// Purchase correction (after saving, only with manager / owner approval): target lines vs what the rows say now.
function purchaseRowsOf(no) { return rows('Get Purchase By No').filter(function (r) { return str(r.purchase_no) === no; }); }
function purchaseFixChanges(no, lines) {
  const cur = {};
  purchaseRowsOf(no).forEach(function (r) {
    const k = String(r.product_id);
    if (!cur[k]) cur[k] = { qty: 0, total: 0, supplier: str(r.supplier), name: str(r.name) };
    cur[k].qty = Math.round((cur[k].qty + num(r.qty)) * 1000) / 1000;
    cur[k].total += money(r.total);
  });
  const changes = [];
  (Array.isArray(lines) ? lines : []).slice(0, 100).forEach(function (l) {
    const c = cur[String(l.product_id)];
    if (!c) return;
    const qty = Math.round(num(l.qty) * 1000) / 1000;
    if (qty < 0) return;
    const cost = l.cost_price === undefined || l.cost_price === null || l.cost_price === '' ? (c.qty > 0 ? Math.round(c.total / c.qty) : 0) : money(l.cost_price);
    const total = Math.round(qty * cost);
    const dq = Math.round((qty - c.qty) * 1000) / 1000, dt = total - c.total;
    if (dq !== 0 || dt !== 0) changes.push({ product_id: Number(l.product_id), name: c.name, supplier: c.supplier, from_qty: c.qty, to_qty: qty, from_total: c.total, to_total: total, cost_price: cost, d_qty: dq, d_total: dt });
  });
  return { found: Object.keys(cur).length > 0, changes: changes };
}
function applyPurchaseFix(no, changes, reason, byName) {
  const out = [];
  changes.forEach(function (ch) {
    const p = productById[String(ch.product_id)];
    if (!p) return;
    const st = num(p.stock), ns = Math.round((st + ch.d_qty) * 1000) / 1000;
    const nc = ns > 0 && st + ch.d_qty > 0 ? Math.max(0, Math.round((Math.max(0, st) * money(p.cost_price) + ch.d_total) / Math.max(ns, 0.001))) : money(p.cost_price);
    ops.products.push(forWrite(Object.assign({}, p, { stock: ns, cost_price: nc }), p.id));
    ops.purchases.push(forWrite({
      purchase_date: jkDate(), supplier: ch.supplier, product_id: p.id, name: str(p.name), qty: ch.d_qty, cost_price: ch.cost_price, total: ch.d_total,
      note: ('KOREKSI ' + no + ': ' + fmtN(ch.from_qty) + '→' + fmtN(ch.to_qty) + ' | ' + str(reason)).slice(0, 500), user: byName, photo_id: '', exp_date: '',
      purchase_no: no, match_status: 'koreksi', match_notes: str(reason).slice(0, 300)
    }, -1));
    const o = { product_id: p.id, stock: ns };
    if (role === 'owner') o.cost_price = nc;
    out.push(o);
  });
  return out;
}
// ---- Payments in / out, matched with the transfer slip, allocated to invoices / goods-in notes (v13) ----
const partyPayments = rows('Get Party Payments');
function payAlloc(p) { let a1 = []; try { a1 = JSON.parse(p.alloc || '[]'); } catch (e) { a1 = []; } return Array.isArray(a1) ? a1 : []; }
function payDir(p) { return str(p.direction) || 'in'; }
// Open documents of a party: customer → sales with debt; supplier → goods-in notes. paid = allocations of other payments.
function partyDocs(partyType, key, excludePayId) {
  const docs = {};
  if (partyType === 'customer') {
    rows('Get Party Sales').filter(function (x) { return Number(x.customer_id) === Number(key) && x.status !== 'void' && money(x.debt_amount) > 0; })
      .forEach(function (x) { docs[x.invoice_no] = { ref: x.invoice_no, date: str(x.sale_date), total: money(x.debt_amount), paid: 0 }; });
  } else {
    rows('Get Party Purchases').filter(function (x) { return str(x.supplier) === key; }).forEach(function (x) {
      const ref = str(x.purchase_no) || ('PB-' + str(x.purchase_date));
      if (!docs[ref]) docs[ref] = { ref: ref, date: str(x.purchase_date), total: 0, paid: 0 };
      docs[ref].total += money(x.total);
      if (str(x.purchase_date) < docs[ref].date) docs[ref].date = str(x.purchase_date);
    });
  }
  partyPayments.forEach(function (p) {
    if (excludePayId && p.pay_id === excludePayId) return;
    const mine = partyType === 'customer' ? (Number(p.customer_id) === Number(key) && payDir(p) === 'in') : (str(p.supplier) === key && payDir(p) === 'out');
    if (!mine) return;
    payAlloc(p).forEach(function (a1) { if (docs[a1.ref]) docs[a1.ref].paid += money(a1.amount); });
  });
  Object.keys(docs).forEach(function (k) { docs[k].remaining = Math.max(0, docs[k].total - docs[k].paid); });
  return docs;
}
function checkAlloc(list, docs, amount) {
  const out = [];
  let sum = 0;
  const seen = {};
  for (let i = 0; i < (Array.isArray(list) ? list.slice(0, 50) : []).length; i++) {
    const a1 = list[i] || {};
    const ref = str(a1.ref || a1.invoice_no || a1.purchase_no), amt = money(a1.amount);
    if (!ref || !(amt > 0)) return { error: 'Alokasi tidak valid' };
    if (!docs[ref]) return { error: 'Faktur / nota tidak ditemukan untuk pihak ini: ' + ref };
    if (seen[ref]) return { error: 'Faktur dobel di alokasi: ' + ref };
    seen[ref] = true;
    if (amt > docs[ref].remaining) return { error: 'Alokasi ' + ref + ' melebihi sisa (' + docs[ref].remaining + ')' };
    sum += amt;
    out.push({ ref: ref, amount: amt });
  }
  if (sum > amount) return { error: 'Total alokasi melebihi jumlah pembayaran' };
  return { alloc: out, sum: sum };
}
function allocStatus(amount, chk, docs) {
  if (!chk.alloc.length) return 'belum_dialokasi';
  if (chk.alloc.some(function (a1) { return docs[a1.ref].remaining - a1.amount > 0; })) return 'sebagian';
  if (chk.sum < amount) return 'lebih';
  return 'lunas';
}
function slipCheck(amount) {
  // A payment with a photographed slip must have the slip's amount (or a reason).
  if (!str(data.photo_id)) return null;
  const ph = rows('Get Photo').find(function (x) { return x.photo_id === str(data.photo_id); });
  if (!ph || ph.kind !== 'bayar') return { fail: fail('INVALID', 'Foto bukti pembayaran tidak ditemukan') };
  let ex = {};
  try { ex = JSON.parse(ph.extracted || '{}'); } catch (e) { ex = {}; }
  const slip = ex.amount === null || ex.amount === undefined || !isFinite(Number(ex.amount)) ? null : money(ex.amount);
  if (slip !== null && slip !== amount && !str(data.mismatch_reason)) {
    Object.keys(ops).forEach(function (k) { ops[k] = []; });
    return { fail: done({ ok: false, error: 'MISMATCH', message: 'Jumlah tidak sama dengan bukti transfer: input ' + amount + ', bukti ' + slip, slip_amount: slip, extracted: ex }) };
  }
  return { slip: slip, ex: ex };
}
function dupRef(ref) { return str(ref) && partyPayments.some(function (p) { return str(p.transfer_ref) && str(p.transfer_ref).toLowerCase() === str(ref).toLowerCase(); }); }
function payOut(p) { const o = clean(p); o.alloc = payAlloc(p); return o; }
// Company bank accounts (settings.bank_accounts: [{id, bank, account_no, holder, active}]); bank payments name the account used.
function bankAccounts() { const a1 = readSettings().bank_accounts; return Array.isArray(a1) ? a1.filter(function (x) { return x && str(x.id); }) : []; }
function payAccount(method) {
  if (method !== 'transfer' && method !== 'qris') return '';
  const accs = bankAccounts();
  const want = str(data.account_id);
  if (want && accs.some(function (x) { return str(x.id) === want; })) return want;
  const act = accs.filter(function (x) { return x.active !== false; });
  return act.length ? str(act[0].id) : '';
}
function dayNum(d) { return Math.round(Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') / 86400000); }

// ---- Monthly bank statement vs payments recorded in the app (v14) ----
function periodRange(period) {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: period + '-01', to: period + '-' + (last < 10 ? '0' : '') + last };
}
function reconcile(lines, accountId, period) {
  const pr = periodRange(period);
  const pays = rows('Get Range Payments').filter(function (p) {
    return (p.method === 'transfer' || p.method === 'qris') && (!str(p.account_id) || str(p.account_id) === accountId);
  });
  const used = {};
  lines.forEach(function (l) { if (l.status === 'manual' && l.pay_id) used[l.pay_id] = true; });
  const out = lines.filter(function (l) { return l.status !== 'dihapus'; }).map(function (l) {
    const r = { line_id: l.line_id, seq: l.seq, line_date: l.line_date, description: l.description, amount: money(l.amount), ref: l.ref, balance: l.balance, note: str(l.note) };
    if (l.status === 'manual' || l.status === 'diabaikan') return Object.assign(r, { status: l.status, pay_id: str(l.pay_id), diff_days: 0 });
    const dir = money(l.amount) > 0 ? 'in' : 'out', abs = Math.abs(money(l.amount));
    const text = (str(l.description) + ' ' + str(l.ref)).toLowerCase();
    let best = null;
    pays.forEach(function (p) {
      if (used[p.pay_id] || payDir(p) !== dir) return;
      const refHit = !!(str(p.transfer_ref) && str(p.transfer_ref).length >= 4 && text.indexOf(str(p.transfer_ref).toLowerCase()) >= 0);
      const diff = Math.abs(dayNum(l.line_date) - dayNum(p.pay_date));
      const same = money(p.amount) === abs;
      if (!same && !refHit) return;
      if (same && !refHit && diff > 3) return;
      const sc = (refHit ? 0 : 10) + (same ? 0 : 100) + diff;
      if (!best || sc < best.sc) best = { sc: sc, p: p, diff: diff, same: same };
    });
    if (!best) return Object.assign(r, { status: 'tidak_tercatat', pay_id: '', diff_days: null });
    used[best.p.pay_id] = true;
    return Object.assign(r, { status: !best.same ? 'beda_jumlah' : (best.diff <= 1 ? 'cocok' : 'beda_tanggal'), pay_id: best.p.pay_id, diff_days: best.diff,
      pay_amount: money(best.p.amount), pay_date: str(best.p.pay_date), party: str(best.p.customer_name) || str(best.p.supplier) });
  });
  const missing = pays.filter(function (p) { return !used[p.pay_id] && str(p.pay_date) >= pr.from && str(p.pay_date) <= pr.to; }).map(payOut);
  const inPeriod = pays.filter(function (p) { return str(p.pay_date) >= pr.from && str(p.pay_date) <= pr.to; });
  const sum = function (arr, f) { return arr.reduce(function (a1, x) { return a1 + f(x); }, 0); };
  const counts = {};
  out.forEach(function (x) { counts[x.status] = (counts[x.status] || 0) + 1; });
  return {
    lines: out, missing: missing, counts: counts,
    totals: {
      statement_in: sum(out, function (x) { return x.amount > 0 ? x.amount : 0; }), statement_out: sum(out, function (x) { return x.amount < 0 ? -x.amount : 0; }),
      recorded_in: sum(inPeriod, function (p) { return payDir(p) === 'in' ? money(p.amount) : 0; }), recorded_out: sum(inPeriod, function (p) { return payDir(p) === 'out' ? money(p.amount) : 0; })
    }
  };
}
function reconText(acc, period, rep) {
  const c = rep.counts;
  return 'Rekening ' + str(acc.bank) + ' ' + str(acc.account_no) + ' ' + period + ': ' + rep.lines.length + ' baris — cocok ' + ((c.cocok || 0) + (c.manual || 0)) +
    ', beda tanggal ' + (c.beda_tanggal || 0) + ', beda jumlah ' + (c.beda_jumlah || 0) + ', tidak tercatat di aplikasi ' + (c.tidak_tercatat || 0) +
    ', diabaikan ' + (c.diabaikan || 0) + ', tercatat tapi tidak ada di rekening ' + rep.missing.length;
}
function fixSummary(no, changes) { return 'Koreksi barang masuk ' + no + ': ' + changes.map(function (c) { return c.name + ' ' + fmtN(c.from_qty) + '→' + fmtN(c.to_qty) + (c.d_total ? ' (Rp ' + c.from_total + '→' + c.to_total + ')' : ''); }).join('; '); }

// ---- Devices: where each phone / tablet / computer running one of the apps is (the app asks the user's consent
// first). Every request may carry data.device = {id, app, label, lat, lng, acc, loc_status, battery}; the row is
// written only when something changed (new device, other user, status, moved > 100 m) or every 10 minutes, so
// location costs no extra executions. device_ping does the same on its own (app open, every 30 min when idle). ----
const deviceRows = rows('Get Devices');
function isCoord(lat, lng) { return isFinite(Number(lat)) && isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && !(Number(lat) === 0 && Number(lng) === 0) && lat !== null && lat !== '' && lng !== null && lng !== ''; }
function metres(aLat, aLng, bLat, bLng) {
  const R = 6371000, k = Math.PI / 180, dLat = (bLat - aLat) * k, dLng = (bLng - aLng) * k;
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * k) * Math.cos(bLat * k) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function deviceTouch(dev, force) {
  if (!dev || typeof dev !== 'object') return null;
  const id = str(dev.id);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const ex = deviceRows.find(function (x) { return x.device_id === id; }) || null;
  const now = new Date().toISOString();
  const hasLoc = isCoord(dev.lat, dev.lng);
  const status = ['granted', 'denied', 'unavailable', 'prompt', 'off'].indexOf(dev.loc_status) >= 0 ? dev.loc_status : (hasLoc ? 'granted' : 'unavailable');
  if (ex && !force) {
    const moved = hasLoc && (!isCoord(ex.lat, ex.lng) || metres(num(ex.lat), num(ex.lng), num(dev.lat), num(dev.lng)) > 100);
    const stale = !(Date.parse(ex.last_seen) > Date.now() - 600000);
    if (!moved && !stale && str(ex.user) === me.name && str(ex.loc_status) === status) return ex;
  }
  const row = {
    device_id: id, user: me.name, role: role, app: ['owner', 'kasir', 'sales'].indexOf(dev.app) >= 0 ? dev.app : 'owner',
    label: str(dev.label).slice(0, 60), ua: str(req.ua).slice(0, 300), ip: str(req.ip).slice(0, 60),
    lat: hasLoc ? Math.round(num(dev.lat) * 1e6) / 1e6 : (ex ? num(ex.lat) : 0), lng: hasLoc ? Math.round(num(dev.lng) * 1e6) / 1e6 : (ex ? num(ex.lng) : 0),
    acc: hasLoc ? Math.round(num(dev.acc)) : (ex ? num(ex.acc) : 0), loc_status: status, loc_at: hasLoc ? now : (ex ? str(ex.loc_at) : ''),
    first_seen: ex ? str(ex.first_seen) || now : now, last_seen: now, pings: (ex ? num(ex.pings) : 0) + 1,
    battery: isFinite(Number(dev.battery)) && dev.battery !== null && dev.battery !== '' ? Math.round(Math.min(1, Math.max(0, num(dev.battery))) * 100) / 100 : (ex ? num(ex.battery) : 0)
  };
  ops.devices.push(forWrite(row, ex ? ex.id : -1));
  if (!ex) logAct('perangkat_baru', 'Perangkat baru: ' + (row.label || 'tanpa nama') + ' (' + row.app + ', ' + me.name + ')' + (row.ip ? ' IP ' + row.ip : ''), id, 0, 'info');
  return row;
}
if (req.action !== 'device_ping') deviceTouch(data.device, false);

switch (req.action) {
  case 'login':
    if (viaMaster) logAct('masuk_master', 'Masuk ke akun ' + me.name + ' (' + role + ') dengan kode pemilik', me.name, 0, 'warn');
    return done({ ok: true, user: { name: me.name, role: role }, must_change: me.must_change === true && !viaMaster, via_master: viaMaster });

  case 'move_stock': {
    // Warehouse → shelf (to: "toko") or back (to: "gudang"). Moving to the shelf needs the goods in the warehouse first,
    // and warehouse stock only comes from goods-in with the supplier note (or the owner's count / correction).
    const toShop = data.to !== 'gudang';
    const lines = Array.isArray(data.lines) ? data.lines.slice(0, 200) : [];
    if (!lines.length) return fail('INVALID', 'Pilih barang yang dipindah');
    const agg = {};
    for (let i = 0; i < lines.length; i++) {
      const p = productById[String(lines[i] && lines[i].product_id)];
      if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan: ' + (lines[i] && lines[i].product_id));
      const q = Math.round(num(lines[i].qty) * 1000) / 1000;
      if (!(q > 0)) return fail('INVALID', 'Jumlah tidak valid: ' + str(p.name));
      agg[String(p.id)] = Math.round(((agg[String(p.id)] || 0) + q) * 1000) / 1000;
    }
    const short = [], out = [];
    Object.keys(agg).forEach(function (pid) {
      const p = productById[pid], sh = shopOf(p), gd = Math.round((num(p.stock) - sh) * 1000) / 1000, q = agg[pid];
      if (toShop && q > gd + 1e-9) short.push(str(p.name) + ': gudang ' + fmtN(Math.max(0, gd)) + (gd <= 0 ? ' — belum ada barang masuk dengan nota' : ''));
      else if (!toShop && q > sh + 1e-9) short.push(str(p.name) + ': rak ' + fmtN(Math.max(0, sh)));
      else out.push({ p: p, q: q, sh: Math.round((sh + (toShop ? q : -q)) * 1000) / 1000 });
    });
    if (short.length) return fail(toShop ? 'NOT_IN_GUDANG' : 'NOT_ON_SHELF', (toShop ? 'Tidak bisa pindah ke toko — stok gudang kurang: ' : 'Stok rak kurang: ') + short.join('; '));
    out.forEach(function (x) { shopSet[String(x.p.id)] = x.sh; ops.products.push(forWrite(Object.assign({}, x.p), x.p.id)); });
    const note = str(data.note).slice(0, 200);
    logAct('pindah_stok', (toShop ? 'Gudang → toko: ' : 'Toko → gudang: ') + out.map(function (x) { return str(x.p.name) + ' ' + fmtN(x.q) + ' ' + str(x.p.unit); }).join('; ') + (note ? ' | ' + note : ''), '', 0, 'info');
    return done({ ok: true, stock: out.map(function (x) { return { product_id: x.p.id, stock: num(x.p.stock), shop_stock: x.sh, gudang_stock: Math.round((num(x.p.stock) - x.sh) * 1000) / 1000 }; }) });
  }

  case 'change_pin': {
    if (!isHash(data.new_pin_hash)) return fail('INVALID', 'PIN baru tidak valid');
    if (data.new_pin_hash === me.pin_hash) return fail('INVALID', 'PIN baru harus berbeda dari PIN lama');
    if (viaMaster && role === 'owner') return fail('FORBIDDEN', 'PIN pemilik hanya bisa diganti dengan PIN pemilik sendiri');
    if (activeUsers.some(function (u) { return isHash(u.master_hash) && u.master_hash === data.new_pin_hash; })) return fail('INVALID', 'PIN baru tidak valid');
    ops.users.push(forWrite(Object.assign({}, me, { pin_hash: data.new_pin_hash, must_change: viaMaster, fail_count: 0, locked_until: '' }), me.id));
    logAct('ganti_pin', viaMaster ? 'PIN ' + me.name + ' direset dengan kode pemilik (wajib ganti saat masuk)' : me.name + ' mengganti PIN sendiri', me.name, 0, viaMaster ? 'warn' : 'info');
    return done({ ok: true, must_change: viaMaster });
  }

  case 'set_master': {
    if (role !== 'owner' || viaMaster) return fail('FORBIDDEN', 'Hanya pemilik dengan PIN sendiri');
    if (!isHash(data.master_hash) || data.master_hash === me.pin_hash) return fail('INVALID', 'Kode pemilik tidak valid');
    if (users.some(function (u) { return u.pin_hash === data.master_hash; })) return fail('INVALID', 'Kode pemilik tidak valid');
    ops.users.push(forWrite(Object.assign({}, me, { master_hash: data.master_hash, fail_count: 0, locked_until: '' }), me.id));
    logAct('kode_pemilik', 'Kode pemilik ' + (isHash(me.master_hash) ? 'diganti' : 'dibuat'), me.name, 0, 'warn');
    return done({ ok: true });
  }

  case 'device_ping': {
    if (!deviceTouch(data.device, true)) return fail('INVALID', 'device.id tidak valid');
    return done({ ok: true, require_location: readSettings().require_device_location === true, server_time: new Date().toISOString() });
  }

  case 'list_devices': {
    const st = readSettings();
    return done({
      ok: true, store: { lat: num(st.store_lat), lng: num(st.store_lng) },
      devices: deviceRows.map(clean).sort(function (a, b) { return String(b.last_seen).localeCompare(String(a.last_seen)); }),
      server_time: new Date().toISOString()
    });
  }

  case 'bootstrap':
    return done({
      ok: true,
      user: { name: me.name, role: role },
      approvals_pending: isApprover ? approvalRows.filter(function (a) { return a.status === 'pending' && canDecide(a); }).length : 0,
      products: products.map(productOut),
      customers: customers.map(clean),
      settings: readSettings(),
      users: users.map(function (u) { return role === 'owner' ? { name: u.name, role: u.role, active: u.active !== false, must_change: u.must_change === true, locked: Date.parse(u.locked_until) > Date.now(), has_master: u.role === 'owner' && isHash(u.master_hash) } : { name: u.name, role: u.role, active: u.active !== false }; }),
      via_master: viaMaster, must_change: me.must_change === true && !viaMaster,
      shift: shiftOut(myShift),
      open_shifts: isApprover ? openShifts.map(shiftOut) : [],
      activity_recent: role === 'owner' ? rows('Get Range Activity').map(clean).sort(function (a1, b1) { return String(b1.at).localeCompare(String(a1.at)); }).slice(0, 100) : [],
      server_time: new Date().toISOString()
    });

  case 'save_sale': {
    const dup = rows('Get Sale By Client').filter(function (x) { return x.client_id === req.client_id; });
    if (dup.length) {
      return done({ ok: true, duplicate: true, invoice_no: dup[0].invoice_no, sale: strip(dup[0], role), stock: [] });
    }
    // The cash drawer belongs to the cashier: only kasir accounts need an open shift (owner / manager sell without one).
    if (!myShift && role === 'kasir' && readSettings().require_shift !== false) return fail('SHIFT_REQUIRED', 'Buka kasir (shift) dulu');
    const invoice = 'KM' + str(data.sale_date).replace(/-/g, '').slice(2) + '-' + rand(5);
    const c = computeSale(invoice);
    if (c.error) return c.error;
    // Only goods already moved from the warehouse to the shelf can be sold (they came in with a supplier note first).
    const notOnShelf = [];
    Object.keys(c.qtyByProduct).forEach(function (pid) {
      const p = productById[pid], sh = shopOf(p);
      if (c.qtyByProduct[pid] > sh + 1e-9) notOnShelf.push({ product_id: p.id, name: str(p.name), need: c.qtyByProduct[pid], shop: sh, gudang: Math.round((num(p.stock) - sh) * 1000) / 1000 });
    });
    if (notOnShelf.length && readSettings().sell_from_shop_only !== false && data.queued !== true) {
      Object.keys(ops).forEach(function (k) { ops[k] = []; });
      return done({ ok: false, error: 'NOT_ON_SHELF', items: notOnShelf,
        message: 'Barang belum ada di rak toko: ' + notOnShelf.map(function (x) { return x.name + ' (perlu ' + fmtN(x.need) + ', rak ' + fmtN(x.shop) + ', gudang ' + fmtN(x.gudang) + (x.gudang <= 0 ? ' — belum ada barang masuk dengan nota' : ' — pindahkan dulu dari gudang') + ')'; }).join('; ') });
    }
    let approvedBy = '';
    if (c.debt > 0) {
      if (isApprover) {
        approvedBy = me.name;
      } else if (data.approver && data.approver.user) {
        const ap = findApprover(data.approver.user, data.approver.pin_hash);
        if (!ap) return fail('APPROVAL_REQUIRED', 'PIN persetujuan salah / bukan pemilik atau manajer');
        approvedBy = ap.name;
      } else if (data.approval_id) {
        const a = approvalById(String(data.approval_id));
        if (!a) return fail('APPROVAL_REQUIRED', 'Permintaan persetujuan tidak ditemukan');
        if (a.kind && a.kind !== 'credit') return fail('APPROVAL_REQUIRED', 'Persetujuan ini bukan untuk hutang');
        if (a.status !== 'approved') return fail('APPROVAL_REQUIRED', a.status === 'rejected' ? 'Hutang ditolak: ' + str(a.note) : 'Hutang belum disetujui');
        if (a.client_id !== req.client_id || Number(a.customer_id) !== Number(c.customer.id) || c.debt > money(a.debt_amount) || c.total > money(a.total)) {
          return fail('APPROVAL_REQUIRED', 'Transaksi berubah setelah disetujui, minta persetujuan lagi');
        }
        approvedBy = str(a.decided_by);
        ops.approvals.push(forWrite(Object.assign({}, a, { status: 'used' }), a.id));
      } else {
        return fail('APPROVAL_REQUIRED', 'Penjualan hutang wajib disetujui pemilik atau manajer');
      }
    }
    // Discount above the limit (default 3 %): a kasir needs the manager's or owner's approval first.
    const disc = discountOf(c);
    const mem = memberInfo(c.customer);
    const discLimit = maxDiscountPct() + (mem ? mem.pct : 0);
    let discApprovedBy = '';
    if (disc.pct > discLimit + 1e-9) {
      if (role === 'kasir') {
        const da = str(data.discount_approval_id) ? approvalById(str(data.discount_approval_id)) : null;
        if (!da || da.kind !== 'discount') return fail('DISCOUNT_APPROVAL_REQUIRED', 'Diskon ' + disc.pct + '% melebihi batas ' + discLimit + '%: minta persetujuan manajer / pemilik');
        if (da.status !== 'approved') return fail('DISCOUNT_APPROVAL_REQUIRED', da.status === 'rejected' ? 'Diskon ditolak: ' + str(da.note) : 'Diskon belum disetujui');
        if (da.client_id !== req.client_id || disc.amount > money(da.debt_amount)) return fail('DISCOUNT_APPROVAL_REQUIRED', 'Transaksi berubah setelah diskon disetujui, minta persetujuan lagi');
        discApprovedBy = str(da.decided_by);
        ops.approvals.push(forWrite(Object.assign({}, da, { status: 'used' }), da.id));
      } else discApprovedBy = me.name;
    }
    const st = readSettings();
    const minTotal = num(st.exit_photo_min_total) > 0 ? num(st.exit_photo_min_total) : 1000000;
    const minQty = num(st.exit_photo_min_qty) > 0 ? num(st.exit_photo_min_qty) : 20;
    const exitRequired = c.total >= minTotal || c.lines.some(function (l) { return l.qty >= minQty; });
    const survey = Array.isArray(data.survey) && data.survey_consent === true ? data.survey.slice(0, 10).map(function (x) { return { q: str(x.q), a: str(x.a) }; }).filter(function (x) { return x.a; }) : [];
    const sale = {
      invoice_no: invoice, sale_date: data.sale_date, sale_time: str(data.sale_time) || new Date().toISOString(),
      cashier: me.name, customer_id: c.customer ? c.customer.id : 0,
      customer_name: c.customer ? str(c.customer.name) : (str(data.customer_name) || 'Umum'),
      customer_type: c.customer ? str(c.customer.type) : (data.customer_type === 'grosir' ? 'grosir' : 'eceran'),
      subtotal: c.subtotal, discount: c.discount, send_fee: c.sendFee, total: c.total, total_cost: c.totalCost, profit: c.total - c.totalCost,
      payment_method: c.method, paid_amount: c.paid, debt_amount: c.debt, status: 'ok',
      survey: JSON.stringify(survey), survey_transcript: data.survey_consent === true ? str(data.survey_transcript).slice(0, 4000) : '',
      notes: (str(data.notes) + (mem && mem.pct > 0 ? ' [member ' + mem.pct + '% · pembelian ke-' + mem.purchase_no + ']' : '') + (discApprovedBy ? ' [diskon ' + disc.pct + '% disetujui ' + discApprovedBy + ']' : '')).trim(), client_id: req.client_id, approved_by: approvedBy,
      exit_photo: exitRequired ? 'required' : '', exit_match: '',
      channel: ['toko', 'whatsapp', 'shopee', 'tiktok', 'tokopedia', 'web', 'lainnya'].indexOf(data.channel) >= 0 ? data.channel : 'toko',
      promo_code: str(data.promo_code).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30),
      shift_id: myShift ? str(myShift.shift_id) : ''
    };
    if (myShift) {
      const cashPart = (c.method === 'tunai' || c.method === 'hutang') ? Math.min(c.paid, c.total) : 0;
      const paidPart = Math.min(c.paid, c.total);
      ops.shifts.push(forWrite(Object.assign({}, myShift, {
        sales_count: num(myShift.sales_count) + 1, sales_total: money(myShift.sales_total) + c.total, cash_sales: money(myShift.cash_sales) + cashPart,
        transfer_sales: money(myShift.transfer_sales) + (c.method === 'transfer' ? paidPart : 0), qris_sales: money(myShift.qris_sales) + (c.method === 'qris' ? paidPart : 0),
        debt_sales: money(myShift.debt_sales) + c.debt,
        items_qty: Math.round((num(myShift.items_qty) + c.lines.reduce(function (a1, l) { return a1 + l.qty; }, 0)) * 1000) / 1000
      }), myShift.id));
    }
    ops.sales.push(forWrite(sale, -1));
    c.lines.forEach(function (l) { ops.sale_items.push(forWrite(l, -1)); });
    const stockOut = [];
    Object.keys(c.qtyByProduct).forEach(function (pid) {
      const p = productById[pid];
      const newStock = Math.round((num(p.stock) - c.qtyByProduct[pid]) * 1000) / 1000;
      shopSet[String(p.id)] = Math.round((shopOf(p) - c.qtyByProduct[pid]) * 1000) / 1000;
      ops.products.push(forWrite(Object.assign({}, p, { stock: newStock }), p.id));
      stockOut.push({ product_id: p.id, stock: newStock, shop_stock: newStock >= 0 ? Math.max(0, Math.min(newStock, shopSet[String(p.id)])) : newStock });
    });
    if (c.customer) {
      ops.customers.push(forWrite(Object.assign({}, c.customer, {
        debt_balance: money(c.customer.debt_balance) + c.debt, visits: Math.max(0, Math.round(num(c.customer.visits))) + 1, last_visit: data.sale_date,
        receipts_sent: Math.max(0, Math.round(num(c.customer.receipts_sent))) + (data.send_receipt === true ? 1 : 0)
      }), c.customer.id));
    }
    if (notOnShelf.length) logAct('jual_tanpa_rak', 'Penjualan ' + invoice + ' (tersimpan offline) melebihi stok rak: ' + notOnShelf.map(function (x) { return x.name + ' perlu ' + fmtN(x.need) + ', rak ' + fmtN(x.shop); }).join('; '), invoice, 0, 'warn');
    if (discApprovedBy) logAct('diskon', 'Diskon ' + disc.pct + '% (Rp ' + disc.amount + ') pada ' + invoice + ' oleh ' + me.name + (discApprovedBy !== me.name ? ', disetujui ' + discApprovedBy : ''), invoice, disc.amount, 'warn');
    if (c.debt > 0) logAct('hutang', 'Penjualan hutang ' + invoice + ' ' + str(sale.customer_name) + ' Rp ' + c.debt + (approvedBy ? ' (disetujui ' + approvedBy + ')' : ''), invoice, c.debt, 'info');
    return done({ ok: true, duplicate: false, invoice_no: invoice, sale: strip(sale, role), stock: stockOut, exit_photo_required: exitRequired, member: mem });
  }

  case 'request_discount': {
    if (!data.client_id) return fail('INVALID', 'client_id wajib');
    const c = computeSale('PENDING', true);
    if (c.error) return c.error;
    const disc = discountOf(c);
    const mem = memberInfo(c.customer);
    if (disc.pct <= maxDiscountPct() + (mem ? mem.pct : 0) + 1e-9) return fail('INVALID', 'Diskon ' + disc.pct + '% masih dalam batas, tidak perlu persetujuan');
    const profitBefore = c.listTotal - c.totalCost, profitAfter = c.total - c.totalCost;
    const mb = marginPct(c.listTotal, c.totalCost), ma = marginPct(c.total, c.totalCost);
    const reason = str(data.reason).slice(0, 300);
    const a = newApproval({
      kind: 'discount', approver_role: 'manager', client_id: String(data.client_id), ref: String(data.client_id),
      customer_id: c.customer ? c.customer.id : 0, customer_name: c.customer ? str(c.customer.name) : str(data.customer_name || 'Umum'),
      total: c.total, debt_amount: disc.amount, note: reason,
      summary: ('Diskon ' + disc.pct + '% (Rp ' + disc.amount + '): Rp ' + c.listTotal + ' → Rp ' + c.total + ' — ' + c.lines.map(function (l) { return l.name + ' x' + l.qty + ' @' + l.unit_price; }).join('; ') +
        ' | laba ' + mb + '% → ' + ma + '% (Rp ' + profitBefore + ' → Rp ' + profitAfter + ')').slice(0, 1500),
      payload: JSON.stringify({ list_total: c.listTotal, total: c.total, discount: disc.amount, pct: disc.pct, max_pct: maxDiscountPct(), member_pct: mem ? mem.pct : 0, reason: reason,
        lines: c.lines.map(function (l) { return { name: l.name, qty: l.qty, unit_price: l.unit_price }; }),
        profit_before: profitBefore, profit_after: profitAfter, margin_before: mb, margin_after: ma })
    });
    ops.approvals.push(forWrite(a, -1));
    logAct('minta_diskon', 'Minta diskon ' + disc.pct + '% (Rp ' + disc.amount + ') total Rp ' + c.listTotal + ' → Rp ' + c.total + ' | laba ' + mb + '% → ' + ma + '%' + (reason ? ' | ' + reason : ''), a.request_id, disc.amount, 'warn');
    return done({ ok: true, request_id: a.request_id, approval: approvalOut(a) });
  }

  case 'request_credit': {
    if (!data.client_id) return fail('INVALID', 'client_id wajib');
    const c = computeSale('PENDING');
    if (c.error) return c.error;
    if (!(c.debt > 0)) return fail('INVALID', 'Tidak ada hutang, tidak perlu persetujuan');
    const summary = c.lines.map(function (l) { return l.name + ' x' + l.qty + ' @' + l.unit_price; }).join('; ');
    const a = newApproval({
      client_id: String(data.client_id), customer_id: c.customer.id, customer_name: str(c.customer.name),
      customer_debt_before: money(c.customer.debt_balance), total: c.total, debt_amount: c.debt,
      summary: summary.slice(0, 1500), note: str(data.notes), kind: 'credit', ref: String(data.client_id), approver_role: 'manager'
    });
    ops.approvals.push(forWrite(a, -1));
    return done({ ok: true, request_id: a.request_id, approval: approvalOut(a) });
  }

  case 'request_void': {
    const sale = rows('Get Sale By Invoice')[0];
    if (!sale) return fail('NOT_FOUND', 'Transaksi tidak ditemukan');
    if (sale.status === 'void') return fail('INVALID', 'Transaksi sudah dibatalkan');
    if (!str(data.reason)) return fail('INVALID', 'Alasan wajib diisi');
    const existing = approvalRows.find(function (x) { return x.status === 'pending' && x.kind === 'void' && x.ref === sale.invoice_no; });
    if (existing) return done({ ok: true, request_id: existing.request_id, approval: approvalOut(existing), duplicate: true });
    const a = newApproval({
      customer_id: num(sale.customer_id), customer_name: str(sale.customer_name), total: money(sale.total), debt_amount: money(sale.debt_amount),
      summary: ('Batalkan faktur ' + sale.invoice_no + ' (' + sale.sale_date + ', kasir ' + str(sale.cashier) + ')').slice(0, 1500),
      note: str(data.reason), kind: 'void', ref: sale.invoice_no, approver_role: 'owner'
    });
    ops.approvals.push(forWrite(a, -1));
    logAct('minta_batal', 'Minta batal faktur ' + sale.invoice_no + ': ' + str(data.reason), sale.invoice_no, money(sale.total), 'warn');
    return done({ ok: true, request_id: a.request_id, approval: approvalOut(a) });
  }

  case 'change_price': {
    const p = productById[String(data.product_id)];
    if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan');
    const changes = {};
    for (let i = 0; i < PRICE_FIELDS.length; i++) {
      const f = PRICE_FIELDS[i];
      if (data[f] === undefined || data[f] === null || data[f] === '') continue;
      const to = money(data[f]);
      if (to < 0) return fail('INVALID', 'Harga tidak valid');
      if (to !== money(p[f])) changes[f] = { from: money(p[f]), to: to };
    }
    if (!Object.keys(changes).length) return fail('INVALID', 'Tidak ada perubahan harga');
    const need = changes.cost_price ? 'owner' : 'manager';
    const payload = JSON.stringify({ product_id: p.id, product_name: str(p.name), changes: changes, reason: str(data.reason) });
    const summary = 'Ubah harga ' + str(p.name) + ': ' + Object.keys(changes).map(function (f) { return f + ' ' + changes[f].from + '→' + changes[f].to; }).join(', ');
    const allowed = role === 'owner' || (role === 'manager' && need === 'manager');
    if (allowed) {
      const np = applyPrices(p, changes);
      const now = new Date().toISOString();
      ops.approvals.push(forWrite(newApproval({ summary: summary, note: str(data.reason), kind: 'price', ref: String(p.id), payload: payload,
        approver_role: need, status: 'auto', decided_by: me.name, decided_at: now }), -1));
      logAct('harga', summary + (str(data.reason) ? ' | ' + str(data.reason) : ''), String(p.id), 0, 'warn');
      return done({ ok: true, applied: true, product: productOut(np) });
    }
    const a = newApproval({ summary: summary, note: str(data.reason), kind: 'price', ref: String(p.id), payload: payload, approver_role: need });
    ops.approvals.push(forWrite(a, -1));
    logAct('minta_harga', 'Minta ' + summary + (str(data.reason) ? ' | ' + str(data.reason) : ''), String(p.id), 0, 'info');
    return done({ ok: true, applied: false, request_id: a.request_id, approval: approvalOut(a) });
  }

  case 'repack': {
    // Bulk → small packs made in the shop: how much bulk went in, how many packs came out, the loss and the pack cost.
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const to = productById[String(data.to_product_id)];
    if (!to) return fail('NOT_FOUND', 'Produk kemasan tidak ditemukan');
    const from = num(to.repack_from) > 0 ? productById[String(to.repack_from)] : null;
    if (!from || !(num(to.repack_qty) > 0)) return fail('INVALID', 'Produk ini belum diatur sebagai kemasan ulang (asal curah + isi per kemasan)');
    const toQty = Math.round(num(data.to_qty) * 1000) / 1000;
    if (!(toQty > 0)) return fail('INVALID', 'Jumlah kemasan jadi tidak valid');
    const size = num(to.repack_qty);
    const fromQty = data.from_qty === undefined || data.from_qty === null || data.from_qty === '' ? Math.round(toQty * size * 1000) / 1000 : Math.round(num(data.from_qty) * 1000) / 1000;
    if (!(fromQty > 0)) return fail('INVALID', 'Jumlah curah yang dipakai tidak valid');
    if (fromQty > num(from.stock) + 1e-9) return fail('INVALID', 'Stok ' + str(from.name) + ' tidak cukup (' + num(from.stock) + ' ' + str(from.unit) + ')');
    const packCost = Math.max(0, money(data.packaging_cost));
    const expected = Math.round(fromQty / size * 1000) / 1000;
    const unitCost = Math.round((fromQty * money(from.cost_price) + packCost) / toQty);
    const date = isDate(data.date) ? data.date : jkDate();
    const fromNew = Math.round((num(from.stock) - fromQty) * 1000) / 1000;
    const oldTo = Math.max(0, num(to.stock));
    const toNew = Math.round((num(to.stock) + toQty) * 1000) / 1000;
    const toCost = oldTo + toQty > 0 ? Math.round((oldTo * money(to.cost_price) + toQty * unitCost) / (oldTo + toQty)) : unitCost;
    ops.products.push(forWrite(Object.assign({}, from, { stock: fromNew }), from.id));
    ops.products.push(forWrite(Object.assign({}, to, { stock: toNew, cost_price: toCost }), to.id));
    const rp = {
      repack_id: 'RP' + rand(6), repack_date: date, repack_time: new Date().toISOString(), user: me.name,
      from_product_id: from.id, from_name: str(from.name), from_unit: str(from.unit), from_qty: fromQty,
      to_product_id: to.id, to_name: str(to.name), to_unit: str(to.unit), to_qty: toQty, pack_size: size,
      expected_qty: expected, yield_pct: expected > 0 ? Math.round(toQty / expected * 1000) / 10 : 0,
      loss_qty: Math.round((fromQty - toQty * size) * 1000) / 1000, packaging_cost: packCost, unit_cost: unitCost,
      exp_date: isDate(data.exp_date) ? data.exp_date : '', note: str(data.note).slice(0, 300)
    };
    ops.repacks.push(forWrite(rp, -1));
    ops.purchases.push(forWrite({ purchase_date: date, supplier: 'KEMAS ULANG', product_id: from.id, name: str(from.name), qty: -fromQty, cost_price: money(from.cost_price), total: 0,
      note: ('→ ' + str(to.name) + ' x' + toQty + ' (' + rp.repack_id + ') ' + rp.note).trim(), user: me.name, photo_id: '', exp_date: '' }, -1));
    ops.purchases.push(forWrite({ purchase_date: date, supplier: 'KEMAS ULANG', product_id: to.id, name: str(to.name), qty: toQty, cost_price: unitCost, total: 0,
      note: ('dari ' + str(from.name) + ' ' + fromQty + ' ' + str(from.unit) + ' (' + rp.repack_id + ') ' + rp.note).trim(), user: me.name, photo_id: '', exp_date: rp.exp_date }, -1));
    const stock = [{ product_id: from.id, stock: fromNew }, { product_id: to.id, stock: toNew }];
    if (role === 'owner') stock[1].cost_price = toCost;
    logAct('kemas_ulang', 'Kemas ulang ' + rp.from_name + ' ' + fmtN(fromQty) + ' ' + rp.from_unit + ' → ' + rp.to_name + ' x' + fmtN(toQty) + ' (hasil ' + rp.yield_pct + '%, susut ' + fmtN(rp.loss_qty) + ' ' + rp.from_unit + ')', rp.repack_id, 0, rp.yield_pct < 95 ? 'warn' : 'info');
    const out = Object.assign({}, rp);
    if (role !== 'owner') { delete out.unit_cost; delete out.packaging_cost; }
    return done({ ok: true, repack: out, stock: stock });
  }

  case 'stock_count': {
    const list = Array.isArray(data.counts) ? data.counts.slice(0, 500) : [];
    const lines = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {};
      const p = productById[String(it.product_id)];
      if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan: ' + it.product_id);
      if (it.counted === undefined || it.counted === null || it.counted === '' || !(num(it.counted) >= 0)) return fail('INVALID', 'Jumlah hitung tidak valid: ' + p.name);
      const counted = Math.round(num(it.counted) * 1000) / 1000;
      const system = Math.round(num(p.stock) * 1000) / 1000;
      lines.push({ product_id: p.id, name: str(p.name), unit: str(p.unit), system: system, counted: counted, diff: Math.round((counted - system) * 1000) / 1000 });
    }
    if (!lines.length) return fail('INVALID', 'Belum ada barang yang dihitung');
    const note = str(data.note).slice(0, 300);
    const changed = lines.filter(function (l) { return l.diff !== 0; });
    const cnt = 'Stok opname ' + lines.length + ' barang, ' + changed.length + ' selisih: ' + changed.slice(0, 20).map(function (l) { return l.name + ' ' + l.system + '→' + l.counted; }).join('; ');
    if (role === 'owner') { logAct('opname', cnt, '', 0, changed.length ? 'warn' : 'info'); return done({ ok: true, applied: true, lines: lines, stock: applyCount(lines, note, me.name) }); }
    logAct('minta_opname', 'Minta ' + cnt, '', 0, 'info');
    const a = newApproval({
      kind: 'opname', approver_role: 'owner', ref: 'OP' + rand(5), note: note,
      summary: ('Stok opname ' + lines.length + ' barang, ' + changed.length + ' selisih: ' + changed.slice(0, 20).map(function (l) { return l.name + ' ' + l.system + '→' + l.counted; }).join('; ')).slice(0, 1500),
      payload: JSON.stringify({ lines: lines, counted_at: new Date().toISOString(), by: me.name })
    });
    ops.approvals.push(forWrite(a, -1));
    return done({ ok: true, applied: false, request_id: a.request_id, approval: approvalOut(a), lines: lines });
  }

  case 'save_expense': {
    const CATS = ['sewa', 'gaji', 'listrik_air', 'transport', 'iklan', 'kemasan', 'perawatan', 'lain'];
    const amount = money(data.amount);
    if (!(amount > 0)) return fail('INVALID', 'Jumlah tidak valid');
    const e = {
      expense_date: isDate(data.expense_date) ? data.expense_date : new Date().toISOString().slice(0, 10),
      category: CATS.indexOf(data.category) >= 0 ? data.category : 'lain', amount: amount,
      note: str(data.note).slice(0, 500), user: me.name, photo_id: str(data.photo_id),
      paid_from: data.paid_from === 'lain' ? 'lain' : (data.paid_from === 'kas' || myShift ? 'kas' : 'lain')
    };
    ops.expenses.push(forWrite(e, -1));
    if (myShift && e.paid_from === 'kas') {
      const sh = Object.assign({}, myShift, { cash_out: money(myShift.cash_out) + amount });
      addMove(sh, 'out', amount, 'Pengeluaran ' + e.category + ': ' + e.note);
      ops.shifts.push(forWrite(sh, myShift.id));
    }
    logAct('biaya', 'Pengeluaran ' + e.category + ' Rp ' + amount + (e.note ? ': ' + e.note : '') + ' (' + e.paid_from + ')', '', amount, 'info');
    return done({ ok: true, expense: Object.assign({ id: null }, e) });
  }

  case 'open_shift': {
    // Kasir accounts always; the manager may open her own drawer when she works as cashier (her opening goes to the owner).
    if (role !== 'kasir' && role !== 'manager') return fail('FORBIDDEN', 'Buka kas hanya dari akun kasir atau manajer (aplikasi Khair Kasir)');
    if (myShift) return done({ ok: true, already: true, shift: shiftOut(myShift) });
    const opening = money(data.opening_cash);
    if (opening < 0) return fail('INVALID', 'Modal awal tidak valid');
    const sh = {
      shift_id: 'SH' + rand(6), cashier: me.name, shift_date: isDate(data.shift_date) ? data.shift_date : jkDate(),
      opened_at: new Date().toISOString(), closed_at: '', status: 'open', opening_cash: opening,
      cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0,
      expected_cash: 0, counted_cash: 0, difference: 0, moves: '[]', note: str(data.note),
      transfer_sales: 0, qris_sales: 0, debt_sales: 0, items_qty: 0
    };
    ops.shifts.push(forWrite(sh, -1));
    // Every morning's opening count goes to the manager / owner to check and approve (selling is not blocked).
    const last = rows('Get Range Shifts').filter(function (x) { return x.status === 'closed'; })
      .sort(function (a1, b1) { return String(b1.closed_at).localeCompare(String(a1.closed_at)); })[0] || null;
    const lastTxt = last ? ' — kas terakhir ditutup ' + str(last.closed_at).slice(0, 16).replace('T', ' ') + ' UTC oleh ' + str(last.cashier) + ': dihitung Rp ' + money(last.counted_cash) + ', selisih dengan pembukaan Rp ' + (opening - money(last.counted_cash)) : '';
    const bk = newApproval({ kind: 'buka_kas', approver_role: role === 'manager' ? 'owner' : 'manager', ref: sh.shift_id, total: opening,
      summary: ('Buka kas ' + me.name + ': modal awal dihitung Rp ' + opening + lastTxt).slice(0, 1500), note: str(data.note),
      payload: JSON.stringify({ shift_id: sh.shift_id, opening_cash: opening, last_counted: last ? money(last.counted_cash) : null, last_cashier: last ? str(last.cashier) : '' }) });
    ops.approvals.push(forWrite(bk, -1));
    logAct('buka_kas', 'Buka kas ' + me.name + ' Rp ' + opening + lastTxt, sh.shift_id, opening, last && money(last.counted_cash) !== opening ? 'warn' : 'info');
    return done({ ok: true, already: false, shift: shiftOut(sh), request_id: bk.request_id, approval: approvalOut(bk) });
  }

  case 'cash_move': {
    if (!myShift) return fail('SHIFT_REQUIRED', 'Buka kasir (shift) dulu');
    const amount = money(data.amount);
    if (!(amount > 0)) return fail('INVALID', 'Jumlah tidak valid');
    if (!str(data.note)) return fail('INVALID', 'Keterangan wajib diisi');
    const type = data.type === 'in' ? 'in' : 'out';
    const sh = Object.assign({}, myShift);
    if (type === 'in') sh.cash_in = money(sh.cash_in) + amount; else sh.cash_out = money(sh.cash_out) + amount;
    addMove(sh, type, amount, str(data.note).slice(0, 300));
    ops.shifts.push(forWrite(sh, myShift.id));
    logAct('kas', (type === 'in' ? 'Kas masuk' : 'Kas keluar') + ' Rp ' + amount + ': ' + str(data.note).slice(0, 300), str(myShift.shift_id), amount, 'info');
    return done({ ok: true, shift: shiftOut(sh) });
  }

  case 'close_shift': {
    const target = data.cashier && isApprover ? shiftOf(data.cashier) : myShift;
    if (!target) return fail('NOT_FOUND', 'Tidak ada shift yang terbuka');
    if (data.counted_cash === undefined || data.counted_cash === null || data.counted_cash === '') return fail('INVALID', 'Isi jumlah uang yang dihitung');
    const counted = money(data.counted_cash);
    const expected = money(target.opening_cash) + money(target.cash_sales) + money(target.cash_payments) + money(target.cash_in) - money(target.cash_out);
    const sh = Object.assign({}, target, {
      status: 'closed', closed_at: new Date().toISOString(), counted_cash: counted, expected_cash: expected, difference: counted - expected,
      note: (str(target.note) + (str(data.note) ? ' | ' + str(data.note) : '') + (target.cashier !== me.name ? ' [ditutup oleh ' + me.name + ']' : '')).trim()
    });
    ops.shifts.push(forWrite(sh, target.id));
    logAct('tutup_kas', 'Tutup kas ' + str(target.cashier) + ': dihitung Rp ' + counted + ', seharusnya Rp ' + expected + ', selisih Rp ' + (counted - expected), str(target.shift_id), counted - expected, counted !== expected ? 'warn' : 'info');
    return done({ ok: true, shift: clean(sh) });
  }

  case 'check_approval': {
    const a = approvalById(String(data.request_id || ''));
    if (!a) return fail('NOT_FOUND', 'Permintaan tidak ditemukan');
    return done({ ok: true, approval: approvalOut(a) });
  }

  case 'request_return': {
    // Returns (retur). kind "pelanggan": a customer brings goods back to the counter (refund or less debt);
    // kind "pemasok": goods go back to the supplier (not to spec, bad quality…). The manager approves; above the limit
    // (settings return_owner_min_value / return_owner_min_qty) only the owner. The owner is always told (activity log).
    const kind = data.kind === 'pemasok' ? 'pemasok' : 'pelanggan';
    const st = readSettings();
    const reasonCode = RETURN_REASONS.indexOf(data.reason_code) >= 0 ? data.reason_code : '';
    if (!reasonCode) return fail('INVALID', 'Pilih alasan retur');
    const reasonNote = str(data.reason_note).slice(0, 300);
    if (reasonCode === 'lainnya' && !reasonNote) return fail('INVALID', 'Tulis alasan retur');
    const lines = Array.isArray(data.lines) ? data.lines.slice(0, 100) : [];
    if (!lines.length) return fail('INVALID', 'Pilih barang yang diretur');
    const agg = {};
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] || {};
      const p = productById[String(l.product_id)];
      if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan: ' + l.product_id);
      const q = Math.round(num(l.qty) * 1000) / 1000;
      if (!(q > 0)) return fail('INVALID', 'Jumlah tidak valid: ' + str(p.name));
      const cond = l.condition === 'rusak' ? 'rusak' : 'baik';
      const k = String(p.id) + '|' + (kind === 'pelanggan' ? cond : '');
      if (!agg[k]) agg[k] = { product_id: p.id, name: str(p.name), unit: str(p.unit), qty: 0, condition: kind === 'pelanggan' ? cond : '' };
      agg[k].qty = Math.round((agg[k].qty + q) * 1000) / 1000;
    }
    const list = Object.keys(agg).map(function (k) { return agg[k]; });
    const qtyByPid = {};
    list.forEach(function (l) { qtyByPid[String(l.product_id)] = Math.round(((qtyByPid[String(l.product_id)] || 0) + l.qty) * 1000) / 1000; });
    const ref = kind === 'pelanggan' ? str(data.invoice_no) : str(data.purchase_no);
    if (!ref) return fail('INVALID', kind === 'pelanggan' ? 'Nomor faktur pembelian wajib' : 'Nomor barang masuk (nota pemasok) wajib');
    const before = returnedBefore(ref);
    const returnId = 'RT' + jkDate().replace(/-/g, '').slice(2) + '-' + rand(4);
    let rec;
    if (kind === 'pelanggan') {
      const sale = rows('Get Sale By Invoice').find(function (s) { return s.invoice_no === ref; });
      if (!sale) return fail('NOT_FOUND', 'Faktur tidak ditemukan: ' + ref);
      if (sale.status === 'void') return fail('INVALID', 'Faktur ini sudah dibatalkan');
      const items = rows('Get Items By Invoice').filter(function (it) { return it.invoice_no === ref; });
      const sold = {}, value = {};
      items.forEach(function (it) { const k = String(it.product_id); sold[k] = (sold[k] || 0) + num(it.qty); value[k] = (value[k] || 0) + money(it.line_total); });
      const discRatio = money(sale.subtotal) > 0 ? Math.min(1, money(sale.discount) / money(sale.subtotal)) : 0;
      const over = [];
      Object.keys(qtyByPid).forEach(function (pid) {
        const left = Math.round(((sold[pid] || 0) - (before[pid] || 0)) * 1000) / 1000;
        if (qtyByPid[pid] > left + 1e-9) over.push(str(productById[pid].name) + ': dibeli ' + fmtN(sold[pid] || 0) + ', sudah diretur ' + fmtN(before[pid] || 0));
      });
      if (over.length) return fail('INVALID', 'Jumlah retur melebihi yang dibeli di faktur ini: ' + over.join('; '));
      list.forEach(function (l) {
        const pid = String(l.product_id);
        const unitNet = sold[pid] > 0 ? (value[pid] / sold[pid]) * (1 - discRatio) : 0;
        l.unit_price = Math.round(unitNet);
        l.value = Math.round(l.qty * unitNet);
      });
      const gross = list.reduce(function (a1, l) { return a1 + l.value; }, 0);
      const feePct = Math.min(50, Math.max(0, num(st.return_fee_pct)));
      const fee = Math.round(gross * feePct / 100);
      const method = ['tunai', 'transfer', 'potong_hutang', 'tukar'].indexOf(data.refund_method) >= 0 ? data.refund_method : 'tunai';
      const cust = customerById[String(sale.customer_id)] || null;
      if (method === 'potong_hutang' && !(cust && money(cust.debt_balance) > 0)) return fail('INVALID', 'Pelanggan ini tidak punya hutang untuk dipotong');
      if (str(data.returned_by) && !personName(data.returned_by)) return fail('INVALID', 'Nama orang yang mengembalikan hanya boleh huruf');
      if (str(data.returned_by_phone) && !normPhone(data.returned_by_phone)) return fail('INVALID', 'Nomor HP orang yang mengembalikan tidak valid');
      const by = personName(data.returned_by) || (cust ? str(cust.name) : str(sale.customer_name));
      if (!by) return fail('INVALID', 'Nama orang yang mengembalikan wajib');
      rec = {
        return_id: returnId, kind: kind, ref: ref, party_id: cust ? cust.id : 0, party_name: str(sale.customer_name), bought_by: str(sale.customer_name),
        bought_date: str(sale.sale_date), returned_by: by, returned_by_phone: normPhone(data.returned_by_phone), lines: list,
        qty_total: Math.round(list.reduce(function (a1, l) { return a1 + l.qty; }, 0) * 1000) / 1000, value: gross, fee_pct: feePct, fee: fee,
        refund: gross - fee, refund_method: method, reason_code: reasonCode, reason_note: reasonNote, photo_id: '', out_doc_no: '',
        carrier_type: '', carrier_name: '', carrier_vehicle: '', carrier_phone: ''
      };
    } else {
      const prows = rows('Get Purchase By No').filter(function (x) { return str(x.purchase_no) === ref && num(x.qty) > 0; });
      if (!prows.length) return fail('NOT_FOUND', 'Barang masuk tidak ditemukan: ' + ref);
      const bought = {}, cost = {};
      prows.forEach(function (x) { const k = String(x.product_id); bought[k] = (bought[k] || 0) + num(x.qty); cost[k] = money(x.cost_price); });
      const over = [];
      Object.keys(qtyByPid).forEach(function (pid) {
        const left = Math.round(((bought[pid] || 0) - (before[pid] || 0)) * 1000) / 1000;
        if (!bought[pid]) over.push(str(productById[pid].name) + ': tidak ada di nota ' + ref);
        else if (qtyByPid[pid] > left + 1e-9) over.push(str(productById[pid].name) + ': masuk ' + fmtN(bought[pid]) + ', sudah diretur ' + fmtN(before[pid] || 0));
        else if (qtyByPid[pid] > num(productById[pid].stock) + 1e-9) over.push(str(productById[pid].name) + ': stok hanya ' + fmtN(productById[pid].stock));
      });
      if (over.length) return fail('INVALID', 'Retur ke pemasok tidak bisa: ' + over.join('; '));
      const outDoc = docNo(data.out_doc_no);
      if (!outDoc) return fail('INVALID', 'Nomor nota / surat jalan barang keluar wajib (huruf, angka, / - . saja)');
      const photoId = str(data.photo_id);
      const ph = photoId ? rows('Get Photo').find(function (x) { return x.photo_id === photoId; }) : null;
      if (st.require_return_photo !== false && !ph) return fail('INVALID', 'Foto bukti barang keluar wajib');
      const carrier = readCarrier(data.carrier, true);
      if (carrier.error) return fail('INVALID', carrier.error);
      list.forEach(function (l) { l.unit_price = cost[String(l.product_id)] || 0; l.value = Math.round(l.qty * l.unit_price); });
      const gross = list.reduce(function (a1, l) { return a1 + l.value; }, 0);
      rec = {
        return_id: returnId, kind: kind, ref: ref, party_id: 0, party_name: str(prows[0].supplier), bought_by: '', bought_date: str(prows[0].purchase_date),
        returned_by: carrier.name || me.name, returned_by_phone: carrier.phone, lines: list,
        qty_total: Math.round(list.reduce(function (a1, l) { return a1 + l.qty; }, 0) * 1000) / 1000, value: gross, fee_pct: 0, fee: 0,
        refund: gross, refund_method: 'nota_kredit', reason_code: reasonCode, reason_note: reasonNote, photo_id: ph ? photoId : '', out_doc_no: outDoc,
        carrier_type: carrier.type, carrier_name: carrier.name, carrier_vehicle: carrier.vehicle, carrier_phone: carrier.phone
      };
    }
    const minVal = num(st.return_owner_min_value) > 0 ? num(st.return_owner_min_value) : 2000000;
    const minQty = num(st.return_owner_min_qty);
    const ownerNeeded = rec.value >= minVal || (minQty > 0 && rec.qty_total >= minQty);
    const summary = (kind === 'pelanggan' ? 'Retur pelanggan ' + rec.party_name + ' (dikembalikan ' + rec.returned_by + ') faktur ' + ref : 'Retur ke pemasok ' + rec.party_name + ' dari ' + ref + ', nota keluar ' + rec.out_doc_no) +
      ': ' + list.map(function (l) { return l.name + ' ' + fmtN(l.qty) + ' ' + l.unit + (l.condition === 'rusak' ? ' (rusak)' : ''); }).join('; ') +
      ' | ' + RETURN_REASON_TEXT[reasonCode] + (reasonNote ? ': ' + reasonNote : '') +
      (kind === 'pelanggan' ? ' | uang kembali Rp ' + rec.refund + ' (' + rec.refund_method + ')' + (rec.fee ? ', potongan retur Rp ' + rec.fee : '') : ' | nilai Rp ' + rec.value);
    const a = newApproval({
      kind: 'retur', approver_role: ownerNeeded ? 'owner' : 'manager', ref: returnId, client_id: str(data.client_id).slice(0, 60),
      customer_id: rec.party_id, customer_name: rec.party_name, total: kind === 'pelanggan' ? rec.refund : rec.value, debt_amount: 0,
      summary: summary.slice(0, 1500), note: reasonNote, payload: JSON.stringify(rec)
    });
    ops.approvals.push(forWrite(a, -1));
    logAct('minta_retur', summary + (ownerNeeded ? ' — butuh persetujuan pemilik' : ' — menunggu manajer'), returnId, a.total, 'warn');
    return done({ ok: true, request_id: a.request_id, return_id: returnId, approver_role: a.approver_role, approval: approvalOut(a) });
  }

  case 'propose_agreement': {
    // The owner and the manager agree on a limit: one proposes, the other confirms; each agreement is recorded.
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const key = AGREED_KEYS.indexOf(data.key) >= 0 ? data.key : '';
    if (!key) return fail('INVALID', 'Batas tidak dikenal');
    const value = Math.round(num(data.value));
    if (!(value >= 0) || value > 1000000000 || (key === 'return_owner_min_value' && value < 1)) return fail('INVALID', 'Nilai tidak valid');
    const note = str(data.note).slice(0, 300);
    const label = key === 'return_owner_min_value' ? 'Batas retur yang perlu persetujuan pemilik: Rp ' : 'Batas jumlah barang retur untuk pemilik: ';
    const a = newApproval({ kind: 'kesepakatan', approver_role: role === 'owner' ? 'manager' : 'owner', ref: key, total: value,
      summary: ('Usul ' + me.name + ': ' + label + value + ' (sekarang ' + num(readSettings()[key]) + ')' + (note ? ' | ' + note : '')).slice(0, 1500), note: note,
      payload: JSON.stringify({ key: key, value: value, from: num(readSettings()[key]), proposed_by: me.name, proposed_role: role }) });
    ops.approvals.push(forWrite(a, -1));
    logAct('usul_kesepakatan', a.summary, a.request_id, value, 'info');
    return done({ ok: true, request_id: a.request_id, approval: approvalOut(a) });
  }

  case 'get_sale': {
    // One invoice by its number (returns at the counter): the sale, its lines and what was already returned or is pending.
    const no = str(data.invoice_no);
    const sale = rows('Get Sale By Invoice').find(function (x) { return x.invoice_no === no; });
    if (!no || !sale) return fail('NOT_FOUND', 'Faktur tidak ditemukan: ' + no);
    const items = rows('Get Items By Invoice').filter(function (it) { return it.invoice_no === no; }).map(function (it) { return strip(it, role); });
    const before = returnedBefore(no);
    const cust = customerById[String(sale.customer_id)] || null;
    return done({ ok: true, sale: strip(sale, role), items: items, returned: before, customer_debt: cust ? money(cust.debt_balance) : 0 });
  }

  case 'list_returns': {
    if (!isApprover && role !== 'kasir') return fail('FORBIDDEN', 'Tidak diizinkan');
    const done1 = rows('Get Range Returns').map(returnOut).filter(Boolean);
    const pending = approvalRows.filter(function (a) { return a.kind === 'retur' && a.status === 'pending'; }).map(function (a) {
      let pl = {};
      try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
      return returnOut(Object.assign({}, pl, { status: 'pending', request_id: a.request_id, approver_role: a.approver_role, return_date: str(a.created_at).slice(0, 10), user: str(a.cashier) }));
    }).filter(Boolean);
    return done({ ok: true, returns: pending.concat(done1.sort(function (x, y) { return String(y.at).localeCompare(String(x.at)); })) });
  }

  case 'list_approvals': {
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    return done({ ok: true, approvals: approvalRows.filter(function (a) { return a.status === 'pending'; }).map(approvalOut) });
  }

  case 'decide_approval': {
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const a = approvalById(String(data.request_id || ''));
    if (!a) return fail('NOT_FOUND', 'Permintaan tidak ditemukan');
    if (a.status !== 'pending') return fail('INVALID', 'Permintaan sudah diputuskan: ' + a.status);
    if (!canDecide(a)) return fail('NEEDS_OWNER', 'Butuh persetujuan pemilik');
    const decision = data.decision === 'approved' ? 'approved' : 'rejected';
    const out = { ok: true };
    let finalStatus = decision;
    if (decision === 'approved' && a.kind === 'void') {
      const sale = rows('Get Sale By Invoice')[0];
      if (!sale || sale.invoice_no !== a.ref) return fail('INVALID', 'Kirim invoice_no faktur yang dibatalkan');
      if (sale.status !== 'void') out.sale = strip(doVoid(sale, a.note, me.name + ' (diminta ' + str(a.cashier) + ')'), role);
      finalStatus = 'used';
    }
    if (decision === 'approved' && a.kind === 'opname') {
      let pl = {};
      try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
      out.stock = applyCount(Array.isArray(pl.lines) ? pl.lines : [], a.note, me.name + ' (dihitung ' + str(a.cashier) + ')');
      finalStatus = 'used';
    }
    if (decision === 'approved' && a.kind === 'purchase_fix') {
      let pl = {};
      try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
      const no = str(pl.purchase_no);
      const pf = purchaseFixChanges(no, pl.lines);
      if (!pf.found) return fail('INVALID', 'Kirim purchase_no barang masuk yang dikoreksi');
      out.stock = applyPurchaseFix(no, pf.changes, str(pl.reason) + ' (diminta ' + str(a.cashier) + ', disetujui ' + me.name + ')', me.name);
      finalStatus = 'used';
    }
    if (decision === 'approved' && a.kind === 'price') {
      const p = productById[String(a.ref)];
      if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan');
      let pl = {};
      try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
      const changes = {};
      Object.keys(pl.changes || {}).forEach(function (f) { if (PRICE_FIELDS.indexOf(f) >= 0) changes[f] = { from: money(p[f]), to: money(pl.changes[f].to) }; });
      out.product = productOut(applyPrices(p, changes));
      finalStatus = 'used';
    }
    if (a.kind === 'kesepakatan') {
      if (str(a.cashier).toLowerCase() === me.name.toLowerCase()) return fail('FORBIDDEN', 'Kesepakatan harus dikonfirmasi pihak lain');
      if (a.approver_role === 'owner' && role !== 'owner') return fail('NEEDS_OWNER', 'Butuh konfirmasi pemilik');
      if (a.approver_role === 'manager' && role !== 'manager') return fail('FORBIDDEN', 'Kesepakatan ini dikonfirmasi oleh manajer');
      let pl = {};
      try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
      if (decision === 'approved' && AGREED_KEYS.indexOf(pl.key) >= 0) {
        const byKey = {};
        settingRows.forEach(function (r) { byKey[r.skey] = r; });
        ops.settings.push({ _id: byKey[pl.key] ? byKey[pl.key].id : -1, skey: pl.key, svalue: JSON.stringify(num(pl.value)) });
        const agreed = { key: pl.key, value: num(pl.value), from: num(pl.from), proposed_by: str(pl.proposed_by), confirmed_by: me.name, at: new Date().toISOString(), note: str(a.note) };
        let hist = [];
        try { hist = JSON.parse(JSON.stringify(readSettings().limit_agreements || [])); } catch (e) { hist = []; }
        if (!Array.isArray(hist)) hist = [];
        hist.unshift(agreed);
        ops.settings.push({ _id: byKey.limit_agreements ? byKey.limit_agreements.id : -1, skey: 'limit_agreements', svalue: JSON.stringify(hist.slice(0, 50)) });
        out.agreement = agreed;
      }
      logAct('kesepakatan', (decision === 'approved' ? 'Disepakati ' : 'Ditolak ') + str(pl.proposed_by) + ' & ' + me.name + ': ' + str(a.summary).slice(0, 500), a.request_id, money(a.total), 'warn');
      finalStatus = decision === 'approved' ? 'used' : 'rejected';
    }
    if (a.kind === 'retur') {
      let rec = {};
      try { rec = JSON.parse(a.payload || '{}'); } catch (e) { rec = {}; }
      const lines = Array.isArray(rec.lines) ? rec.lines : [];
      if (decision === 'approved') {
        const back = {};
        lines.forEach(function (l) {
          const pid = String(l.product_id);
          if (rec.kind === 'pemasok') back[pid] = (back[pid] || 0) - num(l.qty);
          else if (l.condition !== 'rusak') back[pid] = (back[pid] || 0) + num(l.qty);
        });
        // Good returned goods go back to the warehouse (checked before they return to the shelf); damaged ones are not stock.
        out.stock = [];
        Object.keys(back).forEach(function (pid) {
          const p = productById[pid];
          if (!p || !back[pid]) return;
          const ns = Math.round((num(p.stock) + back[pid]) * 1000) / 1000;
          if (back[pid] < 0) shopSet[pid] = Math.min(shopOf(p), Math.max(0, ns));
          ops.products.push(forWrite(Object.assign({}, p, { stock: ns }), p.id));
          out.stock.push({ product_id: p.id, stock: ns });
        });
        if (rec.kind === 'pemasok') {
          // A credit note from the supplier: negative goods-in rows lower what we owe them.
          lines.forEach(function (l) {
            ops.purchases.push(forWrite({
              purchase_date: jkDate(), supplier: str(rec.party_name), product_id: l.product_id, name: str(l.name), qty: -num(l.qty),
              cost_price: money(l.unit_price), total: -money(l.value), note: 'RETUR ' + str(rec.return_id) + ' dari ' + str(rec.ref) + ' — ' + (RETURN_REASON_TEXT[rec.reason_code] || '') + (rec.reason_note ? ': ' + str(rec.reason_note) : ''),
              user: str(a.cashier), photo_id: str(rec.photo_id), exp_date: '', purchase_no: str(rec.return_id), match_status: 'retur', match_notes: 'nota keluar ' + str(rec.out_doc_no)
            }, -1));
          });
        } else {
          const cust = customerById[String(rec.party_id)];
          const refund = money(rec.refund);
          if (rec.refund_method === 'potong_hutang' && cust) {
            ops.customers.push(forWrite(Object.assign({}, cust, { debt_balance: Math.max(0, money(cust.debt_balance) - refund) }), cust.id));
          } else if ((rec.refund_method === 'tunai' || rec.refund_method === 'transfer') && refund > 0) {
            ops.payments.push(forWrite({
              pay_id: 'PY' + rand(7), pay_date: jkDate(), pay_time: new Date().toISOString(), direction: 'out', party_type: 'customer',
              customer_id: rec.party_id || 0, customer_name: str(rec.party_name), supplier: '', amount: refund, method: rec.refund_method,
              account_id: payAccount(rec.refund_method), slip_date: '', bank: '', transfer_ref: '', proof_photo_id: '', alloc: '[]', match_status: 'retur',
              note: 'Uang kembali retur ' + str(rec.return_id) + ' faktur ' + str(rec.ref), cashier: str(a.cashier)
            }, -1));
            const sh = rec.refund_method === 'tunai' ? shiftOf(a.cashier) : null;
            if (sh) {
              const nsh = Object.assign({}, sh, { cash_out: money(sh.cash_out) + refund });
              addMove(nsh, 'out', refund, 'Retur ' + str(rec.return_id));
              ops.shifts.push(forWrite(nsh, sh.id));
            }
          }
        }
      }
      ops.returns.push(forWrite(Object.assign({}, rec, {
        lines: JSON.stringify(lines), status: decision, user: str(a.cashier), approved_by: me.name, return_date: jkDate(), at: new Date().toISOString(), request_id: a.request_id
      }), -1));
      logAct('retur', (decision === 'approved' ? 'Retur disetujui ' : 'Retur ditolak ') + me.name + ': ' + str(a.summary).slice(0, 600), str(rec.return_id), money(a.total), 'warn');
      out.return_id = str(rec.return_id);
      finalStatus = decision === 'approved' ? 'used' : 'rejected';
    }
    const na = Object.assign({}, a, { status: finalStatus === 'used' ? 'approved' : finalStatus, decided_by: me.name, decided_at: new Date().toISOString(), note: str(data.note) || str(a.note) });
    ops.approvals.push(forWrite(na, a.id));
    logAct('keputusan', (decision === 'approved' ? 'Disetujui' : 'Ditolak') + ' (' + str(a.kind || 'credit') + ', diminta ' + str(a.cashier) + '): ' + str(a.summary).slice(0, 600) + (str(data.note) ? ' | ' + str(data.note) : ''), a.request_id, money(a.total), decision === 'approved' ? 'info' : 'warn');
    out.approval = approvalOut(na);
    return done(out);
  }

  case 'void_sale': {
    const sale = rows('Get Sale By Invoice')[0];
    if (!sale) return fail('NOT_FOUND', 'Transaksi tidak ditemukan');
    if (sale.status === 'void') return done({ ok: true, sale: strip(sale, role) });
    logAct('batal', 'Faktur dibatalkan ' + sale.invoice_no + ' Rp ' + money(sale.total) + ': ' + str(data.reason), sale.invoice_no, money(sale.total), 'warn');
    return done({ ok: true, sale: strip(doVoid(sale, data.reason, me.name), role) });
  }

  case 'save_product': {
    const name = safeName(data.name, 80);
    if (!name) return fail('INVALID', str(data.name) ? 'Nama produk hanya boleh huruf, angka dan . , \' & ( ) / % + # -' : 'Nama produk wajib');
    const sku = str(data.sku);
    if (sku && !/^[A-Za-z0-9._-]{1,40}$/.test(sku)) return fail('INVALID', 'SKU / barcode hanya boleh huruf, angka, titik, garis');
    if (str(data.category) && !safeName(data.category, 40)) return fail('INVALID', 'Kategori hanya boleh huruf dan angka');
    if (str(data.unit) && !/^[\p{L}\p{N} .\/-]{1,15}$/u.test(str(data.unit))) return fail('INVALID', 'Satuan tidak valid');
    if (str(data.supplier) && !safeName(data.supplier, 80)) return fail('INVALID', 'Nama pemasok hanya boleh huruf dan angka');
    const existing = data.id ? productById[String(data.id)] : null;
    if (data.id && !existing) return fail('NOT_FOUND', 'Produk tidak ditemukan');
    if (sku && products.some(function (p) { return str(p.sku) === sku && (!existing || p.id !== existing.id); })) return fail('INVALID', 'SKU/barcode sudah dipakai');
    const p = {
      sku: sku, name: name, category: str(data.category), unit: str(data.unit) || 'pcs',
      cost_price: money(data.cost_price), retail_price: money(data.retail_price), wholesale_price: money(data.wholesale_price),
      wholesale_min_qty: num(data.wholesale_min_qty), stock: existing ? num(existing.stock) : num(data.stock),
      min_stock: num(data.min_stock), active: data.active !== false, notes: str(data.notes),
      supplier: str(data.supplier).slice(0, 80),
      repack_from: 0, repack_qty: 0
    };
    // Repacked in the shop: this product is made from a bulk product (repack_from), repack_qty of its unit per piece.
    if (num(data.repack_from) > 0) {
      const bulk = productById[String(data.repack_from)];
      if (!bulk || (existing && bulk.id === existing.id)) return fail('INVALID', 'Produk curah (asal kemasan) tidak valid');
      if (!(num(data.repack_qty) > 0)) return fail('INVALID', 'Isi per kemasan wajib diisi');
      p.repack_from = bulk.id;
      p.repack_qty = Math.round(num(data.repack_qty) * 1000) / 1000;
    }
    ops.products.push(forWrite(p, existing ? existing.id : -1));
    if (existing) {
      const changes = {};
      PRICE_FIELDS.forEach(function (f) { if (money(existing[f]) !== p[f]) changes[f] = { from: money(existing[f]), to: p[f] }; });
      if (Object.keys(changes).length) {
        ops.approvals.push(forWrite(newApproval({
          summary: 'Ubah harga ' + name + ': ' + Object.keys(changes).map(function (f) { return f + ' ' + changes[f].from + '→' + changes[f].to; }).join(', '),
          kind: 'price', ref: String(existing.id), payload: JSON.stringify({ product_id: existing.id, product_name: name, changes: changes, reason: 'edit produk' }),
          approver_role: 'owner', status: 'auto', decided_by: me.name, decided_at: new Date().toISOString()
        }), -1));
      }
    }
    if (!existing) logAct('produk_baru', 'Produk baru: ' + name + ' (stok ' + fmtN(p.stock) + ' ' + p.unit + ')', sku, 0, 'info');
    else {
      const ch = PRICE_FIELDS.filter(function (f) { return money(existing[f]) !== p[f]; });
      logAct(ch.length ? 'harga' : 'produk', 'Ubah produk ' + name + (ch.length ? ': ' + ch.map(function (f) { return f + ' ' + money(existing[f]) + '→' + p[f]; }).join(', ') : ''), String(existing.id), 0, ch.length ? 'warn' : 'info');
    }
    return done({ ok: true, product: Object.assign({ id: existing ? existing.id : null }, p) });
  }

  case 'import_products': {
    const list = Array.isArray(data.rows) ? data.rows.slice(0, 500) : [];
    if (!list.length) return fail('INVALID', 'Tidak ada baris');
    let created = 0, updated = 0;
    const bySku = {}, byName = {};
    products.forEach(function (p) { if (str(p.sku)) bySku[str(p.sku)] = p; byName[str(p.name).toLowerCase()] = p; });
    const fields = ['category', 'unit', 'cost_price', 'retail_price', 'wholesale_price', 'wholesale_min_qty', 'min_stock', 'notes', 'supplier'];
    list.forEach(function (r) {
      const name = str(r.name);
      const sku = str(r.sku);
      if (!name && !sku) return;
      const ex = (sku && bySku[sku]) || (name && byName[name.toLowerCase()]) || null;
      const base = ex ? Object.assign({}, ex) : { sku: sku, name: name, category: '', unit: 'pcs', cost_price: 0, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0, stock: 0, min_stock: 0, active: true, notes: '', supplier: '', repack_from: 0, repack_qty: 0 };
      if (name) base.name = name;
      if (sku) base.sku = sku;
      fields.forEach(function (f) {
        if (r[f] !== undefined && r[f] !== null && r[f] !== '') {
          base[f] = (f === 'category' || f === 'unit' || f === 'notes' || f === 'supplier') ? str(r[f]) : (f === 'wholesale_min_qty' || f === 'min_stock' ? num(r[f]) : money(r[f]));
        }
      });
      if (r.stock !== undefined && r.stock !== null && r.stock !== '') base.stock = num(r.stock);
      base.active = true;
      ops.products.push(forWrite(base, ex ? ex.id : -1));
      if (ex) updated++; else { created++; if (sku) bySku[sku] = base; byName[base.name.toLowerCase()] = base; }
    });
    logAct('impor', 'Impor produk: ' + created + ' baru, ' + updated + ' diubah', '', 0, 'info');
    return done({ ok: true, created: created, updated: updated });
  }

  case 'stock_adjust': {
    const p = productById[String(data.product_id)];
    if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan');
    const newStock = num(data.new_stock);
    const diff = Math.round((newStock - num(p.stock)) * 1000) / 1000;
    const np = Object.assign({}, p, { stock: newStock });
    ops.products.push(forWrite(np, p.id));
    ops.purchases.push(forWrite({
      purchase_date: isDate(data.date) ? data.date : new Date().toISOString().slice(0, 10), supplier: 'PENYESUAIAN STOK',
      product_id: p.id, name: str(p.name), qty: diff, cost_price: money(p.cost_price), total: 0,
      note: str(data.reason), user: me.name
    }, -1));
    logAct('stok', 'Penyesuaian stok ' + str(p.name) + ': ' + fmtN(p.stock) + '→' + fmtN(newStock) + (str(data.reason) ? ' | ' + str(data.reason) : ''), String(p.id), 0, 'warn');
    return done({ ok: true, product: productOut(np) });
  }

  case 'save_customer': {
    // A number taken at the counter (no id) that is already known updates that customer instead of adding a duplicate.
    const phone = normPhone(data.phone);
    let ex = data.id ? customerById[String(data.id)] : null;
    if (data.id && !ex) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
    let existed = false;
    if (!ex && phone) { ex = customers.find(function (x) { return normPhone(x.phone) === phone; }) || null; existed = !!ex; }
    if (str(data.name) && !safeName(data.name, 80)) return fail('INVALID', 'Nama pelanggan hanya boleh huruf, angka dan . , \' & ( ) / -');
    if (str(data.phone) && !/^[0-9+ ().-]{3,20}$/.test(str(data.phone))) return fail('INVALID', 'Nomor HP hanya boleh angka (contoh 0812xxxxxxx)');
    if (str(data.address).length > 200 || str(data.notes).length > 300) return fail('INVALID', 'Alamat / catatan terlalu panjang');
    const name = safeName(data.name, 80) || (ex ? str(ex.name) : (phone ? 'Pelanggan ' + phone.slice(-4) : ''));
    if (!name) return fail('INVALID', 'Nama pelanggan wajib');
    const optin = typeof data.wa_optin === 'boolean' ? (existed ? (data.wa_optin || ex.wa_optin === true) : data.wa_optin) : !!(ex && ex.wa_optin === true);
    const c = existed ? {
      name: name, phone: phone, type: str(ex.type) || 'eceran', address: str(data.address) || str(ex.address), notes: str(data.notes) || str(ex.notes),
      debt_balance: money(ex.debt_balance), wa_optin: optin, source: str(ex.source) || str(data.source).slice(0, 20)
    } : {
      // Fields the app did not send keep their stored value (a partial edit, e.g. only "member", must not wipe the rest).
      name: name, phone: phone || (data.phone !== undefined ? str(data.phone) : (ex ? str(ex.phone) : '')),
      type: data.type !== undefined ? (data.type === 'grosir' ? 'grosir' : 'eceran') : (ex ? str(ex.type) || 'eceran' : 'eceran'),
      address: data.address !== undefined ? str(data.address) : (ex ? str(ex.address) : ''), notes: data.notes !== undefined ? str(data.notes) : (ex ? str(ex.notes) : ''),
      debt_balance: ex ? money(ex.debt_balance) : 0,
      wa_optin: optin, source: str(data.source).slice(0, 20) || (ex ? str(ex.source) : '')
    };
    // E-mail and membership (v16). Any user may register a member; only owner / manager may end a membership.
    let email = data.email !== undefined ? str(data.email).toLowerCase() : (ex ? str(ex.email) : '');
    if (email && !isEmail(email)) return fail('INVALID', 'Alamat e-mail tidak valid');
    const wasMember = !!(ex && ex.member === true);
    const member = typeof data.member === 'boolean' ? data.member : wasMember;
    if (wasMember && !member && !isApprover) return fail('FORBIDDEN', 'Hanya pemilik / manajer yang bisa menghapus member');
    c.email = email;
    c.member = member;
    c.member_no = ex && str(ex.member_no) ? str(ex.member_no) : (member ? 'M' + rand(6) : '');
    c.member_since = member ? (ex && str(ex.member_since) && wasMember ? str(ex.member_since) : jkDate()) : (ex ? str(ex.member_since) : '');
    c.visits = ex ? Math.max(0, Math.round(num(ex.visits))) : 0;
    c.receipts_sent = ex ? Math.max(0, Math.round(num(ex.receipts_sent))) : 0;
    c.last_visit = ex ? str(ex.last_visit) : '';
    ops.customers.push(forWrite(c, ex ? ex.id : -1));
    if (member && !wasMember) logAct('member_baru', 'Member baru: ' + c.name + ' (' + c.member_no + ')' + (c.phone ? ' ' + c.phone : '') + (email ? ' ' + email : ''), c.member_no, 0, 'info');
    if (!member && wasMember) logAct('member_berhenti', 'Member dihapus: ' + c.name + ' (' + c.member_no + ')', c.member_no, 0, 'warn');
    return done({ ok: true, existed: existed, customer: Object.assign({ id: ex ? ex.id : null }, c), member: memberInfo(Object.assign({}, c)) });
  }

  case 'receive_payment': {
    const c = customerById[String(data.customer_id)];
    if (!c) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
    const amount = money(data.amount);
    if (!(amount > 0)) return fail('INVALID', 'Jumlah pembayaran tidak valid');
    if (amount > money(c.debt_balance)) return fail('INVALID', 'Pembayaran melebihi hutang');
    if (dupRef(data.transfer_ref)) return fail('INVALID', 'Nomor transfer ini sudah pernah dipakai: ' + str(data.transfer_ref));
    const sc = slipCheck(amount);
    if (sc && sc.fail) return sc.fail;
    const docs = partyDocs('customer', c.id, '');
    const chk = checkAlloc(data.alloc, docs, amount);
    if (chk.error) return fail('INVALID', chk.error);
    const nc = Object.assign({}, c, { debt_balance: Math.max(0, money(c.debt_balance) - amount) });
    const pay = {
      pay_id: 'PY' + rand(7), pay_date: isDate(data.pay_date) ? data.pay_date : jkDate(), pay_time: new Date().toISOString(),
      direction: 'in', party_type: 'customer', customer_id: c.id, customer_name: str(c.name), supplier: '', amount: amount,
      method: ['tunai', 'transfer', 'qris'].indexOf(data.method) >= 0 ? data.method : 'tunai',
      account_id: payAccount(data.method), slip_date: sc && sc.ex && sc.ex.date ? str(sc.ex.date) : '',
      bank: str(data.bank).slice(0, 60), transfer_ref: str(data.transfer_ref).slice(0, 80), proof_photo_id: str(data.photo_id).slice(0, 40),
      alloc: JSON.stringify(chk.alloc), match_status: allocStatus(amount, chk, docs),
      note: (str(data.note) + (str(data.mismatch_reason) ? ' | beda dengan bukti: ' + str(data.mismatch_reason) : '')).slice(0, 500), cashier: me.name
    };
    ops.payments.push(forWrite(pay, -1));
    ops.customers.push(forWrite(nc, c.id));
    if (myShift && pay.method === 'tunai') {
      ops.shifts.push(forWrite(Object.assign({}, myShift, { cash_payments: money(myShift.cash_payments) + amount }), myShift.id));
    }
    const dateOff = pay.slip_date && pay.slip_date !== pay.pay_date;
    logAct('bayar_masuk', 'Pembayaran ' + str(c.name) + ' Rp ' + amount + ' (' + pay.method + (pay.bank ? ' ' + pay.bank : '') + (pay.transfer_ref ? ', ref ' + pay.transfer_ref : '') + ')' +
      (chk.alloc.length ? ' untuk ' + chk.alloc.map(function (a1) { return a1.ref + ' Rp ' + a1.amount; }).join(', ') : ' — belum dialokasi') + (str(data.mismatch_reason) ? ' | beda dengan bukti: ' + str(data.mismatch_reason) : '') +
      (dateOff ? ' | tanggal bukti ' + pay.slip_date + ' ≠ dicatat ' + pay.pay_date : ''),
      pay.pay_id, amount, str(data.mismatch_reason) || dateOff || pay.match_status === 'belum_dialokasi' ? 'warn' : 'info');
    return done({ ok: true, payment: Object.assign({ id: null }, payOut(pay)), customer: clean(nc) });
  }

  case 'pay_supplier': {
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const sup = safeName(data.supplier, 80);
    if (!sup) return fail('INVALID', 'Nama pemasok wajib (huruf dan angka saja)');
    const amount = money(data.amount);
    if (!(amount > 0)) return fail('INVALID', 'Jumlah pembayaran tidak valid');
    const method = ['tunai', 'transfer', 'qris'].indexOf(data.method) >= 0 ? data.method : 'transfer';
    const fromKas = data.paid_from === 'kas' && method === 'tunai';
    if (fromKas && !myShift) return fail('SHIFT_REQUIRED', 'Buka kasir (shift) dulu untuk bayar dari kas');
    if (dupRef(data.transfer_ref)) return fail('INVALID', 'Nomor transfer ini sudah pernah dipakai: ' + str(data.transfer_ref));
    const sc = slipCheck(amount);
    if (sc && sc.fail) return sc.fail;
    const docs = partyDocs('supplier', sup, '');
    const chk = checkAlloc(data.alloc, docs, amount);
    if (chk.error) return fail('INVALID', chk.error);
    const pay = {
      pay_id: 'PY' + rand(7), pay_date: isDate(data.pay_date) ? data.pay_date : jkDate(), pay_time: new Date().toISOString(),
      direction: 'out', party_type: 'supplier', customer_id: 0, customer_name: '', supplier: sup, amount: amount, method: method,
      account_id: payAccount(method), slip_date: sc && sc.ex && sc.ex.date ? str(sc.ex.date) : '',
      bank: str(data.bank).slice(0, 60), transfer_ref: str(data.transfer_ref).slice(0, 80), proof_photo_id: str(data.photo_id).slice(0, 40),
      alloc: JSON.stringify(chk.alloc), match_status: allocStatus(amount, chk, docs),
      note: (str(data.note) + (fromKas ? ' [dari kas]' : '') + (str(data.mismatch_reason) ? ' | beda dengan bukti: ' + str(data.mismatch_reason) : '')).slice(0, 500), cashier: me.name
    };
    ops.payments.push(forWrite(pay, -1));
    if (fromKas) {
      const sh = Object.assign({}, myShift, { cash_out: money(myShift.cash_out) + amount });
      addMove(sh, 'out', amount, 'Bayar pemasok ' + sup);
      ops.shifts.push(forWrite(sh, myShift.id));
    }
    logAct('bayar_keluar', 'Bayar pemasok ' + sup + ' Rp ' + amount + ' (' + method + (pay.bank ? ' ' + pay.bank : '') + (pay.transfer_ref ? ', ref ' + pay.transfer_ref : '') + (fromKas ? ', dari kas' : '') + ')' +
      (chk.alloc.length ? ' untuk ' + chk.alloc.map(function (a1) { return a1.ref + ' Rp ' + a1.amount; }).join(', ') : ' — belum dialokasi') + (str(data.mismatch_reason) ? ' | beda dengan bukti: ' + str(data.mismatch_reason) : '') +
      (pay.slip_date && pay.slip_date !== pay.pay_date ? ' | tanggal bukti ' + pay.slip_date + ' ≠ dicatat ' + pay.pay_date : ''),
      pay.pay_id, amount, str(data.mismatch_reason) || (pay.slip_date && pay.slip_date !== pay.pay_date) ? 'warn' : 'info');
    return done({ ok: true, payment: Object.assign({ id: null }, payOut(pay)) });
  }

  case 'allocate_payment': {
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const p0 = partyPayments.find(function (x) { return x.pay_id === str(data.pay_id); });
    if (!p0) return fail('NOT_FOUND', 'Pembayaran tidak ditemukan (kirim juga customer_id / supplier)');
    const pt = payDir(p0) === 'out' ? 'supplier' : 'customer';
    const docs = partyDocs(pt, pt === 'customer' ? p0.customer_id : str(p0.supplier), p0.pay_id);
    const chk = checkAlloc(data.alloc, docs, money(p0.amount));
    if (chk.error) return fail('INVALID', chk.error);
    const np = Object.assign({}, p0, { alloc: JSON.stringify(chk.alloc), match_status: allocStatus(money(p0.amount), chk, docs),
      note: (str(p0.note) + (str(data.note) ? ' | alokasi: ' + str(data.note) : '')).slice(0, 500) });
    ops.payments.push(forWrite(np, p0.id));
    logAct('alokasi', 'Alokasi pembayaran ' + p0.pay_id + ' (' + (pt === 'customer' ? str(p0.customer_name) : str(p0.supplier)) + ' Rp ' + money(p0.amount) + '): ' +
      (chk.alloc.length ? chk.alloc.map(function (a1) { return 'bagian dari ' + a1.ref + ' Rp ' + a1.amount; }).join(', ') : 'dikosongkan') + (str(data.note) ? ' | ' + str(data.note) : ''), p0.pay_id, money(p0.amount), 'info');
    return done({ ok: true, payment: payOut(np) });
  }

  case 'import_statement': {
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const acc = bankAccounts().find(function (x) { return str(x.id) === str(data.account_id); });
    if (!acc) return fail('INVALID', 'Pilih rekening bank toko (atur di Pengaturan)');
    const period = str(data.period);
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('INVALID', 'Periode harus YYYY-MM');
    const pr = periodRange(period);
    const src = Array.isArray(data.lines) ? data.lines : [];
    if (!src.length || src.length > 1500) return fail('INVALID', 'Baris rekening kosong atau terlalu banyak (maks 1500)');
    const existing = rows('Get Bank Lines').filter(function (x) { return str(x.account_id) === str(acc.id) && str(x.period) === period; })
      .sort(function (a1, b1) { return num(a1.seq) - num(b1.seq); });
    const now = new Date().toISOString();
    const lines = [];
    for (let i = 0; i < src.length; i++) {
      const l = src[i] || {};
      if (!isDate(l.date) || l.date < pr.from || l.date > pr.to) return fail('INVALID', 'Baris ' + (i + 1) + ': tanggal di luar periode ' + period);
      const amt = l.amount !== undefined && l.amount !== null && l.amount !== '' ? money(l.amount) : money(l.credit) - money(l.debit);
      if (!amt) return fail('INVALID', 'Baris ' + (i + 1) + ': jumlah kosong');
      lines.push({ line_id: str(acc.id) + '-' + period + '-' + (i + 1), account_id: str(acc.id), period: period, seq: i + 1, line_date: l.date,
        description: str(l.description).slice(0, 300), amount: amt, ref: str(l.ref).slice(0, 80), balance: l.balance === undefined || l.balance === null || l.balance === '' ? 0 : money(l.balance),
        status: '', pay_id: '', note: '', imported_at: now, imported_by: me.name });
    }
    const rep = reconcile(lines, str(acc.id), period);
    const byId = {};
    rep.lines.forEach(function (x) { byId[x.line_id] = x; });
    lines.forEach(function (l, i) {
      const x = byId[l.line_id];
      ops.bank_lines.push(forWrite(Object.assign({}, l, { status: x.status, pay_id: x.pay_id || '' }), existing[i] ? existing[i].id : -1));
    });
    existing.slice(lines.length).forEach(function (x) { ops.bank_lines.push(forWrite(Object.assign({}, x, { status: 'dihapus' }), x.id)); });
    const bad = (rep.counts.beda_tanggal || 0) + (rep.counts.beda_jumlah || 0) + (rep.counts.tidak_tercatat || 0) + rep.missing.length;
    logAct('rekening', reconText(acc, period, rep), str(acc.id) + ' ' + period, rep.totals.statement_in - rep.totals.statement_out, bad ? 'warn' : 'info');
    return done(Object.assign({ ok: true, account: acc, period: period }, rep));
  }

  case 'bank_recon': {
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const acc = bankAccounts().find(function (x) { return str(x.id) === str(data.account_id); });
    if (!acc) return fail('INVALID', 'Pilih rekening bank toko');
    const period = str(data.period);
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('INVALID', 'Periode harus YYYY-MM');
    const lines = rows('Get Bank Lines').filter(function (x) { return str(x.account_id) === str(acc.id) && str(x.period) === period; })
      .sort(function (a1, b1) { return num(a1.seq) - num(b1.seq); });
    return done(Object.assign({ ok: true, account: acc, period: period, imported: lines.length > 0 }, reconcile(lines, str(acc.id), period)));
  }

  case 'match_bank_line': {
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    const l = rows('Get Bank Lines').find(function (x) { return x.line_id === str(data.line_id); });
    if (!l) return fail('NOT_FOUND', 'Baris rekening tidak ditemukan (kirim account_id + period)');
    let upd;
    if (data.ignore === true) upd = { status: 'diabaikan', pay_id: '' };
    else if (str(data.pay_id)) {
      const p = rows('Get Range Payments').find(function (x) { return x.pay_id === str(data.pay_id); });
      if (!p) return fail('NOT_FOUND', 'Pembayaran tidak ditemukan di sekitar periode ini');
      upd = { status: 'manual', pay_id: p.pay_id };
    } else upd = { status: 'tidak_tercatat', pay_id: '' };
    const note = str(data.note).slice(0, 300);
    if (upd.status !== 'tidak_tercatat' && !note) return fail('INVALID', 'Catatan wajib diisi');
    const nl = Object.assign({}, l, upd, { note: note });
    ops.bank_lines.push(forWrite(nl, l.id));
    logAct('rekening', 'Baris rekening ' + str(l.line_date) + ' Rp ' + money(l.amount) + ' (' + str(l.description).slice(0, 80) + '): ' +
      (upd.status === 'manual' ? 'dicocokkan manual dengan ' + upd.pay_id : (upd.status === 'diabaikan' ? 'diabaikan' : 'dibuka lagi')) + (note ? ' | ' + note : ''), str(l.line_id), money(l.amount), 'info');
    return done({ ok: true, line: clean(nl) });
  }

  case 'daily_report': {
    // One day in numbers: sales by payment method, what went to the bank, payments, expenses and every cash drawer.
    if (!isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    if (!isDate(data.date)) return fail('INVALID', 'Tanggal tidak valid');
    const day = data.date;
    const allSales = rows('Get Range Sales').filter(function (x) { return x.sale_date === day; });
    const okSales = allSales.filter(function (x) { return x.status !== 'void'; });
    const voids = allSales.filter(function (x) { return x.status === 'void'; });
    const okInv = {};
    okSales.forEach(function (x) { okInv[x.invoice_no] = true; });
    const items = rows('Get Range Items').filter(function (x) { return okInv[x.invoice_no]; });
    const sumOf = function (arr, f) { return arr.reduce(function (a1, x) { return a1 + f(x); }, 0); };
    const byMethod = { tunai: 0, transfer: 0, qris: 0 };
    okSales.forEach(function (x) { const paid = Math.min(money(x.paid_amount), money(x.total)); if (byMethod[x.payment_method] !== undefined) byMethod[x.payment_method] += paid; else byMethod.tunai += paid; });
    const prod = {};
    items.forEach(function (it) { const k = String(it.product_id); if (!prod[k]) prod[k] = { name: str(it.name), qty: 0, total: 0 }; prod[k].qty = Math.round((prod[k].qty + num(it.qty)) * 1000) / 1000; prod[k].total += money(it.line_total); });
    const pays = rows('Get Range Payments').filter(function (p) { return p.pay_date === day; });
    const pin = pays.filter(function (p) { return payDir(p) === 'in'; }), pout = pays.filter(function (p) { return payDir(p) === 'out'; });
    const mSum = function (arr, m) { return sumOf(arr.filter(function (p) { return p.method === m; }), function (p) { return money(p.amount); }); };
    const exps = rows('Get Range Expenses').filter(function (e) { return e.expense_date === day; });
    const shifts = rows('Get Range Shifts').filter(function (x) { return x.shift_date === day; }).map(function (x) {
      const exp = money(x.opening_cash) + money(x.cash_sales) + money(x.cash_payments) + money(x.cash_in) - money(x.cash_out);
      return { shift_id: x.shift_id, cashier: x.cashier, status: x.status, opening_cash: money(x.opening_cash), cash_sales: money(x.cash_sales), cash_payments: money(x.cash_payments),
        cash_in: money(x.cash_in), cash_out: money(x.cash_out), expected_cash: x.status === 'closed' ? money(x.expected_cash) : exp, counted_cash: x.status === 'closed' ? money(x.counted_cash) : null,
        difference: x.status === 'closed' ? money(x.difference) : null, sales_count: num(x.sales_count), sales_total: money(x.sales_total) };
    });
    const rep = {
      date: day,
      sales: { count: okSales.length, total: sumOf(okSales, function (x) { return money(x.total); }), discount: sumOf(okSales, function (x) { return money(x.discount); }),
        items_qty: Math.round(sumOf(items, function (x) { return num(x.qty); }) * 1000) / 1000, by_method: byMethod, debt: sumOf(okSales, function (x) { return money(x.debt_amount); }),
        voids: { count: voids.length, total: sumOf(voids, function (x) { return money(x.total); }) } },
      top_items: Object.keys(prod).map(function (k) { return prod[k]; }).sort(function (a1, b1) { return b1.total - a1.total; }).slice(0, 10),
      payments_in: { count: pin.length, total: sumOf(pin, function (p) { return money(p.amount); }), tunai: mSum(pin, 'tunai'), transfer: mSum(pin, 'transfer'), qris: mSum(pin, 'qris') },
      payments_out: { count: pout.length, total: sumOf(pout, function (p) { return money(p.amount); }), tunai: mSum(pout, 'tunai'), transfer: mSum(pout, 'transfer'), qris: mSum(pout, 'qris') },
      expenses: { count: exps.length, total: sumOf(exps, function (e) { return money(e.amount); }), from_kas: sumOf(exps.filter(function (e) { return e.paid_from === 'kas'; }), function (e) { return money(e.amount); }) },
      shifts: shifts
    };
    rep.bank = { sales_transfer: byMethod.transfer, sales_qris: byMethod.qris, payments_transfer: rep.payments_in.transfer, payments_qris: rep.payments_in.qris,
      out_transfer: rep.payments_out.transfer + rep.payments_out.qris };
    rep.bank.in_total = rep.bank.sales_transfer + rep.bank.sales_qris + rep.bank.payments_transfer + rep.bank.payments_qris;
    rep.cash = { sales: byMethod.tunai, payments_in: rep.payments_in.tunai, payments_out: rep.payments_out.tunai, expenses_from_kas: rep.expenses.from_kas,
      expected_total: sumOf(shifts, function (x) { return x.expected_cash; }), counted_total: sumOf(shifts.filter(function (x) { return x.status === 'closed'; }), function (x) { return x.counted_cash; }),
      difference_total: sumOf(shifts.filter(function (x) { return x.status === 'closed'; }), function (x) { return x.difference; }) };
    if (role === 'owner') rep.profit = sumOf(okSales, function (x) { return money(x.profit); });
    const st = readSettings();
    const rets = rows('Get Range Returns').filter(function (x) { return x.status === 'approved'; });
    const custRets = rets.filter(function (x) { return x.kind !== 'pemasok'; });
    rep.returns = {
      customer: { count: custRets.length, refund: custRets.reduce(function (a1, x) { return a1 + money(x.refund); }, 0),
        tunai: custRets.filter(function (x) { return x.refund_method === 'tunai'; }).reduce(function (a1, x) { return a1 + money(x.refund); }, 0) },
      supplier: { count: rets.length - custRets.length }
    };
    if (role === 'owner') rep.returns.supplier.value = rets.filter(function (x) { return x.kind === 'pemasok'; }).reduce(function (a1, x) { return a1 + money(x.value); }, 0);
    return done({ ok: true, report: rep, send_to: { company: str(st.wa_shop_number), manager: str(st.wa_manager_number), owner: str(st.wa_owner_number) } });
  }

  case 'party_ledger': {
    const pt = data.party_type === 'supplier' ? 'supplier' : 'customer';
    if (pt === 'supplier' && !isApprover) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
    let key, balance;
    if (pt === 'customer') {
      const c = customerById[String(data.customer_id)];
      if (!c) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
      key = c.id;
      balance = money(c.debt_balance);
    } else {
      key = str(data.supplier);
      if (!key) return fail('INVALID', 'Nama pemasok wajib');
    }
    const docs = partyDocs(pt, key, '');
    const pays = partyPayments.filter(function (p) { return pt === 'customer' ? (Number(p.customer_id) === Number(key) && payDir(p) === 'in') : (str(p.supplier) === key && payDir(p) === 'out'); })
      .map(payOut).sort(function (a1, b1) { return String(b1.pay_date + b1.pay_time).localeCompare(String(a1.pay_date + a1.pay_time)); });
    const list = Object.keys(docs).map(function (k) { return docs[k]; }).sort(function (a1, b1) { return String(a1.date).localeCompare(String(b1.date)); });
    if (pt === 'supplier') balance = list.reduce(function (a1, d) { return a1 + d.total; }, 0) - pays.reduce(function (a1, p) { return a1 + money(p.amount); }, 0);
    // Money paid without choosing an invoice is applied to the oldest open ones first (auto), so old invoices do not look unpaid.
    let free = partyPayments.filter(function (p) { return pt === 'customer' ? (Number(p.customer_id) === Number(key) && payDir(p) === 'in') : (str(p.supplier) === key && payDir(p) === 'out'); }).reduce(function (a1, p) {
      const alloc = payAlloc(p).reduce(function (a2, x) { return a2 + money(x.amount); }, 0);
      return a1 + Math.max(0, money(p.amount) - alloc);
    }, 0);
    list.forEach(function (d) {
      const take = Math.min(free, Math.max(0, d.total - d.paid));
      d.auto = take; free -= take;
      d.remaining = Math.max(0, d.total - d.paid - take);
    });
    return done({ ok: true, party_type: pt, docs: list, payments: pays, balance: balance, unapplied: free });
  }

  case 'save_purchase': {
    const items = Array.isArray(data.items) ? data.items.slice(0, 200) : [];
    if (!items.length) return fail('INVALID', 'Tidak ada barang');
    if (str(data.supplier) && !safeName(data.supplier, 80)) return fail('INVALID', 'Nama pemasok hanya boleh huruf dan angka');
    // Who brought the goods: public transport (+ its number), a friend (name), the supplier's driver or our staff.
    const carrier = readCarrier(data.carrier, readSettings().require_carrier !== false);
    if (carrier.error) return fail('CARRIER_REQUIRED', carrier.error);
    const date = isDate(data.purchase_date) ? data.purchase_date : new Date().toISOString().slice(0, 10);
    const photoId = str(data.photo_id);
    if (photoId) {
      const ph = rows('Get Photo').find(function (x) { return x.photo_id === photoId; });
      if (!ph || ph.kind !== 'masuk') return fail('INVALID', 'Foto barang masuk tidak ditemukan');
    } else if (readSettings().require_purchase_photo !== false) {
      return fail('PHOTO_REQUIRED', 'Barang masuk wajib foto nota / barang');
    }
    // Check what was typed against the photographed supplier note before anything is saved.
    const photoRow = photoId ? rows('Get Photo').find(function (x) { return x.photo_id === photoId; }) : null;
    const typed = items.map(function (it) { const p0 = productById[String(it.product_id)]; return { name: p0 ? str(p0.name) : str(it.product_id), qty: Math.round(num(it.qty) * 1000) / 1000, photo_index: it.photo_index }; });
    const match = photoRow ? matchNote(typed, photoRow) : { status: 'tanpa_foto', diffs: [], notes: '' };
    const reason = str(data.mismatch_reason).slice(0, 300);
    if (match.status === 'tidak_cocok' && !reason) {
      Object.keys(ops).forEach(function (k) { ops[k] = []; });
      return done({ ok: false, error: 'MISMATCH', message: 'Jumlah tidak sama dengan nota: ' + diffText(match.diffs), match: match });
    }
    const purchaseNo = 'PB' + date.replace(/-/g, '').slice(2) + '-' + rand(4);
    const matchNotes = (match.diffs.length ? diffText(match.diffs) : '') + (reason ? ' | alasan: ' + reason : '');
    const state = {};
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const p = state[String(it.product_id)] || (productById[String(it.product_id)] ? Object.assign({}, productById[String(it.product_id)]) : null);
      if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan: ' + it.product_id);
      const qty = Math.round(num(it.qty) * 1000) / 1000;
      if (!(qty > 0)) return fail('INVALID', 'Jumlah tidak valid: ' + p.name);
      const cost = money(it.cost_price);
      const oldStock = Math.max(0, num(p.stock));
      const newCost = oldStock + qty > 0 ? Math.round((oldStock * money(p.cost_price) + qty * cost) / (oldStock + qty)) : cost;
      p.stock = Math.round((num(p.stock) + qty) * 1000) / 1000;
      p.cost_price = newCost;
      state[String(p.id)] = p;
      ops.purchases.push(forWrite({
        purchase_date: date, supplier: str(data.supplier), product_id: p.id, name: str(p.name), qty: qty,
        cost_price: cost, total: Math.round(qty * cost), note: str(data.note), user: me.name, photo_id: photoId,
        exp_date: isDate(it.exp_date) ? it.exp_date : '', purchase_no: purchaseNo, match_status: match.status, match_notes: matchNotes.slice(0, 500),
        carrier_type: carrier.type, carrier_name: carrier.name, carrier_vehicle: carrier.vehicle, carrier_phone: carrier.phone
      }, -1));
    }
    const stockOut = [];
    Object.keys(state).forEach(function (pid) {
      const p = state[pid];
      ops.products.push(forWrite(p, p.id));
      const o = { product_id: p.id, stock: p.stock };
      if (role === 'owner') o.cost_price = p.cost_price;
      stockOut.push(o);
    });
    const sumTotal = ops.purchases.reduce(function (a1, r) { return a1 + money(r.total); }, 0);
    logAct('masuk', 'Barang masuk ' + purchaseNo + (str(data.supplier) ? ' dari ' + str(data.supplier) : '') + ': ' + items.length + ' baris, Rp ' + sumTotal + ' — nota: ' + match.status + (matchNotes ? ' (' + matchNotes + ')' : '') + (carrier.type ? ' — dibawa ' + ({ umum: 'kendaraan umum', teman: 'teman', pemasok: 'sopir pemasok', karyawan: 'karyawan' })[carrier.type] + (carrier.name ? ' ' + carrier.name : '') + (carrier.vehicle ? ' ' + carrier.vehicle : '') : ''), purchaseNo, sumTotal, match.status === 'cocok' ? 'info' : 'warn');
    return done({ ok: true, stock: stockOut, purchase_no: purchaseNo, match: match });
  }

  case 'request_purchase_fix': {
    // A saved goods-in can only be corrected with the manager's (or owner's) approval; the owner sees it in the log.
    const no = str(data.purchase_no);
    if (!no) return fail('INVALID', 'purchase_no wajib');
    const reason = str(data.reason).slice(0, 300);
    if (!reason) return fail('INVALID', 'Alasan koreksi wajib diisi');
    const pf = purchaseFixChanges(no, data.lines);
    if (!pf.found) return fail('NOT_FOUND', 'Barang masuk tidak ditemukan');
    if (!pf.changes.length) return fail('INVALID', 'Tidak ada perubahan');
    const summary = fixSummary(no, pf.changes);
    if (isApprover) {
      const stock = applyPurchaseFix(no, pf.changes, reason, me.name);
      logAct('koreksi_masuk', summary + ' | ' + reason, no, pf.changes.reduce(function (a1, c) { return a1 + c.d_total; }, 0), 'warn');
      return done({ ok: true, applied: true, changes: role === 'owner' ? pf.changes : pf.changes.map(qtyOnly), stock: stock });
    }
    const a = newApproval({ kind: 'purchase_fix', approver_role: 'manager', ref: no, note: reason, summary: summary.slice(0, 1500),
      total: pf.changes.reduce(function (a1, c) { return a1 + c.to_total; }, 0),
      payload: JSON.stringify({ purchase_no: no, lines: data.lines, reason: reason, changes: pf.changes }) });
    ops.approvals.push(forWrite(a, -1));
    logAct('minta_koreksi', 'Minta ' + summary + ' | ' + reason, no, 0, 'warn');
    return done({ ok: true, applied: false, request_id: a.request_id, approval: approvalOut(a), changes: pf.changes.map(qtyOnly) });
  }

  case 'list_activity': {
    return done({ ok: true, activity: rows('Get Range Activity').map(clean).sort(function (a1, b1) { return String(b1.at).localeCompare(String(a1.at)); }) });
  }

  case 'get_sales': {
    if (!isDate(data.from) || !isDate(data.to)) return fail('INVALID', 'Rentang tanggal tidak valid');
    return done({
      ok: true,
      sales: rows('Get Range Sales').map(function (r) { return strip(r, role); }),
      items: rows('Get Range Items').map(function (r) { return strip(r, role); }),
      payments: rows('Get Range Payments').map(clean),
      purchases: rows('Get Range Purchases').map(function (r) { const o = strip(r, role); if (role !== 'owner') delete o.total; return o; }),
      expenses: rows('Get Range Expenses').map(clean),
      shifts: rows('Get Range Shifts').map(clean),
      repacks: rows('Get Range Repacks').map(function (r) { const o = clean(r); if (role !== 'owner') { delete o.unit_cost; delete o.packaging_cost; } return o; })
    });
  }

  case 'save_settings': {
    const incoming = data.settings && typeof data.settings === 'object' ? data.settings : {};
    const allowed = ['store_name', 'address', 'phone', 'receipt_footer', 'paper', 'survey_questions', 'survey_auto', 'auto_lock_minutes', 'language', 'exit_photo_min_total', 'exit_photo_min_qty', 'require_purchase_photo', 'require_shift', 'wa_shop_number', 'wa_manager_number', 'wa_owner_number', 'report_time', 'max_discount_pct', 'receipt_send_fee', 'sell_from_shop_only', 'return_owner_min_value', 'return_owner_min_qty', 'return_fee_pct', 'require_return_photo', 'require_carrier', 'member_enabled', 'member_tiers', 'survey_voice', 'store_lat', 'store_lng', 'require_device_location', 'bank_accounts'];
    const byKey = {};
    settingRows.forEach(function (r) { byKey[r.skey] = r; });
    if (AGREED_KEYS.some(function (k) { return incoming[k] !== undefined && JSON.stringify(incoming[k]) !== JSON.stringify(readSettings()[k]); })) {
      return fail('AGREEMENT_REQUIRED', 'Batas retur diubah lewat kesepakatan pemilik dan manajer (propose_agreement)');
    }
    allowed.forEach(function (k) {
      if (incoming[k] === undefined) return;
      ops.settings.push({ _id: byKey[k] ? byKey[k].id : -1, skey: k, svalue: JSON.stringify(incoming[k]) });
    });
    const merged = readSettings();
    allowed.forEach(function (k) { if (incoming[k] !== undefined) merged[k] = incoming[k]; });
    const changedKeys = allowed.filter(function (k) { return incoming[k] !== undefined && JSON.stringify(incoming[k]) !== JSON.stringify(readSettings()[k]); });
    if (changedKeys.length) logAct('pengaturan', 'Pengaturan diubah: ' + changedKeys.join(', '), '', 0, 'info');
    return done({ ok: true, settings: merged });
  }

  case 'save_user': {
    const name = personName(data.name);
    if (!name) return fail('INVALID', str(data.name) ? 'Nama pengguna hanya boleh huruf, spasi dan . \' -' : 'Nama wajib');
    const newRole = ['owner', 'manager', 'sales'].indexOf(data.role) >= 0 ? data.role : 'kasir';
    const ex = users.find(function (u) { return str(u.name).toLowerCase() === name.toLowerCase(); });
    const active = data.active !== false;
    // Another person takes this account / role (new name): needs a new PIN made with the new name (hash includes it).
    let newName = '';
    if (str(data.new_name)) {
      newName = personName(data.new_name);
      if (!ex) return fail('NOT_FOUND', 'Pengguna tidak ditemukan');
      if (!newName) return fail('INVALID', 'Nama baru hanya boleh huruf, angka, spasi dan . , \' -');
      if (users.some(function (u) { return u.id !== ex.id && str(u.name).toLowerCase() === newName.toLowerCase(); })) return fail('INVALID', 'Nama sudah dipakai');
      if (!isHash(data.pin_hash)) return fail('INVALID', 'Ganti nama butuh PIN sementara baru');
      if (shiftOf(ex.name)) return fail('INVALID', 'Tutup kas ' + ex.name + ' dulu sebelum ganti nama');
    }
    if (data.pin_hash !== undefined && data.pin_hash !== '' && !isHash(data.pin_hash)) return fail('INVALID', 'PIN tidak valid');
    if (!ex && !isHash(data.pin_hash)) return fail('INVALID', 'PIN wajib untuk pengguna baru');
    if (ex && ex.role === 'owner' && (newRole !== 'owner' || !active)) {
      const owners = activeUsers.filter(function (u) { return u.role === 'owner'; });
      if (owners.length <= 1) return fail('INVALID', 'Harus ada minimal satu pemilik aktif');
    }
    // A PIN set by the owner for someone else is temporary: that person chooses their own at the next login.
    const newPin = isHash(data.pin_hash) && (!ex || data.pin_hash !== ex.pin_hash);
    const self = ex && ex.id === me.id;
    const u = Object.assign({}, ex ? clean(ex) : {}, {
      name: newName || (ex ? ex.name : name), role: newRole, pin_hash: isHash(data.pin_hash) ? data.pin_hash : ex.pin_hash, active: active,
      must_change: newPin ? !self : (ex ? ex.must_change === true : false)
    });
    if (newPin) { u.fail_count = 0; u.locked_until = ''; }
    if (users.some(function (x) { return isHash(x.master_hash) && x.master_hash === u.pin_hash; })) return fail('INVALID', 'PIN tidak valid');
    delete u.id;
    ops.users.push(forWrite(u, ex ? ex.id : -1));
    if (newName) logAct('pengguna', 'Ganti orang: ' + ex.name + ' → ' + newName + ' (' + newRole + '), PIN sementara baru', newName, 0, 'warn');
    else logAct('pengguna', (ex ? 'Pengguna diubah: ' : 'Pengguna baru: ') + u.name + ' (' + u.role + (u.active ? '' : ', nonaktif') + ')' + (ex && isHash(data.pin_hash) ? ', PIN diganti' : ''), u.name, 0, 'warn');
    return done({ ok: true, user: { name: u.name, role: u.role, active: u.active, must_change: u.must_change } });
  }

  default:
    return fail('INVALID', 'Aksi tidak dikenal: ' + req.action);
}
