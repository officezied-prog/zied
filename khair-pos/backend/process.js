const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Request').first().json;
const data = req.data || {};
const ops = { sales: [], sale_items: [], payments: [], purchases: [], products: [], customers: [], users: [], settings: [], approvals: [], expenses: [], shifts: [] };

function rows(name) {
  try {
    return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; });
  } catch (e) { return []; }
}
function done(resp) { return [{ json: { response: resp, ops: ops, action: req.action } }]; }
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
const me = activeUsers.find(function (u) { return str(u.name).toLowerCase() === req.user.trim().toLowerCase(); });
if (!me || me.pin_hash !== req.pin_hash) return fail('BAD_PIN', 'Nama atau PIN salah');
const role = me.role === 'owner' ? 'owner' : (me.role === 'manager' ? 'manager' : (me.role === 'sales' ? 'sales' : 'kasir'));
if (role === 'sales' && ['login', 'bootstrap'].indexOf(req.action) < 0) return fail('FORBIDDEN', 'Akun sales memakai aplikasi Khair Sales');
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
const OWNER_ONLY = ['void_sale', 'save_product', 'import_products', 'stock_adjust', 'save_settings', 'save_user'];
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
  survey_voice: true
};
const settingRows = rows('Get Settings');
const approvalRows = rows('Get Approvals');
function approvalById(id) { return approvalRows.find(function (a) { return a.request_id === id; }) || null; }
function canDecide(a) { return role === 'owner' || (role === 'manager' && a.approver_role !== 'owner'); }
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
    if (p) ops.products.push(forWrite(Object.assign({}, p, { stock: Math.round((num(p.stock) + back[pid]) * 1000) / 1000 }), p.id));
  });
  const c = customerById[String(sale.customer_id)];
  if (c && money(sale.debt_amount) > 0) {
    ops.customers.push(forWrite(Object.assign({}, c, { debt_balance: Math.max(0, money(c.debt_balance) - money(sale.debt_amount)) }), c.id));
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
function computeSale(invoice) {
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
    lines.push({
      invoice_no: invoice, sale_date: data.sale_date, product_id: p.id, sku: str(p.sku), name: str(p.name),
      qty: qty, unit_price: unitPrice, price_type: it.price_type === 'grosir' ? 'grosir' : 'eceran',
      cost_price: cost, line_total: lineTotal, line_profit: lineTotal - Math.round(qty * cost),
      customer_name: customer ? str(customer.name) : str(data.customer_name || 'Umum')
    });
    qtyByProduct[String(p.id)] = (qtyByProduct[String(p.id)] || 0) + qty;
  }
  const subtotal = lines.reduce(function (a, l) { return a + l.line_total; }, 0);
  const discount = Math.min(Math.max(money(data.discount), 0), subtotal);
  const total = subtotal - discount;
  const totalCost = lines.reduce(function (a, l) { return a + Math.round(l.qty * l.cost_price); }, 0);
  const method = ['tunai', 'transfer', 'qris', 'hutang'].indexOf(data.payment_method) >= 0 ? data.payment_method : 'tunai';
  let paid = Math.max(money(data.paid_amount), 0);
  if (method === 'hutang' && data.paid_amount === undefined) paid = 0;
  const debt = Math.max(0, total - paid);
  if (debt > 0 && !customer) return { error: fail('INVALID', 'Hutang / bayar kurang wajib pilih pelanggan') };
  return { lines: lines, qtyByProduct: qtyByProduct, customer: customer, subtotal: subtotal, discount: discount, total: total, totalCost: totalCost, method: method, paid: paid, debt: debt };
}
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
function productOut(p) { return strip(p, role); }

