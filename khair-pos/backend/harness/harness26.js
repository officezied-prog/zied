// v23 — supplier payments require the OWNER's approval, via a manager-proposed pay plan.
// The manager proposes a LIST (propose_payment → kind 'pay_plan', approver_role owner); the owner authorizes a
// subset (decide_approval with approve_items); the manager then records each authorized payment through pay_supplier
// (plan_request_id + item_index). A manager pay_supplier with no valid authorized plan item is refused (NEEDS_OWNER).
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
  { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true },
  { id: 4, name: 'Sari', role: 'sales', pin_hash: h('Sari', '3333'), active: true },
  { id: 5, name: 'Akun', role: 'akuntan', pin_hash: h('Akun', '4444'), active: true }
];
const products = [
  { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, min_stock: 3, active: true }
];
const db = { users, products };
const withAp = ap => Object.assign({}, db, { ap: ap });
const base = (user, pin, action, data) => ({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (Linux; Android 14)', action, key: KEY, user, pin_hash: h(user, pin), data, client_id: '__none__', invoice_no: '__none__', from: '9999-12-31', to: '0000-01-01' });
let pass = 0, fail = 0;
function ok(label, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label + (extra !== undefined ? ' | ' + extra : '')); cond ? pass++ : fail++; }
const resp = r => r.response || r;
const apOf = (r, id) => (r.ops.approvals || []).find(a => a.request_id === id);
const parse = s => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };

// The list the manager builds and sends (most-urgent first via priority).
const ITEMS = [
  { supplier: 'PT Kurma', amount: 500000, priority: 1, note: 'paling mendesak' },
  { supplier: 'CV Kismis', amount: 300000, priority: 2, note: '' },
  { supplier: 'UD Madu', amount: 200000, priority: 3, note: 'bisa nanti' }
];
// A stored pay_plan approval row. `approvedIdx` = item indexes the owner authorized; `paidIdx` = already paid.
function plan(opts) {
  opts = opts || {};
  const approved = opts.approvedIdx || [], paid = opts.paidIdx || [];
  const items = ITEMS.map((i, idx) => Object.assign({}, i, { approved: approved.indexOf(idx) >= 0, paid: paid.indexOf(idx) >= 0, pay_id: paid.indexOf(idx) >= 0 ? 'PYOLD' + idx : '' }));
  return { id: 70, request_id: opts.request_id || 'PP1', kind: 'pay_plan', approver_role: 'owner', status: opts.status || 'pending', cashier: opts.cashier || 'Jihan',
    created_at: '2025-10-09T01:00:00.000Z', total: items.reduce((s, i) => s + i.amount, 0), summary: items.map(i => i.supplier + ' Rp ' + i.amount).join(', '), payload: JSON.stringify({ items: items }) };
}

let r;
// 1–2. the manager proposes the LIST → a pending pay_plan addressed to the owner; nothing paid yet.
r = run(base('Jihan', '2222', 'propose_payment', { items: ITEMS }), withAp([]));
const prop = resp(r), propAp = (r.ops.approvals || []).find(a => a.kind === 'pay_plan'), propPl = parse(propAp && propAp.payload);
ok('1 manager propose = pending pay_plan to owner (applied:false)', prop.ok === true && prop.applied === false && prop.approval && prop.approval.kind === 'pay_plan' && prop.approval.approver_role === 'owner', prop.error || JSON.stringify(prop.approval && [prop.approval.kind, prop.approval.approver_role]));
ok('2 stored plan: status pending, total summed, items unapproved+unpaid', propAp && propAp.status === 'pending' && propAp.total === 1000000 && propPl.items.length === 3 && propPl.items.every(i => i.approved === false && i.paid === false && i.pay_id === ''), propAp && [propAp.status, propAp.total]);

// 3–5. kasir / sales / akuntan cannot propose a pay plan.
ok('3 kasir propose = FORBIDDEN', resp(run(base('Siti', '1111', 'propose_payment', { items: ITEMS }), withAp([]))).error === 'FORBIDDEN');
ok('4 sales propose = FORBIDDEN', resp(run(base('Sari', '3333', 'propose_payment', { items: ITEMS }), withAp([]))).error === 'FORBIDDEN');
ok('5 akuntan propose = FORBIDDEN', resp(run(base('Akun', '4444', 'propose_payment', { items: ITEMS }), withAp([]))).error === 'FORBIDDEN');

