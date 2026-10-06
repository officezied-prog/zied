const STORE_KEY = '__STORE_KEY__';
const req = $('Parse Request').first().json;
const data = req.data || {};
const ops = { sales: [], sale_items: [], payments: [], purchases: [], products: [], customers: [], users: [], settings: [] };

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
const role = me.role === 'owner' ? 'owner' : 'kasir';
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
  ]
};
const settingRows = rows('Get Settings');
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
      products: products.map(productOut),
      customers: customers.map(clean),
      settings: readSettings(),
      users: users.map(function (u) { return { name: u.name, role: u.role, active: u.active !== false }; }),
      server_time: new Date().toISOString()
    });

  case 'save_sale': {
    const dup = rows('Get Sale By Client').filter(function (s) { return s.client_id === req.client_id; });
    if (dup.length) {
      return done({ ok: true, duplicate: true, invoice_no: dup[0].invoice_no, sale: strip(dup[0], role), stock: [] });
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return fail('INVALID', 'Keranjang kosong');
    if (!isDate(data.sale_date)) return fail('INVALID', 'Tanggal tidak valid');
    let customer = null;
    if (data.customer_id !== undefined && data.customer_id !== null && data.customer_id !== '') {
      customer = customerById[String(data.customer_id)] || null;
      if (!customer) return fail('NOT_FOUND', 'Pelanggan tidak ditemukan');
    }
    const invoice = 'KM' + data.sale_date.replace(/-/g, '').slice(2) + '-' + rand(5);
    const lines = [];
    const qtyByProduct = {};
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const p = productById[String(it.product_id)];
      if (!p) return fail('NOT_FOUND', 'Produk tidak ditemukan: ' + it.product_id);
      const qty = Math.round(num(it.qty) * 1000) / 1000;
      if (!(qty > 0)) return fail('INVALID', 'Jumlah tidak valid: ' + p.name);
      const unitPrice = money(it.unit_price);
      if (unitPrice < 0) return fail('INVALID', 'Harga tidak valid: ' + p.name);
      const cost = money(p.cost_price);
      const lineTotal = Math.round(qty * unitPrice);
      const lineCost = Math.round(qty * cost);
      lines.push({
        invoice_no: invoice, sale_date: data.sale_date, product_id: p.id, sku: str(p.sku), name: str(p.name),
        qty: qty, unit_price: unitPrice, price_type: it.price_type === 'grosir' ? 'grosir' : 'eceran',
        cost_price: cost, line_total: lineTotal, line_profit: lineTotal - lineCost,
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
    if (debt > 0 && !customer) return fail('INVALID', 'Hutang / bayar kurang wajib pilih pelanggan');
    const survey = Array.isArray(data.survey) && data.survey_consent === true ? data.survey.slice(0, 10).map(function (x) { return { q: str(x.q), a: str(x.a) }; }).filter(function (x) { return x.a; }) : [];
    const sale = {
      invoice_no: invoice, sale_date: data.sale_date, sale_time: str(data.sale_time) || new Date().toISOString(),
      cashier: me.name, customer_id: customer ? customer.id : 0,
      customer_name: customer ? str(customer.name) : (str(data.customer_name) || 'Umum'),
      customer_type: customer ? str(customer.type) : (data.customer_type === 'grosir' ? 'grosir' : 'eceran'),
      subtotal: subtotal, discount: discount, total: total, total_cost: totalCost, profit: total - totalCost,
      payment_method: method, paid_amount: paid, debt_amount: debt, status: 'ok',
      survey: JSON.stringify(survey), notes: str(data.notes), client_id: req.client_id
    };
    ops.sales.push(forWrite(sale, -1));
    lines.forEach(function (l) { ops.sale_items.push(forWrite(l, -1)); });
    const stockOut = [];
    Object.keys(qtyByProduct).forEach(function (pid) {
      const p = productById[pid];
      const newStock = Math.round((num(p.stock) - qtyByProduct[pid]) * 1000) / 1000;
      ops.products.push(forWrite(Object.assign({}, p, { stock: newStock }), p.id));
      stockOut.push({ product_id: p.id, stock: newStock });
    });
    if (customer && debt > 0) {
      ops.customers.push(forWrite(Object.assign({}, customer, { debt_balance: money(customer.debt_balance) + debt }), customer.id));
    }
    return done({ ok: true, duplicate: false, invoice_no: invoice, sale: strip(sale, role), stock: stockOut });
  }

  case 'void_sale': {
    const sale = rows('Get Sale By Invoice')[0];
    if (!sale) return fail('NOT_FOUND', 'Transaksi tidak ditemukan');
    if (sale.status === 'void') return done({ ok: true, sale: strip(sale, role) });
    const items = rows('Get Items By Invoice');
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
    const voided = Object.assign({}, sale, { status: 'void', notes: (str(sale.notes) + ' [VOID oleh ' + me.name + ': ' + str(data.reason) + ']').trim() });
    ops.sales.push(forWrite(voided, sale.id));
    return done({ ok: true, sale: strip(voided, role) });
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
        cost_price: cost, total: Math.round(qty * cost), note: str(data.note), user: me.name
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
      purchases: rows('Get Range Purchases').map(function (r) { return strip(r, role); })
    });
  }

  case 'save_settings': {
    const incoming = data.settings && typeof data.settings === 'object' ? data.settings : {};
    const allowed = ['store_name', 'address', 'phone', 'receipt_footer', 'paper', 'survey_questions', 'survey_auto', 'auto_lock_minutes', 'language'];
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
    const newRole = data.role === 'owner' ? 'owner' : 'kasir';
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
