// v64 (owner 2026-10-20, to «من يحدد نسبة القصوى للتخفيض؟ — المالك»: «و المدير ايضا»): the manager sets the highest discount a cashier
// gives without asking, as the owner does; the owner is told every change; the cashier and the accountant may not.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

test('v64 the manager sets the discount limit; the owner is told; the cashier and the accountant may not', async () => {
  const db = newDb(), ad = sqliteAdapter(db);
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  assert.equal((await call(ad, 'Siti', 'set_discount_limit', { max_discount_pct: 10 })).error, 'FORBIDDEN');
  assert.equal((await call(ad, 'Aqil', 'set_discount_limit', { max_discount_pct: 10 })).error, 'FORBIDDEN');
  assert.equal((await call(ad, 'Jihan', 'set_discount_limit', { max_discount_pct: 0 })).error, 'INVALID');
  assert.equal((await call(ad, 'Jihan', 'set_discount_limit', { max_discount_pct: 60 })).error, 'INVALID');
  const r = await call(ad, 'Jihan', 'set_discount_limit', { max_discount_pct: 5 });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.settings.max_discount_pct, 5);
  assert.equal((await call(ad, 'Siti', 'bootstrap', {})).settings.max_discount_pct, 5);
  const n = db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all().at(-1);
  assert.equal(n.ref, 'owner');
  assert.equal(n.summary, 'Batas diskon tanpa persetujuan diubah oleh manajer Jihan: 3% → 5%');
  // the manager still cannot change the other settings
  assert.equal((await call(ad, 'Jihan', 'save_settings', { settings: { max_discount_pct: 7 } })).error, 'FORBIDDEN');
  // the owner sets it too (no notice to himself)
  assert.equal((await call(ad, 'Pemilik', 'set_discount_limit', { max_discount_pct: 4 })).ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_activity WHERE kind = 'notifikasi'").get().n, 1);
});