switch (req.action) {
  case 'login':
    return done({ ok: true, user: { name: me.name, role: role } });

  case 'bootstrap':
    return done({
      ok: true,
      user: { name: me.name, role: role },
      approvals_pending: isApprover ? approvalRows.filter(function (a) { return a.status === 'pending' && canDecide(a); }).length : 0,
      products: products.map(productOut),
      customers: customers.map(clean),
      settings: readSettings(),
      users: users.map(function (u) { return { name: u.name, role: u.role, active: u.active !== false }; }),
      shift: shiftOut(myShift),
      open_shifts: isApprover ? openShifts.map(shiftOut) : [],
      server_time: new Date().toISOString()
    });

  case 'save_sale': {
    const dup = rows('Get Sale By Client').filter(function (x) { return x.client_id === req.client_id; });
    if (dup.length) {
      return done({ ok: true, duplicate: true, invoice_no: dup[0].invoice_no, sale: strip(dup[0], role), stock: [] });
    }
    if (!myShift && role !== 'owner' && readSettings().require_shift !== false) return fail('SHIFT_REQUIRED', 'Buka kasir (shift) dulu');
    const invoice = 'KM' + str(data.sale_date).replace(/-/g, '').slice(2) + '-' + rand(5);
    const c = computeSale(invoice);
    if (c.error) return c.error;
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
      subtotal: c.subtotal, discount: c.discount, total: c.total, total_cost: c.totalCost, profit: c.total - c.totalCost,
      payment_method: c.method, paid_amount: c.paid, debt_amount: c.debt, status: 'ok',
      survey: JSON.stringify(survey), survey_transcript: data.survey_consent === true ? str(data.survey_transcript).slice(0, 4000) : '', notes: str(data.notes), client_id: req.client_id, approved_by: approvedBy,
      exit_photo: exitRequired ? 'required' : '', exit_match: '',
      channel: ['toko', 'whatsapp', 'shopee', 'tiktok', 'tokopedia', 'web', 'lainnya'].indexOf(data.channel) >= 0 ? data.channel : 'toko',
      promo_code: str(data.promo_code).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30),
      shift_id: myShift ? str(myShift.shift_id) : ''
    };
    if (myShift) {
      const cashPart = (c.method === 'tunai' || c.method === 'hutang') ? Math.min(c.paid, c.total) : 0;
      ops.shifts.push(forWrite(Object.assign({}, myShift, {
        sales_count: num(myShift.sales_count) + 1, sales_total: money(myShift.sales_total) + c.total, cash_sales: money(myShift.cash_sales) + cashPart
      }), myShift.id));
    }
    ops.sales.push(forWrite(sale, -1));
    c.lines.forEach(function (l) { ops.sale_items.push(forWrite(l, -1)); });
    const stockOut = [];
    Object.keys(c.qtyByProduct).forEach(function (pid) {
      const p = productById[pid];
      const newStock = Math.round((num(p.stock) - c.qtyByProduct[pid]) * 1000) / 1000;
      ops.products.push(forWrite(Object.assign({}, p, { stock: newStock }), p.id));
      stockOut.push({ product_id: p.id, stock: newStock });
    });
    if (c.customer && c.debt > 0) {
      ops.customers.push(forWrite(Object.assign({}, c.customer, { debt_balance: money(c.customer.debt_balance) + c.debt }), c.customer.id));
    }
    return done({ ok: true, duplicate: false, invoice_no: invoice, sale: strip(sale, role), stock: stockOut, exit_photo_required: exitRequired });
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
      return done({ ok: true, applied: true, product: productOut(np) });
    }
    const a = newApproval({ summary: summary, note: str(data.reason), kind: 'price', ref: String(p.id), payload: payload, approver_role: need });
    ops.approvals.push(forWrite(a, -1));
    return done({ ok: true, applied: false, request_id: a.request_id, approval: approvalOut(a) });
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
    if (role === 'owner') return done({ ok: true, applied: true, lines: lines, stock: applyCount(lines, note, me.name) });
    const changed = lines.filter(function (l) { return l.diff !== 0; });
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
    return done({ ok: true, expense: Object.assign({ id: null }, e) });
  }

  case 'open_shift': {
    if (myShift) return done({ ok: true, already: true, shift: shiftOut(myShift) });
    const opening = money(data.opening_cash);
    if (opening < 0) return fail('INVALID', 'Modal awal tidak valid');
    const sh = {
      shift_id: 'SH' + rand(6), cashier: me.name, shift_date: isDate(data.shift_date) ? data.shift_date : jkDate(),
      opened_at: new Date().toISOString(), closed_at: '', status: 'open', opening_cash: opening,
      cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0,
      expected_cash: 0, counted_cash: 0, difference: 0, moves: '[]', note: str(data.note)
    };
    ops.shifts.push(forWrite(sh, -1));
    return done({ ok: true, already: false, shift: shiftOut(sh) });
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
    return done({ ok: true, shift: clean(sh) });
  }

  case 'check_approval': {
    const a = approvalById(String(data.request_id || ''));
    if (!a) return fail('NOT_FOUND', 'Permintaan tidak ditemukan');
    return done({ ok: true, approval: approvalOut(a) });
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
    const na = Object.assign({}, a, { status: finalStatus === 'used' ? 'approved' : finalStatus, decided_by: me.name, decided_at: new Date().toISOString(), note: str(data.note) || str(a.note) });
    ops.approvals.push(forWrite(na, a.id));
    out.approval = approvalOut(na);
    return done(out);
  }

  case 'void_sale': {
    const sale = rows('Get Sale By Invoice')[0];
    if (!sale) return fail('NOT_FOUND', 'Transaksi tidak ditemukan');
    if (sale.status === 'void') return done({ ok: true, sale: strip(sale, role) });
    return done({ ok: true, sale: strip(doVoid(sale, data.reason, me.name), role) });
  }

  case 'save_product': {
    const name = str(data.name);
    if (!name) return fail('INVALID', 'Nama produk wajib');
    const sku = str(data.sku);
    const existing = data.id ? productById[String(data.id)] : null;
    if (data.id && !existing) return fail('NOT_FOUND', 'Produk tidak ditemukan');
    if (sku && products.some(function (p) { return str(p.sku) === sku && (!existing || p.id !== existing.id); })) return fail('INVALID', 'SKU/barcode sudah dipakai');
    const p = {
      sku: sku, name: name, category: str(data.category), unit: str(data.unit) || 'pcs',
      cost_price: money(data.cost_price), retail_price: money(data.retail_price), wholesale_price: money(data.wholesale_price),
      wholesale_min_qty: num(data.wholesale_min_qty), stock: existing ? num(existing.stock) : num(data.stock),
      min_stock: num(data.min_stock), active: data.active !== false, notes: str(data.notes)
    };
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
    return done({ ok: true, product: Object.assign({ id: existing ? existing.id : null }, p) });
  }

  case 'import_products': {
    const list = Array.isArray(data.rows) ? data.rows.slice(0, 500) : [];
    if (!list.length) return fail('INVALID', 'Tidak ada baris');
    let created = 0, updated = 0;
    const bySku = {}, byName = {};
    products.forEach(function (p) { if (str(p.sku)) bySku[str(p.sku)] = p; byName[str(p.name).toLowerCase()] = p; });
    const fields = ['category', 'unit', 'cost_price', 'retail_price', 'wholesale_price', 'wholesale_min_qty', 'min_stock', 'notes'];
    list.forEach(function (r) {
      const name = str(r.name);
      const sku = str(r.sku);
      if (!name && !sku) return;
      const ex = (sku && bySku[sku]) || (name && byName[name.toLowerCase()]) || null;
      const base = ex ? Object.assign({}, ex) : { sku: sku, name: name, category: '', unit: 'pcs', cost_price: 0, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0, stock: 0, min_stock: 0, active: true, notes: '' };
      if (name) base.name = name;
      if (sku) base.sku = sku;
      fields.forEach(function (f) {
        if (r[f] !== undefined && r[f] !== null && r[f] !== '') {
          base[f] = (f === 'category' || f === 'unit' || f === 'notes') ? str(r[f]) : (f === 'wholesale_min_qty' || f === 'min_stock' ? num(r[f]) : money(r[f]));
        }
      });
      if (r.stock !== undefined && r.stock !== null && r.stock !== '') base.stock = num(r.stock);
      base.active = true;
      ops.products.push(forWrite(base, ex ? ex.id : -1));
      if (ex) updated++; else { created++; if (sku) bySku[sku] = base; byName[base.name.toLowerCase()] = base; }
    });
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
    return done({ ok: true, product: productOut(np) });
  }

  case 'save_customer': {
    // A number taken at the counter (no id) that is already known updates that customer instead of adding a duplicate.
    const phone = normPhone(data.phone);
    let ex = data.id ? customerById[String(data.id)] : null;
    if (data.id && !ex) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
    let existed = false;
    if (!ex && phone) { ex = customers.find(function (x) { return normPhone(x.phone) === phone; }) || null; existed = !!ex; }
    const name = str(data.name) || (ex ? str(ex.name) : (phone ? 'Pelanggan ' + phone.slice(-4) : ''));
    if (!name) return fail('INVALID', 'Nama pelanggan wajib');
    const optin = typeof data.wa_optin === 'boolean' ? (existed ? (data.wa_optin || ex.wa_optin === true) : data.wa_optin) : !!(ex && ex.wa_optin === true);
    const c = existed ? {
      name: name, phone: phone, type: str(ex.type) || 'eceran', address: str(data.address) || str(ex.address), notes: str(data.notes) || str(ex.notes),
      debt_balance: money(ex.debt_balance), wa_optin: optin, source: str(ex.source) || str(data.source).slice(0, 20)
    } : {
      name: name, phone: phone || str(data.phone), type: data.type === 'grosir' ? 'grosir' : 'eceran',
      address: str(data.address), notes: str(data.notes), debt_balance: ex ? money(ex.debt_balance) : 0,
      wa_optin: optin, source: str(data.source).slice(0, 20) || (ex ? str(ex.source) : '')
    };
    ops.customers.push(forWrite(c, ex ? ex.id : -1));
    return done({ ok: true, existed: existed, customer: Object.assign({ id: ex ? ex.id : null }, c) });
  }

  case 'receive_payment': {
    const c = customerById[String(data.customer_id)];
    if (!c) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
    const amount = money(data.amount);
    if (!(amount > 0)) return fail('INVALID', 'Jumlah pembayaran tidak valid');
    if (amount > money(c.debt_balance)) return fail('INVALID', 'Pembayaran melebihi hutang');
    const nc = Object.assign({}, c, { debt_balance: Math.max(0, money(c.debt_balance) - amount) });
    const pay = {
      pay_date: isDate(data.pay_date) ? data.pay_date : new Date().toISOString().slice(0, 10),
      customer_id: c.id, customer_name: str(c.name), amount: amount,
      method: ['tunai', 'transfer', 'qris'].indexOf(data.method) >= 0 ? data.method : 'tunai',
      note: str(data.note), cashier: me.name
    };
    ops.payments.push(forWrite(pay, -1));
    ops.customers.push(forWrite(nc, c.id));
    if (myShift && pay.method === 'tunai') {
      ops.shifts.push(forWrite(Object.assign({}, myShift, { cash_payments: money(myShift.cash_payments) + amount }), myShift.id));
    }
    return done({ ok: true, payment: Object.assign({ id: null }, pay), customer: clean(nc) });
  }

  case 'save_purchase': {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return fail('INVALID', 'Tidak ada barang');
    const date = isDate(data.purchase_date) ? data.purchase_date : new Date().toISOString().slice(0, 10);
    const photoId = str(data.photo_id);
    if (photoId) {
      const ph = rows('Get Photo').find(function (x) { return x.photo_id === photoId; });
      if (!ph || ph.kind !== 'masuk') return fail('INVALID', 'Foto barang masuk tidak ditemukan');
    } else if (readSettings().require_purchase_photo !== false) {
      return fail('PHOTO_REQUIRED', 'Barang masuk wajib foto nota / barang');
    }
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
        exp_date: isDate(it.exp_date) ? it.exp_date : ''
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
    return done({ ok: true, stock: stockOut });
  }

  case 'get_sales': {
    if (!isDate(data.from) || !isDate(data.to)) return fail('INVALID', 'Rentang tanggal tidak valid');
    return done({
      ok: true,
      sales: rows('Get Range Sales').map(function (r) { return strip(r, role); }),
      items: rows('Get Range Items').map(function (r) { return strip(r, role); }),
      payments: rows('Get Range Payments').map(clean),
      purchases: rows('Get Range Purchases').map(function (r) { return strip(r, role); }),
      expenses: rows('Get Range Expenses').map(clean),
      shifts: rows('Get Range Shifts').map(clean)
    });
  }

  case 'save_settings': {
    const incoming = data.settings && typeof data.settings === 'object' ? data.settings : {};
    const allowed = ['store_name', 'address', 'phone', 'receipt_footer', 'paper', 'survey_questions', 'survey_auto', 'auto_lock_minutes', 'language', 'exit_photo_min_total', 'exit_photo_min_qty', 'require_purchase_photo', 'require_shift', 'wa_shop_number', 'survey_voice'];
    const byKey = {};
    settingRows.forEach(function (r) { byKey[r.skey] = r; });
    allowed.forEach(function (k) {
      if (incoming[k] === undefined) return;
      ops.settings.push({ _id: byKey[k] ? byKey[k].id : -1, skey: k, svalue: JSON.stringify(incoming[k]) });
    });
    const merged = readSettings();
    allowed.forEach(function (k) { if (incoming[k] !== undefined) merged[k] = incoming[k]; });
    return done({ ok: true, settings: merged });
  }

  case 'save_user': {
    const name = str(data.name);
    if (!name) return fail('INVALID', 'Nama wajib');
    const newRole = ['owner', 'manager', 'sales'].indexOf(data.role) >= 0 ? data.role : 'kasir';
    const ex = users.find(function (u) { return str(u.name).toLowerCase() === name.toLowerCase(); });
    const active = data.active !== false;
    if (data.pin_hash !== undefined && data.pin_hash !== '' && !isHash(data.pin_hash)) return fail('INVALID', 'PIN tidak valid');
    if (!ex && !isHash(data.pin_hash)) return fail('INVALID', 'PIN wajib untuk pengguna baru');
    if (ex && ex.role === 'owner' && (newRole !== 'owner' || !active)) {
      const owners = activeUsers.filter(function (u) { return u.role === 'owner'; });
      if (owners.length <= 1) return fail('INVALID', 'Harus ada minimal satu pemilik aktif');
    }
    const u = { name: ex ? ex.name : name, role: newRole, pin_hash: isHash(data.pin_hash) ? data.pin_hash : ex.pin_hash, active: active };
    ops.users.push(forWrite(u, ex ? ex.id : -1));
    return done({ ok: true, user: { name: u.name, role: u.role, active: u.active } });
  }

  default:
    return fail('INVALID', 'Aksi tidak dikenal: ' + req.action);
}
