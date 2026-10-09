// v28 — account SUSPEND / RE-ENABLE (set_account_active), plus the save_user hardening.
// Rule (owner's decision): the OWNER and the MANAGER may SUSPEND (active=false) any non-owner staff account; the owner
// may also suspend another owner (never the acting owner's own account). RE-ENABLE (active=true) is the OWNER's alone.
// No one suspends their own account. kasir/sales/akuntan may not call it at all. A suspended account cannot authenticate.
const fs = require('fs'), crypto = require('crypto');
const KEY = fs.readFileSync(__dirname + '/storekey.txt', 'utf8').trim();
const code = fs.readFileSync(__dirname + '/../process.js', 'utf8').replace('__STORE_KEY__', KEY);
const fn = new Function('$', code);
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
function run(req, db) {
  const nodes = { 'Parse Request': [req], 'Get Users': db.users, 'Get Settings': db.settings || [], 'Get Products': db.products || [{}], 'Get Customers': [{}],
    'Get Sale By Client': [{}], 'Get Sale By Invoice': [{}], 'Get Items By Invoice': [{}], 'Get Range Sales': [{}], 'Get Range Items': [{}], 'Get Range Payments': [{}], 'Get Range Purchases': [{}], 'Get Approvals': [{}], 'Get Photo': [{}], 'Get Range Expenses': [{}], 'Get Open Shifts': [{}], 'Get Range Shifts': [{}], 'Get Devices': [{}], 'Get Range Repacks': [{}], 'Get Purchase By No': [{}], 'Get Range Activity': [{}], 'Get Party Payments': [{}], 'Get Party Sales': [{}], 'Get Party Purchases': [{}], 'Get Bank Lines': [{}], 'Get Returns By Ref': [{}], 'Get Range Returns': [{}] };
  const $ = n => ({ first: () => ({ json: (nodes[n] || [{}])[0] }), all: () => (nodes[n] || []).map(j => ({ json: j })) });
  return fn($)[0].json;
}
// Fresh user list per call — process.js writes to ops, not to the input, but a clean list keeps each case independent.
function users(over) {
  over = over || {};
  const list = [
    { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true },
    { id: 2, name: 'Owner2', role: 'owner', pin_hash: h('Owner2', '1235'), active: true },
    { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true },
    { id: 4, name: 'Nadia', role: 'manager', pin_hash: h('Nadia', '2223'), active: true },
    { id: 5, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true },
    { id: 6, name: 'Sari', role: 'sales', pin_hash: h('Sari', '3333'), active: true },
    { id: 7, name: 'Akun', role: 'akuntan', pin_hash: h('Akun', '4444'), active: true },
    { id: 8, name: 'Budi', role: 'kasir', pin_hash: h('Budi', '1112'), active: false } // already suspended
  ];
  return list.map(u => over[u.name] ? Object.assign({}, u, over[u.name]) : u);
}
const db = over => ({ users: users(over), products: [{ id: 1, sku: '1', name: 'X', unit: 'pcs', cost_price: 1, retail_price: 2, stock: 1, active: true }] });
const base = (user, pin, action, data) => ({ ip: '1.2.3.4', ua: 'Mozilla/5.0 (Linux; Android 14)', action, key: KEY, user, pin_hash: h(user, pin), data, client_id: '__none__', invoice_no: '__none__', from: '9999-12-31', to: '0000-01-01' });
let pass = 0, fail = 0;
function ok(label, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label + (extra !== undefined ? ' | ' + extra : '')); cond ? pass++ : fail++; }
const resp = r => r.response || r;
// set_account_active as `user`; `over` lets a case start from a modified user list.
const sa = (user, pin, name, active, over) => run(base(user, pin, 'set_account_active', { name, active }), db(over));
// the written row for `name` (process.js matches by id; the harness uses ids, so look it up by the target's id)
const idOf = n => users().find(u => u.name === n).id;
const writtenActive = (r, name) => { const row = (r.ops.users || []).find(u => u._id === idOf(name)); return row ? row.active : undefined; };

let r;
// ---- 1–2. owner suspends a kasir, then re-enables it ----
r = sa('Pemilik', '1234', 'Siti', false);
ok('1 owner suspends kasir Siti → ok, active=false', resp(r).ok === true && resp(r).user.active === false && writtenActive(r, 'Siti') === false, resp(r).error || JSON.stringify(resp(r).user));
r = sa('Pemilik', '1234', 'Budi', true); // Budi starts suspended
ok('2 owner re-enables suspended Budi → ok, active=true', resp(r).ok === true && resp(r).user.active === true && writtenActive(r, 'Budi') === true, resp(r).error || JSON.stringify(resp(r).user));

// ---- 3–6. manager suspends a kasir / sales / akuntan / another manager ----
ok('3 manager suspends kasir → ok', (r = sa('Jihan', '2222', 'Siti', false), resp(r).ok === true && writtenActive(r, 'Siti') === false), resp(r).error);
ok('4 manager suspends sales → ok', (r = sa('Jihan', '2222', 'Sari', false), resp(r).ok === true && writtenActive(r, 'Sari') === false), resp(r).error);
ok('5 manager suspends akuntan → ok', (r = sa('Jihan', '2222', 'Akun', false), resp(r).ok === true && writtenActive(r, 'Akun') === false), resp(r).error);
ok('6 manager suspends another manager (Nadia) → ok', (r = sa('Jihan', '2222', 'Nadia', false), resp(r).ok === true && writtenActive(r, 'Nadia') === false), resp(r).error);

