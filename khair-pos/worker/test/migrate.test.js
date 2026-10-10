// Cut-over safety tests: the n8n→D1 data converter round-trips every tricky value, and a
// fresh (schema-only, empty) database supports first-run setup → bootstrap. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter } from './shim.js';
import { rowsToSql } from '../migrate/rows-to-sql.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');

test('migrate: dump → SQL round-trips booleans, nulls, quotes, JSON columns, ids', () => {
  const dump = {
    pos_users: [
      { id: 5, name: "O'Brien", role: 'owner', pin_hash: 'x', active: true, must_change: false, fail_count: 0, locked_until: null },
      { id: 6, name: 'Siti', role: 'kasir', pin_hash: 'y', active: false },
    ],
    pos_customers: [
      { id: 7, name: 'Toko ABC', phone: '0812', type: 'grosir', debt_balance: 150000, member: true, member_no: 'MABC', notes: "pakai ' petik", visits: 3 },
    ],
    pos_approvals: [
      { id: 9, request_id: 'AP1', status: 'pending', payload: JSON.stringify({ a: 1, note: "x'y" }), customer_id: 7, total: 5000 },
    ],
  };
  const { sql, rows } = rowsToSql(dump);
  assert.equal(rows, 4);

  const db = newDb();
  db.exec(sql);
  const a = sqliteAdapter(db);

  const u5 = a.all('SELECT * FROM pos_users WHERE id = 5')[0];
  assert.equal(u5.name, "O'Brien"); // single-quote escaping
  assert.equal(u5.active, 1); // boolean true → 1
  assert.equal(u5.must_change, 0); // boolean false → 0
  assert.equal(u5.locked_until, null); // null preserved
  assert.equal(a.all('SELECT active FROM pos_users WHERE id = 6')[0].active, 0);

  const c = a.all('SELECT * FROM pos_customers WHERE id = 7')[0];
  assert.equal(c.member, 1);
  assert.equal(c.debt_balance, 150000);
  assert.equal(c.notes, "pakai ' petik");

  const ap = a.all('SELECT payload FROM pos_approvals WHERE id = 9')[0];
  assert.deepEqual(JSON.parse(ap.payload), { a: 1, note: "x'y" }); // JSON string column intact

  // ids are preserved AND autoincrement continues past them (no collision on later inserts).
  const r = a.run('INSERT INTO pos_users (name, role, pin_hash) VALUES (?,?,?)', ['Baru', 'kasir', 'z']);
  assert.ok(r.lastInsertRowid > 6, 'next auto id is past the imported max');
});

test('migrate: a fresh empty DB supports first-run setup → bootstrap', async () => {
  const db = newDb(); // schema only, no rows — the state right after `wrangler d1 execute schema.sql`
  const a = sqliteAdapter(db);
  const setup = await handleRequest(a, { action: 'setup', key: KEY, user: '', pin_hash: '', data: { owner_name: 'Pemilik', pin_hash: h('Pemilik', '1234') } }, {}, KEY);
  assert.equal(setup.ok, true, JSON.stringify(setup));
  const users = a.all('SELECT * FROM pos_users', []);
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'owner');
  assert.equal(users[0].active, 1);
  const boot = await handleRequest(a, { action: 'bootstrap', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: {} }, {}, KEY);
  assert.equal(boot.ok, true, JSON.stringify(boot));
  // setup refuses once an owner exists
  const again = await handleRequest(a, { action: 'setup', key: KEY, user: '', pin_hash: '', data: { owner_name: 'X', pin_hash: h('X', '0000') } }, {}, KEY);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'FORBIDDEN');
});
