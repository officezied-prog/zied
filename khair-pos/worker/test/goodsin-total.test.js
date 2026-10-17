// v50 (owner 2026-10-15: «عند ادخال بضائع جديده … تخرج الاجمالي صفر»): the goods-in history (get_sales → purchases) carries each
// line's total for whoever may see purchase prices: the owner always, the manager / accountant once the owner allows it
// (akuntan_sees_cost). It used to drop the total for every non-owner, so the manager saw "Rp 0" even when allowed.
// v59 (owner 2026-10-17: «لا يظهر الإجمالي و يكتب مخفي لماذا اصلح هذا»): the note total (the supplier's invoice the manager types in)
// reaches the manager and the accountant always; the unit cost per line follows the owner's setting as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
const jkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

test('goods-in totals: owner, manager and accountant always; unit costs for the manager / accountant only when the owner allows them', async () => {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'AZ1', name: 'Air Zam Zam 1 Liter', unit: 'pcs', cost_price: 18000, retail_price: 25000, stock: 61, shop_stock: 61, active: true });
  insert(db, 'pos_settings', { id: 10, skey: 'require_purchase_photo', svalue: 'false' });
  const ad = sqliteAdapter(db);
  const s = await call(ad, 'Jihan', 'save_purchase', { supplier: 'Sarah Hartati', purchase_date: jkToday(), carrier: { type: 'umum', vehicle: 'B 1234 BB' }, items: [{ product_id: 1, qty: 50, cost_price: 19000, exp_none: true }] });
  assert.equal(s.ok, true, JSON.stringify(s));
  const lines = async (u) => (await call(ad, u, 'get_sales', { from: jkToday(), to: jkToday() })).purchases.filter((p) => p.purchase_no === s.purchase_no);
  assert.equal((await lines('Pemilik'))[0].total, 950000);
  for (const u of ['Jihan', 'Aqil']) { const l = (await lines(u))[0]; assert.equal(l.total, 950000, u); assert.equal(l.cost_price, undefined, u); assert.equal(l.qty, 50, u); }
  insert(db, 'pos_settings', { id: 11, skey: 'akuntan_sees_cost', svalue: 'true' });
  for (const u of ['Jihan', 'Aqil']) { const l = (await lines(u))[0]; assert.equal(l.total, 950000, u); assert.equal(l.cost_price, 19000, u); }
});
