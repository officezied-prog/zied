// v17→ cost visibility: the MANAGER sees purchase prices (cost_price / total_cost) together with the ACCOUNTANT,
// gated by the owner's existing setting akuntan_sees_cost. Profit (profit / line_profit) stays owner-only, always.
// OFF  → manager / accountant / kasir see neither cost nor profit; owner sees both.
// ON   → manager & accountant see cost (no profit); owner sees both; kasir still sees neither.
const fs = require('fs'), crypto = require('crypto');
const KEY = fs.readFileSync(__dirname + '/storekey.txt', 'utf8').trim();
const code = fs.readFileSync(__dirname + '/../process.js', 'utf8').replace('__STORE_KEY__', KEY);
const fn = new Function('$', code);
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
function run(req, db) {
  const nodes = { 'Parse Request': [req], 'Get Users': db.users, 'Get Settings': db.settings || [], 'Get Products': db.products, 'Get Customers': [{}],
    'Get Sale By Client': [{}], 'Get Sale By Invoice': [{}], 'Get Items By Invoice': [{}], 'Get Range Sales': db.sales || [{}], 'Get Range Items': db.items || [{}], 'Get Range Payments': [{}], 'Get Range Purchases': db.purchases || [{}], 'Get Approvals': db.ap || [{}], 'Get Photo': [{}], 'Get Range Expenses': [{}], 'Get Open Shifts': [{}], 'Get Range Shifts': [{}], 'Get Devices': [{}], 'Get Range Repacks': [{}], 'Get Purchase By No': [{}], 'Get Range Activity': [{}], 'Get Party Payments': [{}], 'Get Party Sales': [{}], 'Get Party Purchases': [{}], 'Get Bank Lines': [{}], 'Get Returns By Ref': [{}], 'Get Range Returns': [{}] };
  const $ = n => ({ first: () => ({ json: (nodes[n] || [{}])[0] }), all: () => (nodes[n] || []).map(j => ({ json: j })) });
  return fn($)[0].json;
}
const users = [
  { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true },
  { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true },
  { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true },
  { id: 5, name: 'Akun', role: 'akuntan', pin_hash: h('Akun', '4444'), active: true }
];
const products = [
  { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, min_stock: 3, active: true },
  { id: 2, sku: '222', name: 'Kismis 500g', category: 'kismis', unit: 'pcs', cost_price: 20000, retail_price: 25000, stock: 50, min_stock: 5, active: true }
];
// A sale carries total_cost + profit; a line item carries cost_price + line_profit; a goods-in row carries cost_price + total.
// (Every DB row needs an `id` — process.js rows() drops rows without one.)
const sales = [
  { id: 101, invoice_no: 'KM250101-0001', sale_date: '2025-01-01', client_id: 'c1', total: 185000, total_cost: 150000, profit: 35000, status: 'ok' },
  { id: 102, invoice_no: 'KM250101-0002', sale_date: '2025-01-01', client_id: 'c2', total: 50000, total_cost: 40000, profit: 10000, status: 'ok' }
];
const items = [
  { id: 201, invoice_no: 'KM250101-0001', product_id: 1, name: 'Kurma Ajwa 1kg', qty: 1, unit_price: 185000, cost_price: 150000, line_total: 185000, line_profit: 35000 },
  { id: 202, invoice_no: 'KM250101-0002', product_id: 2, name: 'Kismis 500g', qty: 2, unit_price: 25000, cost_price: 20000, line_total: 50000, line_profit: 10000 }
];
const purchases = [
  { id: 50, purchase_no: 'PB1', product_id: 1, name: 'Kurma Ajwa 1kg', qty: 10, cost_price: 150000, total: 1500000, supplier: 'PT Kurma' },
  { id: 51, purchase_no: 'PB1', product_id: 2, name: 'Kismis 500g', qty: 20, cost_price: 20000, total: 400000, supplier: 'PT Kurma' }
];
// db with the cost-visibility setting on / off (settings are skey/svalue rows, like the live store; each needs an id)
const db = (on) => ({ users, products, sales, items, purchases, settings: on ? [{ id: 1, skey: 'akuntan_sees_cost', svalue: 'true' }] : [] });
const base = (user, pin, action, data) => ({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (Linux; Android 14)', action, key: KEY, user, pin_hash: h(user, pin), data, client_id: '__none__', invoice_no: '__none__', from: '9999-12-31', to: '0000-01-01' });
const RANGE = { from: '2025-01-01', to: '2025-12-31' };
let pass = 0, fail = 0;
function ok(label, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label + (extra !== undefined ? ' | ' + extra : '')); cond ? pass++ : fail++; }
const resp = r => r.response || r;
const boot = (user, pin, on) => resp(run(base(user, pin, 'bootstrap', {}), db(on)));
const gsales = (user, pin, on) => resp(run(base(user, pin, 'get_sales', RANGE), db(on)));
const none = (arr, k) => Array.isArray(arr) && arr.length > 0 && arr.every(x => x[k] === undefined);
const all = (arr, k) => Array.isArray(arr) && arr.length > 0 && arr.every(x => x[k] !== undefined);

// ---- OFF: the manager sees neither cost nor profit (bootstrap products + get_sales) ----
let m = boot('Jihan', '2222', false);
ok('1 OFF manager bootstrap: products carry NO cost_price', none(m.products, 'cost_price'), JSON.stringify(m.products.map(p => p.cost_price)));
let g = gsales('Jihan', '2222', false);
ok('2 OFF manager get_sales: sales carry NO profit', none(g.sales, 'profit') && none(g.sales, 'total_cost'), JSON.stringify(g.sales.map(s => [s.profit, s.total_cost])));
ok('3 OFF manager get_sales: items carry NO cost_price and NO line_profit', none(g.items, 'cost_price') && none(g.items, 'line_profit'));
ok('4 OFF manager get_sales: purchases carry NO cost_price', none(g.purchases, 'cost_price'));

// ---- ON: the manager sees cost (cost_price / total_cost) but still NO profit ----
m = boot('Jihan', '2222', true);
ok('5 ON manager bootstrap: products carry cost_price', all(m.products, 'cost_price'), JSON.stringify(m.products.map(p => p.cost_price)));
g = gsales('Jihan', '2222', true);
ok('6 ON manager get_sales: sales carry total_cost', all(g.sales, 'total_cost'), JSON.stringify(g.sales.map(s => s.total_cost)));
ok('7 ON manager get_sales: sales still carry NO profit', none(g.sales, 'profit'), JSON.stringify(g.sales.map(s => s.profit)));
ok('8 ON manager get_sales: items carry cost_price but NO line_profit', all(g.items, 'cost_price') && none(g.items, 'line_profit'), JSON.stringify(g.items.map(i => [i.cost_price, i.line_profit])));
ok('9 ON manager get_sales: purchases carry cost_price', all(g.purchases, 'cost_price'));

// ---- the owner always sees both cost and profit (even with the setting off) ----
m = boot('Pemilik', '1234', false);
ok('10 owner bootstrap: products carry cost_price (setting off)', all(m.products, 'cost_price'));
g = gsales('Pemilik', '1234', false);
ok('11 owner get_sales: sales carry profit + total_cost, items carry cost_price + line_profit', all(g.sales, 'profit') && all(g.sales, 'total_cost') && all(g.items, 'cost_price') && all(g.items, 'line_profit'));

// ---- a kasir never sees cost or profit, even with the setting on ----
m = boot('Siti', '1111', true);
ok('12 ON kasir bootstrap: products carry NO cost_price', none(m.products, 'cost_price'));
g = gsales('Siti', '1111', true);
ok('13 ON kasir get_sales: items carry no cost_price / line_profit, sales no profit', none(g.items, 'cost_price') && none(g.items, 'line_profit') && none(g.sales, 'profit'));

// ---- the accountant with the setting on sees cost but never profit (unchanged by this feature) ----
g = gsales('Akun', '4444', true);
ok('14 ON accountant get_sales: items carry cost_price but NO line_profit; sales NO profit', all(g.items, 'cost_price') && none(g.items, 'line_profit') && none(g.sales, 'profit'));
g = gsales('Akun', '4444', false);
ok('15 OFF accountant get_sales: items carry NO cost_price and NO line_profit', none(g.items, 'cost_price') && none(g.items, 'line_profit'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
