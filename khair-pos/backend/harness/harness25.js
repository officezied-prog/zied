// v22 — owner-monitoring goods-in corrections (Option B): the manager REQUESTS a fix (owner approves);
// the cashier requests a fix (manager approves); only the owner applies a fix directly.
const fs = require('fs'), crypto = require('crypto');
const KEY = fs.readFileSync(__dirname + '/storekey.txt', 'utf8').trim();
const code = fs.readFileSync(__dirname + '/../process.js', 'utf8').replace('__STORE_KEY__', KEY);
const fn = new Function('$', code);
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
function run(req, db) {
  const nodes = { 'Parse Request': [req], 'Get Users': db.users, 'Get Settings': db.settings || [], 'Get Products': db.products, 'Get Customers': [{}],
    'Get Sale By Client': [{}], 'Get Sale By Invoice': [{}], 'Get Items By Invoice': [{}], 'Get Range Sales': [{}], 'Get Range Items': [{}], 'Get Range Payments': [{}], 'Get Range Purchases': [{}], 'Get Approvals': db.ap || [{}], 'Get Photo': [{}], 'Get Range Expenses': [{}], 'Get Open Shifts': [{}], 'Get Range Shifts': [{}], 'Get Devices': [{}], 'Get Range Repacks': [{}], 'Get Purchase By No': db.pbn || [{}], 'Get Range Activity': [{}], 'Get Party Payments': [{}], 'Get Party Sales': [{}], 'Get Party Purchases': [{}], 'Get Bank Lines': [{}], 'Get Returns By Ref': [{}], 'Get Range Returns': [{}] };
  const $ = n => ({ first: () => ({ json: (nodes[n] || [{}])[0] }), all: () => (nodes[n] || []).map(j => ({ json: j })) });
  return fn($)[0].json;
}
const users = [
  { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true },
  { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true },
  { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true }
];
const products = [
  { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, min_stock: 3, active: true },
  { id: 2, sku: '222', name: 'Kismis 500g', category: 'kismis', unit: 'pcs', cost_price: 20000, retail_price: 25000, stock: 50, min_stock: 5, active: true }
];
const prow = [
  { id: 50, purchase_no: 'PB1', product_id: 1, name: 'Kurma Ajwa 1kg', qty: 10, cost_price: 150000, total: 1500000, supplier: 'PT Kurma' },
  { id: 51, purchase_no: 'PB1', product_id: 2, name: 'Kismis 500g', qty: 20, cost_price: 20000, total: 400000, supplier: 'PT Kurma' }
];
const db = { users, products, pbn: prow };
const base = (user, pin, action, data) => ({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (Linux; Android 14)', action, key: KEY, user, pin_hash: h(user, pin), data, client_id: '__none__', invoice_no: '__none__', from: '9999-12-31', to: '0000-01-01' });
let pass = 0, fail = 0;
function ok(label, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label + (extra !== undefined ? ' | ' + extra : '')); cond ? pass++ : fail++; }
const resp = r => r.response || r;
const FIX = { purchase_no: 'PB1', lines: [{ product_id: 1, qty: 8 }], reason: 'salah ketik' };

let r;
// 1–2. a cashier REQUESTS → not applied, waits for the manager; the cashier never sees cost
r = run(base('Siti', '1111', 'request_purchase_fix', FIX), db);
ok('1 kasir fix = request to manager', resp(r).applied === false && resp(r).approver_role === 'manager' && resp(r).approval.approver_role === 'manager', resp(r).error || '');
ok('2 kasir changes carry no cost', Array.isArray(resp(r).changes) && resp(r).changes.every(c => c.to_total === undefined && c.cost_price === undefined), JSON.stringify(resp(r).changes));

// 3–5. a manager REQUESTS → not applied, waits for the owner; the manager keeps cost; nothing written
r = run(base('Jihan', '2222', 'request_purchase_fix', FIX), db);
ok('3 manager fix = request to owner', resp(r).applied === false && resp(r).approver_role === 'owner' && resp(r).approval.approver_role === 'owner', resp(r).error || '');
ok('4 manager changes keep cost', Array.isArray(resp(r).changes) && resp(r).changes.some(c => c.to_total !== undefined), JSON.stringify(resp(r).changes.map(c => c.to_total)));
ok('5 manager request applies nothing', !(r.ops && r.ops.purchases && r.ops.purchases.length), (r.ops && r.ops.purchases || []).length);

// 6–7. the owner applies a fix directly
r = run(base('Pemilik', '1234', 'request_purchase_fix', FIX), db);
ok('6 owner fix applied directly', resp(r).applied === true && r.ops.purchases.length === 1, resp(r).error || '');
ok('7 owner fix writes a koreksi row qty -2', r.ops.purchases[0] && r.ops.purchases[0].qty === -2 && r.ops.purchases[0].match_status === 'koreksi', JSON.stringify(r.ops.purchases[0] && [r.ops.purchases[0].qty, r.ops.purchases[0].match_status]));

// 8. the manager cannot decide an owner-level fix
const fixApO = { id: 41, request_id: 'APF2', kind: 'purchase_fix', status: 'pending', approver_role: 'owner', cashier: 'Jihan', summary: 'Koreksi', payload: JSON.stringify(FIX) };
r = run(base('Jihan', '2222', 'decide_approval', { request_id: 'APF2', decision: 'approved', purchase_no: 'PB1' }), Object.assign({}, db, { ap: [fixApO] }));
ok('8 manager cannot approve owner fix', resp(r).error === 'NEEDS_OWNER', resp(r).error);
// 9. the owner approves the manager's fix → applied
r = run(base('Pemilik', '1234', 'decide_approval', { request_id: 'APF2', decision: 'approved', purchase_no: 'PB1' }), Object.assign({}, db, { ap: [fixApO] }));
ok('9 owner approves manager fix', resp(r).ok === true && r.ops.purchases.some(x => x.qty === -2), (resp(r).error || '') + ' status=' + (r.ops.approvals[0] || {}).status);

// 10. the manager approves a cashier's fix (approver_role 'manager')
const fixApM = { id: 40, request_id: 'APF1', kind: 'purchase_fix', status: 'pending', approver_role: 'manager', cashier: 'Siti', summary: 'Koreksi', payload: JSON.stringify(FIX) };
r = run(base('Jihan', '2222', 'decide_approval', { request_id: 'APF1', decision: 'approved', purchase_no: 'PB1' }), Object.assign({}, db, { ap: [fixApM] }));
ok('10 manager approves kasir fix', resp(r).ok === true && r.ops.purchases.some(x => x.qty === -2), resp(r).error || '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