// ---- 7. manager suspending the owner → FORBIDDEN ----
ok('7 manager suspends owner → FORBIDDEN', resp(sa('Jihan', '2222', 'Pemilik', false)).error === 'FORBIDDEN');

// ---- 8. manager re-enabling a suspended account → FORBIDDEN (owner-only) ----
r = sa('Jihan', '2222', 'Budi', true); // Budi suspended
ok('8 manager re-enables suspended Budi → FORBIDDEN', resp(r).error === 'FORBIDDEN', resp(r).message);

// ---- 9. a user suspending their own account → FORBIDDEN (owner and manager) ----
ok('9a owner suspends self → FORBIDDEN', resp(sa('Pemilik', '1234', 'Pemilik', false)).error === 'FORBIDDEN');
ok('9b manager suspends self → FORBIDDEN', resp(sa('Jihan', '2222', 'Jihan', false)).error === 'FORBIDDEN');

// ---- 10–12. kasir / sales / akuntan calling set_account_active → FORBIDDEN ----
ok('10 kasir calls set_account_active → FORBIDDEN', resp(sa('Siti', '1111', 'Sari', false)).error === 'FORBIDDEN');
ok('11 sales calls set_account_active → FORBIDDEN', resp(sa('Sari', '3333', 'Siti', false)).error === 'FORBIDDEN');
ok('12 akuntan calls set_account_active → FORBIDDEN', resp(sa('Akun', '4444', 'Siti', false)).error === 'FORBIDDEN');

// ---- 13. a suspended user cannot authenticate (login or any action) ----
ok('13a suspended Budi login → BAD_PIN (cannot authenticate)', resp(run(base('Budi', '1112', 'login', {}), db())).error === 'BAD_PIN');
ok('13b suspended Budi bootstrap → BAD_PIN', resp(run(base('Budi', '1112', 'bootstrap', {}), db())).error === 'BAD_PIN');
ok('13c suspended Budi set_account_active → BAD_PIN', resp(sa('Budi', '1112', 'Siti', false)).error === 'BAD_PIN');

// ---- 14. owner may suspend ANOTHER owner (not self); two owners exist here so the min-one-owner guard is not hit ----
ok('14a owner suspends another owner → ok', (r = sa('Pemilik', '1234', 'Owner2', false), resp(r).ok === true && writtenActive(r, 'Owner2') === false), resp(r).error);
// the last active owner is protected: only one owner in the list → suspending that owner is blocked (unreachable via self,
// so we assert it through the demote path in save_user, where the guard is reachable)
ok('14b demote the only owner via save_user → INVALID (min one owner)', resp(run(base('Pemilik', '1234', 'save_user', { name: 'Pemilik', role: 'kasir', active: true }), db({ Owner2: { role: 'kasir' } }))).error === 'INVALID');

// ---- 15. bad input: target not found, non-boolean active ----
ok('15a unknown target → NOT_FOUND', resp(sa('Pemilik', '1234', 'Ghaib', false)).error === 'NOT_FOUND');
ok('15b non-boolean active → INVALID', resp(run(base('Pemilik', '1234', 'set_account_active', { name: 'Siti', active: 'yes' }), db())).error === 'INVALID');

// ---- 16. save_user hardening: re-enable is owner-only; no self-suspend; manager still can suspend kasir via save_user ----
// manager tries to flip a suspended kasir (Budi) back to active through save_user → FORBIDDEN
ok('16a manager re-enables via save_user → FORBIDDEN', resp(run(base('Jihan', '2222', 'save_user', { name: 'Budi', role: 'kasir', active: true }), db())).error === 'FORBIDDEN');
// owner re-enables the same suspended kasir through save_user → ok
{ const r3 = run(base('Pemilik', '1234', 'save_user', { name: 'Budi', role: 'kasir', active: true }), db()); ok('16b owner re-enables via save_user → ok, active=true', resp(r3).ok === true && resp(r3).user.active === true, resp(r3).error); }
// owner cannot suspend their own account through save_user either
ok('16c owner self-suspend via save_user → FORBIDDEN', resp(run(base('Pemilik', '1234', 'save_user', { name: 'Pemilik', role: 'owner', active: false }), db({ Owner2: { active: true } }))).error === 'FORBIDDEN');
// manager suspends a kasir through save_user (active=false) → still ok (a manager may deactivate kasir/sales here)
{ const r4 = run(base('Jihan', '2222', 'save_user', { name: 'Siti', role: 'kasir', active: false }), db()); ok('16d manager suspends kasir via save_user → ok, active=false', resp(r4).ok === true && resp(r4).user.active === false, resp(r4).error); }
// manager still cannot create/edit a non-kasir/sales account (unchanged)
ok('16e manager save_user akuntan → FORBIDDEN (create/edit limit unchanged)', resp(run(base('Jihan', '2222', 'save_user', { name: 'Akun', role: 'akuntan', active: false }), db())).error === 'FORBIDDEN');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
