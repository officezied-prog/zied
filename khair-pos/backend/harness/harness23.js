// v21 — expiry (kedaluwarsa) + product attributes (size/weight) on goods-in and product save.
const fs = require('fs'), crypto = require('crypto');
const KEY = fs.readFileSync(__dirname + '/storekey.txt', 'utf8').trim();
const code = fs.readFileSync(__dirname + '/../process.js', 'utf8').replace('__STORE_KEY__', KEY);
const fn = new Function('$', code);
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const DEFSHIFTS = [{ id: 22, shift_id: 'SHJ', cashier: 'Jihan', status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' }];
function run(req, db) {
  const nodes = { 'Parse Request': [req], 'Get Users': db.users, 'Get Settings': db.settings || [], 'Get Products': db.products, 'Get Customers': db.customers || [{}],
    'Get Sale By Client': [{}], 'Get Sale By Invoice': [{}], 'Get Items By Invoice': [{}], 'Get Range Sales': [{}], 'Get Range Items': [{}], 'Get Range Payments': [{}], 'Get Range Purchases': db.rpu || [{}], 'Get Approvals': [{}], 'Get Photo': db.ph || [{}], 'Get Range Expenses': [{}], 'Get Open Shifts': db.os || DEFSHIFTS, 'Get Range Shifts': [{}], 'Get Devices': [{}], 'Get Range Repacks': [{}], 'Get Purchase By No': db.pbn || [{}], 'Get Range Activity': [{}], 'Get Party Payments': [{}], 'Get Party Sales': [{}], 'Get Party Purchases': [{}], 'Get Bank Lines': [{}], 'Get Returns By Ref': [{}], 'Get Range Returns': [{}] };
  const $ = n => ({ first: () => ({ json: (nodes[n] || [{}])[0] }), all: () => (nodes[n] || []).map(j => ({ json: j })) });
  return fn($)[0].json;
}
const NOPHOTO = [{ id: 1, skey: 'require_purchase_photo', svalue: 'false' }, { id: 2, skey: 'require_carrier', svalue: 'false' }];
const db = {
  users: [{ id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true },
    { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true }],
  settings: NOPHOTO,
  products: [
    { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 10, min_stock: 3, active: true, exp_date: '', exp_none: false, size: '', weight: '' },
    { id: 2, sku: '222', name: 'Kismis 500g', category: 'kismis', unit: 'pcs', cost_price: 20000, retail_price: 25000, stock: 0, min_stock: 5, active: true, exp_date: '', exp_none: false, size: '', weight: '' },
    { id: 3, sku: '333', name: 'Cokelat Arab', category: 'cokelat', unit: 'pcs', cost_price: 10000, retail_price: 15000, stock: 5, min_stock: 2, active: true, exp_date: '2027-01-01', exp_none: false, size: '', weight: '' },
    { id: 4, sku: '444', name: 'Madu 250g', category: 'madu', unit: 'pcs', cost_price: 30000, retail_price: 40000, stock: 0, min_stock: 2, active: true, exp_date: '2027-01-01', exp_none: false, size: '', weight: '' }
  ]
};
const base = (action, user, pin, data) => ({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (Linux; Android 14)', action, key: KEY, user, pin_hash: h(user, pin), data, client_id: '__none__', invoice_no: '__none__', from: '9999-12-31', to: '0000-01-01' });
const prod = (r, id) => (r.ops.products || []).find(p => p._id === id);
let pass = 0, fail = 0;
function ok(label, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label + (extra !== undefined ? ' | ' + extra : '')); cond ? pass++ : fail++; }

let r;
// 1 — a line with neither a date nor "no expiry" is rejected
r = run(base('save_purchase', 'Jihan', '2222', { supplier: 'CV A', items: [{ product_id: 1, qty: 5, cost_price: 1000 }] }), db);
ok('1 missing expiry → INVALID', r.response.error === 'INVALID', r.response.message);

// 2 — a dated line stores exp_date on the purchase row and on the product (exp_none false)
r = run(base('save_purchase', 'Jihan', '2222', { supplier: 'CV A', items: [{ product_id: 1, qty: 5, cost_price: 1000, exp_date: '2027-06-01' }] }), db);
ok('2 purchase row exp_date', (r.ops.purchases || []).some(x => x.product_id === 1 && x.exp_date === '2027-06-01'));
ok('2 product exp_date + exp_none false', prod(r, 1) && prod(r, 1).exp_date === '2027-06-01' && prod(r, 1).exp_none === false, prod(r, 1) && prod(r, 1).exp_date);
ok('2 stockOut carries expiry', (r.response.stock || []).some(s => s.product_id === 1 && s.exp_date === '2027-06-01' && s.exp_none === false));

// 3 — "no expiry" marks the product (exp_none true, date cleared)
r = run(base('save_purchase', 'Jihan', '2222', { supplier: 'CV A', items: [{ product_id: 1, qty: 5, cost_price: 1000, exp_none: true }] }), db);
ok('3 product exp_none true, date empty', prod(r, 1) && prod(r, 1).exp_none === true && prod(r, 1).exp_date === '', prod(r, 1) && JSON.stringify({ n: prod(r, 1).exp_none, d: prod(r, 1).exp_date }));

// 4a — existing earlier date is kept when the new batch expires later (soonest wins)
r = run(base('save_purchase', 'Jihan', '2222', { supplier: 'CV A', items: [{ product_id: 3, qty: 2, cost_price: 1000, exp_date: '2027-06-01' }] }), db);
ok('4a keeps soonest (2027-01-01)', prod(r, 3) && prod(r, 3).exp_date === '2027-01-01', prod(r, 3) && prod(r, 3).exp_date);
// 4b — a sooner new batch moves the product's date earlier
r = run(base('save_purchase', 'Jihan', '2222', { supplier: 'CV A', items: [{ product_id: 3, qty: 2, cost_price: 1000, exp_date: '2026-12-01' }] }), db);
ok('4b moves earlier (2026-12-01)', prod(r, 3) && prod(r, 3).exp_date === '2026-12-01', prod(r, 3) && prod(r, 3).exp_date);

// 5 — fresh stock (was 0) replaces the stale date even if the old one was earlier
r = run(base('save_purchase', 'Jihan', '2222', { supplier: 'CV A', items: [{ product_id: 4, qty: 3, cost_price: 1000, exp_date: '2027-06-01' }] }), db);
ok('5 empty stock replaces date (2027-06-01)', prod(r, 4) && prod(r, 4).exp_date === '2027-06-01', prod(r, 4) && prod(r, 4).exp_date);

// 6 — save_product stores size/weight and the expiry choice
r = run(base('save_product', 'Pemilik', '1234', { name: 'Gelas Plastik', unit: 'pcs', category: 'alat', size: '200 ml', weight: '20 g', exp_none: true, stock: 0 }), db);
ok('6a new no-expiry product', prod(r, -1) && prod(r, -1).exp_none === true && prod(r, -1).exp_date === '' && prod(r, -1).size === '200 ml' && prod(r, -1).weight === '20 g');
r = run(base('save_product', 'Pemilik', '1234', { name: 'Susu UHT', unit: 'pcs', exp_date: '2026-12-31', stock: 0 }), db);
ok('6b new dated product', prod(r, -1) && prod(r, -1).exp_date === '2026-12-31' && prod(r, -1).exp_none === false);
r = run(base('save_product', 'Pemilik', '1234', { id: 1, name: 'Kurma Ajwa 1kg', unit: 'kg', size: '1 kg', weight: '1000 g' }), db);
ok('6c edit keeps id, sets size/weight', prod(r, 1) && prod(r, 1).size === '1 kg' && prod(r, 1).weight === '1000 g');
r = run(base('save_product', 'Pemilik', '1234', { name: 'Tanggal Rusak', unit: 'pcs', exp_date: '31-12-2026', stock: 0 }), db);
ok('6d bad date format → INVALID', r.response.error === 'INVALID', r.response.message);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
