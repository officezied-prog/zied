const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Request').first().json;
const data = req.data || {};
const ops = { sales: [], sale_items: [], payments: [], purchases: [], products: [], customers: [], users: [], settings: [], approvals: [], expenses: [] };

function rows(name) {
  try {
    return $(name).all().map(function (i) { return i.json; }).filter(function (r) { return r && r.id !== undefined && r.id !== null; });
  } catch (e) { return []; }
}
function done(resp) { return [{ json: { response: resp, ops: ops, action: req.action } }]; }
function fail(code, msg) { return done({ ok: false, error: code, message: msg || code }); }
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
const role = me.role === 'owner' ? 'owner' : (me.role === 'manager' ? 'manager' : 'kasir');
const isApprover = role === 'owner' || role === 'manager';
function findApprover(name, hash) {
  const u = activeUsers.find(function (x) { return str(x.name).toLowerCase() === str(name).toLowerCase(); });
  if (!u || u.pin_hash !== hash || (u.role !== 'owner' && u.role !== 'manager')) return null;
  return u;
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
  require_purchase_photo: true
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
      server_time: new Date().toISOString()
    });

  case 'save_sale': {
    const dup = rows('Get Sale By Client').filter(function (x) { return x.client_id === req.client_id; });
    if (dup.length) {
      return done({ ok: true, duplicate: true, invoice_no: dup[0].invoice_no, sale: strip(dup[0], role), stock: [] });
    }
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
      survey: JSON.stringify(survey), notes: str(data.notes), client_id: req.client_id, approved_by: approvedBy,
      exit_photo: exitRequired ? 'required' : '', exit_match: ''
    };
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

  case 'save_expense': {
    const CATS = ['sewa', 'gaji', 'listrik_air', 'transport', 'iklan', 'kemasan', 'perawatan', 'lain'];
    const amount = money(data.amount);
    if (!(amount > 0)) return fail('INVALID', 'Jumlah tidak valid');
    const e = {
      expense_date: isDate(data.expense_date) ? data.expense_date : new Date().toISOString().slice(0, 10),
      category: CATS.indexOf(data.category) >= 0 ? data.category : 'lain', amount: amount,
      note: str(data.note).slice(0, 500), user: me.name, photo_id: str(data.photo_id)
    };
    ops.expenses.push(forWrite(e, -1));
    return done({ ok: true, expense: Object.assign({ id: null }, e) });
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
    const name = str(data.name);
    if (!name) return fail('INVALID', 'Nama pelanggan wajib');
    const ex = data.id ? customerById[String(data.id)] : null;
    if (data.id && !ex) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
    const c = {
      name: name, phone: str(data.phone), type: data.type === 'grosir' ? 'grosir' : 'eceran',
      address: str(data.address), notes: str(data.notes), debt_balance: ex ? money(ex.debt_balance) : 0
    };
    ops.customers.push(forWrite(c, ex ? ex.id : -1));
    return done({ ok: true, customer: Object.assign({ id: ex ? ex.id : null }, c) });
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
        cost_price: cost, total: Math.round(qty * cost), note: str(data.note), user: me.name, photo_id: photoId
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
      expenses: rows('Get Range Expenses').map(clean)
    });
  }

  case 'save_settings': {
    const incoming = data.settings && typeof data.settings === 'object' ? data.settings : {};
    const allowed = ['store_name', 'address', 'phone', 'receipt_footer', 'paper', 'survey_questions', 'survey_auto', 'auto_lock_minutes', 'language', 'exit_photo_min_total', 'exit_photo_min_qty', 'require_purchase_photo'];
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
    const newRole = data.role === 'owner' ? 'owner' : (data.role === 'manager' ? 'manager' : 'kasir');
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
