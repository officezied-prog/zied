// v22 — manager/accountant may ADD a new product (create only); editing an existing product stays owner-only; kasir/sales cannot.
const fs = require('fs'), crypto = require('crypto');
const KEY = fs.readFileSync(__dirname + '/storekey.txt', 'utf8').trim();
const code = fs.readFileSync(__dirname + '/../process.js', 'utf8').replace('__STORE_KEY__', KEY);
const fn = new Function('$', code);
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
function run(req, db) {
  const nodes = { 'Parse Request': [req], 'Get Users': db.users, 'Get Settings': db.settings || [], 'Get Products': db.products, 'Get Customers': [{}],
    'Get Sale By Client': [{}], 'Get Sale By Invoice': [{}], 'Get Items By Invoice': [{}], 'Get Range Sales': [{}], 'Get Range Items': [{}], 'Get Range Payments': [{}], 'Get Range Purchases': [{}], 'Get Approvals': [{}], 'Get Photo': [{}], 'Get Range Expenses': [{}], 'Get Open Shifts': [{}], 'Get Range Shifts': [{}], 'Get Devices': [{}], 'Get Range Repacks': [{}], 'Get Purchase By No': [{}], 'Get Range Activity': [{}], 'Get Party Payments': [{}], 'Get Party Sales': [{}], 'Get Party Purchases': [{}], 'Get Bank Lines': [{}], 'Get Returns By Ref': [{}], 'Get Range Returns': [{}] };
  const $ = n => ({ first: () => ({ json: (nodes[n] || [{}])[0] }), all: () => (nodes[n] || []).map(j => ({ json: j })) });
  return fn($)[0].json;
}
const db = {
  users: [
    { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true },
    { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true },
    { id: 8, name: 'Lestari', role: 'akuntan', pin_hash: h('Lestari', '5555'), active: true },
    { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true },
    { id: 9, name: 'Wahyu', role: 'sales', pin_hash: h('Wahyu', '6666'), active: true }
  ],
  products: [{ id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, min_stock: 3, active: true }]
};
const base = (user, pin, data) => ({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (Linux; Android 14)', action: 'save_product', key: KEY, user, pin_hash: h(user, pin), data, client_id: '__none__', invoice_no: '__none__', from: '9999-12-31', to: '0000-01-01' });
const NEW = { name: 'Barang Baru', unit: 'pcs', category: 'lain', retail_price: 10000, stock: 0 };
let pass = 0, fail = 0;
function ok(label, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label + (extra !== undefined ? ' | ' + extra : '')); cond ? pass++ : fail++; }
const resp = r => r.response || r;

let r;
r = run(base('Jihan', '2222', NEW), db);               ok('1 manager CREATE ok', resp(r).ok === true && !!(r.ops && r.ops.products && r.ops.products.length), resp(r).error || '');
r = run(base('Jihan', '2222', Object.assign({ id: 1 }, NEW)), db); ok('2 manager EDIT forbidden', resp(r).error === 'FORBIDDEN', resp(r).message);
r = run(base('Lestari', '5555', NEW), db);              ok('3 accountant CREATE ok', resp(r).ok === true, resp(r).error || '');
r = run(base('Lestari', '5555', Object.assign({ id: 1 }, NEW)), db); ok('4 accountant EDIT forbidden', resp(r).error === 'FORBIDDEN', resp(r).message);
r = run(base('Siti', '1111', NEW), db);                 ok('5 kasir CREATE forbidden', resp(r).error === 'FORBIDDEN', resp(r).message);
r = run(base('Wahyu', '6666', NEW), db);                ok('6 sales CREATE forbidden', resp(r).error === 'FORBIDDEN', resp(r).message);
r = run(base('Pemilik', '1234', NEW), db);              ok('7 owner CREATE ok', resp(r).ok === true, resp(r).error || '');
r = run(base('Pemilik', '1234', Object.assign({ id: 1, retail_price: 190000 }, NEW)), db); ok('8 owner EDIT ok', resp(r).ok === true, resp(r).error || '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