// 6. input validation (empty list, amount<=0, empty supplier, too many).
ok('6a empty list rejected', resp(run(base('Jihan', '2222', 'propose_payment', { items: [] }), withAp([]))).error === 'INVALID');
ok('6b amount<=0 rejected', resp(run(base('Jihan', '2222', 'propose_payment', { items: [{ supplier: 'PT Kurma', amount: 0 }] }), withAp([]))).error === 'INVALID');
ok('6c empty supplier rejected', resp(run(base('Jihan', '2222', 'propose_payment', { items: [{ supplier: '', amount: 1000 }] }), withAp([]))).error === 'INVALID');
ok('6d >50 items rejected', resp(run(base('Jihan', '2222', 'propose_payment', { items: Array.from({ length: 51 }, () => ({ supplier: 'PT Kurma', amount: 1000 })) }), withAp([]))).error === 'INVALID');

// 7–8. the owner authorizes a SUBSET (items 0 and 2, not 1) → status 'approved', the right flags set.
r = run(base('Pemilik', '1234', 'decide_approval', { request_id: 'PP1', decision: 'approved', approve_items: [0, 2] }), withAp([plan({})]));
const decAp = apOf(r, 'PP1'), decPl = parse(decAp && decAp.payload);
ok('7 owner approves subset → status approved', resp(r).ok === true && decAp && decAp.status === 'approved', (resp(r).error || '') + ' status=' + (decAp && decAp.status));
ok('8 approved flags set for picked items only', decPl.items[0].approved === true && decPl.items[1].approved === false && decPl.items[2].approved === true && decPl.items.every(i => i.paid === false), JSON.stringify(decPl.items.map(i => i.approved)));

// 9. the manager cannot decide an owner-level pay_plan.
ok('9 manager cannot decide pay_plan', resp(run(base('Jihan', '2222', 'decide_approval', { request_id: 'PP1', decision: 'approved', approve_items: [0] }), withAp([plan({})]))).error === 'NEEDS_OWNER');

// 10–11. the owner rejects the plan, or approves with nothing ticked → status 'rejected', no item authorized.
ok('10 owner rejects plan → rejected', apOf(run(base('Pemilik', '1234', 'decide_approval', { request_id: 'PP1', decision: 'rejected' }), withAp([plan({})])), 'PP1').status === 'rejected');
{ const rr = run(base('Pemilik', '1234', 'decide_approval', { request_id: 'PP1', decision: 'approved', approve_items: [] }), withAp([plan({})])); const a = apOf(rr, 'PP1');
  ok('11 approve with none ticked → rejected, nothing authorized', a.status === 'rejected' && parse(a.payload).items.every(i => i.approved === false), a.status); }

