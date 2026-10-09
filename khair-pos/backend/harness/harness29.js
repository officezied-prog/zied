// v29 — owner-approved BANK TRANSFERS (request_transfer → decide_approval → record_transfer).
// The MANAGER raises a transfer request (payee, amount, reason); the OWNER approves it (approval kind 'transfer',
// approver_role 'owner'); then the MANAGER records the transfer executed via the company bank (BNI). Money leaving
// the company this way needs the owner's approval. The owner may still record a transfer directly. A transfer is a
// direction-out, party_type 'other', method 'transfer' payment — it counts as money-out/transfer in the daily report
// and appears in NO supplier/customer ledger. akuntan / kasir / sales cannot touch any of it.
const fs = require('fs'), crypto = require('crypto');
const KEY = fs.readFileSync(__dirname + '/storekey.txt', 'utf8').trim();
const code = fs.readFileSync(__dirname + '/../process.js', 'utf8').replace('__STORE_KEY__', KEY);
const fn = new Function('$', code);
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
function run(req, db) {
  db = db || {};
  const nodes = { 'Parse Request': [req], 'Get Users': db.users, 'Get Settings': db.settings || [{ id: 1, skey: 'bank_accounts', svalue: JSON.stringify([{ id: 'BA1', bank: 'BNI', account_no: '123456', holder: 'Toko', active: true }]) }],
    'Get Products': db.products || [{}], 'Get Customers': [{}], 'Get Sale By Client': [{}], 'Get Sale By Invoice': [{}], 'Get Items By Invoice': [{}],
    'Get Range Sales': [{}], 'Get Range Items': [{}], 'Get Range Payments': db.rangePays || [{}], 'Get Range Purchases': [{}], 'Get Approvals': db.ap || [{}], 'Get Photo': [{}],
    'Get Range Expenses': [{}], 'Get Open Shifts': [{}], 'Get Range Shifts': [{}], 'Get Devices': [{}], 'Get Range Repacks': [{}], 'Get Purchase By No': [{}], 'Get Range Activity': [{}],
    'Get Party Payments': db.pp || [{}], 'Get Party Sales': [{}], 'Get Party Purchases': [{}], 'Get Bank Lines': [{}], 'Get Returns By Ref': [{}], 'Get Range Returns': [{}] };
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
const db = { users };
const withAp = ap => Object.assign({}, db, { ap });
const base = (user, pin, action, data) => ({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (Linux; Android 14)', action, key: KEY, user, pin_hash: h(user, pin), data, client_id: '__none__', invoice_no: '__none__', from: '9999-12-31', to: '0000-01-01' });
let pass = 0, fail = 0;
function ok(label, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label + (extra !== undefined ? ' | ' + extra : '')); cond ? pass++ : fail++; }
const resp = r => r.response || r;
const apOf = (r, id) => (r.ops.approvals || []).find(a => a.request_id === id);
const parse = s => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };
// A stored transfer-request approval row (what request_transfer produces, with the owner's decision applied as needed).
function transfer(opts) {
  opts = opts || {};
  const payee = opts.payee || 'PLN', amount = opts.amount || 500000, reason = opts.reason || 'Bayar listrik', paid = opts.paid === true;
  return { id: 80, request_id: opts.request_id || 'TR1', kind: 'transfer', approver_role: 'owner', status: opts.status || 'pending', cashier: opts.cashier || 'Jihan',
    created_at: '2025-10-09T01:00:00.000Z', total: amount, summary: payee + ' Rp ' + amount + ' — ' + reason,
    payload: JSON.stringify({ payee, amount, reason, account_id: opts.account_id || '', paid, pay_id: paid ? 'PYOLD' : '' }) };
}

let r;
// ---- 1. the manager raises a transfer request → a pending 'transfer' addressed to the owner; nothing paid. ----
r = run(base('Jihan', '2222', 'request_transfer', { payee: 'PLN', amount: 500000, reason: 'Bayar listrik', account_id: 'BA1' }), withAp([]));
const req1 = resp(r), reqAp = (r.ops.approvals || []).find(a => a.kind === 'transfer'), reqPl = parse(reqAp && reqAp.payload);
ok('1a manager request_transfer = pending transfer to owner (applied:false)', req1.ok === true && req1.applied === false && req1.approval && req1.approval.kind === 'transfer' && req1.approval.approver_role === 'owner', req1.error || JSON.stringify(req1.approval && [req1.approval.kind, req1.approval.approver_role]));
ok('1b stored request: pending, total=amount, payload payee/amount/reason, unpaid', reqAp && reqAp.status === 'pending' && reqAp.total === 500000 && reqPl.payee === 'PLN' && reqPl.amount === 500000 && reqPl.reason === 'Bayar listrik' && reqPl.paid === false && reqPl.pay_id === '', reqAp && [reqAp.status, reqAp.total]);

// request validation: empty payee, amount<=0, unknown account.
ok('1c empty payee rejected', resp(run(base('Jihan', '2222', 'request_transfer', { payee: '', amount: 1000 }), withAp([]))).error === 'INVALID');
ok('1d amount<=0 rejected', resp(run(base('Jihan', '2222', 'request_transfer', { payee: 'PLN', amount: 0 }), withAp([]))).error === 'INVALID');
ok('1e unknown account_id rejected', resp(run(base('Jihan', '2222', 'request_transfer', { payee: 'PLN', amount: 1000, account_id: 'ZZ9' }), withAp([]))).error === 'INVALID');
ok('1f empty account_id accepted (optional)', resp(run(base('Jihan', '2222', 'request_transfer', { payee: 'PLN', amount: 1000 }), withAp([]))).ok === true);

// ---- 2. the manager records WITHOUT an approved request → NEEDS_OWNER (no request / pending / wrong amount / unpaid flag). ----
ok('2a manager record with NO request = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'record_transfer', { payee: 'PLN', amount: 500000 }), withAp([]))).error === 'NEEDS_OWNER');
ok('2b manager record against a PENDING request = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'record_transfer', { payee: 'PLN', amount: 500000, request_id: 'TR1' }), withAp([transfer({ status: 'pending' })]))).error === 'NEEDS_OWNER');
ok('2c manager record approved request, WRONG amount = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'record_transfer', { payee: 'PLN', amount: 400000, request_id: 'TR1' }), withAp([transfer({ status: 'approved' })]))).error === 'NEEDS_OWNER');
ok('2d manager record approved request, WRONG payee = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'record_transfer', { payee: 'PDAM', amount: 500000, request_id: 'TR1' }), withAp([transfer({ status: 'approved' })]))).error === 'NEEDS_OWNER');

// ---- 3. the owner approves the pending request → status 'approved' (no side-effect; execution is separate). ----
r = run(base('Pemilik', '1234', 'decide_approval', { request_id: 'TR1', decision: 'approved' }), withAp([transfer({ status: 'pending' })]));
const decAp = apOf(r, 'TR1');
ok('3a owner approves transfer request → status approved', resp(r).ok === true && decAp && decAp.status === 'approved', (resp(r).error || '') + ' status=' + (decAp && decAp.status));
ok('3b owner rejects → status rejected', apOf(run(base('Pemilik', '1234', 'decide_approval', { request_id: 'TR1', decision: 'rejected' }), withAp([transfer({ status: 'pending' })])), 'TR1').status === 'rejected');

// ---- 4. the manager records against the approved request → a direction-out, party_type 'other', transfer payment; request done. ----
r = run(base('Jihan', '2222', 'record_transfer', { payee: 'PLN', amount: 500000, request_id: 'TR1', bank: 'BNI', transfer_ref: 'TRX-001', account_id: 'BA1' }), withAp([transfer({ status: 'approved' })]));
const rec = resp(r), payRow = (r.ops.payments || [])[0], upAp = apOf(r, 'TR1'), upPl = parse(upAp && upAp.payload);
ok('4a manager records the authorized transfer', rec.ok === true && payRow && payRow.direction === 'out' && payRow.party_type === 'other' && payRow.method === 'transfer' && payRow.payee === 'PLN' && payRow.amount === 500000, rec.error || JSON.stringify(payRow && [payRow.direction, payRow.party_type, payRow.method, payRow.payee]));
ok('4b transfer payment carries bank / ref / account, no customer / supplier', payRow && payRow.bank === 'BNI' && payRow.transfer_ref === 'TRX-001' && payRow.account_id === 'BA1' && payRow.customer_id === 0 && payRow.supplier === '' && payRow.customer_name === '', JSON.stringify(payRow && [payRow.bank, payRow.transfer_ref, payRow.account_id]));
ok('4c request marked paid + pay_id, status done', upPl.paid === true && upPl.pay_id === payRow.pay_id && upAp.status === 'done', JSON.stringify([upPl.paid, upPl.pay_id === payRow.pay_id, upAp.status]));
ok('4d response carries the transfer status', rec.transfer && rec.transfer.request_id === 'TR1' && rec.transfer.status === 'done', JSON.stringify(rec.transfer));

// ---- 5. a second record against the same (already paid) request → refused. ----
ok('5a record against an already-paid request (paid flag) = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'record_transfer', { payee: 'PLN', amount: 500000, request_id: 'TR1' }), withAp([transfer({ status: 'approved', paid: true })]))).error === 'NEEDS_OWNER');
ok('5b record against a done request = NEEDS_OWNER', resp(run(base('Jihan', '2222', 'record_transfer', { payee: 'PLN', amount: 500000, request_id: 'TR1' }), withAp([transfer({ status: 'done', paid: true })]))).error === 'NEEDS_OWNER');

// ---- 6. the manager cannot DECIDE an owner-level transfer request. ----
ok('6 manager cannot decide a transfer', resp(run(base('Jihan', '2222', 'decide_approval', { request_id: 'TR1', decision: 'approved' }), withAp([transfer({ status: 'pending' })]))).error === 'NEEDS_OWNER');

// ---- 7. the owner records a transfer directly (no request needed), same 'other' payment shape, no transfer field. ----
r = run(base('Pemilik', '1234', 'record_transfer', { payee: 'Pajak', amount: 250000, reason: 'PPh', bank: 'BNI', transfer_ref: 'TRX-OWN' }), withAp([]));
const ownPay = (r.ops.payments || [])[0];
ok('7 owner records transfer directly (no request)', resp(r).ok === true && ownPay && ownPay.direction === 'out' && ownPay.party_type === 'other' && ownPay.method === 'transfer' && ownPay.payee === 'Pajak' && ownPay.amount === 250000 && !resp(r).transfer, resp(r).error || JSON.stringify(ownPay && [ownPay.party_type, ownPay.payee]));

// ---- 8. the transfer counts in daily_report payments_out.transfer and appears in NO supplier ledger. ----
const TPAY = { id: 9, pay_id: 'PY9', pay_date: '2025-10-09', pay_time: '2025-10-09T04:00:00.000Z', direction: 'out', party_type: 'other', customer_id: 0, customer_name: '', supplier: '', payee: 'PLN', amount: 500000, method: 'transfer', account_id: 'BA1', bank: 'BNI', transfer_ref: 'TRX-001', alloc: '[]', match_status: '', note: 'Bayar listrik', cashier: 'Jihan' };
r = run(base('Pemilik', '1234', 'daily_report', { date: '2025-10-09' }), Object.assign({}, db, { rangePays: [TPAY] }));
const drep = resp(r).report;
ok('8a daily_report payments_out.transfer includes the transfer', resp(r).ok === true && drep && drep.payments_out.transfer === 500000 && drep.payments_out.count === 1 && drep.bank.out_transfer === 500000, JSON.stringify(drep && drep.payments_out));
// party_ledger (supplier): the 'other' payment belongs to no supplier, so it is not listed.
r = run(base('Pemilik', '1234', 'party_ledger', { party_type: 'supplier', supplier: 'PT Kurma' }), Object.assign({}, db, { pp: [TPAY] }));
ok('8b party_ledger (supplier) excludes the transfer payment', resp(r).ok === true && Array.isArray(resp(r).payments) && resp(r).payments.length === 0 && resp(r).balance === 0, JSON.stringify(resp(r).payments));

// ---- 9. list_transfers: the manager's own approved, still-unpaid requests (owner sees all); paid ones hidden. ----
{ const lt = resp(run(base('Jihan', '2222', 'list_transfers', {}), withAp([transfer({ request_id: 'TR1', status: 'approved' })])));
  ok('9a list_transfers returns the approved unpaid request', lt.ok === true && Array.isArray(lt.transfers) && lt.transfers.length === 1 && lt.transfers[0].request_id === 'TR1' && lt.transfers[0].payee === 'PLN' && lt.transfers[0].amount === 500000, JSON.stringify(lt.transfers)); }
ok('9b list_transfers hides a paid request', (resp(run(base('Jihan', '2222', 'list_transfers', {}), withAp([transfer({ request_id: 'TR2', status: 'approved', paid: true })]))).transfers || []).length === 0);
ok('9c list_transfers hides a pending request', (resp(run(base('Jihan', '2222', 'list_transfers', {}), withAp([transfer({ request_id: 'TR3', status: 'pending' })]))).transfers || []).length === 0);
ok('9d list_transfers hides another manager\'s request from this manager', (resp(run(base('Jihan', '2222', 'list_transfers', {}), withAp([transfer({ request_id: 'TR4', status: 'approved', cashier: 'OrangLain' })]))).transfers || []).length === 0);
ok('9e owner list_transfers sees any approved unpaid request', (resp(run(base('Pemilik', '1234', 'list_transfers', {}), withAp([transfer({ request_id: 'TR4', status: 'approved', cashier: 'OrangLain' })]))).transfers || []).length === 1);

// ---- 10. akuntan / kasir / sales are FORBIDDEN on every transfer action. ----
['request_transfer', 'record_transfer', 'list_transfers'].forEach(act => {
  ok('10 akuntan ' + act + ' = FORBIDDEN', resp(run(base('Akun', '4444', act, { payee: 'PLN', amount: 1000 }), withAp([]))).error === 'FORBIDDEN');
  ok('10 kasir ' + act + ' = FORBIDDEN', resp(run(base('Siti', '1111', act, { payee: 'PLN', amount: 1000 }), withAp([]))).error === 'FORBIDDEN');
  ok('10 sales ' + act + ' = FORBIDDEN', resp(run(base('Sari', '3333', act, { payee: 'PLN', amount: 1000 }), withAp([]))).error === 'FORBIDDEN');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