// 12–15. the manager pay_supplier guard: no plan / pending plan / wrong amount / un-authorized item all refused.
ok('12 manager pay with NO plan = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'pay_supplier', { supplier: 'PT Kurma', amount: 500000, method: 'transfer' }), withAp([]))).error === 'NEEDS_OWNER');
ok('13 manager pay against a PENDING plan = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'pay_supplier', { supplier: 'PT Kurma', amount: 500000, method: 'transfer', plan_request_id: 'PP1', item_index: 0 }), withAp([plan({ status: 'pending', approvedIdx: [0] })]))).error === 'NEEDS_OWNER');
ok('14 manager pay approved item, WRONG amount = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'pay_supplier', { supplier: 'PT Kurma', amount: 400000, method: 'transfer', plan_request_id: 'PP2', item_index: 0 }), withAp([plan({ request_id: 'PP2', status: 'approved', approvedIdx: [0, 2] })]))).error === 'NEEDS_OWNER');
ok('15 manager pay an UN-authorized item = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'pay_supplier', { supplier: 'CV Kismis', amount: 300000, method: 'transfer', plan_request_id: 'PP2', item_index: 1 }), withAp([plan({ request_id: 'PP2', status: 'approved', approvedIdx: [0, 2] })]))).error === 'NEEDS_OWNER');

// 16–18. the manager pays an authorized+unpaid item → payment recorded, item marked paid+pay_id, plan still 'approved'
// (item 2 is authorized but still unpaid).
r = run(base('Jihan', '2222', 'pay_supplier', { supplier: 'PT Kurma', amount: 500000, method: 'transfer', plan_request_id: 'PP2', item_index: 0 }), withAp([plan({ request_id: 'PP2', status: 'approved', approvedIdx: [0, 2] })]));
const pr = resp(r), payRow = (r.ops.payments || [])[0], upAp = apOf(r, 'PP2'), upPl = parse(upAp && upAp.payload);
ok('16 manager pay authorized item records the payment', pr.ok === true && payRow && payRow.direction === 'out' && payRow.party_type === 'supplier' && payRow.supplier === 'PT Kurma' && payRow.amount === 500000, pr.error || '');
ok('17 item marked paid + pay_id; plan still approved (another authorized item unpaid)', upPl.items[0].paid === true && upPl.items[0].pay_id === payRow.pay_id && upPl.items[2].paid === false && upAp.status === 'approved', JSON.stringify([upPl.items[0].paid, upPl.items[0].pay_id === payRow.pay_id, upAp.status]));
ok('18 response carries the plan status', pr.plan && pr.plan.status === 'approved' && pr.plan.item_index === 0, JSON.stringify(pr.plan));

// 19. paying the LAST remaining authorized item → the whole plan becomes 'done'.
r = run(base('Jihan', '2222', 'pay_supplier', { supplier: 'UD Madu', amount: 200000, method: 'transfer', plan_request_id: 'PP3', item_index: 2 }), withAp([plan({ request_id: 'PP3', status: 'approved', approvedIdx: [0, 2], paidIdx: [0] })]));
const fin = apOf(r, 'PP3'), finPl = parse(fin && fin.payload);
ok('19 paying the last authorized item → plan done', resp(r).ok === true && fin.status === 'done' && finPl.items[2].paid === true, JSON.stringify([fin && fin.status, finPl.items && finPl.items[2].paid]));

// 20–21. the owner still pays a supplier directly (no plan); the cashier is still forbidden entirely.
r = run(base('Pemilik', '1234', 'pay_supplier', { supplier: 'PT Kurma', amount: 500000, method: 'transfer' }), withAp([]));
ok('20 owner pays supplier directly (no plan needed)', resp(r).ok === true && (r.ops.payments || [])[0] && (r.ops.payments || [])[0].amount === 500000 && !resp(r).plan, resp(r).error || '');
ok('21 kasir pay_supplier still FORBIDDEN', resp(run(base('Siti', '1111', 'pay_supplier', { supplier: 'PT Kurma', amount: 1000, method: 'transfer' }), withAp([]))).error === 'FORBIDDEN');

// 22–24. list_pay_plans surfaces the manager's own approved, still-payable plans only.
{ const lpp = resp(run(base('Jihan', '2222', 'list_pay_plans', {}), withAp([plan({ request_id: 'PP2', status: 'approved', approvedIdx: [0, 2] })])));
  ok('22 list_pay_plans returns the approved plan with its authorized unpaid items', lpp.ok === true && Array.isArray(lpp.pay_plans) && lpp.pay_plans.length === 1 && lpp.pay_plans[0].items.filter(i => i.approved && !i.paid).length === 2, JSON.stringify(lpp.pay_plans && lpp.pay_plans.map(p => p.request_id))); }
ok('23 list_pay_plans hides a plan with nothing left to pay', (resp(run(base('Jihan', '2222', 'list_pay_plans', {}), withAp([plan({ request_id: 'PP4', status: 'approved', approvedIdx: [0], paidIdx: [0] })]))).pay_plans || []).length === 0);
ok('24 list_pay_plans hides another proposer\'s plan from this manager', (resp(run(base('Jihan', '2222', 'list_pay_plans', {}), withAp([plan({ request_id: 'PP5', status: 'approved', approvedIdx: [0, 2], cashier: 'OrangLain' })]))).pay_plans || []).length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
